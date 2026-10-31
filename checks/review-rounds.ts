#!/usr/bin/env node
/**
 * The review converges: a bounded defect sweep routed by evidence, and an approval that rests on
 * acceptance evidence per declared criterion.
 *
 * Drives the real `initiativeState`, `source_add`'s ledger rule and `document_approve`'s
 * acceptance rule over a fixture store with no typed-service key, so the deterministic rules are
 * what is exercised; the reading-dependent branches are driven by writing the store copies of
 * the readings, which is exactly what `source_add` and `document_write` write.
 *
 *   1. a ledger is refused by name: none, two, a bad impact, reproduced with no reproducer, a
 *      wrong round number, `resolved` naming an unknown id, one id both restated and resolved —
 *      and a ledger with several of these at once is refused with every one, counted (AC-2.2)
 *   2. `reviewRoundOf` counts only the verifying document's own stage
 *   3. every reviewMove branch: round 1, fix, run_experiment, settled, out-of-scope, S1
 *      reproduced out of scope, a repeat (and a repeat read after an unavailable reading), the budget on a non-converging review, a renewal, an accepted residual
 *   4. the approval rules: no round and no waiver, a stakeholder's waiver, no section, a missing row, a stray row, a bad status, no locator,
 *      a locator with a space after its colon, a table the gate cannot read, no quote, deferred
 *      with and without a stakeholder source, the Backlog, and `unavailable` — and a table with
 *      several independent problems, two on one row, refused with all of them, counted
 *   5. the readings: a task's whole criterion, the plan's declared checks bound to the criteria
 *      they verify and a row naming one asked only whether it passed, `no` refuses, `unclear`
 *      asks to sharpen, a `no` taken after an `unavailable` reading of the same evidence refuses, `unclear` again on new evidence goes to the stakeholder, whose source
 *      accepts it
 *   6. the replay of 2026-09-24-plugin-eval-next-version: fix, fix, fix (converging, so no
 *      budget stop), settled after Round 4; Rounds 5-6 (inferred) route to run_experiment
 *   7. a round introducing twelve S1/S2 findings asks every one, no more than eight at a time,
 *      of a stub typed service on a local port
 *   8. a source with no `added_at` is ordered by its row's own timestamp as an instant, not as text
 *
 * Run: node checks/review-rounds.ts   (also run by scripts/gate.ts)
 */
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { rowsOf, stubInitiativePool, type StubInitiative } from "./in-process.ts";

process.env.ZZ_CATALOG_DIR = join(process.cwd(), "catalog");
process.env.TEAM_DB_URL = "postgresql://stub@127.0.0.1:1/stub";
delete process.env.TYPESAFE_API_KEY;

// A typed service that answers every call 400 after a pause, counting how many calls it holds at
// once. Only case 7 sets a key, so every other case asks nothing.
const typed = { inFlight: 0, most: 0, calls: 0 };
const typedServer = createServer((req, res) => {
  typed.calls += 1;
  typed.inFlight += 1;
  typed.most = Math.max(typed.most, typed.inFlight);
  req.resume();
  setTimeout(() => { typed.inFlight -= 1; res.writeHead(400).end("stub"); }, 40);
});
await new Promise<void>((r) => typedServer.listen(0, "127.0.0.1", r));
process.env.TYPESAFE_BASE_URL = `http://127.0.0.1:${(typedServer.address() as AddressInfo).port}`;

const TEAM = "t1";
/** One initiative's world: its own row, its documents, and the answers the assessor recorded. */
interface W extends StubInitiative {
  answers: { about: string; family: string; reading: string; probability: number | null; asked_at: string;
             question_digest?: string }[];
}
let world = new Map<string, W>();
const blank = (flow: string | null): W => ({ flow, docs: [], answers: [] });

stubInitiativePool(() => world, {
  openedAt: "2026-09-26",
  own: (sql, values) => {
    const bySlug = world.get(String(values[1] ?? ""));
    if (/from zz\.assessment a\b/.test(sql) && /select a\.family/.test(sql)) {
      return rowsOf((bySlug?.answers ?? []).map((a) => ({ ...a, instruction_version: 1, question_digest: "d",
        requested_model: null, resolved_model: null, identity_assurance: null, reason: null,
        initiative: String(values[1]), asked_by: "ada@zz.test" })));
    }
    // The acceptance memo: the answers already taken, keyed by the `about` they were asked under.
    if (/select a\.about, a\.reading/.test(sql)) {
      const prefix = String(values[2]).replace(/%$/, "");
      // Filtered by the question only when the statement asks for it — the stub answers what the SQL
      // says, so a statement that stopped filtering is caught rather than covered for here.
      const byQuestion = /a\.question_digest = \$4/.test(sql);
      return rowsOf((bySlug?.answers ?? []).filter((a) => a.about.startsWith(prefix) &&
                                                         (!byQuestion || (a.question_digest ?? CURRENT) === values[3]))
        .map((a) => ({ about: a.about, reading: a.reading,
                       probability: a.probability === null ? null : String(a.probability),
                       reason: null, asked_at: a.asked_at })));
    }
    if (/insert into zz\.model_call\b/.test(sql)) return rowsOf([{ id: "1" }]);
    if (/FROM zz\.membership m/.test(sql)) return rowsOf([{ slug: TEAM, role: "admin", active_slug: TEAM }]);
    if (/insert into zz\.assessment\b/.test(sql)) {
      // COUPLED: the insert's own bind order — family `$1`, reading `$5`, about `$13`, slug `$16`.
      world.get(String(values[15] ?? ""))?.answers.push({
        family: String(values[0] ?? ""), reading: String(values[4] ?? ""),
        about: String(values[12] ?? ""), probability: null, asked_at: new Date().toISOString() });
      return rowsOf([{ id: "a1" }]);
    }
    return undefined;
  },
});

