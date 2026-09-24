#!/usr/bin/env node
/**
 * The evaluator registry (Task I-8): what is true with no database at all, which is everything
 * offline can prove.
 *
 *   1. `evaluatorQuestionDigest` is the plan header's exact formula: the first 16 hex characters
 *      of sha256 over `stable_key + "\n" + version + "\n" + question`.
 *   2. `registerEvaluator` refuses a `kind` outside `noul|choice|score` and a `kind`/
 *      `answer_schema.type` mismatch before it ever reaches a database.
 *   3. With no `TEAM_DB_URL`, `registerEvaluator`, `askEvaluator` and `recordEvaluatorAssessment`
 *      all refuse — "no platform database" — rather than silently doing nothing.
 *
 * What this cannot prove offline — an evaluator resolving to its registered
 * `zz.eval_evaluator_version`, one noul/choice/score assessment row satisfying migration 077's
 * checks, an unregistered `evaluator_version_id` refused, an insert failure propagating — needs a
 * real database and is established by agent-review of a live run instead (see `checks/insert-arity.ts`
 * for the one part of that — column/value parity — this repository can still check statically).
 *
 * Run: node checks/eval-evaluators.ts   (also run by scripts/gate.ts)
 */
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
// Type-only: gives this file a real, checked reference to the registry's public shapes, so a
// rename of either drifts here too rather than only inside evaluators.ts itself. Erased before
// node ever runs this file (`erasableSyntaxOnly` in tsconfig.tooling.json requires exactly that).
import type { EvaluatorDefinition, EvaluatorAnswerSchema } from "../services/zz-core/dist/eval/evaluators.js";

delete process.env.TEAM_DB_URL;

/** Exercises the two imported types structurally — an `EvaluatorDefinition` built from a
 *  `noul` `EvaluatorAnswerSchema` — so both stay real type-checked surface rather than an
 *  import nothing in this file's runtime code shape depends on. */
const sampleDefinition: EvaluatorDefinition = {
  stable_key: "verify.i8.type-sample", kind: "noul",
  question: "q", answer_schema: { type: "noul" } satisfies EvaluatorAnswerSchema,
  polarity: {}, model_policy: {},
};
void sampleDefinition;

const load = (p: string) => import(pathToFileURL(join(process.cwd(), p)).href);
const { evaluatorQuestionDigest, recordEvaluatorAssessment } =
  await load("services/zz-core/dist/semantic.js");
const { registerEvaluator, askEvaluator } = await load("services/zz-core/dist/eval/evaluators.js");

const fail: string[] = [];
const is = (cond: unknown, why: string) => { if (!cond) fail.push(why); };

// 1. The digest formula, computed independently.
{
  const { createHash } = await import("node:crypto");
  const want = createHash("sha256").update("discover.owner_kind\n3\nWhose fault is this?")
    .digest("hex").slice(0, 16);
  const got = evaluatorQuestionDigest("discover.owner_kind", 3, "Whose fault is this?");
  assert.equal(got, want, "evaluatorQuestionDigest matches sha256(stable_key\\nversion\\nquestion) sliced to 16 hex");
  assert.match(got, /^[0-9a-f]{16}$/, "the digest is 16 lowercase hex characters");
  is(evaluatorQuestionDigest("a", 1, "q") !== evaluatorQuestionDigest("b", 1, "q"),
     "the stable key is part of the digest");
  is(evaluatorQuestionDigest("a", 1, "q") !== evaluatorQuestionDigest("a", 2, "q"),
     "the version is part of the digest");
}

// 2. registerEvaluator's own guards, before any database call.
{
  await assert.rejects(
    () => registerEvaluator({
      stable_key: "x", kind: "vibes", question: "q", answer_schema: { type: "noul" },
      polarity: {}, model_policy: {},
    }),
    /not a registered answer kind/,
    "an unrecognised kind is refused before a database is touched");
  await assert.rejects(
    () => registerEvaluator({
      stable_key: "x", kind: "noul", question: "q",
      answer_schema: { type: "choice", criteria: { a: "a" } },
      polarity: {}, model_policy: {},
    }),
    /declares kind "noul" but its answer_schema is "choice"/,
    "a kind/answer_schema mismatch is refused before a database is touched");
}

// 3. No TEAM_DB_URL: every entry point refuses rather than proceeding silently.
{
  await assert.rejects(
    () => registerEvaluator({
      stable_key: "discover.owner_kind", kind: "choice", question: "Whose fault is this?",
      answer_schema: { type: "choice", criteria: { plugin: "the plugin caused it" } },
      polarity: {}, model_policy: {},
    }),
    /no platform database/,
    "registerEvaluator refuses with no platform database");
  await assert.rejects(
    () => askEvaluator("11111111-1111-1111-1111-111111111111", "subject", undefined, "ada@zz.test"),
    /no platform database/,
    "askEvaluator refuses with no platform database (it resolves through recordEvaluatorAssessment)");
  await assert.rejects(
    () => recordEvaluatorAssessment({
      evaluator_version_id: "11111111-1111-1111-1111-111111111111",
      subject_text: "subject", askedBy: "ada@zz.test",
    }),
    /no platform database/,
    "recordEvaluatorAssessment refuses with no platform database");
  // This does NOT prove a malformed id is refused as "not registered" — that needs a database,
  // since resolveEvaluatorVersion checks `db()` before its own UUID-shape guard. What it proves
  // is only that the no-database refusal fires unconditionally, for a garbage id exactly as for
  // a well-formed one — established live instead, against zz-squash-a.
  await assert.rejects(
    () => recordEvaluatorAssessment({
      evaluator_version_id: "not-a-uuid", subject_text: "subject", askedBy: "ada@zz.test",
    }),
    /no platform database/,
    "with no database the refusal fires before the id shape is even checked");
}

if (fail.length) { console.error(fail.join("\n")); process.exit(1); }
console.log("ok eval-evaluators");
