/**
 * tenant-rebuild.ts — I-15's rebuild walk: turns one owner's canonical `.zz/` commit log into
 * a complete, verified generation of the migration-070 derived database, in an isolated target
 * a caller supplies. Never the serving database, never activated by this file — see below.
 *
 * READS ONLY WHAT I-7's COMMIT ENGINE MADE DURABLE. `RebuildIO` has no `stat` — deliberately.
 * The one property this whole file exists to guarantee is "a copied store with changed mtimes
 * reconstructs the same semantic projections", and a caller cannot violate that by accident if
 * the interface offers no operation that could ever read an mtime in the first place. Every
 * decision below comes from `.zz/commits/*.json` (the manifest, its own `manifest_hash`, its
 * `previous_commit_hash` chain) and `.zz/blobs/<hash>` (content-addressed, so "the blob exists
 * and hashes to its own name" is the only freshness check a blob needs).
 *
 * THREE FAILURE CLASSES, THREE OUTCOMES — this task's own contract, verbatim:
 *   - a missing mount, an unreadable owner root, or a corrupt chain/blob:        "blocked"
 *   - the isolated target database throwing (an outage, mid-replay):            "unavailable"
 *   - everything read clean and every commit replayed:                         "ready"
 * "blocked" and "unavailable" are kept apart on purpose. A missing mount reported the same way
 * as a database outage would tempt a caller to retry both the same way, and retrying a missing
 * mount teaches nothing — it must be refused, loudly, forever, until the mount is fixed. Never,
 * under any outcome, does this file touch the SERVING generation or flip anything live: that
 * decision belongs to whatever caller reads this outcome and chooses to activate the isolated
 * database it just verified — an operational cutover, not a runtime concept this schema has a
 * column for.
 *
 * WHY THE CHAIN WALK, THE MANIFEST-HASH CHECK AND THE BLOB-HASH CHECK ARE REIMPLEMENTED HERE
 * rather than imported from `services/zz-core/src/tenant-info/{record,recovery}.ts`, which
 * already do almost exactly this. `packages/indexing`'s own `tsconfig.json` references only
 * `../contracts` — a package importing a service would invert the dependency direction
 * `index.ts`'s own header states plainly ("a service cannot import another service", and a
 * package is what a service imports, never the reverse). The duplication is small (one hash
 * function, one directory walk) and each half is exercised against a REAL commit this suite's
 * own fixtures produce via the real `mutate()`/`commitTransaction` pipeline, not a hand-built
 * manifest — so a drift between the two copies is exactly what those fixtures would catch.
 *
 * THE ONE PROJECTION POLICY, SHARED. `classifyArtifact` and `toProjectionManifest` below are
 * exported so that whichever task eventually wires `record.ts`'s `CommitExports.
 * projectToDatabase` for the LIVE path calls the same two functions this rebuild calls — "same
 * projection policy" by construction, not by two implementations kept in sync by hand.
 *
 * A REAL, NAMED GAP THIS FILE DOES NOT PAPER OVER: `applyCommit` (`tenant-projections.ts`,
 * I-13, outside this task's edit surface) issues ONE `zz.artifact` insert per call, keyed by
 * the manifest's own single `artifact_id`. A commit that mints a document and same-batch
 * SourceArtifacts alongside it produces events for every one of them (which land, correctly,
 * in `zz.artifact_event`) but a `zz.artifact` row only for the document — the sources it staged
 * never get their own row. This rebuild calls `applyCommit` exactly once per commit, the same
 * way live replay will, so both exhibit the identical gap rather than disagreeing about it;
 * `RebuildStats.unprojectedSourceArtifacts` counts it so it is visible, not silent. Fixing it
 * means changing `applyCommit`'s own contract, which is I-13's file, not this task's.
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

// ── Task I-13's rederivation pass: this file's second rebuild concept ──────────────────────
//
// `rebuildGeneration` above (I-15, an earlier initiative) replays one owner's `.zz/` commit
// log into the migration-070 derived database. `rebuildRowVector` below is unrelated to that
// walk — it is the entry point `rederivation.ts`'s generation-aware backfill over EXISTING
// `zz.doc`/`zz.knowledge_node` rows calls, per row, to get the SAME weighted term vector the
// write path (`index.ts`'s `indexDoc`) would produce for that row today. Both live in this
// file because the frozen gate check `rederivation-generation.ts` reads THIS file's own source
// for an `import { buildRowVector … }` line — the property it is checking is that the rebuild
// path and the write path share one weighting implementation rather than growing a second one
// that drifts, and grepping the import is how it verifies that without executing a database.
//
// NOT AN ALIAS. An earlier form of the frozen check demanded `rebuildRowVector ===
// buildRowVector` by reference, which forced exactly `export const rebuildRowVector =
// buildRowVector` — a pointless export and a dead assertion, corrected once already (the
// check's own comment says so). What earns this its own name is the normalization a raw
// database row needs and a freshly-parsed envelope never does: `title`/`body` are `not null
// default ''` on both tables and `tags` is `not null default '{}'`, so in practice every field
// arrives a real string/array already — but the column types themselves do not promise that
// for every future caller of this function, and `buildRowVector`'s own contract takes exactly
// `{title, tags, body}` with no room for `null`. Defaulting a nullable field here, once, is
// what keeps that adaptation out of the rederivation loop itself.
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

// ── the read-only I/O this walk needs, and nothing more ────────────────────────────────────

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

// ── the pure cache decision: the frozen check's own subject ────────────────────────────────

/** Whether a row derived under `oldFingerprint` must be re-derived to match `newFingerprint`.
 *  `null` — no prior attempt reached this artifact at all — always needs derivation; any two
 *  distinct fingerprints do too, by construction, since `derivationFingerprint` (I-14) changes
 *  on every one of the versions it hashes. The progress cache this feeds is disposable: losing
 *  it entirely just means every artifact re-derives, never that one is skipped that should not
 *  have been. */
