/**
 * The execution half of the benchmark: runs the held-out queries and counts what came back.
 * `benchmark-report.ts` assembles and validates a report and measures nothing.
 *
 * It calls the public path, not SQL and not a ranker. Every measured query goes through
 * `searchTenantInformation` (services/zz-core/src/tenant-info/search.ts), which composes
 * `parseQuery` → `loadCorpusRegistry` → `resolveCorpora` → `search()` (four lanes and RRF) →
 * hydration → `matchesArtifact` → `serializeResults`; what is counted is the string
 * `serializeResults` emitted, parsed back through the published `SearchResponseSchema`. Nothing
 * here imports a lane, a scorer or a table name. `knowledge_search` is not that path: it reads
 * `zz.doc`/`zz.knowledge_node`, a different store from the tenant-information corpora.
 *
 * COUPLED: `benchmark-report.ts` binds this module by hash (`search_module_sha256`).
 *
 * What it answers: slices, denominators, a binary `Recall@20` per query, and whether the three
 * language populations stayed separate. Whether a call travelled the public path is
 * `benchmark-route.ts`'s question, and a route fault means the numbers must not be read at all.
 *
 * `pooled` is an observation, never a literal: earned by recomputing each slice's ratio from
 * its own recorded per-query outcomes and checking the three slices are disjoint.
 *
 * Nothing here reads or writes a file, so the probe can drive the same code against a fake
 * store. The runner (`benchmark-measure-run.ts`) owns the database, the preflight and the two
 * writes.
 */
import { SearchResponseSchema } from "../../packages/contracts/dist/index.js";
import type { CorpusDescriptor, RetrievalClient } from "../../services/zz-core/dist/tenant-info/retrieval.js";
import {
  searchTenantInformation, type TenantSearchContext, type TenantSearchRequest,
} from "../../services/zz-core/dist/tenant-info/search.js";

import { RELEASE_TARGETS } from "./benchmark.ts";
import { computeRoute, instrument, observeRoute, type RouteObservation } from "./benchmark-route.ts";
import { ISOLATION_CATEGORY, type JudgedQuery, type Qrel } from "./judged-dataset.ts";

/** The k in `Recall@20`, and the request limit that produces it. Both are 20, read off the
 *  target key `recall_at_20` in `benchmark.ts` rather than restated as policy here. */
const DISPLAYED_AT_K = 20;

/** The three held-out language slices, in the order a report prints them. Measured
 *  independently and never pooled: each one carries its own denominator and its own mean. */
export const SLICE_LANGUAGES = ["en", "zh", "mixed"] as const;

/**
 * The judged dataset and the handler do not share a vocabulary. Three fields collide by name
 * and disagree in value:
 *
 *   · `query_mode` is `exact` | `semantic` | `hybrid` (judged-dataset.ts's
 *     `QUERY_MODE_BY_CATEGORY`). The handler's `QueryMode` is `natural` | `websearch`. Not one
 *     value overlaps.
 *   · `scopes` is `own_team` | `shared` — an audience, which `resolveCorpora` decides with
 *     `context.shared_allowed`. The handler's `scopes` are retrieval scopes: `current`,
 *     `evidence`, `history`. Passing the dataset's values straight through resolves zero
 *     corpora and returns an empty page for every query.
 *   · `caller_fixture` is a corpus key (`primary_evidence`, `other_team_a`, …). The handler's
 *     `context.owner_id` is a uuid, and which uuid owns that corpus only the loaded registry
 *     can answer.
 *
 * The translation is carried into the report as `request_translation`. Each rule:
 *
 *   mode      every dataset mode → `natural`. `websearch` is a different grammar (quoted
 *             phrases, `OR`, `-exclusion`), not a different intent, and the dataset's query
 *             strings are plain prose in all three modes.
 *   scopes    the retrieval scope of the caller's own corpus, taken from the registry entry for
 *             `caller_fixture`: a query whose relevant artifact lives in an `evidence`-scope
 *             corpus must ask for that scope or the corpus is never consulted.
 *   audience  `shared` present → `shared_allowed: true`; absent → false, which is the
 *             distinction `resolveCorpora`'s two admitting branches draw.
 *   owner     the registry entry's `owner_id` for `caller_fixture`. One fixed uuid for every
 *             query would measure one tenant's corpus over and over.
 */