const load = (p: string) => import(pathToFileURL(join(process.cwd(), p)).href);
const { initiativeState } = await load("services/zz-core/dist/tools/initiative-status.js");
const rr = await load("services/zz-core/dist/review-rounds.js");
const acc = await load("services/zz-core/dist/review-acceptance.js");
const CURRENT: string = (await load("services/zz-core/dist/semantic.js")).questionDigest("evidence_relation");
const { ROUND_BUDGET } = await load("services/zz-core/dist/audit-rounds.js");
const { assessmentsFor } = await load("services/zz-core/dist/review-rounds.js");
const { chainFor } = await load("services/zz-core/dist/chain.js");
const { db } = await load("services/zz-core/dist/platform-db.js");

const fail: string[] = [];
const is = (cond: unknown, why: string) => { if (!cond) fail.push(why); };

const doc = (fields: Record<string, string>, body: string) =>
  `---\n${Object.entries(fields).map(([k, v]) => `${k}: ${v}`).join("\n")}\n---\n\n${body}\n`;
const approved = { flow: "sdlc-flow", status: "approved", approved_by: "ada@zz.test", approved_at: "2026-09-24" };

interface Finding { id: string; locator: string; claim: string; impact: string; evidence: string;
                    reproducer: string | null; introduced_by_scope: boolean }
interface Ledger { round: number; scope: { base: string; head: string }; findings: Finding[];
                   resolved: Array<{ id: string; by: string; how: string }> }
interface Resolved { documents: unknown[] }
interface Fixture { name: string; chain: Resolved }

const SPEC = "# Spec\n\n## Stakeholders & Work\n\n- [ ] **AC-1.1** An intake email becomes a case. (FR-1)\n" +
             "- [ ] **AC-2.1** A case can be closed. (FR-2)\n";
// The phase carries its `### As built` deliberately: this check is about the rounds a SETTLED AND
// BUILT plan owes, and `initiative_status` reads a phase with no `### As built` as still being
// executed — it routes to `sdlc-execute` and offers no round at all (the defect 0.83.2 fixes, proven
// by checks/plan-waves-status.ts cases 5 and 6).
const PLAN = "# Plan\n\n## Phase 1 — cases\n\n### Task I-1: Intake (← AC-1.1)\n\n**Technical acceptance " +
             "criteria** (← AC-1.1): the intake check passes on a sample email. It proves:\n" +
             "- one email becomes one case\n\n**Checks:**\n- Check: `verify/intake.ts`\n" +
             "- Run: `node verify/intake.ts`  Expected: PASS once implemented\n\n" +
             "### As built\n\nPhase 1 is built.\n\n## Full-suite gate\n\nnpm run gate\n";

let n = 0;
let seq = 0;
/** One document row, as `docRows` answers with it. `cols` are the row's own columns, `payload`
 *  is the envelope's open half — `stage` and `added_at` for a source — and `supports` is the
 *  relation, which is a list of document paths and never an envelope key. */
const env = (initiative: string, path: string, cols: Record<string, string>, body: string,
             payload: Record<string, string> | null = null, supports: string[] = []) => ({
  id: `d${++seq}`, path, initiative, flow: "", type: "",
  status: cols.status ?? "", outcome: cols.outcome ?? null, approved_by: cols.approved_by ?? null,
  approved_at: cols.approved_at ?? null, closed_by: null, updated_at: "2026-09-26T00:00:00.000Z",
  title: cols.title ?? "", body, tags: [], current_revision: Number(cols.version) || 1,
  current_version: Number(cols.version) || 1, content_generation: "0",
  approved_revision: null, fields: payload, supports,
});

/** A fresh sdlc-flow initiative whose spec, plan and both audits are settled. */
async function fresh(): Promise<Fixture> {
  const name = `2026-09-26-review-${++n}`;
  const w = blank("sdlc-flow");
  world.set(name, w);
  w.docs.push(env(name, "explore.md", { title: "E", flow: "sdlc-flow" }, "# E"));
  w.docs.push(env(name, "spec.md", { title: "Spec", ...approved, version: "1" }, SPEC));
  w.docs.push(env(name, "plan.md", { title: "Plan", ...approved, version: "1" }, PLAN));
  for (const [stage, supports] of [["sdlc-spec-audit", "spec.md"], ["sdlc-plan-audit", "plan.md"]]) {
    w.docs.push(env(name, `sources/2026-09-24-${stage}.md`, { title: stage }, "no blocking findings",
      { stage, audits_version: "1", added_at: "2026-09-24T00:00:00.000Z" }, [supports]));
  }
  return { name, chain: await chainFor(db()!, TEAM, `${name}/x.md`) };
}
const finding = (id: string, impact: string, evidence = "cited", scope = true): Finding =>
  ({ id, locator: `src/${id}.ts:1`, claim: `${id} breaks`, impact, evidence,
     reproducer: evidence === "reproduced" ? `check:${id}` : null, introduced_by_scope: scope });
