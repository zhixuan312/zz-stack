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
 *      wrong round number, `resolved` naming an unknown id, one id both restated and resolved
 *   2. `reviewRoundOf` counts only the verifying document's own stage
 *   3. every reviewMove branch: round 1, fix, run_experiment, settled, out-of-scope, S1
 *      reproduced out of scope, a repeat, the budget on a non-converging review, a renewal, an accepted residual
 *   4. the approval rules: no round and no waiver, a stakeholder's waiver, no section, a missing row, a stray row, a bad status, no locator, no
 *      quote, deferred with and without a stakeholder source, the Backlog, and `unavailable`
 *   5. the readings: `no` refuses, `unclear` asks to sharpen, `unclear` again on new evidence
 *      goes to the stakeholder, whose source accepts it
 *   6. the replay of 2026-09-24-plugin-eval-next-version: fix, fix, fix (converging, so no
 *      budget stop), settled after Round 4; Rounds 5-6 (inferred) route to run_experiment
 *
 * Run: node checks/review-rounds.ts   (also run by scripts/gate.ts)
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import pg from "pg";

process.env.ZZ_CATALOG_DIR = join(process.cwd(), "catalog");
process.env.TEAM_DB_URL = "postgresql://stub@127.0.0.1:1/stub";
delete process.env.TYPESAFE_API_KEY;

const TEAM = "t1";
/** One initiative's world: its own row, its documents, and the answers the assessor recorded. */
interface W {
  flow: string | null;
  docs: Record<string, unknown>[];
  answers: { about: string; family: string; reading: string; probability: number | null; asked_at: string }[];
}
let world = new Map<string, W>();
const blank = (flow: string | null): W => ({ flow, docs: [], answers: [] });

pg.Pool.prototype.query = (async function query(text: string, values: unknown[] = []) {
  const sql = String(text).replace(/\s+/g, " ").trim();
  const one = (rows: Record<string, unknown>[]) => ({ rows, rowCount: rows.length });
  // Two param shapes: the document and answer readers take the TEAM first and the initiative
  // second, and the one-initiative lookups take the team first and the slug second. One lookup
  // each, so a route cannot read the wrong one.
  const bySlug = world.get(String(values[1] ?? ""));
  if (/select i\.slug from zz\.initiative i join zz\.team t on t\.id = i\.team_id where t\.slug = \$1 order by i\.slug/.test(sql)) {
    return one([...world.keys()].sort().map((slug) => ({ slug })));
  }
  if (/select i\.slug, i\.flow, i\.closed_at::text/.test(sql)) {
    const names = (values[1] as string[]) ?? [];
    return one(names.filter((n) => world.has(n)).map((n) => ({
      slug: n, flow: world.get(n)!.flow, closed_at: null, closed_by: null, outcome: null })));
  }
  if (/from zz\.initiative i join zz\.team t on t\.id = i\.team_id/.test(sql)) {
    return one(bySlug ? [{ id: "i1", flow: bySlug.flow, opened_at: "2026-09-26",
                           opened_by: "ada@zz.test", slug: String(values[1]) }] : []);
  }
  // `docRows(p, team, initiative)` binds the INITIATIVE first — the one reader whose params are
  // the other way round — so its lookup is its own.
  if (/from zz\.doc d\b/.test(sql) && /order by d\.path/.test(sql)) {
    return one(world.get(String(values[0]))?.docs ?? []);
  }
  if (/from zz\.doc d\b/.test(sql)) {
    const hit = (bySlug?.docs ?? []).filter((d) => d.path === values[2]);
    return one(hit.length ? [hit[hit.length - 1]] : []);
  }
  // The revision a document currently points at: what its bytes, its title and its seal are.
  if (/from zz\.doc_revision r\b/.test(sql) && /where r\.doc_id = \$1::uuid/.test(sql)) {
    const id = String(values[0]);
    const d = [...world.values()].flatMap((w) => w.docs).find((x) => x.id === id);
    return one(d ? [{ revision: d.current_revision, content_state: "retained", title: d.title,
                      body: d.body, tags: d.tags, content_hash: "h", fields: d.fields,
                      revision_note: null, written_by: "ada@zz.test", written_at: d.updated_at,
                      approved_by: d.approved_by, approved_at: d.approved_at }] : []);
  }
  if (/from zz\.initiative_fact f\b/.test(sql)) return one([]);
  if (/from zz\.initiative_record r\b/.test(sql)) return one([]);
  if (/from zz\.assessment a\b/.test(sql) && /select a\.family/.test(sql)) {
    return one((bySlug?.answers ?? []).map((a) => ({ ...a, instruction_version: 1, question_digest: "d",
      requested_model: null, resolved_model: null, identity_assurance: null, reason: null,
      initiative: String(values[1]), asked_by: "ada@zz.test" })));
  }
  // The acceptance memo: the answers already taken, keyed by the `about` they were asked under.
  if (/select a\.about, a\.reading/.test(sql)) {
    const prefix = String(values[2]).replace(/%$/, "");
    return one((bySlug?.answers ?? []).filter((a) => a.about.startsWith(prefix))
      .map((a) => ({ about: a.about, reading: a.reading,
                     probability: a.probability === null ? null : String(a.probability),
                     reason: null, asked_at: a.asked_at })));
  }
  if (/insert into zz\.assessment\b/.test(sql)) {
    // COUPLED: the insert's own bind order — family `$1`, reading `$5`, about `$13`, slug `$16`.
    world.get(String(values[15] ?? ""))?.answers.push({
      family: String(values[0] ?? ""), reading: String(values[4] ?? ""),
      about: String(values[12] ?? ""), probability: null, asked_at: new Date().toISOString() });
    return one([{ id: "a1" }]);
  }
  return one([]);
}) as unknown as typeof pg.Pool.prototype.query;

