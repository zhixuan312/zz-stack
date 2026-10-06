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
 *   5. where a close lands (`closeLandsOn`): the declared closing document, the furthest one
 *      written, the one named — and an abandon of an initiative holding no document lands on its
 *      anchor row even when a document is named.
 *
 * Run: node checks/close-fallback-gates.ts   (also run by scripts/gate.ts)
 */
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import pg from "pg";

process.env.ZZ_CATALOG_DIR = join(process.cwd(), "catalog");
process.env.TEAM_DB_URL = "postgresql://stub@127.0.0.1:1/stub";

const TEAM = "t1";
interface W { flow: string | null; docs: Record<string, unknown>[]; facts: Record<string, string>;
             records: Record<string, Record<string, string>> }
const world = new Map<string, W>();
let seq = 0;

pg.Pool.prototype.query = (async function query(text: string, values: unknown[] = []) {
  const sql = String(text).replace(/\s+/g, " ").trim();
  const one = (rows: Record<string, unknown>[]) => ({ rows, rowCount: rows.length });
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
    return one(bySlug ? [{ id: "i1", flow: bySlug.flow, opened_at: "2026-09-25",
                           opened_by: "ada@zz.test", slug: String(values[1]) }] : []);
  }
  if (/from zz\.doc d\b/.test(sql) && /order by d\.path/.test(sql)) {
    return one(world.get(String(values[0]))?.docs ?? []);
  }
  if (/from zz\.doc d\b/.test(sql)) {
    const hit = (bySlug?.docs ?? []).filter((d) => d.path === values[2]);
    return one(hit.length ? [hit[hit.length - 1]] : []);
  }
  if (/from zz\.doc_revision r\b/.test(sql) && /where r\.doc_id = \$1::uuid/.test(sql)) {
    const d = [...world.values()].flatMap((x) => x.docs).find((x) => x.id === String(values[0]));
    return one(d ? [{ revision: 1, content_state: "retained", title: d.title, body: d.body,
                      tags: [], content_hash: "h", fields: d.fields, revision_note: null,
                      written_by: "ada@zz.test", written_at: d.updated_at,
                      approved_by: d.approved_by, approved_at: d.approved_at }] : []);
  }
  if (/from zz\.initiative_fact f\b/.test(sql)) {
    return one(Object.entries(bySlug?.facts ?? {}).map(([fact, value]) => ({ fact, value })));
  }
  if (/from zz\.initiative_record r\b/.test(sql)) {
    return one(Object.entries(bySlug?.records ?? {}).flatMap(([stage, ids]) =>
      Object.entries(ids).map(([id_name, value]) => ({ stage, id_name, value }))));
  }
  return one([]);
}) as unknown as typeof pg.Pool.prototype.query;

const load = (p: string) => import(pathToFileURL(join(process.cwd(), p)).href);
const { chainFor } = await load("services/zz-core/dist/chain.js");
const { documentGuards } = await load("services/zz-core/dist/guards.js");
const { db } = await load("services/zz-core/dist/platform-db.js");

const fail: string[] = [];
const is = (cond: unknown, why: string) => { if (!cond) fail.push(why); };

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
/** The columns a doc row carries; every other key is the revision's own envelope payload. */
const COLUMNS = new Set(["status", "outcome", "approved_by", "approved_at", "closed_by", "title", "flow", "version"]);
const row = (initiative: string, path: string, fields: Record<string, string>, text: string) => ({
  id: `d${++seq}`, path, initiative, flow: "", type: "",
  status: fields.status ?? "", outcome: fields.outcome ?? null,
  approved_by: fields.approved_by ?? null, approved_at: fields.approved_at ?? null,
  closed_by: fields.closed_by ?? null, updated_at: "2026-09-25T00:00:00.000Z",
  title: fields.title ?? path, body: text.split("\n---\n\n")[1] ?? text, tags: [],
  current_revision: Number(fields.version) || 1, approved_revision: null,
  fields: Object.fromEntries(Object.entries(fields).filter(([k]) => !COLUMNS.has(k))),
});

let n = 0;
async function open(flow: string, facts: Record<string, string> | null) {
  const name = `2026-09-25-close-${++n}`;
  const w: W = { flow, docs: [], facts: facts ?? {}, records: {} };
  world.set(name, w);
  const chain: Chain = await chainFor(db()!, TEAM, `${name}/x.md`) as Chain;
  const write = (doc: string, fields: Record<string, string>) =>
    w.docs.push(row(name, doc, { title: doc, flow, ...fields }, body(chain, doc, { title: doc, flow, ...fields })));
  // The guard reads the rows: a database read cannot be synchronous, and the close is the
  // load-bearing case — it asks whether each required document exists, which is a question only
  // the rows can answer once documents stop being files.
  const close = async (doc: string, fields: Record<string, string>): Promise<string | null> =>
    await documentGuards(chain, `${name}/${doc}`, body(chain, doc, { title: doc, flow, ...fields }), TEAM, "fixture");
  return { name, chain, write, close };
}

