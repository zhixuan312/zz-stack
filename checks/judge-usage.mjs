/**
 * The judge records what it consumed, and a gap stays a gap.
 *
 * THIS DRIVES `markAll`; IT DOES NOT GREP judge.ts. The first draft of this check was six
 * regexes over the source, and two of them — `/Date\.now\(\)/` and `/ok\s*:/` — would have
 * passed on almost any TypeScript file in this repository. They asserted that two strings
 * appear, not that a completion is timed or that a failed one is still recorded, and a check
 * that cannot tell the property from a coincidence is a defect wearing a green tick. A regex
 * cannot express "every path out of the fetch writes exactly one row" at all; running the
 * function can, so it does.
 *
 * Four scenarios, one `markAll` call each, against a fake pool that records the
 * `zz.model_call` inserts and a `fetch` that answers however the scenario needs:
 *
 *   whole      — a normal answer with no `usage` block: one row, ok, all three token
 *                columns null, because "the provider said nothing" is not "it cost nothing".
 *   counted    — a normal answer WITH usage: the three columns carry what it reported.
 *   truncated  — `finish_reason: "length"` with usage: one row, NOT ok, and the tokens it
 *                still cost. The expensive failure, and the one a happy-path recorder drops.
 *   threw      — the fetch itself throwing: one row, NOT ok, tokens null.
 *   refused    — the endpoint answering 500: one row, NOT ok. The fourth way out.
 *
 * `duration_ms` IS TESTED AGAINST A REAL DELAY rather than against `typeof "number"`. The stub
 * sleeps 25ms before answering and the row must show at least 10, so a `duration_ms: 0` and a
 * `Date.now()` deleted into `undefined - started` (which is NaN, and NaN is a number) both go
 * red. A type assertion would have passed all three.
 *
 * Columns are read BY NAME — the insert's own `(a, b, c)` list is parsed and zipped with the
 * parameter array — so reordering the statement cannot make a wrong assertion pass.
 *
 * `cached_tokens` IS UNVERIFIED AGAINST A LIVE PROVIDER. This check pins the mapping judge.ts
 * chose from z.ai's published chat-completion reference; it cannot prove the provider really
 * spells it that way, and judge.ts says so at the `Usage` interface.
 */
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";

const dist = new URL("../services/zz-core/dist/eval/judge.js", import.meta.url);
if (!existsSync(dist)) {
  console.error("services/zz-core/dist/eval/judge.js does not exist — this check runs the compiled " +
                "judge rather than reading it; run `npm run build`");
  process.exit(1);
}

// Read at module load by judge.ts, so they must be set before the import. Neither is used:
// every fetch in this file is the stub below.
process.env.LLM_BASE_URL = "https://example.invalid/v1";
process.env.LLM_API_KEY = "not-a-key";

const { markAll } = await import(pathToFileURL(dist.pathname).href);

const fail = [];

/** The columns of an `insert ... (a, b, c) values ($1, $2, $3)`, zipped with its parameters. */
function byName(sql, params) {
  const cols = /\(([^)]*)\)\s*values/i.exec(sql)[1].split(",").map((c) => c.trim());
  return Object.fromEntries(cols.map((c, i) => [c, params[i]]));
}

/** Enough of a pg.Pool for one round of one subject. Every statement markAll issues is
 *  answered by shape; the model_call inserts are kept. */
