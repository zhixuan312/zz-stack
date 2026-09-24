/**
 * Subject identity (FR-1): the one immutable `subject_version` every later stage binds to.
 *
 * `plugin_locate` is IDENTIFY for a catalog plugin. It resolves a catalog plugin's released
 * version, computes its whole-plugin content digest from the sorted digests of its own
 * components (skills, declared servers, the flow manifest itself — never the environment it
 * happens to run in), and upserts the immutable row `zz.eval_subject_version` is keyed on:
 * `(plugin_id, declared_version, content_digest)`. Calling it twice for a release whose content
 * has not moved returns the same `subject_version_id` — idempotent by construction, through the
 * unique constraint, and again through the FR-59 ledger this module is the first caller of.
 *
 * `plugin_register` is IDENTIFY for everything else (FR-2): a plugin the catalog has never
 * released, captured once from its own source directory rather than recomputed on every call —
 * there is no release to anchor a recompute to, so the row `plugin_register` writes is what
 * `plugin_locate` reads back for it afterwards, unchanged, rather than a second derivation that
 * could disagree with the first.
 *
 * DELIBERATE: both are mutators, unlike everything in plugin-eval.ts. They are the only places a
 * new subject version comes from, so the identity every later stage joins against exists before
 * anything asks for it a second time.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { manifestAt } from "@zz/catalog";
import { parseCaller } from "@zz/contracts";
import { requestHeaders, text } from "@zz/mcp-http";
import type pg from "pg";
import { z } from "zod";

import { entryOf, serversOf } from "./plugin-eval.js";
import { withIdempotency, type IdempotencyOutcome, type MutatorOutcome } from "./idempotency.js";
import { logActivity } from "../persist.js";
import { userRoot } from "../paths.js";
import { db } from "../platform-db.js";

const json = (v: unknown) => text(JSON.stringify(v, null, 2));
const noDb = () => text("ERROR: this deployment has no platform database, so no subject can be recorded");

/** One entry of `component_manifest`. `kind: "config"` is part of the declared shape for a
 *  component this catalog schema does not carry yet (deploy/environment declarations, say) —
 *  none is emitted today because nothing in `CatalogManifest` represents one. */
interface Component {
  readonly kind: "skill" | "server" | "flow" | "config";
  readonly name: string;
  readonly digest: string;
}

const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

/** The whole-plugin digest: sha256 over the SORTED per-component digests, never over an order a
 *  query happened to return them in — two locates of the same release must agree on this digest
 *  however their component rows came back. */
function combinedDigest(components: readonly Component[]): string {
  return sha256([...components.map((c) => c.digest)].sort().join("\n"));
}

/** Everything IDENTIFY needs about one released (plugin, version), resolved once before any
 *  write. Returns null for a plugin/version this platform never released — the caller turns
 *  that into the contract's exact refusal text; this function does no I/O beyond reading. */