// 1. skip: improvement ruled out, proposal ruled out — closes on findings.md
{
  const i = await open("zz-plugin-eval", { protocol_action: "reuse", improvement_mode: "skip", release_mode: "not_applicable" });
  is(i.chain.closingDoc === "improvement.md",
     `zz-plugin-eval's declared closing document is ${i.chain.closingDoc}, not improvement.md — this check's premise moved`);
  i.write("findings.md", {});
  const got = await i.close("findings.md", FINISHED);
  is(got === null, `skip: a finished close on findings.md was refused: ${JSON.stringify(got)}`);
}

// 2. proposal_only: closes on proposal.md; findings.md alone is not enough
{
  const i = await open("zz-plugin-eval", { protocol_action: "reuse", improvement_mode: "proposal", release_mode: "proposal_only" });
  i.write("findings.md", {});
  const early = await i.close("findings.md", FINISHED);
  is(typeof early === "string" && /proposal\.md does not exist/.test(early),
     `proposal_only: a finished close on findings.md without proposal.md was not refused for it: ${JSON.stringify(early)}`);
  i.write("proposal.md", {});
  const got = await i.close("proposal.md", FINISHED);
  is(got === null, `proposal_only: a finished close on proposal.md was refused: ${JSON.stringify(got)}`);
}

// 3. promotable: closes on improvement.md, which is gated and the declared closing document
{
  const i = await open("zz-plugin-eval", { protocol_action: "reuse", improvement_mode: "release", release_mode: "promotable" });
  i.write("findings.md", {});
  i.write("improvement.md", {});
  const draft = await i.close("improvement.md", FINISHED);
  is(typeof draft === "string" && /cannot be closed while its own approval is unrecorded/.test(draft),
     `promotable: a finished close on a draft improvement.md was not refused for its own gate: ${JSON.stringify(draft)}`);
  const got = await i.close("improvement.md", { ...APPROVED, ...FINISHED });
  is(got === null, `promotable: a finished close on an approved improvement.md was refused: ${JSON.stringify(got)}`);
}

// 4. sdlc-flow abandoned with its gates in draft — the stop lands on the furthest document
{
  const i = await open("sdlc-flow", null);
  is(i.chain.closingDoc === "review.md",
     `sdlc-flow's declared closing document is ${i.chain.closingDoc}, not review.md — this check's premise moved`);
  i.write("explore.md", {});
  i.write("spec.md", { status: "draft" });
  const got = await i.close("spec.md", { status: "draft", ...STOPPED });
  is(got === null, `sdlc: abandoning on a draft spec.md (no review.md) was refused: ${JSON.stringify(got)}`);
  const finished = await i.close("spec.md", { status: "draft", ...FINISHED });
  is(finished === null || !/own approval is unrecorded/.test(finished),
     `sdlc: a finished outcome on spec.md was judged as a close on it: ${JSON.stringify(finished)}`);

  const j = await open("sdlc-flow", null);
  j.write("explore.md", {});
  j.write("spec.md", APPROVED);
  j.write("plan.md", { status: "draft" });
  const plan = await j.close("plan.md", { status: "draft", ...STOPPED });
  is(plan === null, `sdlc: abandoning on a draft plan.md was refused: ${JSON.stringify(plan)}`);
}

// 5. where the close lands, as `closeLandsOn` answers it — and an abandon of an initiative holding
//    no document lands on its anchor row even when the caller names a document (bug 8fcf5d90)
{
  const { closeLandsOn } = await load("services/zz-core/dist/tools/initiative-close.js");
  const docs = [{ name: "explore.md" }, { name: "spec.md" }, { name: "plan.md" }, { name: "review.md" }];
  const at = (o: Record<string, unknown>) => closeLandsOn({ initiative: "i", stopped: true, held: [],
    closingDoc: "review.md", documents: docs, ruledOut: false, named: "", ...o });
  is(at({ named: "explore.md" }) === "", `an abandon of an empty initiative naming explore.md landed on "${at({ named: "explore.md" })}"`);
  is(at({}) === "", "an abandon of an empty initiative did not land on its anchor row");
  is(at({ held: ["i/explore.md", "i/spec.md"] }) === "spec.md", "an abandon did not land on the furthest document written");
  is(at({ held: ["i/explore.md", "i/spec.md"], named: "explore.md" }) === "explore.md", "an abandon ignored the document named");
  is(at({ stopped: false, held: ["i/review.md"], named: "explore.md" }) === "review.md",
     "a finished close did not land on the flow's declared closing document");
  is(at({ stopped: false, closingDoc: null, held: ["i/notes.md"], named: "notes.md" }) === "notes.md",
     "a freeform close did not land on the document named");
}

// DELIBERATE: the file version's damaged-facts cases — a DAMAGED `_facts.json` refusing its own
// initiative, and an abandon still landing over it — have nothing left to assert. A row is written
// whole by the database or not at all, so the truncated or non-object file they guarded cannot
// arise; the refusals they proved named a state the store can no longer be in. `factsFor`
// (initiative-record.ts) carries that reasoning in its own docstring.

if (fail.length) {
  console.error(`close-fallback-gates: ${fail.length} failure(s)\n  - ${fail.join("\n  - ")}`);
  process.exit(1);
}
console.log("close-fallback-gates: skip, proposal_only and promotable each close where their branch " +
            "lands, and a stop on a fallback draft is not asked for that draft's approval");
