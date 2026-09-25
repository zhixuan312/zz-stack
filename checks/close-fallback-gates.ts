#!/usr/bin/env node
/**
 * Where a close lands, and which gate that document still owes — over the REAL catalog
 * manifests of zz-plugin-eval and sdlc-flow, through the real `chainFor` and `documentGuards`.
 *
 * A close lands on the flow's declared closing document, or — when the branch ruled that
 * document out, or the work stopped before it was written — on the furthest document that
 * exists (`closingDocRuledOut`, initiative-close.ts). The fallback document's own gate is waived
 * for a STOP and only for a stop: it is where the work happened to end, not a document the flow
 * asked to close on. The declared closing document's gate is never waived.
 *
 *   1. zz-plugin-eval, improvement skipped (release_mode not_applicable): a finished close on
 *      findings.md is admitted.
 *   2. zz-plugin-eval, proposal_only: a finished close on proposal.md is admitted, and one on
 *      findings.md while proposal.md (requiredForClose on this branch) is missing is refused.
 *   3. zz-plugin-eval, promotable: a finished close on improvement.md is refused while it is a
 *      draft and admitted once approved.
 *   4. sdlc-flow abandoned mid-draft: a stop on spec.md (gated, draft, no review.md) is
 *      admitted, and so is one on plan.md in draft; a FINISHED close there is not a close at all.
 *   5. a damaged `_facts.json` — the branch a close is judged on — is refused by name for that
 *      initiative, and the no-argument listing reports it as damaged and still lists the rest.
 *   6. over that same damage an ABANDON still lands — the one way out of an initiative whose
 *      branch cannot be read — while a finished close is refused with a refusal that names the
 *      abandon and the operator repair.
 *
 * Run: node checks/close-fallback-gates.ts   (also run by scripts/gate.ts)
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

process.env.ZZ_CATALOG_DIR = join(process.cwd(), "catalog");

const load = (p: string) => import(pathToFileURL(join(process.cwd(), p)).href);
const { chainFor } = await load("services/zz-core/dist/chain.js");
const { documentGuards } = await load("services/zz-core/dist/guards.js");
const rec = await load("services/zz-core/dist/initiative-record.js");
const { initiativeListing, initiativeState } = await load("services/zz-core/dist/tools/initiative-status.js");

const fail: string[] = [];
const is = (cond: unknown, why: string) => { if (!cond) fail.push(why); };

const root = mkdtempSync(join(tmpdir(), "close-fallback-gates-"));

interface Doc { name: string; sections?: string[] }
interface Chain { documents: Doc[]; closingDoc: string }

/** A document carrying every section its manifest declares, so the section rule never answers
 *  for the close rule this check is about. */
const body = (chain: Chain, name: string, fields: Record<string, string>): string => {
  const sections = chain.documents.find((d) => d.name === name)?.sections ?? [];
  return `---\n${Object.entries(fields).map(([k, v]) => `${k}: ${v}`).join("\n")}\n---\n\n# ${name}\n\n` +
    sections.map((s) => `## ${s}\n\nText.\n`).join("\n");
};
const APPROVED = { status: "approved", approved_by: "ada@zz.test", approved_at: "2026-09-25" };
const FINISHED = { outcome: "delivered", closed_by: "ada@zz.test", no_signoff_reason: "nobody signed" };
const STOPPED = { outcome: "abandoned", closed_by: "ada@zz.test" };

let n = 0;
function open(flow: string, facts: Record<string, string> | null) {
  const name = `2026-09-25-close-${++n}`;
  rec.recordOpen(root, name, flow, "ada@zz.test");
  if (facts) rec.writeFacts(root, name, facts);
  const chain: Chain = chainFor(root, `${name}/x.md`);
  const write = (doc: string, fields: Record<string, string>) =>
    writeFileSync(join(root, name, doc), body(chain, doc, { title: doc, flow, ...fields }));
  const close = (doc: string, fields: Record<string, string>): string | null =>
    documentGuards(chain, root, `${name}/${doc}`, body(chain, doc, { title: doc, flow, ...fields }), null, "fixture");
  return { name, chain, write, close };
}

// 1. skip: improvement ruled out, proposal ruled out — closes on findings.md
{
  const i = open("zz-plugin-eval", { protocol_action: "reuse", improvement_mode: "skip", release_mode: "not_applicable" });
  is(i.chain.closingDoc === "improvement.md",
     `zz-plugin-eval's declared closing document is ${i.chain.closingDoc}, not improvement.md — this check's premise moved`);
  i.write("findings.md", {});
  const got = i.close("findings.md", FINISHED);
  is(got === null, `skip: a finished close on findings.md was refused: ${JSON.stringify(got)}`);
}