async function resolveSubject(pool: pg.Pool, plugin: string, version: string | undefined): Promise<{
  pluginId: string; origin: string; declaredVersion: string; releasedDigest: string;
  components: Component[]; contentDigest: string;
  sourceLocator: Record<string, unknown>; releaseIdentity: Record<string, unknown>;
} | null> {
  // `$2::text is null` rather than two query strings: one text keeps the "latest release" and
  // "this exact release" paths from drifting apart the way plugin-eval.ts's old copy of this
  // query and this one already had, once, before this task merged them.
  const head = (await pool.query<{ plugin_id: string; origin: string; declared_version: string; digest: string }>(`
    select p.id::text as plugin_id, p.origin, pv.version as declared_version, pv.digest
      from zz.plugin p join zz.plugin_version pv on pv.plugin_id = p.id
     where p.name = $1 and ($2::text is null or pv.version = $2)
     order by pv.version desc limit 1`, [plugin, version ?? null])).rows[0];
  if (!head) return null;

  // A third party has no release to recompute against — plugin_register captured its
  // component set once, from the source directory it was given, and that capture is this
  // subject's whole identity. Recomputing here the way the catalog path does below would read
  // zz.plugin_version_skill (empty: a third party's skills never go through register-skills)
  // and the catalog manifest (absent by definition), landing on a digest that can never agree
  // with the one plugin_register wrote — the same plugin/version would then answer with two
  // different subject_version_id values depending on which tool minted the row first.
  if (head.origin === "third_party") {
    const captured = (await pool.query<{
      component_manifest: Component[]; content_digest: string;
      source_locator: Record<string, unknown>; release_identity: Record<string, unknown>;
    }>(`
      select component_manifest, content_digest, source_locator, release_identity
        from zz.eval_subject_version
       where plugin_id = $1::uuid and declared_version = $2
       order by captured_at desc limit 1`, [head.plugin_id, head.declared_version])).rows[0];
    // Registered but never captured should not happen — plugin_register writes zz.plugin_version
    // and zz.eval_subject_version in the same transaction — but a partial state is reported as
    // "never released" rather than crashing on a read that found nothing to return.
    if (!captured) return null;
    return {
      pluginId: head.plugin_id, origin: head.origin, declaredVersion: head.declared_version,
      releasedDigest: head.digest, components: captured.component_manifest,
      contentDigest: captured.content_digest, sourceLocator: captured.source_locator,
      releaseIdentity: captured.release_identity,
    };
  }

  const skills = (await pool.query<{ name: string; version: string; content_hash: string }>(`
    select s.name, sv.version, sv.content_hash
      from zz.plugin_version pv
      join zz.plugin p on p.id = pv.plugin_id
      join zz.plugin_version_skill pvs on pvs.plugin_version_id = pv.id
      join zz.skill_version sv on sv.id = pvs.skill_version_id
      join zz.skill s on s.id = sv.skill_id
     where p.name = $1 and pv.version = $2
     order by s.name`, [plugin, head.declared_version])).rows;

  const entry = entryOf(plugin);
  const components: Component[] = [
    ...skills.map((s): Component => ({
      kind: "skill", name: s.name,
      // A skill version's own content hash, never blank in practice (register-skills.ts always
      // writes one) — falling back to a hash of its identity rather than throwing, so a stray
      // pre-migration row cannot take IDENTIFY down for the whole plugin.
      digest: s.content_hash || sha256(`${s.name}@${s.version}`),
    })),
    ...serversOf(entry).map((sv): Component => ({
      kind: "server", name: sv.name, digest: sha256(`${sv.name}:${sv.path}`),
    })),
  ];
  if (entry) {
    // The manifest @zz/catalog already parsed and validated for us — `entryOf` runs through
    // `catalogEntries()`, which is @zz/catalog's own `manifestAt`. Hashing that object, never a
    // second raw read of flow.json off disk, is what keeps this the only reader a flow's
    // manifest has: catalog-manifest.ts's gate check refuses a second one.
    components.push({ kind: "flow", name: entry.flow, digest: sha256(JSON.stringify(entry.manifest)) });
  }

  return {
    pluginId: head.plugin_id, origin: head.origin, declaredVersion: head.declared_version,
    releasedDigest: head.digest, components, contentDigest: combinedDigest(components),
    sourceLocator: entry
      ? { kind: "catalog", owner: entry.owner, flow: entry.flow }
      : { kind: "unrecorded" },
    // FR-1's "immutable source/release identity" — what release.ts's own digest (written once,
    // at release, by register-plugins.ts) and this call's origin were at the moment this subject
    // version was captured. Not the content digest above: that is recomputed here and can differ
    // from the release-time one if a component's digest source changes under it, which is exactly
    // what a second locate is supposed to catch.
    releaseIdentity: { plugin_version_id: head.plugin_id, released_digest: head.digest, origin: head.origin },
  };
}

/** The `plugin_locate` response, read back from the row rather than re-derived — a replayed
 *  idempotent call and a freshly inserted one return through this one path, so the two can never
 *  disagree about the shape. */
