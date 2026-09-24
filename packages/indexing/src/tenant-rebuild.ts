/**
 * Turns one owner's canonical `.zz/` commit log into a complete, verified generation of the
 * derived search database, in an isolated target the caller supplies. Never the serving
 * database, and nothing here activates the result.
 *
 * Every decision comes from `.zz/commits/*.json` (the manifest, its `manifest_hash`, its
 * `previous_commit_hash` chain) and `.zz/blobs/<hash>`. DELIBERATE: `RebuildIO` has no `stat` —
 * with no operation that can read an mtime, a caller cannot break "a copied store with changed
 * mtimes reconstructs the same semantic projections".
 *
 * Three failure classes, three outcomes:
 *   - a missing mount, an unreadable owner root, or a corrupt chain/blob:        "blocked"
 *   - the isolated target database throwing (an outage, mid-replay):            "unavailable"
 *   - everything read clean and every commit replayed:                         "ready"
 * "blocked" and "unavailable" stay apart because a missing mount must not be retried the way an
 * outage is.
 *
 * DELIBERATE: the chain walk, the manifest-hash check and the blob-hash check are reimplemented
 * here rather than imported from `services/zz-core/src/tenant-info/{record,recovery}.ts`.
 * `packages/indexing`'s own tsconfig references only `../contracts`, and a package importing a
 * service inverts the dependency direction.
 *
 * COUPLED: `classifyArtifact` and `toProjectionManifest` are exported so a live-replay wiring of
 * `record.ts`'s `CommitExports.projectToDatabase` calls these same two functions.
 *
 * `applyCommit` (`tenant-projections.ts`) issues one `zz.artifact` insert per call, keyed by the
 * manifest's single `artifact_id`, so a commit that mints a document and same-batch
 * SourceArtifacts produces events for all of them but a `zz.artifact` row only for the document.
 * This rebuild calls `applyCommit` once per commit, the same way live replay will, so both
 * exhibit the same gap; `RebuildStats.unprojectedSourceArtifacts` counts it.
 */
import { createHash } from "node:crypto";
import { access, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  ArtifactClassSchema, ContentRevisionSchema, ArtifactEventSchema, SourceCaptureSchema,
  type ArtifactClass, type ArtifactEvent, type ContentRevision, type SourceCapture,
} from "@zz/contracts";

import {
  ANALYZER_NAME, buildRowVector, identifierTokens, passagesOf,
} from "./tenant-analysis.js";
import {
  applyCommit, ensureCorpus, semanticProjectionHash,
  type ProjectionClient, type ProjectionManifest,
} from "./tenant-projections.js";

// `rebuildGeneration` above replays one owner's `.zz/` commit log into the derived search
// database. `rebuildRowVector` below is unrelated to that walk: it is what
// `rederivation.ts`'s generation-aware backfill calls per existing `zz.doc`/`zz.knowledge_node`
// row to get the same weighted term vector the write path (`index.ts`'s `indexDoc`) produces.
//
// COUPLED: the gate check `rederivation-generation.ts` reads this file's own source for an
// `import { buildRowVector … }` line — that import is how it verifies the rebuild path and the
// write path share one weighting implementation.
//
// DELIBERATE: not an alias of `buildRowVector`. What earns it its own name is the normalization
// a raw database row needs: `title`/`body` are `not null default ''` and `tags` is `not null
// default '{}'`, but the column types do not promise that for every future caller, and
// `buildRowVector`'s contract takes `{title, tags, body}` with no room for `null`.
export interface RebuildRowInput {
  readonly title: string | null;
  readonly tags: readonly string[] | null;
  readonly body: string | null;
}

export function rebuildRowVector(row: RebuildRowInput): ReturnType<typeof buildRowVector> {
  return buildRowVector({
    title: row.title ?? "",
    tags: row.tags ?? [],
    body: row.body ?? "",
  });
}

const STORE_DIR = ".zz";
const COMMITS_SUBDIR = "commits";
const BLOBS_SUBDIR = "blobs";

// The read-only I/O this walk needs, and nothing more

export interface RebuildIO {
  exists(path: string): Promise<boolean>;
  readdir(path: string): Promise<string[]>;
  readFile(path: string): Promise<Buffer>;
}

