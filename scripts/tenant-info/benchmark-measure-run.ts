/**
 * benchmark-measure-run.ts — the runner behind `benchmark --measure`: the database, the
 * preflight, and the two writes. The measurement itself is `benchmark-measure.ts`, which owns
 * no I/O so a probe can drive the identical code against a fake store.
 *
 * A benchmark report is structurally indistinguishable from a fabricated one, so the producer
 * must not reach the file unless every premise of the measurement was observed first. Each
 * preflight below is a premise, each failure names itself, and a failed preflight writes
 * nothing and exits nonzero — leaving `en/zh/mixed_recall_at_20` blocked in `evaluateTargets`.
 *
 * Two writes, and one of them is deliberately inside the checkout:
 *   · `<workspace>/benchmark-inputs/<profile>/measurements.json` goes through `safeWritePath`
 *     like every other tenant-info write. `assembleBenchmarkReport` loads that file and feeds
 *     its numbers to `evaluateTargets`.
 *   · `testing/tenant-info/benchmark-report.json` is where a measured run writes, of the same
 *     class as `testing/tenant-info/analyzer-opacity.golden.json`: a fixture a gate check
 *     reads, produced by a generator that fails rather than invent one. It is not committed,
 *     so `benchmark-report-slices.ts` finds nothing on disk, notes that its per-slice
 *     clauses did not run, and leaves the target blocked. It is the only write this
 *     repository's tooling makes inside its own checkout; `ZZ_TENANT_INFO_WORKSPACE` is still
 *     required and everything scratch still goes there.
 *
 * The runtime facts nobody may invent come from the environment, and their absence blocks:
 * `ZZ_TENANT_INFO_INDEX_GENERATION` (which projection generation is mounted — only the serving
 * process can say) and `ZZ_TENANT_INFO_CURSOR_KEY` (the deployment's HMAC key for provenance
 * cursors). A producer that made up either would put a fabricated value in a disclosed
 * response field.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import pg from "pg";

import { loadCorpusRegistry } from "../../services/zz-core/dist/tenant-info/corpus-registry.js";
import type { CorpusDescriptor, RetrievalClient } from "../../services/zz-core/dist/tenant-info/retrieval.js";

import { planCorpora } from "./inventory.ts";
import {
  VALID_GRADES, VALID_LANGUAGES, VALID_SPLITS, type JudgedQuery, type Qrel,
} from "./judged-dataset.ts";
import {
  buildReport, detectPooling, measureHeldOut, measurementsForTargets, MeasurementRefused,
  qualityInputFor, relevantRefsByQuery, selectHeldOut, SLICE_LANGUAGES,
  type Measurement, type SliceMeasurement,
} from "./benchmark-measure.ts";
import { safeWritePath } from "./workspace.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const REPORT_PATH = "testing/tenant-info/benchmark-report.json";

export interface MeasureReceipt {
  readonly verb: "benchmark";
  readonly step: "measure";
  readonly profile: "baseline" | "acceptance";
  readonly ran_at: string;
  readonly measured: boolean;
  /** Why the measurement could not be made, one premise per entry. Non-empty means no file was
   *  written and every quality target stays blocked. */
  readonly blocked_reasons: readonly string[];
  readonly report_path: string | null;
  readonly measurements_path: string | null;
  readonly route: string | null;
  readonly slices: Readonly<Record<string, { denominator: number; hits: number; recall_at_20: number }>> | null;
  readonly ok: boolean;
}

// The judged dataset, read from the committed bytes

/**
 * A row that did not narrow, named by file, line and field.
 *
 * Every field is checked rather than cast: a cast asserts the shape the caller asked for, so a
 * renamed or malformed field arrives in the measurement as a well-typed value — a query whose
 * `language` became `"english"` silently leaves the `en` slice, and the run reports a shrunken
 * denominator as a measurement rather than as a broken instrument. The rows under measurement
 * are the rows H1's signature is over.
 */
class DatasetRowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DatasetRowError";
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Every narrowing failure reads the same way: which file, which line, which field, and what
 *  was there instead. A reader fixes the row without opening the measurement. */
function rowFailure(relative: string, line: number, field: string, want: string, saw: unknown): never {
  throw new DatasetRowError(
    `${relative}:${line}: field "${field}" must be ${want}, got ${JSON.stringify(saw) ?? typeof saw}`,
  );
}