const load = (p: string) => import(pathToFileURL(join(process.cwd(), p)).href);
const { initiativeState } = await load("services/zz-core/dist/tools/initiative-status.js");
const rr = await load("services/zz-core/dist/review-rounds.js");
const acc = await load("services/zz-core/dist/review-acceptance.js");
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
             "criteria** (← AC-1.1): the intake check passes on a sample email.\n\n" +
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
/** An answer the assessor recorded, in the grain `assessFamily` persists it. */
function recorded(name: string, about: string, family: string, reading: string, probability: number, at: string) {
  world.get(name)!.answers.push({ about, family, reading, probability, asked_at: at });
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
  stakeholder(g, "2026-09-26T03:30:00.000Z", "Keep going.");
  m = await move(g);
  is(m?.action === "fix", `a decision naming no id renews the budget: ${JSON.stringify(m)}`);
  stakeholder(g, "2026-09-26T03:40:00.000Z", "R3-X is accepted as residual.");
  m = await move(g);
  is(m?.action === "write_document" && m?.document === "review.md",
     `a stakeholder source naming R3-X accepts it and the rounds settle: ${JSON.stringify(m)}`);

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
  is(/AC-2\.1 is blocked and its evidence names no kind-prefixed locator/.test(got.refusal ?? ""), `no locator: ${got.refusal}`);
  got = await approval(e, table([ok1, "| AC-2.1 | established | check:close passed | |", okT]));
  is(/AC-2\.1 is established and quotes no output/.test(got.refusal ?? ""), `no quote: ${got.refusal}`);
  got = await approval(e, table([ok1, "| AC-2.1 | deferred | | next release |", okT]));
  is(/AC-2\.1 is deferred and no stakeholder source names it/.test(got.refusal ?? ""), `deferred alone: ${got.refusal}`);
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
  const texts = new Map(((await acc.declaredCriteriaOf(TEAM, r.name, ["spec.md", "plan.md"])) as Array<{ id: string; text: string }>)
    .map((x) => [x.id, x.text]));
  is(texts.get("I-1") === "the intake check passes on a sample email.", `a task's criterion is its technical AC: ${texts.get("I-1")}`);
  const evidenceOf = (row: string) => row.split("|")[3].trim();
  // The memo key is `<doc>#<row>#<digest of the criterion and the evidence>`, so a reading taken
  // on other evidence is not a reading of this one.
  const reading = (id: string, row: string, value: string, at: string) =>
    recorded(r.name, `review.md#${id}#${acc.rowDigest(texts.get(id), evidenceOf(row))}`,
             "evidence_relation", value, value === "no" ? 0.1 : 0.5, at);
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
if (fail.length) {
  console.error(`review-rounds: ${fail.length} failure(s)\n  - ${fail.join("\n  - ")}`);
  process.exit(1);
}
console.log("review-rounds: rounds follow evidence and stop at the budget, and approval rests on acceptance evidence");