const nodeRebuildIO: RebuildIO = {
  exists: async (path) => {
    try { await access(path); return true; } catch { return false; }
  },
  readdir: (path) => readdir(path),
  readFile: (path) => readFile(path),
};

// The pure cache decision: the frozen check's own subject

/** Whether a row derived under `oldFingerprint` must be re-derived to match `newFingerprint`.
 *  `null` — no prior attempt reached this artifact — always needs derivation; any two distinct
 *  fingerprints do too, since `derivationFingerprint` changes on every version it hashes. The
 *  progress cache this feeds is disposable: losing it re-derives everything, never skips one. */
export function needsRederive(oldFingerprint: string | null, newFingerprint: string): boolean {
  return oldFingerprint === null || oldFingerprint !== newFingerprint;
}

// mount/readiness validation, before anything else runs

interface StoreAvailability {
  readonly available: boolean;
  readonly reason?: string;
}

/** Everything that must be true of `root` before this walk reasons about how many commits an
 *  owner has. A missing `.zz/` layout is refused here, before a commit is read, so it cannot be
 *  misread later as "an owner with zero commits". Both shapes of missing are named: the whole
 *  root gone, and the root present but without its commits/blobs subdirectories. */
export async function checkStoreAvailability(root: string, io: RebuildIO = nodeRebuildIO): Promise<StoreAvailability> {
  const zzDir = join(root, STORE_DIR);
  if (!(await io.exists(zzDir))) {
    return { available: false, reason: `owner-store root ${root} has no ${STORE_DIR}/ layout — a missing mount is refused, never read as an owner with no documents` };
  }
  const commitsDir = join(zzDir, COMMITS_SUBDIR);
  const blobsDir = join(zzDir, BLOBS_SUBDIR);
  if (!(await io.exists(commitsDir)) || !(await io.exists(blobsDir))) {
    return { available: false, reason: `owner-store root ${root} is missing ${COMMITS_SUBDIR}/ or ${BLOBS_SUBDIR}/ under ${STORE_DIR}/ — an incomplete mount is refused the same way a missing one is` };
  }
  return { available: true };
}

// The canonical commit hash, matching record.ts's own algorithm exactly

/** SHA-256 of every manifest field except `manifest_hash`, over canonical UTF-8 JSON with
 *  recursively sorted keys — byte-for-byte the algorithm `services/zz-core/src/tenant-info/
 *  record.ts`'s `manifestHash` computes. A manifest this disagrees with was not written by that
 *  engine, or was corrupted after it was. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "number" || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(record[k])}`).join(",")}}`;
  }
  return "null";
}

function canonicalCommitHash(manifest: Record<string, unknown>): string {
  const rest: Record<string, unknown> = {};
  for (const key of Object.keys(manifest)) if (key !== "manifest_hash") rest[key] = manifest[key];
  return createHash("sha256").update(canonicalJson(rest), "utf8").digest("hex");
}

function sha256Hex(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

// Reading the commit log, chain and blobs verified

interface RawFileChange {
  readonly path: string;
  readonly before_hash: string | null;
  readonly after_hash: string | null;
}

export interface RawCommitManifest {
  readonly owner_id: string;
  readonly sequence: number;
  readonly transaction_id: string;
  readonly previous_commit_hash: string | null;
  readonly manifest_hash: string;
  readonly file_changes: readonly RawFileChange[];
  readonly source_captures: readonly SourceCapture[];
  readonly revisions: readonly ContentRevision[];
  readonly events: readonly ArtifactEvent[];
}

interface OrderedCommitsResult {
  readonly ok: boolean;
  readonly problems: readonly string[];
  /** Only commits with `sequence > afterSequence`, in order. The walk itself still reads every
   *  commit from sequence 1: chain integrity is a property of the whole log, and the baseline
   *  watermark is a replay cursor. */
  readonly commits: readonly RawCommitManifest[];
}

function shapeProblem(file: string, reason: string): string {
  return `${file}: ${reason}`;
}

/** Parses and validates one commit file's typed arrays against the same zod schemas the kernel
 *  validated them against on the way in (`@zz/contracts`). A manifest that no longer parses as
 *  its own declared shape is reported as corrupt rather than read past with an `as` cast. */