function stringField(row: Record<string, unknown>, field: string, relative: string, line: number): string {
  const value = row[field];
  if (typeof value !== "string" || value.trim() === "") rowFailure(relative, line, field, "a non-empty string", value);
  return value;
}

/**
 * One query row, narrowed rather than asserted.
 *
 * `language` and `split` are checked against `judged-dataset.ts`'s own vocabularies, not
 * against a spelling repeated here — those two decide which slice a case lands in and whether
 * it is held out at all, so a value outside the declared set must stop the run rather than
 * quietly shrink a denominator. `answerable` must be a real boolean: a truthy string would put
 * a no-answer case into the recall population.
 *
 * Read by the measurement: `id`, `category`, `language`, `split`, `answerable`, `query`,
 * `scopes`, `caller_fixture`. `family`, `query_mode` and `filters` are carried, not read, and
 * are narrowed only as far as the row shape declares them.
 */
function narrowQuery(row: unknown, relative: string, line: number): JudgedQuery {
  if (!isRecord(row)) rowFailure(relative, line, "(row)", "a JSON object", row);
  const language = stringField(row, "language", relative, line);
  if (!VALID_LANGUAGES.has(language)) {
    rowFailure(relative, line, "language", `one of ${[...VALID_LANGUAGES].join(", ")}`, language);
  }
  const split = stringField(row, "split", relative, line);
  if (!VALID_SPLITS.has(split)) rowFailure(relative, line, "split", `one of ${[...VALID_SPLITS].join(", ")}`, split);
  if (typeof row.answerable !== "boolean") rowFailure(relative, line, "answerable", "a boolean", row.answerable);
  if (!Array.isArray(row.scopes) || !row.scopes.every((s) => typeof s === "string")) {
    rowFailure(relative, line, "scopes", "an array of strings", row.scopes);
  }
  return {
    id: stringField(row, "id", relative, line),
    category: stringField(row, "category", relative, line),
    language,
    family: stringField(row, "family", relative, line),
    query: stringField(row, "query", relative, line),
    query_mode: stringField(row, "query_mode", relative, line),
    scopes: row.scopes,
    filters: row.filters,
    caller_fixture: stringField(row, "caller_fixture", relative, line),
    split,
    answerable: row.answerable,
  };
}

/** One judgment row. `grade` decides whether a ref counts toward recall at all, so it is
 *  checked against the declared grade set rather than accepted as an arbitrary number. */
function narrowQrel(row: unknown, relative: string, line: number): Qrel {
  if (!isRecord(row)) rowFailure(relative, line, "(row)", "a JSON object", row);
  if (typeof row.grade !== "number" || !VALID_GRADES.has(row.grade)) {
    rowFailure(relative, line, "grade", `one of ${[...VALID_GRADES].join(", ")}`, row.grade);
  }
  return {
    query_id: stringField(row, "query_id", relative, line),
    ref: stringField(row, "ref", relative, line),
    grade: row.grade,
    evidence: stringField(row, "evidence", relative, line),
    rationale: stringField(row, "rationale", relative, line),
    reviewer: stringField(row, "reviewer", relative, line),
  };
}

function readJsonl<T>(relative: string, narrow: (row: unknown, relative: string, line: number) => T): T[] {
  return readFileSync(join(repoRoot, relative), "utf8").trim().split("\n").map((text, index) => {
    const line = index + 1;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (err: unknown) {
      throw new DatasetRowError(`${relative}:${line}: not JSON — ${err instanceof Error ? err.message : String(err)}`);
    }
    return narrow(parsed, relative, line);
  });
}

/** The queries and qrels as committed. Read from disk rather than regenerated:
 *  `generateJudgedDataset` would produce the same rows, but the rows under measurement must be
 *  the ones the signature is over. */
function loadJudgedDataset(): { queries: JudgedQuery[]; qrels: Qrel[] } {
  return {
    queries: readJsonl("testing/tenant-info/queries.jsonl", narrowQuery),
    qrels: readJsonl("testing/tenant-info/qrels.jsonl", narrowQrel),
  };
}

// The preflight: every premise, named

const TABLES = [
  "zz.artifact", "zz.artifact_event", "zz.artifact_edge", "zz.artifact_identifier",
  "zz.search_current", "zz.search_evidence", "zz.search_history",
  "zz.search_current_default", "zz.search_evidence_default", "zz.search_history_default",
  "zz.artifact_projection_watermark",
];