async function subjectResponse(
  runner: Pick<pg.Pool, "query">, subjectVersionId: string,
): Promise<Record<string, unknown>> {
  const row = (await runner.query<{
    id: string; plugin: string; declared_version: string; content_digest: string;
    component_manifest: Component[]; release_identity: Record<string, unknown>;
    origin: string; owner_team: string | null; evolvable: boolean; release_owners: string[];
  }>(`
    select sv.id::text as id, p.name as plugin, sv.declared_version, sv.content_digest,
           sv.component_manifest, sv.release_identity,
           p.origin, p.owner_team, p.evolvable, p.release_owners
      from zz.eval_subject_version sv
      join zz.plugin p on p.id = sv.plugin_id
     where sv.id = $1::uuid`, [subjectVersionId])).rows[0];

  // The newest protocol version this plugin has, if any — FR-4/FR-5's protocol lineage has no
  // writer yet in this task's dependency scope (protocol_record is a later stage), so this reads
  // as null until it does. Not a compatibility check against `subject_compatibility`: that
  // reading is protocol_read's one job, and duplicating it here would give two answers to
  // "which protocol applies" from two different tools.
  const protocol = (await runner.query<{ id: string }>(`
    select epv.id::text as id
      from zz.eval_protocol_version epv
      join zz.eval_protocol ep on ep.id = epv.protocol_id
      join zz.plugin p on p.id = ep.plugin_id
     where p.name = $1
     order by epv.version desc limit 1`, [row.plugin])).rows[0];

  return {
    subject_version_id: row.id,
    plugin: row.plugin,
    declared_version: row.declared_version,
    content_digest: row.content_digest,
    component_manifest: row.component_manifest,
    release_identity: row.release_identity,
    origin: row.origin,
    owner_team: row.owner_team,
    evolvable: row.evolvable,
    release_owners: row.release_owners,
    // Ownership's own release track, not the per-initiative branch fact of the same name
    // FR-52/FR-58 has `release_prepare`/`proposal_prepare` write into `_facts.json` (Task I-27).
    // That later fact is read from THIS one: a subject with no release owners can never be
    // promoted (FR-47), so it is `proposal_only`; the reverse is `promotable`, contingent on
    // every later gate this initiative still has to pass. Never `not_applicable` here — that
    // value belongs to an initiative that never reached a release/proposal stage at all, which
    // is not a fact plugin_locate, called before any evaluation exists, can see.
    release_mode: row.release_owners.length > 0 ? "promotable" : "proposal_only",
    latest_compatible_protocol_version_id: protocol?.id ?? null,
    // What an evaluation may do with its findings follows from whose the plugin is — carried
    // over from plugin-eval.ts's pre-FR-1 plugin_locate, which this module replaces. Ours
    // (`origin = "platform"`): the findings feed a change somebody makes. A third party's
    // (`origin = "third_party"`): assess and stop, because a proposed change against a plugin we
    // do not own is a finding pretending to be an instruction (FR-51).
    origin_mode: row.origin === "third_party" ? "assess only" : "assess, then change",
  };
}

/** `plugin_register`'s `source_kind: "local_dir"` reader: every SKILL.md under the directory
 *  (or its own `skills/` subdirectory, the catalog's own convention, when it has one), plus
 *  whatever `flow.json` beside it declares — read straight off disk, never through the catalog
 *  or zz.skill_version, neither of which a third party ever has a row in.
 *
 *  Returns null for a directory with nothing to capture — no SKILL.md and no flow.json — which
 *  `plugin_register` turns into the contract's "source could not be read" refusal rather than
 *  minting a subject with an empty component set. */
function resolveLocalDir(path: string): { components: Component[] } | null {
  if (!existsSync(path) || !statSync(path).isDirectory()) return null;
  const skillsDir = existsSync(join(path, "skills")) ? join(path, "skills") : path;
  const components: Component[] = [];
  const walk = (d: string): void => {
    for (const f of readdirSync(d, { withFileTypes: true })) {
      const abs = join(d, f.name);
      if (f.isDirectory()) { walk(abs); continue; }
      if (f.name !== "SKILL.md") continue;
      // The digest is the file's own bytes, not a database row: a third party carries no
      // zz.skill_version, so there is no content_hash column to defer to the way the catalog
      // path does above.
      components.push({ kind: "skill", name: basename(dirname(abs)), digest: sha256(readFileSync(abs, "utf8")) });
    }
  };
  if (existsSync(skillsDir)) walk(skillsDir);

  const flowFile = join(path, "flow.json");
  if (existsSync(flowFile)) {
    const got = manifestAt(flowFile);
    if (got.manifest) {
      for (const sv of got.manifest.servers ?? []) {
        components.push({ kind: "server", name: sv.name, digest: sha256(`${sv.name}:${sv.path}`) });
      }
      components.push({
        kind: "flow", name: got.manifest.name ?? basename(path),
        digest: sha256(JSON.stringify(got.manifest)),
      });
    }
  }
  return components.length ? { components } : null;
}