function parseTypedArrays(file: string, manifest: Record<string, unknown>, problems: string[]): {
  revisions: ContentRevision[]; events: ArtifactEvent[]; source_captures: SourceCapture[];
} {
  const revisions: ContentRevision[] = [];
  for (const raw of (manifest.revisions as unknown[] ?? [])) {
    const parsed = ContentRevisionSchema.safeParse(raw);
    if (parsed.success) revisions.push(parsed.data);
    else problems.push(shapeProblem(file, `a revision failed schema validation — ${parsed.error.issues[0]?.message ?? "malformed"}`));
  }
  const events: ArtifactEvent[] = [];
  for (const raw of (manifest.events as unknown[] ?? [])) {
    const parsed = ArtifactEventSchema.safeParse(raw);
    if (parsed.success) events.push(parsed.data);
    else problems.push(shapeProblem(file, `an event failed schema validation — ${parsed.error.issues[0]?.message ?? "malformed"}`));
  }
  const source_captures: SourceCapture[] = [];
  for (const raw of (manifest.source_captures as unknown[] ?? [])) {
    const parsed = SourceCaptureSchema.safeParse(raw);
    if (parsed.success) source_captures.push(parsed.data);
    else problems.push(shapeProblem(file, `a source capture failed schema validation — ${parsed.error.issues[0]?.message ?? "malformed"}`));
  }
  return { revisions, events, source_captures };
}

/** Walks `root/.zz/commits/` in sequence order, verifying: no two files claim one sequence,
 *  every `previous_commit_hash` chains from the prior commit's `manifest_hash`, every manifest's
 *  recomputed hash matches the one it carries, and every blob a `file_changes`/`source_captures`
 *  entry references exists and hashes to its own claimed name. Any single problem makes
 *  `ok:false` — a replay of everything except the corrupt commit would produce an incomplete
 *  generation that reports as nearly ready. */
export async function readOrderedCommits(
  root: string, afterSequence: number, io: RebuildIO = nodeRebuildIO,
): Promise<OrderedCommitsResult> {
  const commitsDir = join(root, STORE_DIR, COMMITS_SUBDIR);
  const blobsDir = join(root, STORE_DIR, BLOBS_SUBDIR);
  let files: string[];
  try {
    files = (await io.readdir(commitsDir)).filter((f) => f.endsWith(".json"));
  } catch (err) {
    return { ok: false, problems: [`commits directory unreadable: ${err instanceof Error ? err.message : String(err)}`], commits: [] };
  }
  const entries = files
    .map((f) => ({ file: f, sequence: Number(/^(\d+)-/.exec(f)?.[1] ?? NaN) }))
    .sort((a, b) => a.sequence - b.sequence);

  const problems: string[] = [];
  const commits: RawCommitManifest[] = [];
  const claimedBy = new Map<number, string>();
  let previousHash: string | null = null;

  for (const { file, sequence } of entries) {
    if (!Number.isFinite(sequence)) { problems.push(shapeProblem(file, "unrecognized filename in commits/")); continue; }
    const priorClaim = claimedBy.get(sequence);
    if (priorClaim) { problems.push(`sequence ${sequence} is claimed by both ${priorClaim} and ${file}`); continue; }
    claimedBy.set(sequence, file);

    let raw: Record<string, unknown>;
    try {
      raw = JSON.parse((await io.readFile(join(commitsDir, file))).toString("utf8"));
    } catch (err) {
      problems.push(shapeProblem(file, `could not be parsed — ${err instanceof Error ? err.message : String(err)}`));
      continue;
    }
    if (typeof raw.owner_id !== "string" || typeof raw.transaction_id !== "string"
      || typeof raw.manifest_hash !== "string" || !Array.isArray(raw.file_changes)) {
      problems.push(shapeProblem(file, "missing required top-level manifest fields"));
      continue;
    }
    if ((raw.previous_commit_hash ?? null) !== previousHash) {
      problems.push(shapeProblem(file, "previous_commit_hash does not chain from the prior commit"));
    }
    if (canonicalCommitHash(raw) !== raw.manifest_hash) {
      problems.push(shapeProblem(file, "manifest_hash does not match its own canonical content"));
    }
    previousHash = raw.manifest_hash;

    const typed = parseTypedArrays(file, raw, problems);
    const fileChanges = raw.file_changes as RawFileChange[];
    for (const change of fileChanges) {
      if (change.after_hash === null) continue;
      const blobPath = join(blobsDir, change.after_hash);
      if (!(await io.exists(blobPath))) { problems.push(shapeProblem(file, `references missing blob ${change.after_hash}`)); continue; }
      if (sha256Hex(await io.readFile(blobPath)) !== change.after_hash) {
        problems.push(shapeProblem(file, `blob ${change.after_hash} does not hash to its own name — corrupt`));
      }
    }
    for (const capture of typed.source_captures) {
      const blobPath = join(blobsDir, capture.blob_hash);
      if (!(await io.exists(blobPath))) { problems.push(shapeProblem(file, `references missing source blob ${capture.blob_hash}`)); continue; }
      if (sha256Hex(await io.readFile(blobPath)) !== capture.blob_hash) {
        problems.push(shapeProblem(file, `source blob ${capture.blob_hash} does not hash to its own name — corrupt`));
      }
    }

    if (sequence > afterSequence) {
      commits.push({
        owner_id: raw.owner_id, sequence, transaction_id: raw.transaction_id,
        previous_commit_hash: (raw.previous_commit_hash as string | null) ?? null,
        manifest_hash: raw.manifest_hash, file_changes: fileChanges,
        source_captures: typed.source_captures, revisions: typed.revisions, events: typed.events,
      });
    }
  }
  return { ok: problems.length === 0, problems, commits };
}