const REQUEST_TRANSLATION = Object.freeze({
  query_mode: Object.freeze({ exact: "natural", semantic: "natural", hybrid: "natural" }),
  scopes: "the retrieval scope of the registry entry whose corpus_key is the query's caller_fixture",
  shared_allowed: 'true when the query\'s scopes contain "shared"',
  owner_id: "the registry entry's owner_id for the query's caller_fixture",
  note: "the judged dataset's query_mode/scopes vocabulary has no counterpart in TenantSearchRequest; "
    + "this mapping is an assumption of the measurement, not a fact either side declares",
});

interface TranslatedRequest {
  readonly context: TenantSearchContext;
  readonly request: TenantSearchRequest;
}

/**
 * One judged query as a call the handler will accept, or `null` when the deployment holds no
 * corpus by the name the query's `caller_fixture` gives. A null is a blocked case, never a
 * miss: the caller below refuses the whole run rather than scoring it zero.
 */
function translateRequest(
  query: JudgedQuery, registry: readonly CorpusDescriptor[], runtime: { index_generation: string; cursor_key: string; caller_id: string },
): TranslatedRequest | null {
  const own = registry.find((entry) => entry.corpus_key === query.caller_fixture);
  if (!own) return null;
  const asked = Array.isArray(query.scopes) ? query.scopes.map(String) : [];
  return {
    context: {
      owner_id: own.owner_id,
      shared_allowed: asked.includes("shared"),
      caller_id: runtime.caller_id,
      index_generation: runtime.index_generation,
      cursor_key: runtime.cursor_key,
    },
    request: {
      query: query.query,
      mode: "natural",
      scopes: [own.scope],
      limit: DISPLAYED_AT_K,
    },
  };
}

/**
 * What a case records. DELIBERATE: no query text and no relevant ref, including in the failed
 * cases — a case exposed for debugging stops being held-out evidence. The id, the slice, the
 * category and where the relevant artifact ranked are enough to act on.
 */
interface MeasuredCase {
  readonly query_id: string;
  readonly language: string;
  readonly category: string;
  readonly hit: boolean;
  /** 1-based rank within the displayed list, or null when it was not displayed at all. */
  readonly rank: number | null;
  readonly displayed: number;
  readonly candidate_total: number;
  readonly withheld_candidates: number;
  readonly incomplete: boolean;
  readonly reasons: readonly string[];
  readonly route: RouteObservation;
}

interface EmptyCase {
  readonly query_id: string;
  readonly language: string;
  readonly category: string;
  /** A complete empty: nothing displayed, nothing withheld, and the response not marked
   *  incomplete. A budget-limited or otherwise qualified empty is not a correct negative. */
  readonly complete_empty: boolean;
  readonly displayed: number;
  readonly incomplete: boolean;
  readonly reasons: readonly string[];
}

/**
 * The fixture locator a displayed result could be filed under. A qrel's `ref` is a generated
 * filename (`primary_evidence-000037.txt` — all `benchmark.ts`'s `REF_PATTERN` admits) and a
 * result carries a `path`, so the match is on the path, whole or basename, with and without the
 * extension. Nothing is inferred from a prefix: a result matches only by naming the fixture
 * outright. DELIBERATE: `ref.artifact_id` is not a locator — it is a uuid on every real
 * response, and `REF_PATTERN` means no qrel can name one.
 *
 * A wrong guess here would miss on every query and read as a measured 0.00, so the runner's
 * preflight resolves every judged ref against the store before a single query is asked.
 */
function locatorsOf(result: { path: string }): string[] {
  const base = result.path.split("/").pop() ?? result.path;
  return [result.path, base, base.replace(/\.txt$/, "")];
}

interface MeasureOptions {
  readonly runtime: { index_generation: string; cursor_key: string; caller_id: string };
  /** Injected so the probe can drive the identical code against a fake store. Defaults to the
   *  real composed path, which is the only thing the producer ever passes. */
  readonly call?: (client: RetrievalClient, context: TenantSearchContext, request: TenantSearchRequest) => Promise<string>;
}

interface OneOutcome {
  readonly displayed: readonly { path: string }[];
  readonly candidate_total: number;
  readonly withheld_candidates: number;
  readonly incomplete: boolean;
  readonly reasons: readonly string[];
  readonly route: RouteObservation;
}

/** One call, end to end, with the response read back through the published contract. A
 *  response that does not parse is not treated as an empty page: `contract_parsed` goes false,
 *  `computeRoute` refuses the route, and the run cannot claim the public handler. */