/** `plugin_register`'s `source_kind: "git"` and `"package"` readers both shell out to a real
 *  binary (git / npm / tar) against a caller-controlled locator, so every call here goes through
 *  `tryExec`: argv arrays only, `--` ahead of the untrusted token so it can never be read as a
 *  flag, a bounded timeout and a bounded output buffer. Neither git nor npm caps how much they
 *  write to *disk*, so `directorySizeBytes` below is the actual backstop against an oversized or
 *  bombed fetch — the buffer limit only bounds what a command prints. */
const EXEC_TIMEOUT_MS = 120_000;
const MAX_EXEC_OUTPUT_BYTES = 16 * 1024 * 1024;
/** Generous for a plugin's own skills and servers, and still a real ceiling: a shallow git clone
 *  or an npm tarball this large is almost certainly the wrong repository/package, not a slow one. */
const MAX_SOURCE_BYTES = 200 * 1024 * 1024;

type ExecResult = { ok: true; output: string } | { ok: false; error: string };

/** One external command, run the way psql.ts's own `psqlText` does: no shell, so the locator can
 *  never be interpolated into anything a shell parses, and the caller decides what "failed"
 *  means for its own contract rather than this throwing past it. */
function tryExec(cmd: string, args: string[], cwd?: string): ExecResult {
  try {
    const output = execFileSync(cmd, args, {
      cwd, encoding: "utf8", timeout: EXEC_TIMEOUT_MS, maxBuffer: MAX_EXEC_OUTPUT_BYTES,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { ok: true, output };
  } catch (err) {
    const e = err as { stderr?: string; stdout?: string; message?: string; killed?: boolean; signal?: string };
    const timedOut = e.killed && e.signal ? ` (killed by ${e.signal} after ${EXEC_TIMEOUT_MS}ms)` : "";
    return { ok: false, error: `${(e.stderr || e.stdout || e.message || "unknown error").trim().slice(-500)}${timedOut}` };
  }
}

/** A temporary directory that is always removed, success or failure — `plugin_register`'s
 *  contract for `git`/`package` requires the clone/extract scratch space to be gone afterwards,
 *  whatever the outcome. */
function withTempDir<T>(prefix: string, fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The real size backstop (see the block comment above `EXEC_TIMEOUT_MS`): a recursive byte
 *  count of what git/tar actually put on disk, stopping early once it is already over `limit` —
 *  the caller only needs to know "too big", not the exact total for something it is about to
 *  refuse. Symlinks are skipped rather than followed, so a crafted entry cannot point back out
 *  of its own temporary directory and inflate — or escape — this count. */
function directorySizeBytes(dir: string, limit: number): number {
  let total = 0;
  const walk = (d: string): void => {
    for (const f of readdirSync(d, { withFileTypes: true })) {
      if (total > limit) return;
      if (f.isSymbolicLink()) continue;
      const abs = join(d, f.name);
      if (f.isDirectory()) { walk(abs); continue; }
      total += statSync(abs).size;
    }
  };
  walk(dir);
  return total;
}

const oversizeError = (limit: number) =>
  `the fetched source exceeds the ${Math.round(limit / (1024 * 1024))}MB size limit`;

type SourceResolution = { components: Component[]; identityExtra: Record<string, unknown> } | { error: string };

/** `source_kind: "git"`: `<url>` or `<url>#<ref>` — a branch, tag or commit. Cloned shallow
 *  (`--depth 1`) into a temporary directory, resolved exactly like `local_dir`, and the ref it
 *  actually landed on recorded as `resolved_commit` — the immutable half of FR-1's release
 *  identity for a source that itself is not immutable (a branch moves; the commit it named at
 *  capture time does not). */
function resolveGit(locator: string): SourceResolution {
  const hashAt = locator.lastIndexOf("#");
  const url = hashAt === -1 ? locator : locator.slice(0, hashAt);
  const ref = hashAt === -1 ? undefined : locator.slice(hashAt + 1) || undefined;
  if (!url) return { error: "no repository URL was given before '#'" };

  return withTempDir("zz-plugin-git-", (dir) => {
    // The fast path: a shallow clone of exactly the named branch/tag, or of the default branch
    // when no ref was given. `--` ends option parsing before the caller-controlled URL, so a
    // locator that happens to start with '-' is read as a repository name and never as a flag.
    const shallow = ref
      ? tryExec("git", ["clone", "--quiet", "--depth", "1", "--branch", ref, "--", url, dir])
      : tryExec("git", ["clone", "--quiet", "--depth", "1", "--", url, dir]);
    if (!shallow.ok) {
      if (!ref) return { error: shallow.error };
      // `--branch` only resolves refs the remote advertises (branches and tags), so a commit SHA
      // falls through to a full clone plus an explicit fetch of that one commit — still shallow
      // at the object it lands on, just not at the clone step.
      const full = tryExec("git", ["clone", "--quiet", "--", url, dir]);
      if (!full.ok) return { error: full.error };
      const fetch = tryExec("git", ["fetch", "--quiet", "--depth", "1", "--", "origin", ref], dir);
      if (!fetch.ok) return { error: `ref ${ref} could not be fetched: ${fetch.error}` };
      const checkout = tryExec("git", ["checkout", "--quiet", "FETCH_HEAD"], dir);
      if (!checkout.ok) return { error: checkout.error };
    }

    const size = directorySizeBytes(dir, MAX_SOURCE_BYTES);
    if (size > MAX_SOURCE_BYTES) return { error: oversizeError(MAX_SOURCE_BYTES) };

    const head = tryExec("git", ["rev-parse", "HEAD"], dir);
    if (!head.ok) return { error: head.error };

    const resolved = resolveLocalDir(dir);
    if (!resolved) return { error: "no SKILL.md and no flow.json were found in the cloned repository" };
    return { components: resolved.components, identityExtra: { resolved_commit: head.output.trim() } };
  });
}

/** `npm pack`'s own `--json` report for the tarball it just wrote — only the fields this reader
 *  uses, not the package's full manifest. */
interface NpmPackEntry {
  filename: string;
  integrity?: string;
  shasum?: string;
}

/** `source_kind: "package"`: an npm spec (`name@version`, same syntax `npm install` takes).
 *  Fetched with `npm pack` — never installed, so no `postinstall` script of the package's own
 *  runs — extracted into a temporary directory and resolved like `local_dir`. The tarball's own
 *  integrity hash is recorded, because a package version is otherwise mutable at the registry in
 *  a way a git commit is not: republishing the same `name@version` under `npm unpublish` +
 *  republish is rare but real, and the integrity is what makes a later locate notice it. */
function resolvePackage(spec: string): SourceResolution {
  return withTempDir("zz-plugin-package-", (dir) => {
    const pack = tryExec("npm", [
      "pack", "--json", "--pack-destination", dir, "--ignore-scripts", "--no-audit", "--no-fund", "--", spec,
    ]);
    if (!pack.ok) return { error: pack.error };

    let entries: NpmPackEntry[];
    try {
      entries = JSON.parse(pack.output) as NpmPackEntry[];
    } catch {
      return { error: "npm pack did not answer with the JSON it was asked for" };
    }
    const entry = entries[0];
    if (!entry?.filename) return { error: "npm pack produced no tarball" };

    const extracted = join(dir, "extracted");
    mkdirSync(extracted);
    // `--` here too: the tarball path is ours, not the caller's, but the rule is "argv arrays,
    // no shell interpolation of the locator" for this whole reader, applied uniformly rather
    // than only where the untrusted string happens to land.
    const untar = tryExec("tar", ["-xzf", join(dir, entry.filename), "-C", extracted]);
    if (!untar.ok) return { error: untar.error };

    const size = directorySizeBytes(extracted, MAX_SOURCE_BYTES);
    if (size > MAX_SOURCE_BYTES) return { error: oversizeError(MAX_SOURCE_BYTES) };

    // npm packs every tarball with its content under one top-level "package/" directory —
    // npm-packlist's own convention, not this platform's — resolved straight through on the rare
    // publisher whose tarball omits it.
    const root = existsSync(join(extracted, "package")) ? join(extracted, "package") : extracted;
    const resolved = resolveLocalDir(root);
    if (!resolved) return { error: "no SKILL.md and no flow.json were found in the package" };
    return {
      components: resolved.components,
      identityExtra: { tarball_integrity: entry.integrity ?? entry.shasum ?? null },
    };
  });
}

/** `plugin_register`'s three `source_kind` readers, behind one signature: `local_dir` reads the
 *  path as given (no fetch, no temporary directory, no size limit — it is already local and
 *  already the caller's own disk); `git` and `package` fetch first and clean up after
 *  themselves whatever the outcome. Every branch returns either components to capture or the
 *  contract's own `<reason>` half of `ERROR: source <locator> could not be read: <reason>`. */
function resolveSource(kind: "local_dir" | "git" | "package", locator: string): SourceResolution {
  if (kind === "local_dir") {
    const resolved = resolveLocalDir(locator);
    return resolved
      ? { components: resolved.components, identityExtra: {} }
      : { error: "no SKILL.md and no flow.json were found under this path" };
  }
  return kind === "git" ? resolveGit(locator) : resolvePackage(locator);
}

export function registerSubjectTools(server: McpServer): void {
  server.registerTool(
    "plugin_locate",
    {
      description:
        "WHEN an evaluation begins, before any other tool on this door: IDENTIFY the plugin it is " +
        "about. It RETURNS FR-1's immutable subject_version — declared version, whole-plugin " +
        "content digest, per-component manifest (skill/server/flow/config digests, never the " +
        "environment), ownership and its release mode, and the latest compatible protocol version " +
        "if one exists — with the SAME subject_version_id for the same release content, whichever " +
        "call minted the row. Every later tool takes the subject_version_id this returns, so an " +
        "evaluation cannot drift onto a different version of its own subject halfway through. A " +
        "mutator: it upserts zz.eval_subject_version through the FR-59 idempotency ledger, so a " +
        "retried call with the same idempotency_key replays rather than minting a second row. " +
        "REFUSES a plugin this platform has never released.",
      inputSchema: {
        plugin: z.string(),
        version: z.string().optional().describe("Omit for the newest released version."),
        idempotency_key: z.string().min(1),
      },
    },
    async ({ plugin, version, idempotency_key }) => {
      const pool = db();
      if (!pool) return noDb();

      const resolved = await resolveSubject(pool, plugin, version);
      if (!resolved) {
        return text(`ERROR: no plugin named ${plugin} is registered — plugin_register adds one that is not in the catalog`);
      }

      const principal = parseCaller(requestHeaders()).email;
      const outcome: IdempotencyOutcome<string> = await withIdempotency(
        principal, "plugin_locate", idempotency_key, { plugin, version },
        async (client): Promise<MutatorOutcome<string>> => {
          const row = (await client.query<{ id: string }>(`
            insert into zz.eval_subject_version
              (plugin_id, declared_version, content_digest, component_manifest, source_locator,
               release_identity, captured_at)
            values ($1::uuid, $2, $3, $4::jsonb, $5::jsonb, $6::jsonb, now())
            on conflict (plugin_id, declared_version, content_digest)
              -- A no-op write of the row onto itself: the conflict key already fixes every other
              -- column's value, so this exists only so the RETURNING clause below gives back the
              -- existing id rather than nothing, the same trick ruler_record uses on zz.rubric.
              do update set component_manifest = excluded.component_manifest
            returning id::text as id`,
            [resolved.pluginId, resolved.declaredVersion, resolved.contentDigest,
             JSON.stringify(resolved.components), JSON.stringify(resolved.sourceLocator),
             JSON.stringify(resolved.releaseIdentity)])).rows[0];
          // `result` carries the id on the fresh path — the only thing `subjectResponse` needs —
          // so both arms below read the id off a field `IdempotencyOutcome` actually has.
          return { result: row.id, result_table: "zz.eval_subject_version", result_id: row.id };
        },
      );
      const subjectVersionId = outcome.replayed ? outcome.result_id : outcome.result;

      logActivity(await userRoot(), null,
        { user: principal, action: "plugin_locate", plugin, version: resolved.declaredVersion,
          subject_version_id: subjectVersionId, replayed: outcome.replayed });

      return json(await subjectResponse(pool, subjectVersionId));
    },
  );

  server.registerTool(
    "plugin_register",
    {
      description:
        "WHEN a plugin needs to be evaluated and the catalog has never released it: IDENTIFY " +
        "it from its own source instead. It reads source_locator — for source_kind local_dir, " +
        "the directory's own SKILL.md files, declared servers and flow manifest; for git, a " +
        "repository URL (optionally '#ref') shallow-cloned and read the same way, with the " +
        "commit it landed on recorded; for package, an npm spec (name@version) fetched with " +
        "npm pack and read from its extracted tarball, with the tarball's own integrity " +
        "recorded — and RETURNS the same subject_version_id shape plugin_locate comes back with, so plugin_locate, " +
        "plugin_profile and plugin_conform all then work for this plugin with no catalog entry. " +
        "The row it captures is that subject's whole identity: unlike plugin_locate, a later " +
        "call for the same plugin/version reads this capture back rather than recomputing it, " +
        "because a third party has no release moment to recompute against. A mutator, through " +
        "the same FR-59 idempotency ledger plugin_locate uses. REFUSES a name the catalog " +
        "already owns — that plugin is registered by release, never by this tool — REFUSES a " +
        "payload naming origin, owner_team, evolvable or release_owners, since the platform " +
        "derives every authority field itself and never takes one as input, and REFUSES a " +
        "source_locator it cannot read.",
      inputSchema: {
        name: z.string(),
        version: z.string(),
        source_kind: z.enum(["local_dir", "git", "package"]),
        source_locator: z.string(),
        idempotency_key: z.string().min(1),
        // Not accepted — named here only so a caller that supplies one is not silently
        // stripped before the handler below can refuse it. See the contract's "authority
        // field" refusal.
        origin: z.unknown().optional(),
        owner_team: z.unknown().optional(),
        evolvable: z.unknown().optional(),
        release_owners: z.unknown().optional(),
      },
    },
    async ({ name, version, source_kind, source_locator, idempotency_key,
             origin, owner_team, evolvable, release_owners }) => {
      if (origin !== undefined || owner_team !== undefined || evolvable !== undefined
          || release_owners !== undefined) {
        return text("ERROR: origin/owner/evolvable/release_owners are derived by the platform, not supplied");
      }
      if (entryOf(name)) {
        return text(`ERROR: ${name} is a catalog plugin; it is registered by release`);
      }

      const pool = db();
      if (!pool) return noDb();

      // A name this platform once released and the catalog no longer carries is still the
      // catalog's to speak for — never flipped to third_party by a call that merely found the
      // entry gone, which `entryOf` above cannot see for a removed flow.
      const existing = (await pool.query<{ origin: string }>(
        `select origin from zz.plugin where name = $1`, [name])).rows[0];
      if (existing?.origin === "platform") {
        return text(`ERROR: ${name} is a catalog plugin; it is registered by release`);
      }

      // Ahead of withIdempotency, and so ahead of the ledger's own proceed/replay decision — a
      // replayed call re-clones/re-fetches only to have its result discarded below, the same
      // cost local_dir already paid to re-read a directory before this task. Moving the fetch
      // inside the ledger's transaction would mean holding a database connection open for a
      // multi-second git clone or npm pack, which is the worse trade.
      const resolved = resolveSource(source_kind, source_locator);
      if ("error" in resolved) {
        return text(`ERROR: source ${source_locator} could not be read: ${resolved.error}`);
      }
      const contentDigest = combinedDigest(resolved.components);

      const principal = parseCaller(requestHeaders()).email;
      const outcome: IdempotencyOutcome<string> = await withIdempotency(
        principal, "plugin_register", idempotency_key,
        { name, version, source_kind, source_locator },
        async (client): Promise<MutatorOutcome<string>> => {
          const pluginRow = (await client.query<{ id: string }>(`
            insert into zz.plugin (name, origin) values ($1, 'third_party')
            on conflict (name) do update set origin = excluded.origin
            returning id::text as id`, [name])).rows[0];
          await client.query(`
            insert into zz.plugin_version (plugin_id, version, digest)
            values ($1::uuid, $2, $3)
            on conflict (plugin_id, version) do update set digest = excluded.digest`,
            [pluginRow.id, version, contentDigest]);
          const row = (await client.query<{ id: string }>(`
            insert into zz.eval_subject_version
              (plugin_id, declared_version, content_digest, component_manifest, source_locator,
               release_identity, captured_at)
            values ($1::uuid, $2, $3, $4::jsonb, $5::jsonb, $6::jsonb, now())
            on conflict (plugin_id, declared_version, content_digest)
              do update set component_manifest = excluded.component_manifest
            returning id::text as id`,
            [pluginRow.id, version, contentDigest, JSON.stringify(resolved.components),
             JSON.stringify({ kind: source_kind, locator: source_locator }),
             JSON.stringify({ origin: "third_party", ...resolved.identityExtra })])).rows[0];
          return { result: row.id, result_table: "zz.eval_subject_version", result_id: row.id };
        },
      );
      const subjectVersionId = outcome.replayed ? outcome.result_id : outcome.result;

      logActivity(await userRoot(), null,
        { user: principal, action: "plugin_register", plugin: name, version,
          subject_version_id: subjectVersionId, replayed: outcome.replayed });

      return json(await subjectResponse(pool, subjectVersionId));
    },
  );
}