const ledger = (round: number, findings: Finding[], resolved: string[] = []): Ledger =>
  ({ round, scope: { base: "a1", head: "b2" }, findings, resolved: resolved.map((id) => ({ id, by: "c3", how: "fixed" })) });
const content = (l: unknown) => `Round notes.\n\n\`\`\`json\n${JSON.stringify(l)}\n\`\`\`\n`;
function round(i: Fixture, l: Ledger, at: string, file = `2026-09-26-review-round-${l.round}.md`) {
  world.get(i.name)!.docs.push(env(i.name, `sources/${file}`, { title: `Review round ${l.round}` },
    content(l), { stage: "sdlc-review", added_at: at }, ["review.md"]));
  return file;
}
function stakeholder(i: Fixture, at: string, body: string) {
  world.get(i.name)!.docs.push(env(i.name, `sources/2026-09-26-decision-${at.replace(/\W/g, "")}.md`,
    { title: "Stakeholder decision" }, body, { added_at: at }, ["review.md"]));
}
/** An answer the assessor recorded, in the grain `assessFamily` persists it — under the question
 *  asked now unless `digest` names another. */
function recorded(name: string, about: string, family: string, reading: string, probability: number, at: string,
                  digest = CURRENT) {
  world.get(name)!.answers.push({ about, family, reading, probability, asked_at: at, question_digest: digest });
}
const sourcesOf = (i: Fixture) => world.get(i.name)!.docs;
const answersOf = (i: Fixture) => assessmentsFor(db()!, TEAM, i.name);

const move = async (i: Fixture) =>
  (await initiativeState(db()!, TEAM, i.name, i.chain, i.chain.documents)).next_move;