async function runOne(
  client: RetrievalClient, translated: TranslatedRequest, options: MeasureOptions,
): Promise<OneOutcome> {
  const call = options.call ?? searchTenantInformation;
  const { client: watched, log } = instrument(client);
  const wire = await call(watched, translated.context, translated.request);
  const parsed = SearchResponseSchema.safeParse(JSON.parse(wire));
  const route = observeRoute(log, translated.context.owner_id, parsed.success);
  if (!parsed.success) {
    return { displayed: [], candidate_total: 0, withheld_candidates: 0, incomplete: true,
      reasons: ["response did not validate against SearchResponseSchema"], route };
  }
  const body = parsed.data;
  return {
    // The displayed list, not the candidate list: `serializeResults` drops trailing candidates
    // until the 24000-byte envelope fits, so what a caller was shown is `results`, and an
    // artifact withheld under `response_budget` is a miss. The slice is a second bound —
    // `limit` already asked for 20.
    displayed: body.results.slice(0, DISPLAYED_AT_K),
    candidate_total: body.candidate_total,
    withheld_candidates: body.withheld_candidates,
    incomplete: body.incomplete,
    reasons: body.reasons,
    route,
  };
}

export interface SliceMeasurement {
  readonly language: string;
  readonly denominator: number;
  readonly hits: number;
  readonly recall_at_20: number;
  readonly query_ids: readonly string[];
  readonly cases: readonly MeasuredCase[];
}

export interface Measurement {
  readonly route: string;
  readonly pooled: boolean;
  readonly pooled_evidence: readonly string[];
  readonly slices: Readonly<Record<string, SliceMeasurement>>;
  readonly no_answer: { readonly denominator: number; readonly correct: number; readonly rate: number; readonly cases: readonly EmptyCase[] };
  readonly excluded: Readonly<Record<string, number>>;
  readonly failed_cases: readonly MeasuredCase[];
  readonly request_translation: typeof REQUEST_TRANSLATION;
}

/**
 * `pooled`, computed. Three things have to hold for three slices to be three measurements
 * rather than one figure printed three times, each checked against the per-case records the
 * slice was built from:
 *
 *   1. the slices are disjoint — no query id appears in two of them;
 *   2. every slice's denominator is its own case count;
 *   3. every slice's ratio recomputes from its own hits and its own denominator.
 *
 * Any of the three failing means the numbers did not come from three separate populations, and
 * `pooled` says so.
 */
export function detectPooling(slices: readonly SliceMeasurement[]): { pooled: boolean; evidence: string[] } {
  const evidence: string[] = [];
  const seen = new Map<string, string>();
  for (const slice of slices) {
    for (const id of slice.query_ids) {
      const owner = seen.get(id);
      if (owner !== undefined) evidence.push(`query ${id} is counted in both the ${owner} and ${slice.language} slices`);
      else seen.set(id, slice.language);
    }
    if (slice.denominator !== slice.cases.length) {
      evidence.push(`the ${slice.language} slice states denominator ${slice.denominator} over ${slice.cases.length} recorded cases`);
    }
    const recomputed = slice.denominator === 0 ? Number.NaN : slice.hits / slice.denominator;
    if (!Object.is(recomputed, slice.recall_at_20)) {
      evidence.push(`the ${slice.language} slice states ${slice.recall_at_20} where its own ${slice.hits}/${slice.denominator} gives ${recomputed}`);
    }
  }
  return { pooled: evidence.length > 0, evidence };
}

function buildSlice(language: string, cases: readonly MeasuredCase[]): SliceMeasurement {
  const hits = cases.filter((c) => c.hit).length;
  return {
    language,
    // The denominator is this slice's own case count and is printed beside the ratio: these
    // denominators are small, so at n=20 a single miss is 0.95 exactly and a bare "0.95" hides
    // whether the slice cleared the bar or sat on it.
    denominator: cases.length,
    hits,
    recall_at_20: cases.length === 0 ? Number.NaN : hits / cases.length,
    query_ids: cases.map((c) => c.query_id),
    cases,
  };
}

/** Judged queries that are actually measurable for recall: held out, answerable, and not an
 *  isolation case. `no-answer` is answerable:false and is measured separately; `isolation` is
 *  answerable:false too but belongs to the `unauthorized_results` target and the isolation
 *  suite, and folding it into the no-answer rate would be a second kind of pooling. */
export function selectHeldOut(queries: readonly JudgedQuery[]): {
  answerable: JudgedQuery[]; noAnswer: JudgedQuery[]; isolation: JudgedQuery[];
} {
  const held = queries.filter((q) => q.split === "held-out");
  return {
    answerable: held.filter((q) => q.answerable && q.category !== ISOLATION_CATEGORY),
    noAnswer: held.filter((q) => !q.answerable && q.category !== ISOLATION_CATEGORY),
    isolation: held.filter((q) => q.category === ISOLATION_CATEGORY),
  };
}