// The shared projection policy: one commit, one ProjectionManifest

class RebuildDataError extends Error {}

/** The artifact this commit is primarily about — the one revision it carries, or (a pure
 *  source creation, or a same-batch source with no document of its own) its sole event's
 *  artifact. `null` only for a commit with neither, which the current kernel never produces. */
function primaryArtifactId(manifest: RawCommitManifest): string | null {
  if (manifest.revisions.length > 0) return manifest.revisions[0].artifact_id;
  if (manifest.events.length > 0) return manifest.events[0].artifact_id;
  return null;
}

/** Derives `artifact_class`, which no commit field records durably. An artifact with no
 *  `ContentRevision` is a `SourceArtifact` (it only gets `source_captures` plus a
 *  `revision: null` event); one whose latest revision payload names a `KnowledgeTypeSchema`
 *  value is a knowledge concept; anything else with a revision is a work document. Exported so
 *  a future live-replay wiring calls this function rather than a second guess at the rule. */
export function classifyArtifact(
  manifest: RawCommitManifest, artifactId: string, knownClasses: Map<string, ArtifactClass> = new Map(),
): ArtifactClass {
  // Read from the record, never inferred from content. The `created` event carries
  // `data.artifact_class`, written once by the policy that decided it and immutable after.
  //
  // Reading `payload.type` instead misclassifies any work document whose type happens to be one
  // of the four native knowledge types — `testing/tenant-info/model.ts` builds a
  // `work_document` with `type: "Decision"`.
  const created = manifest.events.find((e) => e.artifact_id === artifactId && e.kind === "created");
  const declared = created?.data?.["artifact_class"];
  if (typeof declared === "string") {
    const parsed = ArtifactClassSchema.parse(declared);
    knownClasses.set(artifactId, parsed);
    return parsed;
  }
  // Carried by the walk, the way `currentPathFor` carries a path. A `created` event appears in
  // exactly one commit; every later commit touching that artifact names it without restating
  // what it is, so reading only the manifest in hand would classify the first commit and fail
  // for every one after it.
  const remembered = knownClasses.get(artifactId);
  if (remembered !== undefined) return remembered;
  // A `created` event without the class is an incomplete record, not an invitation to guess:
  // filling a NOT NULL column with a best idea decides something only the writer knew.
  throw new RebuildDataError(
    `commit ${manifest.sequence} has no recorded artifact_class for ${artifactId} — the created ` +
    `event must carry data.artifact_class, and a rebuild does not infer a class from content`,
  );
}