// 1. the ledger
  const bad = (c: string, earlier: Ledger[], expect: RegExp, why: string) => {
    const said = rr.ledgerRefusal(c, earlier, "review.md");
    is(said && /^ERROR/.test(said) && expect.test(said), `${why}: ${said}`);
  };
  bad("no ledger here", [], /exactly one fenced/, "a round with no ledger was accepted");
  bad(content(ledger(1, [])) + content(ledger(1, [])), [], /has 2/, "two ledgers were accepted");
  bad(content(ledger(1, [{ ...finding("R1-A", "S2"), impact: "high" }])), [], /R1-A: `impact` must be one of S1/, "a bad impact was accepted");
  bad(content(ledger(1, [{ ...finding("R1-A", "S2", "reproduced"), reproducer: null }])), [], /names no `reproducer`/,
      "reproduced with no reproducer was accepted");
  bad(content(ledger(2, [])), [], /this is round 1/, "a wrong round number was accepted");
  bad(content(ledger(2, [], ["R1-X"])), [ledger(1, [finding("R1-A", "S2")])], /names R1-X/, "`resolved` naming an unknown id was accepted");
  bad(content(ledger(2, [finding("R1-A", "S2")], ["R1-A"])), [ledger(1, [finding("R1-A", "S2")])], /restate it or resolve it/,
      "an id both restated and resolved was accepted");
  is(rr.ledgerRefusal(content(ledger(1, [finding("R1-A", "S2")])), [], "review.md") === null, "a well-formed ledger was refused");
  // Shape problems, the round number and an unknown `resolved` id at once: every one of them.
  {
    const said = rr.ledgerRefusal(content(ledger(3, [{ ...finding("R2-A", "S2"), impact: "high" },
                                                     { ...finding("R2-B", "S1", "reproduced"), reproducer: null }], ["R1-X"])),
                                  [ledger(1, [finding("R1-A", "S2")])], "review.md") ?? "";
    for (const want of [/R2-A: `impact` must be one of S1/, /R2-B says reproduced and names no `reproducer`/,
                        /it says round 3, and 1 round\(s\) are already recorded, so this is round 2/, /`resolved` names R1-X/]) {
      is(want.test(said), `a ledger with several problems does not report ${want}: ${said}`);
    }
    is(/is not recorded — problems \(4\): /.test(said) && !/details:/.test(said), `the ledger's problems are not counted, whole: ${said}`);
  }

  // 2. which sources are review rounds
  const a = await fresh();
  is(rr.reviewRoundOf(a.chain, "sdlc-review", ["review.md"])?.document === "review.md", "a review round was not recognised");
  is(rr.reviewRoundOf(a.chain, "sdlc-review", ["plan.md"]) === null, "a review-stage source supporting plan.md was a round");
  is(rr.reviewRoundOf(a.chain, "sdlc-spec", ["spec.md"]) === null, "a stage writing a non-verifying document was a round");

  // 3. the moves
  let m = await move(a);
  // NOT A TOOL: `add_source` is next_move's own action vocabulary; the call it asks for is source_add.
  is(m?.action === "add_source" && m?.document === "review.md" && /stage: "sdlc-review"/.test(m?.why ?? ""),
     `with the plan settled and no round, round 1 is owed: ${JSON.stringify(m)}`);
  round(a, ledger(1, [finding("R1-A", "S2"), finding("R1-B", "S3")]), "2026-09-26T01:00:00.000Z");
  m = await move(a);
  is(m?.action === "fix" && /R1-A/.test(m?.why ?? "") && !/R1-B/.test(m?.why ?? ""),
     `an evidenced S2 routes fix, and S3 never does: ${JSON.stringify(m)}`);
  round(a, ledger(2, [finding("R2-A", "S2", "inferred")], ["R1-A"]), "2026-09-26T02:00:00.000Z");
  m = await move(a);
  is(m?.action === "run_experiment" && /R2-A/.test(m?.why ?? ""), `an inferred-only S2 routes run_experiment: ${JSON.stringify(m)}`);
  round(a, ledger(3, [], []), "2026-09-26T03:00:00.000Z");
  m = await move(a);
  is(m?.action === "run_experiment", `inferred-only blockers never spend the budget: ${JSON.stringify(m)}`);

  // the budget stops a review that is not converging: three rounds, each raising one new blocker
  const g = await fresh();
  round(g, ledger(1, [finding("R1-X", "S2")]), "2026-09-26T01:00:00.000Z");
  round(g, ledger(2, [finding("R2-X", "S1")], ["R1-X"]), "2026-09-26T02:00:00.000Z");
  m = await move(g);
  is(m?.action === "fix", `two rounds are within the budget: ${JSON.stringify(m)}`);
  round(g, ledger(3, [finding("R3-X", "S2")], ["R2-X"]), "2026-09-26T03:00:00.000Z");
  m = await move(g);
  is(m?.action === "decide" && m?.waiting_on === "stakeholder",
     `${ROUND_BUDGET} rounds each raising a new blocker is the stakeholder's call: ${JSON.stringify(m)}`);
  is(/If the person delegated this decision, record it yourself under their delegation/.test(m?.why ?? ""),
     `the review budget's decide did not say a delegated decision is the agent's to record: ${JSON.stringify(m)}`);
  stakeholder(g, "2026-09-26T03:30:00.000Z", "Keep going.");
  m = await move(g);
  is(m?.action === "fix", `a decision naming no id renews the budget: ${JSON.stringify(m)}`);
  stakeholder(g, "2026-09-26T03:40:00.000Z", "R3-X is accepted as residual.");
  m = await move(g);
  is(m?.action === "write_document" && m?.document === "review.md",
     `a stakeholder source naming R3-X accepts it and the rounds settle: ${JSON.stringify(m)}`);

  // bug 0527280f: the words an edit of review.md files as its own cause are the agent's, not the
  // stakeholder's: naming R3-Y there neither renews the budget nor accepts the finding
  const cc = await fresh();
  round(cc, ledger(1, [finding("R1-Y", "S2")]), "2026-09-26T01:00:00.000Z");
  round(cc, ledger(2, [finding("R2-Y", "S1")], ["R1-Y"]), "2026-09-26T02:00:00.000Z");
  round(cc, ledger(3, [finding("R3-Y", "S2")], ["R2-Y"]), "2026-09-26T03:00:00.000Z");
  world.get(cc.name)!.docs.push(env(cc.name, "sources/2026-09-26-input-behind-v2.md", { title: "Input behind v2" },
    "R3-Y is accepted as residual.", { added_at: "2026-09-26T03:30:00.000Z", cause_of: "review.md" }, ["review.md"]));
  m = await move(cc);
  is(m?.action === "decide" && m?.waiting_on === "stakeholder",
     `an edit's own cause naming R3-Y was read as the stakeholder accepting it: ${JSON.stringify(m)}`);

  const b = await fresh();
  round(b, ledger(1, [finding("R1-O", "S2", "cited", false), finding("R1-P", "S1", "cited", false)]), "2026-09-26T01:00:00.000Z");
  m = await move(b);
  is(m?.action === "write_document", `out-of-scope S2 and cited S1 never open a round: ${JSON.stringify(m)}`);
  const c = await fresh();
  round(c, ledger(1, [finding("R1-Q", "S1", "reproduced", false)]), "2026-09-26T01:00:00.000Z");
  m = await move(c);
  is(m?.action === "fix" && /R1-Q/.test(m?.why ?? ""), `a reproduced S1 blocks wherever it is: ${JSON.stringify(m)}`);
  const d = await fresh();
  round(d, ledger(1, [finding("R1-A", "S2")]), "2026-09-26T01:00:00.000Z");
  const f2 = round(d, ledger(2, [finding("R2-A", "S2")], ["R1-A"]), "2026-09-26T02:00:00.000Z");
  recorded(d.name, `sources/${f2}#R2-A`, "repeats_finding", "yes", 0.9, "2026-09-26T02:00:00.000Z");
  m = await move(d);
  is(m?.action === "write_document", `a finding read as a repeat does not reopen the rounds: ${JSON.stringify(m)}`);
  // A reading re-asked after the service was unavailable stands over the unavailable row before it.
  const d2 = await fresh();
  round(d2, ledger(1, [finding("R1-A", "S2")]), "2026-09-26T01:00:00.000Z");
  const g2 = round(d2, ledger(2, [finding("R2-A", "S2")], ["R1-A"]), "2026-09-26T02:00:00.000Z");
  recorded(d2.name, `sources/${g2}#R2-A`, "repeats_finding", "unavailable", 0, "2026-09-26T02:00:00.000Z");
  recorded(d2.name, `sources/${g2}#R2-A`, "repeats_finding", "yes", 0.9, "2026-09-26T02:30:00.000Z");
  m = await move(d2);
  is(m?.action === "write_document",
     `a repeat read after an unavailable reading was shadowed by the unavailable one: ${JSON.stringify(m)}`);

  // 4. the approval rules
  const approval = async (i: Fixture, body: string) =>
    acc.acceptanceApprovalRefusal(db()!, TEAM, i.chain, `${i.name}/review.md`,
      doc({ title: "Review", flow: "sdlc-flow" }, body), "ada@zz.test", sourcesOf(i), await answersOf(i));
  const table = (rows: string[], extra = "") =>
    `# Review\n\n## Acceptance evidence\n\n| AC | Status | Evidence | Note |\n|---|---|---|---|\n${rows.join("\n")}\n${extra}`;
  const ok1 = "| AC-1.1 | established | check:intake — `intake: ok` | |";
  const ok2 = "| AC-2.1 | established | test:checks/close.ts — `close: ok` | |";
  const okT = "| I-1 | established | check:intake — `intake: 1 case` | |";
  const w = await fresh();
  let got = await approval(w, table([ok1, ok2, okT]));
  is(/no round of sdlc-review is recorded.*stage: "sdlc-review".*Only the stakeholder can waive it/.test(got.refusal ?? ""),
     `zero rounds refuse the approval by name: ${got.refusal}`);
  stakeholder(w, "2026-09-26T00:10:00.000Z", "AC-2.1 is waived for now.");
  got = await approval(w, table([ok1, ok2, okT]));
  is(/no round of sdlc-review is recorded/.test(got.refusal ?? ""), `waiving a criterion is not waiving the sweep: ${got.refusal}`);
  world.get(w.name)!.docs.push(env(w.name, "sources/2026-09-26-input-behind-v1.md", { title: "Input behind v1" },
    "The review sweep is waived: a docs-only change.", { added_at: "2026-09-26T00:15:00.000Z", cause_of: "review.md" },
    ["review.md"]));
  got = await approval(w, table([ok1, ok2, okT]));
  is(/no round of sdlc-review is recorded/.test(got.refusal ?? ""),
     `an edit's own cause saying the sweep is waived was read as the stakeholder's waiver: ${got.refusal}`);
  stakeholder(w, "2026-09-26T00:20:00.000Z", "The review sweep is waived: a docs-only change.");
  got = await approval(w, table([ok1, ok2, okT]));
  is(got.refusal === null && /review sweep ran no round: sources\/2026-09-26-decision-\S+ waives it/.test(got.note),
     `a stakeholder's waiver approves, and the approval says so: ${JSON.stringify(got)}`);
  const e = await fresh();
  round(e, ledger(1, []), "2026-09-26T00:30:00.000Z");
  got = await approval(e, "# Review\n\n## Verdict\n\nShips.\n");
  is(/no `## Acceptance evidence` section.*AC-1\.1, AC-2\.1, I-1/.test(got.refusal ?? ""), `no section: ${got.refusal}`);
  got = await approval(e, table([ok1, okT]));
  is(/no row for AC-2\.1/.test(got.refusal ?? ""), `a missing row: ${got.refusal}`);
  got = await approval(e, table([ok1, ok2, okT, "| AC-9.9 | established | check:x — `x` | |"]));
  is(/rows for AC-9\.9/.test(got.refusal ?? ""), `a stray row: ${got.refusal}`);
  got = await approval(e, table([ok1, "| AC-2.1 | done | check:x — `x` | |", okT]));
  is(/AC-2\.1: status "done"/.test(got.refusal ?? ""), `a bad status: ${got.refusal}`);
  got = await approval(e, table([ok1, "| AC-2.1 | blocked | waiting on the vendor | |", okT]));
  is(/AC-2\.1's evidence names no kind-prefixed locator.*no space after the colon/.test(got.refusal ?? ""), `no locator: ${got.refusal}`);
  got = await approval(e, table([ok1, "| AC-2.1 | established | run: `node checks/close.ts` — `close: ok` | |", okT]));
  is(/AC-2\.1's locator has a space after the colon — write it with none, `run:<what ran>`/.test(got.refusal ?? ""),
     `a locator with a space after its colon (bug 387648d1): ${got.refusal}`);
  got = await approval(e, "# Review\n\n## Acceptance evidence\n\n| Item | Locator | Decisive line |\n|---|---|---|\n" +
                          "| AC-1.1 intake works | check:intake | `intake: ok` |\n");
  is(/table has no row the gate can read — it starts `\| Item \| Locator \| Decisive line \|`.*id alone in the first column/.test(got.refusal ?? "")
     && !/no row for/.test(got.refusal ?? ""),
     `a table the gate cannot read is said once, by its header (bug a568b3d8): ${got.refusal}`);
  got = await approval(e, table([ok1, "| AC-2.1 | established | check:close passed | |", okT]));
  is(/AC-2\.1 is established and quotes no output/.test(got.refusal ?? ""), `no quote: ${got.refusal}`);
  got = await approval(e, table([ok1, "| AC-2.1 | deferred | | next release |", okT]));
  is(/AC-2\.1 is deferred and no stakeholder source names it/.test(got.refusal ?? ""), `deferred alone: ${got.refusal}`);
  // Several independent problems at once — a missing row, a stray row, and two on one row (no
  // locator AND no quote): every one, counted, in one refusal.
  got = await approval(e, table([ok1, "| I-1 | established | it passed | |", "| AC-9.9 | established | check:x — `x` | |"]));
  for (const want of [/no row for AC-2\.1/, /rows for AC-9\.9/, /I-1's evidence names no kind-prefixed locator/,
                      /I-1 is established and quotes no output/]) {
    is(want.test(got.refusal ?? ""), `a table with several problems does not report ${want}: ${got.refusal}`);
  }
  is(/is not approved — problems \(4\): /.test(got.refusal ?? ""), `the table's problems are not counted as 4: ${got.refusal}`);
  stakeholder(e, "2026-09-26T05:00:00.000Z", "AC-2.1 moves to the next release.");
  got = await approval(e, table([ok1, "| AC-2.1 | deferred | | next release |", okT]));
  is(got.refusal === null && /unavailable for AC-1\.1, I-1/.test(got.note),
     `deferred with a stakeholder source, and unavailable readings pass on the deterministic rules: ${JSON.stringify(got)}`);
  const h = await fresh();
  round(h, ledger(1, [finding("R1-B", "S1")]), "2026-09-26T01:00:00.000Z");
  got = await approval(h, table([ok1, ok2, okT]));
  is(/open blocking finding — next move fix: .*R1-B/.test(got.refusal ?? ""), `an open blocker refuses the approval: ${got.refusal}`);
  round(h, ledger(2, [], ["R1-B"]), "2026-09-26T02:00:00.000Z");
  got = await approval(h, table([ok1, ok2, okT]));
  is(got.refusal === null, `a settled sweep lets it approve: ${got.refusal}`);
  round(e, ledger(2, [finding("R1-Z", "S2", "cited", false)]), "2026-09-26T06:00:00.000Z");
  got = await approval(e, table([ok1, ok2, okT]));
  is(/`## Backlog` does not name them: R1-Z/.test(got.refusal ?? ""), `an unbacklogged out-of-scope finding: ${got.refusal}`);
  got = await approval(e, table([ok1, ok2, okT], "\n## Backlog\n\n- R1-Z (S2) — next initiative\n"));
  is(got.refusal === null, `a Backlog naming R1-Z passes: ${got.refusal}`);

  // 5. the readings
  const r = await fresh();
  round(r, ledger(1, []), "2026-09-26T00:30:00.000Z");
  type Criterion = { id: string; text: string; checks: string[] };
  const criteria = new Map(((await acc.declaredCriteriaOf(TEAM, r.name, ["spec.md", "plan.md"])) as Criterion[])
    .map((x) => [x.id, x]));
  is(criteria.get("I-1")?.text === "the intake check passes on a sample email. It proves:\n- one email becomes one case",
     `a task's criterion is its whole technical AC, up to the next label: ${JSON.stringify(criteria.get("I-1")?.text)}`);
  is(JSON.stringify(criteria.get("I-1")?.checks) === '["verify/intake.ts"]' &&
     JSON.stringify(criteria.get("AC-1.1")?.checks) === '["verify/intake.ts"]' &&
     JSON.stringify(criteria.get("AC-2.1")?.checks) === "[]",
     `a task's checks bind to it and to the criteria its heading cites, and to nothing else: ` +
     JSON.stringify([...criteria.values()].map((c) => [c.id, c.checks])));
  // A row naming the plan's declared check is asked only whether it passed (bug d5ab33bd); any
  // other row is asked the criterion itself.
  const bound = acc.questionOf(criteria.get("AC-1.1"), "run:node verify/intake.ts — `intake: ok`");
  is(bound.bound.length === 1 && /^AC-1\.1 is verified by the check the approved plan declares for it, `verify\/intake\.ts`: that check was run and passed\.$/.test(bound.subject),
     `a row naming the declared check: ${JSON.stringify(bound)}`);
  is(acc.questionOf(criteria.get("AC-1.1"), "run:other/dir/intake.ts — `intake: ok`").bound.length === 1,
     "the declared check run from another directory was not recognised by its file name");
  const two = { id: "AC-9.1", text: "both halves hold", from: "spec.md", checks: ["verify/a.ts", "verify/b.ts"] };
  is(acc.questionOf(two, "run:node verify/a.ts — `a: ok`").bound.length === 0 &&
     acc.questionOf(two, "run:node verify/a.ts — `a: ok`; run:node verify/b.ts — `b: ok`").bound.length === 2,
     "a row naming one of a criterion's two declared checks was read as resting on the plan");
  const free = acc.questionOf(criteria.get("AC-1.1"), "check:intake — `intake: ok`");
  is(free.bound.length === 0 && free.subject.startsWith("AC-1.1: "), `a row naming no declared check: ${JSON.stringify(free)}`);
  const evidenceOf = (row: string) => row.split("|")[3].trim();
  // The memo key is `<doc>#<row>#<digest of the subject asked and the evidence>`, so a reading
  // taken on other evidence is not a reading of this one.
  const digestOf = (id: string, row: string) => acc.questionOf(criteria.get(id), evidenceOf(row)).digest;
  const reading = (id: string, row: string, value: string, at: string) =>
    recorded(r.name, `review.md#${id}#${digestOf(id, row)}`,
             "evidence_relation", value, value === "no" ? 0.1 : 0.5, at);
  // A `no` taken under an earlier wording of the question is not a reading of this one: the
  // question was changed because it gave that answer to a passing check (bug 20d5fd6e), and reusing
  // it would keep the refusal the change exists to lift. Its own initiative, so the reading the
  // platform takes when it finds none cannot land in `r`'s memo.
  {
    const q = await fresh();
    round(q, ledger(1, []), "2026-09-26T00:30:00.000Z");
    recorded(q.name, `review.md#AC-1.1#${digestOf("AC-1.1", ok1)}`,
             "evidence_relation", "no", 0.1, "2026-09-26T00:45:00.000Z", "an-older-question");
    const stale = await approval(q, table([ok1, ok2, okT]));
    is(!/AC-1\.1: evidence_relation/.test(stale.refusal ?? ""),
       `a reading taken under another question was reused: ${stale.refusal}`);
  }
  // A `no` taken after an unavailable reading of the same evidence is the reading that stands.
  {
    const u = await fresh();
    round(u, ledger(1, []), "2026-09-26T00:30:00.000Z");
    const about = `review.md#AC-1.1#${digestOf("AC-1.1", ok1)}`;
    recorded(u.name, about, "evidence_relation", "unavailable", 0, "2026-09-26T00:40:00.000Z");
    recorded(u.name, about, "evidence_relation", "no", 0.1, "2026-09-26T00:50:00.000Z");
    const later = await approval(u, table([ok1, ok2, okT]));
    is(/AC-1\.1: evidence_relation reads its evidence as not supporting/.test(later.refusal ?? ""),
       `a no taken after an unavailable reading did not refuse: ${JSON.stringify(later)}`);
  }
  reading("AC-1.1", ok1, "no", "2026-09-26T01:00:00.000Z");
  got = await approval(r, table([ok1, ok2, okT]));
  is(/AC-1\.1: evidence_relation reads its evidence as not supporting/.test(got.refusal ?? ""), `a no refuses: ${got.refusal}`);
  const v1 = "| AC-1.1 | established | check:intake — `intake ran` | |";
  reading("AC-1.1", v1, "unclear", "2026-09-26T02:00:00.000Z");
  got = await approval(r, table([v1, ok2, okT]));
  is(/AC-1\.1: evidence_relation is unclear.*sharpen/.test(got.refusal ?? ""), `a first unclear asks to sharpen: ${got.refusal}`);
  const v2 = "| AC-1.1 | established | check:intake — `intake: 1 of 1 emails became cases` | |";
  reading("AC-1.1", v2, "unclear", "2026-09-26T03:00:00.000Z");
  got = await approval(r, table([v2, ok2, okT]));
  is(/AC-1\.1: evidence_relation is unclear a second time.*stakeholder decides/.test(got.refusal ?? ""),
     `a second unclear on new evidence goes to the stakeholder: ${got.refusal}`);
  stakeholder(r, "2026-09-26T04:00:00.000Z", "AC-1.1 is established; I watched the intake run.");
  got = await approval(r, table([v2, ok2, okT]));
  is(got.refusal === null, `the stakeholder's source accepts the unclear row: ${got.refusal}`);

  // 6. the replay of a real review — the acceptance test for these rules
  const fx = JSON.parse(readFileSync("testing/review-replay/2026-09-24-plugin-eval-next-version.json", "utf8")) as {
    rounds: Array<{ file: string; added_at: string; ledger: Ledger }>;
  };
  const earlier: Ledger[] = [];
  for (const x of fx.rounds) {
    is(rr.ledgerRefusal(content(x.ledger), earlier, "review.md") === null,
       `replay round ${x.ledger.round} is refused: ${rr.ledgerRefusal(content(x.ledger), earlier, "review.md")}`);
    earlier.push(x.ledger);
  }
  const replay = async (upTo: number) => {
    const i = await fresh();
    fx.rounds.slice(0, upTo).forEach((x) => round(i, x.ledger, x.added_at, x.file));
    return i;
  };
  const expect: Array<[number, string, RegExp]> = [[1, "fix", /C1/], [2, "fix", /R2-C1/], [3, "fix", /R3-H1/],
    [4, "write_document", /review\.md/], [5, "run_experiment", /R5-H1/], [6, "run_experiment", /R6-H1.*R6-M1|R6-M1.*R6-H1/]];
  for (const [upTo, action, names] of expect) {
    m = await move(await replay(upTo));
    is(m?.action === action && names.test(JSON.stringify(m)),
       `replay after round ${upTo}: expected ${action} naming ${names}, got ${JSON.stringify(m)}`);
    console.log(`  replay after round ${upTo}: ${m?.action}`);
  }
  // A first round recorded before review.md exists files no `supports` link — there is no row to
  // point at — so its source carries the stage and no link. It is still round 1: round 2 resolving
  // its finding is accepted, and the next move is the fix, not "round 1 is owed" (bug c92d1bb1).
  {
    const u = await fresh();
    world.get(u.name)!.docs.push(env(u.name, "sources/2026-09-29-review-round-1-unlinked.md",
      { title: "Review round 1" }, content(ledger(1, [finding("R1-U", "S2")])),
      { stage: "sdlc-review", added_at: "2026-09-29T01:00:00.000Z" }, []));
    const counted = rr.reviewRounds(world.get(u.name)!.docs, "sdlc-review", "review.md");
    is(counted.length === 1, `a round-1 source with its stage and no link counted as ${counted.length} round(s), not 1`);
    const said = rr.ledgerRefusal(content(ledger(2, [], ["R1-U"])), counted.map((r: { ledger: Ledger }) => r.ledger), "review.md");
    is(said === null, `round 2 resolving an unlinked round 1's finding was refused: ${said}`);
    const mu = await move(u);
    is(mu?.action === "fix" && /R1-U/.test(mu?.why ?? ""),
       `with an unlinked round 1 on record the next move was not its fix: ${JSON.stringify(mu)}`);
    // A link naming another document still rules a source out: the stage is not a blanket pass.
    world.get(u.name)!.docs.push(env(u.name, "sources/2026-09-29-review-round-x-for-spec.md",
      { title: "Review round for spec" }, content(ledger(2, [finding("R2-S", "S2")])),
      { stage: "sdlc-review", added_at: "2026-09-29T02:00:00.000Z" }, ["spec.md"]));
    is(rr.reviewRounds(world.get(u.name)!.docs, "sdlc-review", "review.md").length === 1,
       "a sdlc-review source linked to spec.md was counted as a round of review.md");
  }

// 8. A source with no `added_at` is ordered by its row's `timestamptz` text, as an instant: compared
// as a string against an ISO one, "2026-10-07 06:00:00+00" sorts before "2026-10-07T05:00:00.000Z".
{
  const o = await fresh();
  round(o, ledger(1, [finding("R1-A", "S2")]), "2026-10-07T05:00:00.000Z", "2026-10-07-b-round-1.md");
  const late = env(o.name, "sources/2026-10-07-a-round-2.md", { title: "Review round 2" },
    content(ledger(2, [], ["R1-A"])), { stage: "sdlc-review" }, ["review.md"]);
  world.get(o.name)!.docs.push({ ...late, updated_at: "2026-10-07 06:00:00+00" });
  const order = rr.reviewRounds(world.get(o.name)!.docs, "sdlc-review", "review.md").map((x: { ledger: Ledger }) => x.ledger.round);
  is(order.join(",") === "1,2", `rounds added at 05:00Z and 06:00Z (the second with no added_at) read in the order ${order.join(",")}`);
}

// 7. A round introducing many S1/S2 findings asks `repeats_finding` of every one, eight at a time:
// each call holds a pool connection for up to 100 seconds inside `source_add`.
{
  const r = await fresh();
  round(r, ledger(1, [finding("R1-A", "S2")]), "2026-09-26T01:00:00.000Z");
  const many = Array.from({ length: 12 }, (_, k) => finding(`R2-${k}`, k % 2 ? "S1" : "S2"));
  const file = round(r, ledger(2, many, ["R1-A"]), "2026-09-26T02:00:00.000Z");
  process.env.TYPESAFE_API_KEY = "stub";
  const said = await rr.assessReviewRound(db()!, TEAM, r.name, `sources/${file}`, "sdlc-review", "review.md", "ada@zz.test");
  delete process.env.TYPESAFE_API_KEY;
  is(typed.calls === 12, `a round of 12 new S1/S2 findings asked ${typed.calls} times: ${said}`);
  is(typed.most <= 8, `a round of 12 new S1/S2 findings held ${typed.most} typed-service calls at once`);
}
typedServer.close();

if (fail.length) {
  console.error(`review-rounds: ${fail.length} failure(s)\n  - ${fail.join("\n  - ")}`);
  process.exit(1);
}
console.log("review-rounds: rounds follow evidence and stop at the budget, and approval rests on acceptance evidence");