/** Every judged-relevant (grade > 0) fixture ref, by query id. Grade 0 is a judged non-match
 *  and never counts toward recall. */
export function relevantRefsByQuery(qrels: readonly Qrel[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const qrel of qrels) {
    if (!(qrel.grade > 0)) continue;
    out.set(qrel.query_id, [...(out.get(qrel.query_id) ?? []), qrel.ref]);
  }
  return out;
}

export class MeasurementRefused extends Error {
  readonly reasons: readonly string[];
  constructor(reasons: readonly string[]) {
    super(reasons.join("; "));
    this.name = "MeasurementRefused";
    this.reasons = reasons;
  }
}

/**
 * Runs every held-out case through the public path and returns what was observed.
 *
 * Refuses rather than scoring a zero in two cases: a query whose `caller_fixture` names no
 * corpus this deployment holds, and a query with no judged relevant ref. Neither is a retrieval
 * failure, so the whole run is refused and the target stays blocked. A query that was asked and
 * returned nothing relevant is a genuine miss and is counted as one.
 */
export async function measureHeldOut(
  client: RetrievalClient,
  queries: readonly JudgedQuery[],
  qrels: readonly Qrel[],
  options: MeasureOptions,
  registry: readonly CorpusDescriptor[],
): Promise<Measurement> {
  const { answerable, noAnswer, isolation } = selectHeldOut(queries);
  const relevant = relevantRefsByQuery(qrels);

  const unaskable: string[] = [];
  for (const query of [...answerable, ...noAnswer]) {
    if (!translateRequest(query, registry, options.runtime)) {
      unaskable.push(`${query.id}: no corpus named "${query.caller_fixture}" exists on this deployment`);
    }
  }
  for (const query of answerable) {
    if ((relevant.get(query.id) ?? []).length === 0) unaskable.push(`${query.id}: no judged relevant artifact`);
  }
  if (unaskable.length > 0) throw new MeasurementRefused(unaskable);

  const measured: MeasuredCase[] = [];
  const observations: RouteObservation[] = [];
  for (const query of answerable) {
    const translated = translateRequest(query, registry, options.runtime)!;
    const outcome = await runOne(client, translated, options);
    observations.push(outcome.route);
    const wanted = new Set(relevant.get(query.id) ?? []);
    let rank: number | null = null;
    outcome.displayed.forEach((result, index) => {
      if (rank !== null) return;
      if (locatorsOf(result).some((locator) => wanted.has(locator) || wanted.has(`${locator}.txt`))) rank = index + 1;
    });
    measured.push({
      query_id: query.id, language: query.language, category: query.category,
      // Binary per query: every eligible held-out case has exactly one relevant artifact, so
      // `Recall@20` is 1 when that artifact was displayed within 20 and 0 when it was not.
      hit: rank !== null, rank,
      displayed: outcome.displayed.length, candidate_total: outcome.candidate_total,
      withheld_candidates: outcome.withheld_candidates, incomplete: outcome.incomplete,
      reasons: outcome.reasons, route: outcome.route,
    });
  }

  const emptyCases: EmptyCase[] = [];
  for (const query of noAnswer) {
    const translated = translateRequest(query, registry, options.runtime)!;
    const outcome = await runOne(client, translated, options);
    observations.push(outcome.route);
    emptyCases.push({
      query_id: query.id, language: query.language, category: query.category,
      // A budget-limited or unqualified empty is not a correct complete negative. All three
      // clauses are required: nothing shown, nothing held back, and the response not flagged
      // incomplete for any reason of its own.
      complete_empty: outcome.displayed.length === 0 && outcome.withheld_candidates === 0 && !outcome.incomplete,
      displayed: outcome.displayed.length, incomplete: outcome.incomplete, reasons: outcome.reasons,
    });
  }

  const slices: Record<string, SliceMeasurement> = {};
  for (const language of SLICE_LANGUAGES) {
    slices[language] = buildSlice(language, measured.filter((c) => c.language === language));
  }
  const pooling = detectPooling(SLICE_LANGUAGES.map((l) => slices[l]));
  const correct = emptyCases.filter((c) => c.complete_empty).length;

  return {
    route: computeRoute(observations),
    pooled: pooling.pooled,
    pooled_evidence: pooling.evidence,
    slices,
    no_answer: {
      denominator: emptyCases.length, correct,
      rate: emptyCases.length === 0 ? Number.NaN : correct / emptyCases.length,
      cases: emptyCases,
    },
    excluded: {
      // Named and counted rather than silently dropped: a reader can see that the answerable
      // denominators do not include these, and why.
      no_answer_measured_separately: noAnswer.length,
      isolation_belongs_to_the_isolation_suite: isolation.length,
    },
    failed_cases: measured.filter((c) => !c.hit),
    request_translation: REQUEST_TRANSLATION,
  };
}