// 2. proposal_only: closes on proposal.md; findings.md alone is not enough
{
  const i = open("zz-plugin-eval", { protocol_action: "reuse", improvement_mode: "proposal", release_mode: "proposal_only" });
  i.write("findings.md", {});
  const early = i.close("findings.md", FINISHED);
  is(typeof early === "string" && /proposal\.md does not exist/.test(early),
     `proposal_only: a finished close on findings.md without proposal.md was not refused for it: ${JSON.stringify(early)}`);
  i.write("proposal.md", {});
  const got = i.close("proposal.md", FINISHED);
  is(got === null, `proposal_only: a finished close on proposal.md was refused: ${JSON.stringify(got)}`);
}

// 3. promotable: closes on improvement.md, which is gated and the declared closing document
{
  const i = open("zz-plugin-eval", { protocol_action: "reuse", improvement_mode: "search", release_mode: "promotable" });
  i.write("findings.md", {});
  i.write("improvement.md", {});
  const draft = i.close("improvement.md", FINISHED);
  is(typeof draft === "string" && /cannot be closed while its own approval is unrecorded/.test(draft),
     `promotable: a finished close on a draft improvement.md was not refused for its own gate: ${JSON.stringify(draft)}`);
  const got = i.close("improvement.md", { ...APPROVED, ...FINISHED });
  is(got === null, `promotable: a finished close on an approved improvement.md was refused: ${JSON.stringify(got)}`);
}

// 4. sdlc-flow abandoned with its gates in draft — the stop lands on the furthest document
{
  const i = open("sdlc-flow", null);
  is(i.chain.closingDoc === "review.md",
     `sdlc-flow's declared closing document is ${i.chain.closingDoc}, not review.md — this check's premise moved`);
  i.write("explore.md", {});
  i.write("spec.md", { status: "draft" });
  const got = i.close("spec.md", { status: "draft", ...STOPPED });
  is(got === null, `sdlc: abandoning on a draft spec.md (no review.md) was refused: ${JSON.stringify(got)}`);
  const finished = i.close("spec.md", { status: "draft", ...FINISHED });
  is(finished === null || !/own approval is unrecorded/.test(finished),
     `sdlc: a finished outcome on spec.md was judged as a close on it: ${JSON.stringify(finished)}`);

  const j = open("sdlc-flow", null);
  j.write("explore.md", {});
  j.write("spec.md", APPROVED);
  j.write("plan.md", { status: "draft" });
  const plan = j.close("plan.md", { status: "draft", ...STOPPED });
  is(plan === null, `sdlc: abandoning on a draft plan.md was refused: ${JSON.stringify(plan)}`);
}

// 5. a damaged _facts.json refuses its own initiative and does not take down the listing
{
  const bad = open("zz-plugin-eval", null);
  writeFileSync(join(root, bad.name, "_facts.json"), "{ truncated");
  let direct: unknown = null;
  try { direct = initiativeState(root, bad.name, bad.chain, bad.chain.documents); } catch (err) { direct = err; }
  is(direct instanceof Error && /_facts\.json is not a JSON object/.test(direct.message),
     `a damaged _facts.json was not refused by name for its own initiative: ${String(direct)}`);
  const good = open("sdlc-flow", null);
  good.write("explore.md", {});
  const listed = initiativeListing(root, [bad.name, good.name]);
  const damaged = listed.open.find((s: { initiative: string }) => s.initiative === bad.name);
  is(damaged?.damaged === true && /_facts\.json is not a JSON object/.test(damaged?.error ?? ""),
     `the listing did not report the damaged initiative with its refusal: ${JSON.stringify(damaged)}`);
  is(listed.open.some((s: { name?: string; initiative?: string; next_move?: unknown }) =>
       (s.name ?? s.initiative) === good.name && s.next_move),
     `the listing dropped the healthy initiative beside a damaged one: ${JSON.stringify(listed)}`);
}

// 6. a damaged _facts.json still lets the work stop, and says how to repair it otherwise
{
  const i = open("zz-plugin-eval", null);
  i.write("findings.md", {});
  writeFileSync(join(root, i.name, "_facts.json"), "[\"not an object\"]");
  let finished: unknown = null;
  try { finished = i.close("findings.md", FINISHED); } catch (err) { finished = err; }
  const said = finished instanceof Error ? finished.message : String(finished);
  is(/_facts\.json is not a JSON object/.test(said) && /initiative_close\(.*"abandoned"\)/.test(said) &&
     /zz\.initiative_fact/.test(said),
     `a finished close over a damaged _facts.json did not refuse naming the abandon and the repair: ${said}`);
  let stopped: unknown = null;
  try { stopped = i.close("findings.md", STOPPED); } catch (err) { stopped = err; }
  is(stopped === null, `an abandon over a damaged _facts.json was refused: ${String(stopped)}`);
}

rmSync(root, { recursive: true, force: true });

if (fail.length) {
  console.error(`close-fallback-gates: ${fail.length} failure(s)\n  - ${fail.join("\n  - ")}`);
  process.exit(1);
}
console.log("close-fallback-gates: skip, proposal_only and promotable each close where their branch " +
            "lands, a stop on a fallback draft is not asked for that draft's approval, and a damaged " +
            "_facts.json still lets the work stop");