/** One commit's materialized path for `artifactId` — from this commit's own `file_changes` (a
 *  document create/revise), else its `source_captures` (a source creation), else the last path
 *  this walk saw for the same artifact. A commit touching an artifact with no path anywhere in
 *  this history is refused, not defaulted. */
function currentPathFor(manifest: RawCommitManifest, artifactId: string, knownPaths: Map<string, string>): string {
  const change = manifest.file_changes.find((c) => c.after_hash !== null);
  if (change) { knownPaths.set(artifactId, change.path); return change.path; }
  const capture = manifest.source_captures.find((c) => c.artifact_id === artifactId);
  if (capture) { knownPaths.set(artifactId, capture.original_path); return capture.original_path; }
  const known = knownPaths.get(artifactId);
  if (known !== undefined) return known;
  throw new RebuildDataError(`commit ${manifest.sequence} projects artifact ${artifactId} with no known materialized path in this history`);
}

/** Adapts one canonical commit into the one `ProjectionManifest` `applyCommit` accepts. `null`
 *  only for a commit that names no artifact at all. COUPLED: exported alongside
 *  `classifyArtifact` as the projection policy rebuild and live replay both use. */
export function toProjectionManifest(
  manifest: RawCommitManifest, knownPaths: Map<string, string>,
  knownClasses: Map<string, ArtifactClass> = new Map(),
): ProjectionManifest | null {
  const artifactId = primaryArtifactId(manifest);
  if (artifactId === null) return null;
  return {
    owner_id: manifest.owner_id, artifact_id: artifactId,
    artifact_class: classifyArtifact(manifest, artifactId, knownClasses),
    current_path: currentPathFor(manifest, artifactId, knownPaths),
    sequence: manifest.sequence, transaction_id: manifest.transaction_id,
    audience: null, profile: null,
    revisions: manifest.revisions, events: manifest.events,
  };
}

// Replay

interface RebuildStats {
  readonly applied: number;
  readonly skipped: number;
  /** Same-batch `SourceArtifact`s whose `created` event landed in `zz.artifact_event` but that
   *  never got their own `zz.artifact` row — counted, so a caller reading "ready" still sees it. */
  readonly unprojectedSourceArtifacts: number;
}

function countUnprojectedSources(manifest: RawCommitManifest, primaryId: string): number {
  return manifest.events.filter((e) => e.kind === "created" && e.revision === null && e.artifact_id !== primaryId).length;
}

/** Replays `commits` (already ordered and verified by `readOrderedCommits`) into `client`, one
 *  `applyCommit` call per commit — never per artifact a commit also mentions, which would
 *  collide with `applyCommit`'s transaction_id-keyed idempotency. A thrown error from
 *  `applyCommit`/`ensureCorpus` propagates to `rebuildGeneration`, the one place that decides
 *  "blocked" versus "unavailable". */
async function replayCommits(
  client: ProjectionClient, ownerId: string, commits: readonly RawCommitManifest[],
): Promise<RebuildStats> {
  const knownPaths = new Map<string, string>();
  const knownClasses = new Map<string, ArtifactClass>();
  let applied = 0, skipped = 0, unprojectedSourceArtifacts = 0;
  for (const commit of commits) {
    if (commit.owner_id !== ownerId) {
      throw new RebuildDataError(`commit ${commit.sequence} belongs to owner ${commit.owner_id}, not ${ownerId} — refusing to project it into this owner's generation`);
    }
    const projection = toProjectionManifest(commit, knownPaths, knownClasses);
    if (projection === null) { skipped++; continue; }
    unprojectedSourceArtifacts += countUnprojectedSources(commit, projection.artifact_id);
    const result = await applyCommit(client, projection);
    if (result.applied) applied++; else skipped++;
  }
  return { applied, skipped, unprojectedSourceArtifacts };
}

// search/passage projection

interface SearchStats {
  readonly passages: number;
  readonly identifiers: number;
  readonly searchRows: number;
}