function pool(rows) {
  return {
    query: async (sql, params) => {
      if (/insert into zz\.model_call/i.test(sql)) { rows.push(byName(sql, params)); return { rows: [], rowCount: 0 }; }
      if (/insert into zz\.eval_subject/i.test(sql)) return { rows: [{ id: "11111111-1111-1111-1111-111111111111" }], rowCount: 1 };
      if (/insert into zz\.eval\b/i.test(sql)) return { rows: [{ id: "22222222-2222-2222-2222-222222222222" }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
  };
}

const DIM = {
  dim_id: "33333333-3333-3333-3333-333333333333",
  name: "Evidence", five_means: "cited", one_means: "asserted",
  kind: "qualitative", threshold: "", threshold_reason: "",
};

const MARKING = {
  versionColumn: "plugin_version_id",
  versionId: "44444444-4444-4444-4444-444444444444",
  noun: "plugin", name: "zz-core", version: "1.0.0",
  rubricId: "55555555-5555-5555-5555-555555555555", rubricVersion: "1",
  dims: [DIM], kind: "document",
  items: [{ key: "k", label: "a document", runId: null, docId: "66666666-6666-6666-6666-666666666666",
            team: "t", init: "i", path: "p.md" }],
  control: async () => ({ text: "", truncated: 0 }),
  facts: null,
};

const ANSWER = JSON.stringify({ marks: [{ dimension: "Evidence", score: 4, cite: "c", why: "w" }] });

/** One round, with `fetch` replaced for the duration. Returns the model_call rows it wrote. */
async function round(stub) {
  const rows = [];
  const real = globalThis.fetch;
  globalThis.fetch = stub;
  try {
    await markAll(pool(rows), MARKING, false, 1, null, () => "the document body");
  } finally {
    globalThis.fetch = real;
  }
  return rows;
}

/** Answers after a real 25ms, so `duration_ms` has something to measure. */
const answers = (payload) => async () => {
  await new Promise((done) => setTimeout(done, 25));
  return { ok: true, status: 200, text: async () => "", json: async () => payload };
};

/** Exactly one row, or say which scenario wrote how many. */
function one(rows, scenario) {
  if (rows.length !== 1) {
    fail.push(`${scenario}: wrote ${rows.length} zz.model_call rows, expected exactly 1`);
    return null;
  }
  return rows[0];
}

const eq = (scenario, row, col, want) => {
  if (row[col] !== want) fail.push(`${scenario}: ${col} is ${JSON.stringify(row[col])}, expected ${JSON.stringify(want)}`);
};

// ── whole: an answer with no usage block. A gap stays a gap. ──────────────────────────────
{
  const row = one(await round(answers({ choices: [{ finish_reason: "stop", message: { content: ANSWER } }] })), "whole");
  if (row) {
    eq("whole", row, "ok", true);
    eq("whole", row, "purpose", "plugin-judge");
    eq("whole", row, "plugin", "zz-core");
    if (!row.model) fail.push("whole: no model name on the row");
    for (const c of ["input_tokens", "output_tokens", "cache_read_tokens"]) {
      if (row[c] !== null) {
        fail.push(`whole: the provider reported no usage and ${c} is ${JSON.stringify(row[c])} — ` +
                  "an unreported figure must stay null, never 0");
      }
    }
    // The stub slept 25ms. Anything under 10 means the figure is not a measurement.
    if (!(Number.isInteger(row.duration_ms) && row.duration_ms >= 10)) {
      fail.push(`whole: duration_ms is ${JSON.stringify(row.duration_ms)} after a 25ms answer — ` +
                "the completion is not timed around the fetch");
    }
  }
}

// ── counted: the three columns carry what the provider reported. ──────────────────────────
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

// ── truncated: a failure that cost tokens is still evidence. ──────────────────────────────
{
  const row = one(await round(answers({
    choices: [{ finish_reason: "length", message: { content: "{\"marks\"" } }],
    usage: { prompt_tokens: 7, completion_tokens: 16000 },
  })), "truncated");
  if (row) {
    eq("truncated", row, "ok", false);
    eq("truncated", row, "input_tokens", 7);
    eq("truncated", row, "output_tokens", 16000);
    eq("truncated", row, "cache_read_tokens", null);
  }
}

// ── threw: the fetch never returned. The call still happened. ─────────────────────────────
{
  const row = one(await round(async () => { throw new Error("socket hang up"); }), "threw");
  if (row) {
    eq("threw", row, "ok", false);
    for (const c of ["input_tokens", "output_tokens", "cache_read_tokens"]) eq("threw", row, c, null);
  }
}

// ── refused: the endpoint answered 500. The prompt was still sent. ────────────────────────
{
  const row = one(await round(async () => ({
    ok: false, status: 500, text: async () => "upstream exploded", json: async () => ({}),
  })), "refused");
  if (row) {
    eq("refused", row, "ok", false);
    for (const c of ["input_tokens", "output_tokens", "cache_read_tokens"]) eq("refused", row, c, null);
  }
}

if (fail.length) { console.error(fail.join("\n")); process.exit(1); }
console.log("judge usage: ok");