interface Preflight {
  readonly blocked: string[];
  readonly topology: Record<string, unknown>;
  readonly registry: CorpusDescriptor[];
}

async function preflight(client: RetrievalClient, queries: readonly JudgedQuery[], qrels: readonly Qrel[]): Promise<Preflight> {
  const blocked: string[] = [];
  const topology: Record<string, unknown> = {};

  const { rows: version } = await client.query<{ version: string }>("select version() as version", []);
  topology.postgres = version[0]?.version ?? null;

  const { rows: extensions } = await client.query<{ extname: string; extversion: string }>(
    "select extname, extversion from pg_extension order by extname", []);
  topology.extensions = extensions;

 // The search projection tables
  const { rows: present } = await client.query<{ name: string }>(
    "select (n.nspname || '.' || c.relname) as name from pg_class c join pg_namespace n on n.oid = c.relnamespace "
    + "where n.nspname = 'zz' and c.relkind in ('r','p') and (n.nspname || '.' || c.relname) = any($1::text[])",
    [TABLES]);
  const have = new Set(present.map((r) => r.name));
  const missing = TABLES.filter((t) => !have.has(t));
  topology.tables_present = [...have].sort();
  if (missing.length > 0) {
    blocked.push(`the search projection tables are absent from this cluster: ${missing.join(", ")}`);
    // Nothing below can be asked of tables that do not exist.
    return { blocked, topology, registry: [] };
  }

  // A bm25 index, which is what the lexical lane's `to_bm25query` requires
  const { rows: bm25 } = await client.query<{ indexname: string }>(
    "select indexname from pg_indexes where schemaname = 'zz' and indexdef ilike '%using bm25%' order by indexname", []);
  topology.bm25_indexes = bm25.map((r) => r.indexname);
  if (bm25.length === 0) {
    blocked.push("no bm25 index exists in schema zz: the lexical lane's to_bm25query names an index that is "
      + "not there, so a measured recall would be a measurement of a missing index");
  }

  // Rows, per corpus, against the pinned plan
  const { rows: counts } = await client.query<{ scope: string; corpus_key: string; artifacts: string }>(
    "select 'current' as scope, corpus_key, count(distinct artifact_id)::text as artifacts from zz.search_current group by corpus_key "
    + "union all select 'evidence', corpus_key, count(distinct artifact_id)::text from zz.search_evidence group by corpus_key "
    + "union all select 'history', corpus_key, count(distinct artifact_id)::text from zz.search_history group by corpus_key", []);
  const observed: Record<string, number> = {};
  for (const row of counts) observed[row.corpus_key] = (observed[row.corpus_key] ?? 0) + Number(row.artifacts);
  const declared = planCorpora(1);
  topology.corpus_census = { declared, observed };
  for (const [corpus, plan] of Object.entries(declared)) {
    const actual = observed[corpus] ?? 0;
    if (actual !== plan.records) {
      blocked.push(`corpus "${corpus}" holds ${actual} artifacts against the pinned ${plan.records}: `
        + "a recall figure over a corpus that is not the pinned one is a figure about a different system");
    }
  }

  // The pinned artifacts the judgments point at
  const { answerable } = selectHeldOut(queries);
  const relevant = relevantRefsByQuery(qrels);
  const wanted = [...new Set(answerable.flatMap((q) => relevant.get(q.id) ?? []))];
  const { rows: found } = await client.query<{ locator: string }>(
    "select distinct regexp_replace(path, '^.*/', '') as locator from ("
    + "select path from zz.search_current union all select path from zz.search_evidence "
    + "union all select path from zz.search_history) p where regexp_replace(path, '^.*/', '') = any($1::text[])",
    [wanted]);
  const resolvable = new Set(found.map((r) => r.locator));
  topology.judged_artifacts = { wanted: wanted.length, resolvable: resolvable.size };
  if (resolvable.size !== wanted.length) {
    // The silent-zero guard. A judged fixture missing from the store under the name its qrel
    // gives it makes every query miss and all three slices read 0.00 — a failing measurement
    // that is really an unmade one.
    blocked.push(`${wanted.length - resolvable.size} of ${wanted.length} judged relevant artifacts are not `
      + "in the store under the locator their qrel names: recall could only be measured as zero, which would "
      + "report an unmade measurement as a failed one");
  }

  const registry = await loadCorpusRegistry(client);
  topology.registry = registry.map((e) => ({ corpus_key: e.corpus_key, scope: e.scope, audience: e.audience }));
  if (registry.length === 0) blocked.push("the corpus registry is empty: no corpus can be resolved for any caller");

  const { rows: watermarks } = await client.query<{ owner_id: string; head_sequence: string }>(
    "select owner_id::text as owner_id, head_sequence::text as head_sequence from zz.artifact_projection_watermark", []);
  topology.watermarks = watermarks;

  return { blocked, topology, registry };
}