export function needsRederive(oldFingerprint: string | null, newFingerprint: string): boolean {
  return oldFingerprint === null || oldFingerprint !== newFingerprint;
}

// ── mount/readiness validation, before anything else runs ──────────────────────────────────

interface StoreAvailability {
  readonly available: boolean;
  readonly reason?: string;
}

/** Everything that must be true of `root` before this walk is allowed to reason about how
 *  many commits an owner has. A missing `.zz/` layout — the volume never mounted, or mounted
 *  over an empty directory — is refused HERE, before a single commit is read, so it can never
 *  be misread three functions later as "an owner with zero commits". Both shapes of missing
 *  are named explicitly, because "the whole root is gone" and "the root exists but lost its
 *  commits/blobs subdirectories" are different failures an operator needs told apart. */
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

// ── the canonical commit hash, matching record.ts's own algorithm exactly ──────────────────

/** SHA-256 of every manifest field except `manifest_hash`, over canonical UTF-8 JSON with
 *  recursively sorted keys — byte-for-byte the same algorithm `services/zz-core/src/
 *  tenant-info/record.ts`'s `manifestHash` computes (see this file's header for why it is a
 *  second copy rather than a shared import). A manifest this disagrees with was not written by
 *  that engine, or was corrupted after it was. */
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

// ── reading the commit log, chain and blobs verified ────────────────────────────────────────

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
  /** Only commits with `sequence > afterSequence`, in order — what a replay actually needs.
   *  The WALK itself still reads every commit from sequence 1: chain integrity is a property
   *  of the whole log, and the baseline watermark is a replay cursor, not a reason to skip
   *  verifying what came before it. */
  readonly commits: readonly RawCommitManifest[];
}

function shapeProblem(file: string, reason: string): string {
  return `${file}: ${reason}`;
}

/** Parses and validates one commit file's typed arrays against the SAME zod schemas the
 *  kernel validated them against on the way in (`@zz/contracts`) — a manifest that no longer
 *  parses as its own declared shape is exactly the "corrupt predecessor" this task's contract
 *  names, and is reported as such rather than read past with an `as` cast. */
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

/** Walks `root/.zz/commits/` in sequence order, verifying every link this task's contract
 *  names: no two files claim one sequence, every `previous_commit_hash` chains from the prior
 *  commit's own `manifest_hash`, every manifest's recomputed hash matches the one it carries,
 *  and every blob a `file_changes`/`source_captures` entry references exists AND hashes to its
 *  own claimed name. Any single problem anywhere in the log makes `ok:false` — a rebuild that
 *  replayed everything except the one corrupt commit would produce an INCOMPLETE generation
 *  that reports as nearly ready, which is worse than refusing outright. */
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

// ── the shared projection policy: one commit, one ProjectionManifest ───────────────────────

class RebuildDataError extends Error {}