/** The quality thresholds this run is read against, copied from `RELEASE_TARGETS` by key. The
 *  targets and their numbers are `benchmark.ts`'s and are never redefined here; this is a
 *  projection of four of them into the report. */
function thresholdsForSlices(): Record<string, { direction: string; target: number; unit: string }> {
  const wanted = ["en_recall_at_20", "zh_recall_at_20", "mixed_recall_at_20", "no_answer_correct_rate"];
  const out: Record<string, { direction: string; target: number; unit: string }> = {};
  for (const definition of RELEASE_TARGETS) {
    if (wanted.includes(definition.key)) {
      out[definition.key] = { direction: definition.direction, target: definition.target, unit: definition.unit };
    }
  }
  return out;
}

interface ReportInputs {
  readonly measurement: Measurement;
  readonly run: "baseline" | "candidate";
  readonly topology: Record<string, unknown>;
  readonly command_exits: readonly { readonly command: string; readonly exit: number }[];
  readonly bindings: Record<string, unknown>;
  readonly generated_by: string;
}

/**
 * The benchmark report, as `testing/tenant-info/benchmark-report.json` holds it. The
 * denominators, the route, the pooling observation, the translation, the topology and the exits
 * are all carried; nothing is summarised into a single number.
 */
export function buildReport(inputs: ReportInputs): Record<string, unknown> {
  const { measurement } = inputs;
  const slices: Record<string, unknown> = {};
  for (const language of SLICE_LANGUAGES) {
    const slice = measurement.slices[language];
    slices[language] = {
      denominator: slice.denominator, hits: slice.hits, recall_at_20: slice.recall_at_20,
      // Both halves of the ratio are printed because the denominators are small: at n=20 one
      // miss is exactly 0.95 and two are 0.90, and the bare ratio hides which of those it is.
      one_miss_would_be: slice.denominator === 0 ? null : (1 - 1 / slice.denominator),
      query_ids: slice.query_ids,
      cases: slice.cases,
    };
  }
  return {
    schema: "tenant-info-benchmark-measurement/1",
    criterion: "AC-7.3",
    run: inputs.run,
    generated_at: new Date().toISOString(),
    generated_by: inputs.generated_by,
    _header: [
      "Measured by running the held-out queries through the real public path",
      "(searchTenantInformation → serializeResults) and counting the DISPLAYED results.",
      "`route` and `pooled` are observations computed from the statements each call issued and",
      "from recomputing each slice's ratio out of its own cases — neither is a literal.",
      "The three language slices are measured independently and are never pooled.",
      "Each case records how many results were DISPLAYED and where the relevant artifact ranked,",
      "and deliberately not the displayed list itself or the query text: a held-out case printed",
      "beside its answer stops being held-out evidence. The per-case `route` block is that call's",
      "authorized-read receipt — how many statements it issued and how many bound the caller's id.",
    ],
    route: measurement.route,
    // What `route` denotes, beside the word itself. The literal the release check compares
    // against names a function call rather than a door: no MCP handler sits above this path
    // (services/zz-core/src/tools/knowledge-search.ts keeps the live knowledge_search tool on
    // zz.doc/zz.knowledge_node). A reader taking "public_handler" for a transport would be
    // reading something this run did not measure, so what was called is spelled out here.
    route_denotes: {
      called: "searchTenantInformation(client, context, request)",
      module: "services/zz-core/src/tenant-info/search.ts",
      serializer: "serializeResults (services/zz-core/src/tenant-info/retrieval.ts)",
      transport_exercised: false,
      note: "the function an MCP handler would call, one layer below transport; nothing shallower exists "
        + "for this corpus on this deployment, and the live knowledge_search tool reads a different store",
      earned_by: "per call: a registry statement, a watermark statement, at least one retrieval lane statement, "
        + "a response that parses as the published SearchResponse, and the caller's owner_id bound into a statement",
    },
    pooled: measurement.pooled,
    pooled_evidence: measurement.pooled_evidence,
    slices,
    no_answer: measurement.no_answer,
    excluded: measurement.excluded,
    failed_cases: measurement.failed_cases,
    thresholds: thresholdsForSlices(),
    request_translation: measurement.request_translation,
    topology: inputs.topology,
    command_exits: inputs.command_exits,
    bindings: inputs.bindings,
  };
}

