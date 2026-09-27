/**
 * The judge records what it consumed, and a gap stays a gap — and so does the typed service, whose
 * row is the call's own and whose id is what the assessment beside it is paired with.
 *
 * DELIBERATE: this drives `ask` rather than grepping judge.ts. A regex asserts that a string
 * appears, not that a completion is timed or that a failed one is still recorded, and it cannot
 * express "every path out of the fetch writes exactly one row" at all.
 *
 * One `ask` call per scenario — the one `failure_discover`'s critic makes — against a fake pool
 * that records the `zz.model_call` inserts and a `fetch` that answers however the scenario needs:
 *
 *   whole      — a normal answer with no `usage` block: one row, ok, all three token columns
 *                null, because "the provider said nothing" is not "it cost nothing".
 *   counted    — a normal answer with usage: the three columns carry what it reported.
 *   truncated  — `finish_reason: "length"` with usage: one row, not ok, and the tokens it still
 *                cost.
 *   threw      — the fetch itself throwing: one row, not ok, tokens null.
 *   refused    — the endpoint answering 500: one row, not ok.
 *
 * `duration_ms` is tested against a real delay: the stub sleeps 25ms and the row must show at
 * least 10, so `duration_ms: 0` and a NaN duration both go red.
 *
 * Columns are read by name — the insert's own `(a, b, c)` list is parsed and zipped with the
 * parameter array — so reordering the statement cannot make a wrong assertion pass. Every insert
 * is read that way, which is also how a column this phase drops (`plugin`, `confidence`, `note`,
 * `event_id`) is caught: it is not that the row would be wrong, it is that the migrated table
 * refuses it.
 *
 * `cached_tokens` is unverified against a live provider: this pins the mapping judge.ts chose
 * from z.ai's published chat-completion reference.
 *
 * The typed service is driven the same way at the bottom. Its seam is the runner rather than the
 * pool — `db()` is a module-level pool with no injection point, unlike judge.ts's `ask(pool, …)` —
 * so `typed-service.ask` takes the runner it records through, and the fake one answers with the
 * id the real insert's `returning id` would have given. What that section asserts is the whole
 * contract of the pairing: one row per call (never one per attempt, so the retrying scenario is
 * here too), the failure's message in `error`, and the id `ask` hands back being the row's own.
 */
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";

const dist = new URL("../services/zz-core/dist/eval/judge.js", import.meta.url);
const typedDist = new URL("../services/zz-core/dist/typed-service.js", import.meta.url);
const refusalDist = new URL("../services/zz-core/dist/refusal.js", import.meta.url);
for (const [what, href] of [["eval/judge", dist], ["typed-service", typedDist], ["refusal", refusalDist]] as const) {
  if (!existsSync(href)) {
    console.error(`services/zz-core/dist/${what}.js does not exist — this check runs the compiled ` +
                  "modules rather than reading them; run `npm run build`");
    process.exit(1);
  }
}

// Read at module load by judge.ts and typed-service.ts, so they must be set before the imports.
// Neither is used: every fetch in this file is a stub below.
process.env.LLM_BASE_URL = "https://example.invalid/v1";
process.env.LLM_API_KEY = "not-a-key";
process.env.TYPESAFE_API_KEY = "not-a-key";
// Pinned rather than inherited: the assertions below name the model column's exact string and the
// attempt count one retrying call writes, and a machine that exported a different TYPESAFE_MODEL or
// TYPESAFE_ATTEMPTS must not turn either into a failure.
process.env.TYPESAFE_MODEL = "jev-latest";
process.env.TYPESAFE_ATTEMPTS = "3";

const { ask } = await import(pathToFileURL(dist.pathname).href);
const typed = (await import(pathToFileURL(typedDist.pathname).href)) as
  typeof import("../services/zz-core/dist/typed-service.js");
const { Refusal } = (await import(pathToFileURL(refusalDist.pathname).href)) as
  typeof import("../services/zz-core/dist/refusal.js");

const fail: string[] = [];

/** The columns `002_delivery_telemetry.sql` drops from `zz.model_call`. A statement still writing
 *  one is refused by the migrated table, so writing it is a call that never lands. */
const RETIRED_MODEL_CALL = ["plugin", "confidence", "note", "event_id"];