// The run

/** `git rev-parse HEAD` with its exit code retained rather than swallowed, so the report's
 *  `command_exits` records what this run actually invoked and how it ended. */
function runCommand(command: string, args: readonly string[]): { command: string; exit: number; stdout: string } {
  try {
    const stdout = execFileSync(command, [...args], { cwd: repoRoot, encoding: "utf8" }).trim();
    return { command: [command, ...args].join(" "), exit: 0, stdout };
  } catch (err: unknown) {
    const status = err instanceof Error && "status" in err ? Number((err as { status: unknown }).status) : 1;
    return { command: [command, ...args].join(" "), exit: Number.isFinite(status) ? status : 1, stdout: "" };
  }
}

function refuse(profile: "baseline" | "acceptance", reasons: readonly string[]): MeasureReceipt {
  return {
    verb: "benchmark", step: "measure", profile, ran_at: new Date().toISOString(),
    measured: false, blocked_reasons: [...reasons],
    report_path: null, measurements_path: null, route: null, slices: null, ok: false,
  };
}

/**
 * Measures, or refuses and says why. The only path that writes a file is the one where every
 * preflight premise held and `measureHeldOut` returned three slices with positive denominators.
 */
export async function runMeasurement(
  workspaceReal: string, profile: "baseline" | "acceptance",
): Promise<MeasureReceipt> {
  const url = process.env.TEAM_DB_URL ?? process.env.DATABASE_URL;
  const generation = process.env.ZZ_TENANT_INFO_INDEX_GENERATION;
  const cursorKey = process.env.ZZ_TENANT_INFO_CURSOR_KEY;
  const missing: string[] = [];
  if (!url) missing.push("no TEAM_DB_URL / DATABASE_URL in the environment: there is no deployment to measure");
  if (!generation) {
    missing.push("ZZ_TENANT_INFO_INDEX_GENERATION is not set: nothing in the schema records which projection "
      + "generation is mounted, so only the operator can say and this producer will not invent one");
  }
  if (!cursorKey) {
    missing.push("ZZ_TENANT_INFO_CURSOR_KEY is not set: provenance cursors are signed with the deployment's own "
      + "key, and a made-up key would emit cursors no deployment will honour");
  }
  if (missing.length > 0) return refuse(profile, missing);

  const pool = new pg.Pool({ connectionString: url, max: 2 });
  const client: RetrievalClient = {
    query: async <T>(text: string, params: readonly unknown[] = []) =>
      ({ rows: (await pool.query(text, [...params])).rows as T[] }),
  };

  const exits = [runCommand("git", ["rev-parse", "HEAD"])];
  try {
    // A malformed row is a refusal, not an exception that escapes. Left to propagate it reaches
    // `cli.ts`'s catch-all and exits 2 as INVALID_ARGUMENTS, telling an operator their command
    // was wrong when what was wrong was the committed dataset. The reason names the file, the
    // line and the field to fix.
    let queries: readonly JudgedQuery[];
    let qrels: readonly Qrel[];
    try {
      ({ queries, qrels } = loadJudgedDataset());
    } catch (err: unknown) {
      if (err instanceof DatasetRowError) {
        return refuse(profile, [`the judged dataset does not narrow, so nothing may be measured against it: ${err.message}`]);
      }
      throw err;
    }

    // A database that cannot be reached is a blocked measurement, not a broken invocation.
    // Left to propagate, a refused connection reaches `cli.ts`'s catch-all, is relabelled
    // INVALID_ARGUMENTS and exits 2. It is caught here and named alongside every other unmet
    // premise, so the receipt reads the same whichever premise failed.
    let flight: Preflight;
    try {
      flight = await preflight(client, queries, qrels);
    } catch (err: unknown) {
      return refuse(profile, [`the deployment could not be inspected: ${err instanceof Error ? err.message : String(err)}`]);
    }
    if (flight.blocked.length > 0) return refuse(profile, flight.blocked);

    let measurement: Measurement;
    try {
      measurement = await measureHeldOut(client, queries, qrels, {
        runtime: { index_generation: generation!, cursor_key: cursorKey!, caller_id: "benchmark-measure" },
      }, flight.registry);
    } catch (err: unknown) {
      if (err instanceof MeasurementRefused) return refuse(profile, err.reasons);
      throw err;
    }

    // A slice with no denominator is not a zero. Nothing is written when one is empty: the
    // target stays blocked and the reason says which slice never got sampled.
    const ordered: SliceMeasurement[] = SLICE_LANGUAGES.map((language) => measurement.slices[language]);
    const empty = ordered.filter((s) => s === undefined || s.denominator === 0);
    if (empty.length > 0) {
      return refuse(profile, SLICE_LANGUAGES
        .filter((language) => { const s = measurement.slices[language]; return s === undefined || s.denominator === 0; })
        .map((language) => `the ${language} slice has a denominator of 0: it was never sampled`));
    }

    // Verified at the boundary that writes the file, the same shape the `baseline` verb uses
    // before it emits an exit code. `measurement.pooled` was computed inside `measureHeldOut`;
    // recomputing it here from the slices about to be serialised means the file cannot carry a
    // `pooled: false` that the numbers beside it do not support.
    const recomputed = detectPooling(ordered);
    if (recomputed.pooled !== measurement.pooled || recomputed.pooled) {
      return refuse(profile, recomputed.pooled
        ? recomputed.evidence
        : ["the pooling observation recomputed at the write boundary disagrees with the one measured"]);
    }

    // An unverified route refuses before any write, not after. `measurements.json` carries the
    // numbers and none of their provenance, and every later plain `benchmark --profile
    // acceptance` loads it and turns them into `observed` values in the official report — so a
    // figure produced off a path nobody could verify would arrive there with nothing saying
    // so.
    if (measurement.route !== "public_handler") {
      return refuse(profile, [`the measurement did not travel the public handler and serializer: ${measurement.route}`]);
    }

    const report = buildReport({
      measurement,
      // Which build was under measurement is the profile the operator invoked, not something
      // this code can observe: `baseline` measures the preserved baseline image, `acceptance`
      // the candidate build.
      run: profile === "baseline" ? "baseline" : "candidate",
      topology: flight.topology,
      command_exits: exits.map((e) => ({ command: e.command, exit: e.exit })),
      bindings: {
        checkout_sha: exits[0].exit === 0 ? exits[0].stdout : null,
        index_generation: generation,
        profile,
      },
      generated_by: `npm run tenant-info -- benchmark --profile ${profile} --measure`,
    });

    writeFileSync(join(repoRoot, REPORT_PATH), `${JSON.stringify(report, null, 2)}\n`);

    const inputDir = safeWritePath(workspaceReal, "benchmark-inputs", profile);
    mkdirSync(inputDir, { recursive: true });
    const measurementsPath = safeWritePath(workspaceReal, "benchmark-inputs", profile, "measurements.json");
    writeFileSync(measurementsPath, `${JSON.stringify(measurementsForTargets(measurement), null, 2)}\n`);
    // Both inputs or neither. `assembleBenchmarkReport` fills its targets from the first file
    // and its `quality.slices` from this one, and nothing cross-checks them — a report carrying
    // an observed recall beside a slice that says it was never sampled is incoherent.
    writeFileSync(safeWritePath(workspaceReal, "benchmark-inputs", profile, "quality.json"),
      `${JSON.stringify(qualityInputFor(measurement), null, 2)}\n`);

    const slices: Record<string, { denominator: number; hits: number; recall_at_20: number }> = {};
    for (const slice of ordered) {
      slices[slice.language] = { denominator: slice.denominator, hits: slice.hits, recall_at_20: slice.recall_at_20 };
    }
    return {
      verb: "benchmark", step: "measure", profile, ran_at: new Date().toISOString(),
      measured: true, blocked_reasons: [],
      report_path: REPORT_PATH,
      measurements_path: `benchmark-inputs/${profile}/measurements.json`,
      route: measurement.route, slices,
      // `ok` is not "the command ran": the two ways it could be false have already refused
      // above, before a byte was written. This is the boundary restating them.
      ok: measurement.route === "public_handler" && !measurement.pooled,
    };
  } finally {
    await pool.end();
  }
}