/**
 * The quality observations this run supplies to `evaluateTargets`, keyed exactly as
 * `RELEASE_TARGETS` names them. A slice that produced no denominator supplies no key at all —
 * an absent observation is blocked, where a `0` would read as a measured failure.
 *
 * DELIBERATE: `no_answer_correct_rate` is not one of the keys. That target's `measured_by` is
 * the 70 no-answer cases; this run asks the 14 that are held out, and a 14-case figure under a
 * key defined over 70 would put a wrong-denominator number into the release verdict. The
 * held-out no-answer rate is reported separately, in the report's own `no_answer` block and in
 * `quality.rates`, where its denominator travels with it.
 */
export function measurementsForTargets(measurement: Measurement): Record<string, number> {
  const out: Record<string, number> = {};
  for (const language of SLICE_LANGUAGES) {
    // An absent slice supplies no key either, for the same reason an empty one does not: the
    // target it would have answered stays blocked rather than acquiring a zero.
    const slice = measurement.slices[language];
    if (slice !== undefined && slice.denominator > 0 && Number.isFinite(slice.recall_at_20)) {
      out[`${language}_recall_at_20`] = slice.recall_at_20;
    }
  }
  return out;
}

/**
 * The `quality.json` input `assembleBenchmarkReport` loads, in its own vocabulary.
 *
 * `assembleBenchmarkReport` fills `quality.slices` from this file and its targets from
 * `measurements.json`, and nothing in `validateBenchmarkReport` cross-checks the two — so
 * supplying only the measurements prints `en_recall_at_20` as an observation beside a
 * `held-out-answerable-en` slice reading `denominator: null`. The denominators belong under the
 * slice names that section uses.
 *
 * The two limits are restated because the validator demands the agreement's own values there
 * (quality 20, latency 15) and refuses anything else.
 */
export function qualityInputFor(measurement: Measurement): Record<string, unknown> {
  const rate = (hits: number, denominator: number): number | null => (denominator === 0 ? null : hits / denominator);
  const all = SLICE_LANGUAGES.flatMap((language) => measurement.slices[language]?.cases ?? []);
  const falseEmpties = all.filter((c) => c.displayed === 0).length;
  const incompletes = [...all.map((c) => c.incomplete), ...measurement.no_answer.cases.map((c) => c.incomplete)];
  return {
    definitions: {
      recall_at_k: "distinct required relevant refs in the first k DISPLAYED results / all judged relevant refs, "
        + "arithmetic mean within each named held-out answerable language slice, never pooled across them",
      relevant_grades: [1, 2], quality_limit: 20, latency_limit: 15,
      omissions: "a response-budget omission counts as a miss, never as an undisplayed candidate scored anyway",
      no_answer_cases: "excluded from every recall denominator and reported separately below",
    },
    slices: SLICE_LANGUAGES.map((language) => {
      const slice = measurement.slices[language];
      return {
        slice: `held-out-answerable-${language}`,
        denominator: slice.denominator,
        metrics: { recall_at_20: slice.recall_at_20, hits: slice.hits },
      };
    }),
    // A null rate carries its reason, because `validateBenchmarkReport` refuses one that does
    // not. The runner refuses a zero denominator before it reaches here, so in a real run all
    // three are numbers.
    rates: {
      no_answer_correct_rate: rate(measurement.no_answer.correct, measurement.no_answer.denominator),
      // An answerable query answered with an empty page. Distinct from the no-answer rate:
      // there, an empty page is the correct answer; here it is the whole miss.
      false_empty_rate: rate(falseEmpties, all.length),
      incomplete_rate: rate(incompletes.filter(Boolean).length, incompletes.length),
      blocked_reason: "a rate reading null above was asked of zero cases and was therefore never measured",
      denominators: {
        no_answer_correct_rate: measurement.no_answer.denominator,
        false_empty_rate: all.length, incomplete_rate: incompletes.length,
      },
      note: "measured over the HELD-OUT cases only; the no_answer_correct_rate release target is defined over "
        + "all 70 no-answer cases and is deliberately not supplied from this run",
    },
  };
}