/** The columns of an `insert ... (a, b, c) values ($1, $2, $3)`, zipped with its parameters. */
function byName(sql: string, params: unknown[]): Record<string, unknown> {
  const cols = /\(([^)]*)\)\s*values/i.exec(sql)![1].split(",").map((c) => c.trim());
  return Object.fromEntries(cols.map((c, i) => [c, params[i]]));
}

/** Enough of a pg.Pool for one call. The model_call inserts are kept; `ask` issues nothing else. */
function pool(rows: Record<string, unknown>[]) {
  return {
    query: async (sql: string, params: unknown[]) => {
      if (/insert into zz\.model_call/i.test(sql)) rows.push(byName(sql, params));
      return { rows: [], rowCount: 0 };
    },
  };
}

/** The same, for the typed service: it inserts through the runner `ask` was handed, and the id it
 *  returns is read back out of `rows[0].id` — a `bigint`, which is to say a string. */
function runner(rows: Record<string, unknown>[], id = 42) {
  return {
    query: async (sql: string, params: unknown[]) => {
      if (/insert into zz\.model_call/i.test(sql)) {
        rows.push(byName(sql, params));
        return { rows: [{ id: String(id) }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
  } as unknown as import("../services/zz-core/dist/typed-service.js").ModelCallRunner;
}

const ANSWER = JSON.stringify({ description: "the tool refused a malformed path" });

/** The one shape every stub below answers with — never a real Response, so the global is
 *  overwritten through an untyped write and restored through the typed one.
 *
 *  `headers` is required of every stub although only the typed client reads one: it parses the
 *  supplier's `Retry-After` out of a non-2xx, and a stub that answers one without a header map
 *  makes that read throw, which the client classifies as a transport failure and retries. */
type FetchStub = () => Promise<{
  ok: boolean; status: number;
  headers: { get: (name: string) => string | null };
  text: () => Promise<string>; json: () => Promise<unknown>;
}>;

/** No header the client will act on — no `Retry-After`, and so the kernel's own backoff. */
const NO_HEADERS = { get: () => null };

/** One call, with `fetch` replaced for the duration. Returns the model_call rows it wrote. A
 *  failed call throws by design — the caller falls back — so the throw is expected here and only
 *  the rows are asserted. */
async function round(stub: FetchStub) {
  const rows: Record<string, unknown>[] = [];
  const real = globalThis.fetch;
  (globalThis as Record<string, unknown>).fetch = stub;
  try {
    await ask(pool(rows), "zz-core", "the system prompt", "the failure group", "failure-discover");
  } catch {
    // Asserted through the rows below: every path out of the fetch still writes exactly one.
  } finally {
    globalThis.fetch = real;
  }
  return rows;
}

/** Answers after a real 25ms, so `duration_ms` has something to measure. */
const answers = (payload: Record<string, unknown>) => async () => {
  await new Promise((done) => setTimeout(done, 25));
  return { ok: true, status: 200, headers: NO_HEADERS, text: async () => "", json: async () => payload };
};

/** Exactly one row, or say which scenario wrote how many — and never a column this phase retired,
 *  because the migrated table refuses a statement that names one. */
function one(rows: Record<string, unknown>[], scenario: string): Record<string, unknown> | null {
  if (rows.length !== 1) {
    fail.push(`${scenario}: wrote ${rows.length} zz.model_call rows, expected exactly 1`);
    return null;
  }
  for (const c of RETIRED_MODEL_CALL) {
    if (c in rows[0]) {
      fail.push(`${scenario}: the insert writes zz.model_call.${c}, which ` +
                "002_delivery_telemetry.sql drops — the migrated table refuses the statement");
    }
  }
  return rows[0];
}

const eq = (scenario: string, row: Record<string, unknown>, col: string, want: unknown) => {
  if (row[col] !== want) fail.push(`${scenario}: ${col} is ${JSON.stringify(row[col])}, expected ${JSON.stringify(want)}`);
};

// Whole: an answer with no usage block. A gap stays a gap.
{
  const row = one(await round(answers({ choices: [{ finish_reason: "stop", message: { content: ANSWER } }] })), "whole");
  if (row) {
    eq("whole", row, "ok", true);
    eq("whole", row, "purpose", "failure-discover");
    if (!row.model) fail.push("whole: no model name on the row");
    for (const c of ["input_tokens", "output_tokens", "cache_read_tokens"]) {
      if (row[c] !== null) {
        fail.push(`whole: the provider reported no usage and ${c} is ${JSON.stringify(row[c])} — ` +
                  "an unreported figure must stay null, never 0");
      }
    }
    // The stub slept 25ms. Anything under 10 means the figure is not a measurement.
    if (!(typeof row.duration_ms === "number" && Number.isInteger(row.duration_ms) && row.duration_ms >= 10)) {
      fail.push(`whole: duration_ms is ${JSON.stringify(row.duration_ms)} after a 25ms answer — ` +
                "the completion is not timed around the fetch");
    }
  }
}

// Counted: the three columns carry what the provider reported.
{
  const row = one(await round(answers({
    choices: [{ finish_reason: "stop", message: { content: ANSWER } }],
    usage: { prompt_tokens: 1234, completion_tokens: 56, prompt_tokens_details: { cached_tokens: 789 } },
  })), "counted");
  if (row) {
    eq("counted", row, "input_tokens", 1234);
    eq("counted", row, "output_tokens", 56);
    eq("counted", row, "cache_read_tokens", 789);
    eq("counted", row, "ok", true);
  }
}

// Truncated: a failure that cost tokens is still evidence.
{
  const row = one(await round(answers({
    choices: [{ finish_reason: "length", message: { content: "{\"description\"" } }],
    usage: { prompt_tokens: 7, completion_tokens: 16000 },
  })), "truncated");
  if (row) {
    eq("truncated", row, "ok", false);
    eq("truncated", row, "input_tokens", 7);
    eq("truncated", row, "output_tokens", 16000);
    eq("truncated", row, "cache_read_tokens", null);
  }
}

// Threw: the fetch never returned. The call still happened.
{
  const row = one(await round(async () => { throw new Error("socket hang up"); }), "threw");
  if (row) {
    eq("threw", row, "ok", false);
    for (const c of ["input_tokens", "output_tokens", "cache_read_tokens"]) eq("threw", row, c, null);
  }
}

// Refused: the endpoint answered 500. The prompt was still sent.
{
  const row = one(await round(async () => ({
    ok: false, status: 500, headers: NO_HEADERS, text: async () => "upstream exploded", json: async () => ({}),
  })), "refused");
  if (row) {
    eq("refused", row, "ok", false);
    for (const c of ["input_tokens", "output_tokens", "cache_read_tokens"]) eq("refused", row, c, null);
  }
}

// ---------------------------------------------------------------------------------------------
// The typed service. Its row is the call's own — one row whether the call answered, was refused,
// or was retried — and the id it returns is what `semantic.ts` writes as `assessment.model_call_id`.
// ---------------------------------------------------------------------------------------------

/** The adapter's own reply for one question: the envelope names the version once, the answer
 *  carries the primitive, and the usage block is what the row records. `jev-latest` is an alias,
 *  so the adapter records the reported version as the resolved identity and compares nothing. */
const jev = (key: string) => async () => ({
  ok: true, status: 200, headers: NO_HEADERS, text: async () => "",
  json: async () => ({
    model: "jev-latest",
    answers: { [key]: { noul: 0.9 } },
    usage: { input_tokens: 11, output_tokens: 3 },
  }),
});

/** One typed call with `fetch` replaced for the duration, against a runner that writes the same
 *  rows the judge's fake pool does and answers with the id the real insert's `returning id` gives.
 *  It throws by design when the call refuses, so both outcomes are returned rather than caught. */
async function typedRound(stub: FetchStub, rows: Record<string, unknown>[], id = 42) {
  const real = globalThis.fetch;
  (globalThis as Record<string, unknown>).fetch = stub;
  let call: import("../services/zz-core/dist/typed-service.js").TypedCall | null = null;
  let thrown: unknown = null;
  try {
    call = await typed.ask("the state", { q: { type: "noul", instructions: "is it so" } }, runner(rows, id));
  } catch (err) {
    thrown = err;
  } finally {
    globalThis.fetch = real;
  }
  return { call, thrown };
}

const carried = (thrown: unknown): unknown => (thrown as { model_call_id?: unknown } | null)?.model_call_id;

// Answered: one row, the failure column null, and the id of that row handed back.
{
  const rows: Record<string, unknown>[] = [];
  const { call, thrown } = await typedRound(jev("q"), rows);
  if (thrown) fail.push(`typed/whole: the call threw ${String(thrown)}`);
  const row = one(rows, "typed/whole");
  if (row) {
    eq("typed/whole", row, "ok", true);
    eq("typed/whole", row, "error", null);
    eq("typed/whole", row, "purpose", "typed-judge");
    eq("typed/whole", row, "model", "typesafe/jev-latest");
    eq("typed/whole", row, "input_tokens", 11);
    eq("typed/whole", row, "output_tokens", 3);
    eq("typed/whole", row, "attempts", 1);
  }
  if (call?.model_call_id !== 42) {
    fail.push(`typed/whole: ask() returned model_call_id ${JSON.stringify(call?.model_call_id)}, ` +
              "expected 42 — the id the row was written under");
  }
  if (call?.model !== "typesafe/jev-latest") {
    fail.push(`typed/whole: the call says it asked for ${JSON.stringify(call?.model)}, expected ` +
              "typesafe/jev-latest");
  }
  // The answer still travels with the id: a caller that got only an id would have nothing to score.
  const probability = call?.answers["q"]?.readings.probability ?? null;
  if (probability !== 0.9) {
    fail.push(`typed/whole: the answered call does not carry the answer it read — probability is ` +
              `${JSON.stringify(probability)}, expected 0.9`);
  }
}

// Refused: the endpoint answered 501, which the kernel's table calls permanent — retrying it
// would ask the same question again. One row, the reason in `error`, and a refusal carrying that
// row's id so an `unavailable` reading can name the call it could not get an answer from.
{
  const rows: Record<string, unknown>[] = [];
  const { call, thrown } = await typedRound(async () => ({
    ok: false, status: 501, headers: NO_HEADERS, text: async () => "not implemented", json: async () => ({}),
  }), rows, 7);
  if (call) fail.push("typed/refused: the call answered, and a 501 is not an answer");
  // A subclass, because registerTool's wrapper reads a Refusal and turns it into plain text.
  if (!(thrown instanceof Refusal)) {
    fail.push(`typed/refused: the call threw ${String(thrown)}, expected a Refusal — a wrapper that ` +
              "no longer reads it as one answers with a crash instead of a refusal");
  }
  if (!(thrown instanceof typed.TypedCallRefusal)) {
    fail.push("typed/refused: the call threw a Refusal that does not carry the row's id");
  }
  if (thrown instanceof Error && !thrown.message.startsWith("ERROR:")) {
    fail.push(`typed/refused: the refusal reads ${JSON.stringify(thrown.message)}, expected the ` +
              '"ERROR: " prefix every refusal in this platform carries');
  }
  const row = one(rows, "typed/refused");
  if (row) {
    eq("typed/refused", row, "ok", false);
    eq("typed/refused", row, "attempts", 1);
    if (typeof row.error !== "string" || !row.error.includes("501")) {
      fail.push(`typed/refused: error is ${JSON.stringify(row.error)}, expected the endpoint's own ` +
                "answer — a failure's message goes to error and nowhere else");
    }
  }
  if (carried(thrown) !== 7) {
    fail.push(`typed/refused: the refusal carries model_call_id ${JSON.stringify(carried(thrown))}, ` +
              "expected 7");
  }
}

// Retried: 500 is capacity, so the call is asked again and again until the attempt budget is
// spent — and it still writes ONE row. A row per attempt would make every sum over
// zz.model_call count a single call three times, which is the whole reason the column exists.
// Last, because the backoff between the three attempts is a real wait.
{
  const rows: Record<string, unknown>[] = [];
  const { thrown } = await typedRound(async () => ({
    ok: false, status: 500, headers: NO_HEADERS, text: async () => "upstream exploded", json: async () => ({}),
  }), rows, 9);
  const row = one(rows, "typed/retried");
  if (row) {
    eq("typed/retried", row, "ok", false);
    eq("typed/retried", row, "attempts", 3);
  }
  if (!(thrown instanceof typed.TypedCallRefusal)) {
    fail.push(`typed/retried: the call threw ${String(thrown)}, expected a TypedCallRefusal`);
  }
  if (carried(thrown) !== 9) {
    fail.push(`typed/retried: the refusal carries model_call_id ${JSON.stringify(carried(thrown))}, ` +
              "expected 9 — the one row the whole call wrote");
  }
}

if (fail.length) { console.error(fail.join("\n")); process.exit(1); }
console.log("judge usage: ok");