/** Populates `zz.artifact_passage`/`zz.artifact_identifier`/`zz.search_current` for a
 *  work_document or knowledge_concept's latest revision (`scope: "current"`), and
 *  `zz.search_evidence` for a source, which is immutable and never moves scope.
 *  `zz.search_history` is event-driven and not built here. `analyzed_text` equals `raw_text`:
 *  no analysis pass is stored here, so passages are correctly bounded and byte-safe but carry no
 *  analyzed form. `raw_body` carries the full body, never truncated. */
async function projectSearchAndPassages(
  client: ProjectionClient, corpusKey: string, manifest: ProjectionManifest,
): Promise<SearchStats> {
  const latest = manifest.revisions.reduce<ContentRevision | null>(
    (best, r) => (best === null || r.revision > best.revision ? r : best), null);
  if (!latest) return { passages: 0, identifiers: 0, searchRows: 0 };

  const scope: "current" | "evidence" = manifest.artifact_class === "source" ? "evidence" : "current";
  const table = scope === "current" ? "zz.search_current" : "zz.search_evidence";
  const passages = passagesOf(latest.payload.body);
  let passageCount = 0, identifierCount = 0;

  for (let ordinal = 0; ordinal < passages.length; ordinal++) {
    const p = passages[ordinal];
    const inserted = await client.query<{ id: number }>(
      `insert into zz.artifact_passage
         (owner_id, artifact_id, revision, scope, corpus_key, ordinal, byte_start, byte_end,
          raw_text, analyzed_text, analyzer_version)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9,$10)
       on conflict (owner_id, artifact_id, revision, scope, corpus_key, ordinal) do update set
         byte_start = excluded.byte_start, byte_end = excluded.byte_end,
         raw_text = excluded.raw_text, analyzed_text = excluded.analyzed_text
       returning id`,
      [manifest.owner_id, manifest.artifact_id, latest.revision, scope, corpusKey, ordinal,
       p.start, p.end, p.text, ANALYZER_NAME]);
    passageCount++;
    const passageId = inserted.rows[0]?.id;
    if (passageId === undefined) continue;
    await client.query("delete from zz.artifact_identifier where passage_id=$1", [passageId]);
    const identifiers = new Set<string>();
    for (const tag of latest.payload.tags) {
      for (const tok of identifierTokens(tag)) identifiers.add(tok);
    }
    for (const raw of identifiers) {
      await client.query(
        `insert into zz.artifact_identifier
           (owner_id, artifact_id, revision, scope, corpus_key, passage_id, identifier_text, normalized_text)
         values ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [manifest.owner_id, manifest.artifact_id, latest.revision, scope, corpusKey, passageId, raw, raw.toLowerCase()]);
      identifierCount++;
    }
  }

  const hash = semanticProjectionHash({
    owner_id: manifest.owner_id, artifact_id: manifest.artifact_id, artifact_class: manifest.artifact_class,
    revision: latest.revision, content_hash: latest.content_hash, payload: latest.payload,
  });
  await client.query(
    `insert into ${table}
       (corpus_key, owner_id, artifact_id, revision, content_hash, title, type, tags, path,
        raw_body, analyzer_version, projection_hash)
     values ($1,$2,$3,$4,$5,$6,$7,$8::text[],$9,$10,$11,$12)
     on conflict (corpus_key, owner_id, artifact_id) do update set
       revision = excluded.revision, content_hash = excluded.content_hash, title = excluded.title,
       type = excluded.type, tags = excluded.tags, path = excluded.path, raw_body = excluded.raw_body,
       analyzer_version = excluded.analyzer_version, projection_hash = excluded.projection_hash,
       updated_at = now()`,
    [corpusKey, manifest.owner_id, manifest.artifact_id, latest.revision, latest.content_hash,
     latest.payload.title, latest.payload.type, latest.payload.tags, manifest.current_path,
     latest.payload.body, ANALYZER_NAME, hash]);

  return { passages: passageCount, identifiers: identifierCount, searchRows: 1 };
}

// Orchestration: never activates anything, only verdicts one

interface RebuildRequest {
  readonly root: string;
  readonly ownerId: string;
  /** The corpus this owner's search rows partition under — which tenant or shelf this is, known
   *  only to the caller, the same reason `applyCommit`'s `docBridge`/`knowledgeBridge` are
   *  caller-supplied. Validated by `ensureCorpus`'s safe-partition-name check before any
   *  statement runs. */
  readonly corpusKey: string;
  readonly baselineWatermark: number;
  readonly client: ProjectionClient;
  readonly io?: RebuildIO;
}

type RebuildOutcome =
  | { readonly status: "blocked"; readonly reason: string }
  | { readonly status: "unavailable"; readonly reason: string }
  | { readonly status: "ready"; readonly stats: RebuildStats; readonly search: SearchStats };

/** The one entry point: availability, then chain integrity, then corpus provisioning, then
 *  replay, then search/passage projection, each gating the next. Returns a verdict on the
 *  isolated `client` it was handed; it never writes to, reads from, or knows about whatever
 *  generation is currently serving. */
export async function rebuildGeneration(request: RebuildRequest): Promise<RebuildOutcome> {
  const io = request.io ?? nodeRebuildIO;
  const availability = await checkStoreAvailability(request.root, io);
  if (!availability.available) return { status: "blocked", reason: availability.reason! };

  const ordered = await readOrderedCommits(request.root, request.baselineWatermark, io);
  if (!ordered.ok) return { status: "blocked", reason: `corrupt predecessor/blob chain: ${ordered.problems.join("; ")}` };

  try {
    await ensureCorpus(request.client, request.corpusKey);
    const stats = await replayCommits(request.client, request.ownerId, ordered.commits);
    let search: SearchStats = { passages: 0, identifiers: 0, searchRows: 0 };
    const knownPaths = new Map<string, string>();
    const knownClasses = new Map<string, ArtifactClass>();
    for (const commit of ordered.commits) {
      const projection = toProjectionManifest(commit, knownPaths, knownClasses);
      if (projection === null) continue;
      const s = await projectSearchAndPassages(request.client, request.corpusKey, projection);
      search = { passages: search.passages + s.passages, identifiers: search.identifiers + s.identifiers, searchRows: search.searchRows + s.searchRows };
    }
    return { status: "ready", stats, search };
  } catch (err) {
    if (err instanceof RebuildDataError) return { status: "blocked", reason: err.message };
    return { status: "unavailable", reason: `the isolated target database is unavailable — pending, never treated as an empty tenant: ${err instanceof Error ? err.message : String(err)}` };
  }
}

// Parity: proves the same canonical source reconstructs the same semantic projections

/** Every artifact's semantic hash in one generation, for comparing two independent rebuilds of
 *  the same canonical source — never two different sources. Reads `zz.artifact`/
 *  `zz.artifact_revision` back rather than trusting `replayCommits`'s own bookkeeping. */
export async function collectSemanticState(client: ProjectionClient, ownerId: string): Promise<Map<string, string>> {
  const rows = await client.query<{
    artifact_id: string; artifact_class: ArtifactClass; revision: number; content_hash: string; payload: unknown;
  }>(
    `select a.artifact_id, a.artifact_class, a.current_revision as revision, a.content_hash,
            r.payload
       from zz.artifact a
       left join zz.artifact_revision r
         on r.owner_id = a.owner_id and r.artifact_id = a.artifact_id and r.revision = a.current_revision
      where a.owner_id = $1`,
    [ownerId]);
  const state = new Map<string, string>();
  for (const row of rows.rows) {
    state.set(row.artifact_id, semanticProjectionHash({
      owner_id: ownerId, artifact_id: row.artifact_id, artifact_class: row.artifact_class,
      revision: row.revision, content_hash: row.content_hash, payload: row.payload,
    }));
  }
  return state;
}

interface ParityReport {
  readonly ok: boolean;
  readonly mismatched: readonly string[];
}

/** Two full builds of the same canonical source must agree on every artifact's semantic hash.
 *  `semanticProjectionHash`'s input type has no slot for an operational field, so one cannot be
 *  folded into semantic parity. */
export function compareGenerations(before: ReadonlyMap<string, string>, after: ReadonlyMap<string, string>): ParityReport {
  const mismatched = new Set<string>();
  for (const [id, hash] of before) if (after.get(id) !== hash) mismatched.add(id);
  for (const id of after.keys()) if (!before.has(id)) mismatched.add(id);
  return { ok: mismatched.size === 0, mismatched: [...mismatched] };
}