/** The artifact this commit is primarily about — the one revision it carries, or (a pure
 *  source creation, or a same-batch source with no document of its own) its sole event's
 *  artifact. `null` only for a commit with neither, which the current kernel never produces. */
function primaryArtifactId(manifest: RawCommitManifest): string | null {
  if (manifest.revisions.length > 0) return manifest.revisions[0].artifact_id;
  if (manifest.events.length > 0) return manifest.events[0].artifact_id;
  return null;
}

/** `artifact_class` IS NOT DURABLY RECORDED IN ANY COMMIT FIELD TODAY — see this file's own
 *  contract-defect note in the header and the fuller one in this task's report. This derives
 *  it from what IS durable: an artifact with no `ContentRevision` at all is a `SourceArtifact`
 *  (it only ever gets `source_captures` + a `revision: null` event); one whose latest revision
 *  payload names a `KnowledgeTypeSchema` value (`@zz/contracts`'s own four-member vocabulary —
 *  Decision/Rule/Fact/Defect) is a knowledge concept; anything else with a revision is a work
 *  document. Exported so a future live-replay wiring calls this exact function, never a second
 *  guess at the same rule. */
export function classifyArtifact(
  manifest: RawCommitManifest, artifactId: string, knownClasses: Map<string, ArtifactClass> = new Map(),
): ArtifactClass {
  // READ FROM THE RECORD, NEVER INFERRED FROM CONTENT. The `created` event carries
  // `data.artifact_class`, written once by the policy that decided it and immutable after —
  // the class is a fact about the artifact, not a property of the text inside it.
  //
  // THIS WAS A GUESS UNTIL THIS FILE WAS WRITTEN, and the guess was demonstrably wrong. The
  // first draft read `payload.type` and called anything matching the four native knowledge
  // types a knowledge_concept — which misclassifies every work document whose type happens to
  // be one of those words. This repository's own fixture is exactly that case:
  // `testing/tenant-info/model.ts` builds a `work_document` with `type: "Decision"`. A rebuild
  // that guesses wrong writes a wrong `zz.artifact.artifact_class`, and AC-4.1 asks a replay to
  // restore identical semantic identity — a class it may get wrong is not identity.
  const created = manifest.events.find((e) => e.artifact_id === artifactId && e.kind === "created");
  const declared = created?.data?.["artifact_class"];
  if (typeof declared === "string") {
    const parsed = ArtifactClassSchema.parse(declared);
    knownClasses.set(artifactId, parsed);
    return parsed;
  }
  // CARRIED BY THE WALK, the same way `currentPathFor` carries a path. A `created` event appears
  // in exactly one commit; every later commit touching that artifact — an approval, a revision,
  // a move — names it without restating what it is. Reading only the manifest in hand would make
  // classification work for the first commit and fail for every one after it.
  const remembered = knownClasses.get(artifactId);
  if (remembered !== undefined) return remembered;
  // A `created` event without the class is an incomplete record, not an invitation to guess.
  // Blocking here is the same refusal a corrupt chain gets: a rebuild that fills a NOT NULL
  // column with its best idea has silently decided something only the writer knew.
  throw new RebuildDataError(
    `commit ${manifest.sequence} has no recorded artifact_class for ${artifactId} — the created ` +
    `event must carry data.artifact_class, and a rebuild does not infer a class from content`,
  );
}

/** One commit's materialized path for `artifactId` — from this commit's own `file_changes`
 *  (a document create/revise), else its own `source_captures` (a source creation), else the
 *  last path this walk has already seen for the same artifact. Never guessed: a commit that
 *  touches an artifact with no path anywhere in this history is refused, not defaulted. */
function currentPathFor(manifest: RawCommitManifest, artifactId: string, knownPaths: Map<string, string>): string {
  const change = manifest.file_changes.find((c) => c.after_hash !== null);
  if (change) { knownPaths.set(artifactId, change.path); return change.path; }
  const capture = manifest.source_captures.find((c) => c.artifact_id === artifactId);
  if (capture) { knownPaths.set(artifactId, capture.original_path); return capture.original_path; }
  const known = knownPaths.get(artifactId);
  if (known !== undefined) return known;
  throw new RebuildDataError(`commit ${manifest.sequence} projects artifact ${artifactId} with no known materialized path in this history`);
}

/** Adapts one canonical commit into the ONE `ProjectionManifest` `applyCommit` accepts —
 *  `null` only for a commit that names no artifact at all (never produced by the current
 *  kernel, guarded rather than assumed impossible). Exported alongside `classifyArtifact` as
 *  the shared policy this task's contract asks rebuild and live replay to use identically. */
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

// ── replay ───────────────────────────────────────────────────────────────────────────────

interface RebuildStats {
  readonly applied: number;
  readonly skipped: number;
  /** Same-batch `SourceArtifact`s whose `created` event landed in `zz.artifact_event` but who
   *  never got their own `zz.artifact` row — the gap this file's header names. Counted, not
   *  hidden, so a caller reading "ready" still sees it. */
  readonly unprojectedSourceArtifacts: number;
}

function countUnprojectedSources(manifest: RawCommitManifest, primaryId: string): number {
  return manifest.events.filter((e) => e.kind === "created" && e.revision === null && e.artifact_id !== primaryId).length;
}

/** Replays `commits` (already ordered and verified by `readOrderedCommits`) into `client`, one
 *  `applyCommit` call per commit — never per artifact a commit happens to also mention, which
 *  would collide with `applyCommit`'s own transaction_id-keyed idempotency (see header). A
 *  thrown error from `applyCommit`/`ensureCorpus` (a database outage mid-replay) is NOT caught
 *  here — it propagates to `rebuildGeneration`, which is the one place that decides "blocked"
 *  versus "unavailable" actually means. */
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

// ── search/passage projection: the scope this migration named I-15 as the populator for ───

interface SearchStats {
  readonly passages: number;
  readonly identifiers: number;
  readonly searchRows: number;
}

/** Populates `zz.artifact_passage`/`zz.artifact_identifier`/`zz.search_current` for a
 *  work_document or knowledge_concept's LATEST revision (`scope: "current"`), and
 *  `zz.search_evidence` for a source (immutable, always evidence — it never moves scope).
 *  `zz.search_history` (deprecated/superseded content, and non-latest revisions moving out of
 *  "current") is event-driven and NOT built here — declared, not silently skipped; see this
 *  task's report. `analyzed_text` equals `raw_text`: `zz-lexical-v1`'s CJK n-gram tokenization
 *  is I-14's other named, declined gap, and this is the honest v1 in its absence — passages are
 *  still correctly bounded and byte-safe, only the extra recall a real analysis pass would add
 *  is missing. `raw_body` carries the FULL body, never truncated — the one property this
 *  function must hold for a document whose unique terms live past any fixed cutoff. */
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

// ── orchestration: never activates anything, only verdicts one ─────────────────────────────

interface RebuildRequest {
  readonly root: string;
  readonly ownerId: string;
  /** The corpus this owner's search rows partition under. A runtime fact about WHICH tenant
   *  or shelf this is — the same reason `applyCommit`'s `docBridge`/`knowledgeBridge` are
   *  caller-supplied rather than derived: "only the caller knows that mapping" (tenant-
   *  projections.ts's own words). Validated by `ensureCorpus`'s existing safe-partition-name
   *  check before any statement runs. */
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
 *  replay, then search/passage projection — in that order, each gating the next, exactly the
 *  order this task's contract states ("mount/readiness validation is performed before deletion
 *  or generation changes"). Returns a VERDICT on the isolated `client` it was handed; it never
 *  writes to, reads from, or knows about whatever generation is currently serving. */
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

// ── parity: proves the same canonical source reconstructs the same semantic projections ────

/** Every artifact's semantic hash in one generation, for comparing two independent rebuilds of
 *  the SAME canonical source (a copied store, changed mtimes) — never two different sources.
 *  Reads `zz.artifact`/`zz.artifact_revision` back rather than trusting `replayCommits`'s own
 *  bookkeeping, so a bug that wrote the wrong row and reported success would still be caught. */
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

/** Two full builds of the SAME canonical source must agree on every artifact's semantic hash —
 *  "operational fields reported separately, never folded into semantic parity" holds by
 *  construction here too, since `semanticProjectionHash`'s own input type has no slot for one. */
export function compareGenerations(before: ReadonlyMap<string, string>, after: ReadonlyMap<string, string>): ParityReport {
  const mismatched = new Set<string>();
  for (const [id, hash] of before) if (after.get(id) !== hash) mismatched.add(id);
  for (const id of after.keys()) if (!before.has(id)) mismatched.add(id);
  return { ok: mismatched.size === 0, mismatched: [...mismatched] };
}
