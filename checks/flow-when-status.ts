#!/usr/bin/env node
/**
 * Conditional documents in the flow contract (FR-52, FR-58; Task I-26) — everywhere
 * `documentApplies` (checks/flow-when.ts) is wired into the platform, over a fixture store and a
 * fixture flow manifest carrying `when`-documents. Never the real zz-plugin-eval catalog
 * manifest: writing it is a later task's job (I-26's own plan boundary says so), and driving a
 * fixture keeps this check independent of what that task ships.
 *
 * The fixture flow: `protocol.md` (gated, `when: protocol_action`), `findings.md` (gated,
 * closing, requires protocol.md), `improvement.md` (gated, requiredForClose, `when:
 * release_mode`, requires findings.md) — the shape spec v8's FR-53 describes, without copying
 * its exact document set.
 *
 *   1. reuse: protocol.md is `not_applicable` — excluded from `next_move` and from
 *      `documents[].applies`'s sibling states, discharged as a dependency (findings.md is
 *      writable without it), and refused if written anyway. improvement.md is `not_applicable`
 *      too (`proposal_only`) and is discharged from `closeRequires`, so the initiative can close.
 *   2. create: protocol.md `applies` — required, and its own write succeeds.
 *   3. promotable: improvement.md `applies` and is required before close.
 *   4. no branch fact set at all: protocol.md is `undetermined` — `next_move` names
 *      `resolve_branch`, and its own write is refused as not writable yet.
 *   5. `protocol_action` known and `release_mode` missing: improvement.md is `undetermined`,
 *      which refuses a FINISHED close naming `branch_undetermined`, and does not refuse an
 *      ABANDONED one.
 *   6. a document with no `when` carries no `applies` field at all — today's behaviour,
 *      unchanged.
 *
 * Run: node checks/flow-when-status.ts   (also run by scripts/gate.ts)
 */
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import pg from "pg";

process.env.TEAM_DB_URL = "postgresql://stub@127.0.0.1:1/stub";

const TEAM = "t1";
interface W { flow: string | null; docs: Record<string, unknown>[]; facts: Record<string, string>;
             records: Record<string, Record<string, string>> }
const world = new Map<string, W>();
let seq = 0;
const COLUMNS = new Set(["status", "outcome", "approved_by", "approved_at", "closed_by", "title", "flow", "version"]);
const row = (initiative: string, path: string, fields: Record<string, string>, text: string) => ({
  id: `d${++seq}`, path, initiative, flow: "", type: "",
  status: fields.status ?? "", outcome: fields.outcome ?? null,
  approved_by: fields.approved_by ?? null, approved_at: fields.approved_at ?? null,
  closed_by: fields.closed_by ?? null, updated_at: "2026-09-25T00:00:00.000Z",
  title: fields.title ?? path, body: text.split("\n---\n\n")[1] ?? text, tags: [],
  current_revision: Number(fields.version) || 1, approved_revision: null,
  current_version: Number(fields.version) || 1, content_generation: "0",
  fields: Object.fromEntries(Object.entries(fields).filter(([k]) => !COLUMNS.has(k))),
});

pg.Pool.prototype.query = (async function query(text: string, values: unknown[] = []) {
  const sql = String(text).replace(/\s+/g, " ").trim();
  const one = (rows: Record<string, unknown>[]) => ({ rows, rowCount: rows.length });
  const bySlug = world.get(String(values[1] ?? ""));
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
    return one(d ? [{ revision: 1, version: 1, content_state: "retained", title: d.title, body: d.body,
                      tags: [], content_hash: "h", fields: d.fields, revision_note: null,
                      written_by: "ada@zz.test", written_at: d.updated_at,
                      approved_by: d.approved_by, approved_at: d.approved_at }] : []);
  }
  if (/from zz\.initiative_fact f\b/.test(sql)) {
    return one(Object.entries(bySlug?.facts ?? {}).map(([fact, value]) => ({ fact, value })));
  }
  if (/from zz\.initiative_record r\b/.test(sql)) return one([]);
  return one([]);
}) as unknown as typeof pg.Pool.prototype.query;

const load = (p: string) => import(pathToFileURL(join(process.cwd(), p)).href);
const { initiativeState } = await load("services/zz-core/dist/tools/initiative-status.js");
const { documentGuards } = await load("services/zz-core/dist/guards.js");
const { db } = await load("services/zz-core/dist/platform-db.js");

const fail: string[] = [];
const is = (cond: unknown, why: string) => { if (!cond) fail.push(why); };

const doc = (fields: Record<string, string>, body: string) =>
  `---\n${Object.entries(fields).map(([k, v]) => `${k}: ${v}`).join("\n")}\n---\n\n${body}\n`;

/** The slice of a resolved chain `initiativeState`/`documentGuards` read — built inline, the
 *  same way checks/initiative-open.ts does, because EMPTY_CHAIN's shape is not exported. */
interface DocSpec {
  name: string; role?: string; gate?: boolean; closing?: boolean;
  requires?: string; requiredForClose?: boolean;
  when?: Record<string, string | string[]>;
}
interface Chain {
  name: string | null; documents: DocSpec[]; stages: unknown[];
  docs: Set<string>; requires: Record<string, string>; closingDoc: string;
  closeRequires: string[]; roles: Record<string, string>;
}
const chainOf = (name: string | null, documents: DocSpec[]): Chain => ({
  name, documents, stages: [],
  docs: new Set(documents.map((d) => d.name)),
  requires: Object.fromEntries(documents.filter((d) => d.requires).map((d) => [d.name, d.requires as string])),
  closingDoc: documents.find((d) => d.closing)?.name ?? documents[documents.length - 1]?.name ?? "",
  closeRequires: documents.filter((d) => d.requiredForClose).map((d) => d.name),
  roles: Object.fromEntries(documents.filter((d) => d.role).map((d) => [d.name, d.role as string])),
});

const CHAIN = chainOf("fixture-when-flow", [
  { name: "protocol.md", gate: true, when: { protocol_action: ["create", "revise"] } },
  { name: "findings.md", gate: true, closing: true, requires: "protocol.md" },
  { name: "improvement.md", gate: true, requiredForClose: true,
    when: { release_mode: "promotable" }, requires: "findings.md" },
]);

const init = (name: string): string => { world.set(name, { flow: null, docs: [], facts: {}, records: {} }); return name; };
const facts = (initiative: string, values: Record<string, string>) => { world.get(initiative)!.facts = values; };
const approved = (title: string) =>
  doc({ title, status: "approved", approved_by: "ada@zz.test", approved_at: "2026-09-25" }, `# ${title}`);
/** A document that EXISTS: its row's status and approver are columns, its body the bytes. */
const wrote = (initiative: string, path: string, text: string, cols: Record<string, string> = {}) =>
  world.get(initiative)!.docs.push(row(initiative, path,
    { title: path.replace(/\.md$/, ""), status: "approved", approved_by: "ada@zz.test",
      approved_at: "2026-09-25", ...cols }, text));

// 1. reuse: protocol.md is not_applicable everywhere
const A = init("2026-09-25-reuse");
facts(A, { protocol_action: "reuse", release_mode: "proposal_only" });
let st = await initiativeState(db()!, TEAM, A, CHAIN, CHAIN.documents);
const protocolA = st.documents.find((d: { name: string }) => d.name === "protocol.md");
is(protocolA?.applies === "not_applicable",
   `protocol.md under protocol_action=reuse reports applies=${JSON.stringify(protocolA?.applies)}`);
is(st.next_move?.action === "write_document" && st.next_move?.document === "findings.md",
   `with protocol.md ruled out, the next move is ${JSON.stringify(st.next_move)} — findings.md ` +
   "should be next, discharged of a dependency the branch ruled out");
const refusedProtocolA = await documentGuards(CHAIN, `${A}/protocol.md`, doc({ title: "P" }, "# P"), TEAM, "fixture");
is(typeof refusedProtocolA === "string" && /does not apply on this branch/.test(refusedProtocolA),
   `writing a not_applicable document was not refused: ${JSON.stringify(refusedProtocolA)}`);
const okFindingsA = await documentGuards(CHAIN, `${A}/findings.md`, approved("F"), TEAM, "fixture");
is(okFindingsA === null,
   `findings.md, whose dependency the branch ruled out, was refused: ${JSON.stringify(okFindingsA)}`);
wrote(A, "findings.md", approved("F"));
st = await initiativeState(db()!, TEAM, A, CHAIN, CHAIN.documents);
// NOT A TOOL: `close` here is `next_move.action`, initiative_status's own verb vocabulary —
// the tool it names in its `why` is initiative_close.
is(st.next_move?.action === "close",
   `with findings.md approved and improvement.md ruled out (proposal_only), the next move is ` +
   `${JSON.stringify(st.next_move)} — it should be ready to close without improvement.md`);
const closeA = await documentGuards(CHAIN, `${A}/findings.md`,
  doc({ title: "F", status: "approved", approved_by: "ada@zz.test", approved_at: "2026-09-25",
        outcome: "delivered", closed_by: "ada@zz.test", no_signoff_reason: "nobody signed" }, "# F"),
  TEAM, "fixture");
is(closeA === null,
   `closing with protocol.md and improvement.md both ruled out was refused: ${JSON.stringify(closeA)}`);

// 2. create: protocol.md applies
const B = init("2026-09-25-create");
facts(B, { protocol_action: "create", release_mode: "proposal_only" });
st = await initiativeState(db()!, TEAM, B, CHAIN, CHAIN.documents);
is(st.next_move?.action === "write_document" && st.next_move?.document === "protocol.md",
   `under protocol_action=create the next move is ${JSON.stringify(st.next_move)}, not protocol.md`);
const okProtocolB = await documentGuards(CHAIN, `${B}/protocol.md`, approved("P"), TEAM, "fixture");
is(okProtocolB === null, `writing protocol.md when it applies was refused: ${JSON.stringify(okProtocolB)}`);

// 3. promotable: improvement.md is required before close
const C = init("2026-09-25-promotable");
facts(C, { protocol_action: "reuse", release_mode: "promotable" });
wrote(C, "findings.md", approved("F"));
st = await initiativeState(db()!, TEAM, C, CHAIN, CHAIN.documents);
is(st.next_move?.action === "write_document" && st.next_move?.document === "improvement.md",
   `under release_mode=promotable, with findings.md approved, the next move is ` +
   `${JSON.stringify(st.next_move)}, not improvement.md`);
const closeBeforeImprovement = await documentGuards(CHAIN, `${C}/findings.md`,
  doc({ title: "F", status: "approved", approved_by: "ada@zz.test", approved_at: "2026-09-25",
        outcome: "delivered", closed_by: "ada@zz.test", no_signoff_reason: "x" }, "# F"),
  TEAM, "fixture");
is(typeof closeBeforeImprovement === "string",
   "closing while improvement.md (requiredForClose, and applicable under promotable) does not " +
   "exist was admitted");
wrote(C, "improvement.md", approved("I"));
st = await initiativeState(db()!, TEAM, C, CHAIN, CHAIN.documents);
// NOT A TOOL: `close` here is `next_move.action` again — the same vocabulary as above.
is(st.next_move?.action === "close",
   `with improvement.md written and approved the next move is ${JSON.stringify(st.next_move)}`);

// 4. no _facts.json at all: protocol.md is undetermined
const E = init("2026-09-25-undetermined");
st = await initiativeState(db()!, TEAM, E, CHAIN, CHAIN.documents);
const protocolE = st.documents.find((d: { name: string }) => d.name === "protocol.md");
is(protocolE?.applies === "undetermined",
   `protocol.md with no _facts.json reports applies=${JSON.stringify(protocolE?.applies)}`);
is(st.next_move?.action === "resolve_branch" && st.next_move?.document === "protocol.md",
   `with no _facts.json at all the next move is ${JSON.stringify(st.next_move)}, not resolve_branch`);
const refusedProtocolE = await documentGuards(CHAIN, `${E}/protocol.md`, doc({ title: "P" }, "# P"), TEAM, "fixture");
is(typeof refusedProtocolE === "string" && /not writable yet/.test(refusedProtocolE),
   `writing an undetermined document was not refused as not writable yet: ${JSON.stringify(refusedProtocolE)}`);

// 5. protocol_action known, release_mode missing: improvement.md is undetermined, and that
// blocks a FINISHED close but not an ABANDONED one.
const D = init("2026-09-25-partial-facts");
facts(D, { protocol_action: "create" });
wrote(D, "protocol.md", approved("P"));
wrote(D, "findings.md", approved("F"));
const finishedAttempt = await documentGuards(CHAIN, `${D}/findings.md`,
  doc({ title: "F", status: "approved", approved_by: "ada@zz.test", approved_at: "2026-09-25",
        outcome: "delivered", closed_by: "ada@zz.test", no_signoff_reason: "x" }, "# F"),
  TEAM, "fixture");
is(typeof finishedAttempt === "string" && /branch_undetermined/.test(finishedAttempt),
   `a finished close with improvement.md's branch undetermined was not refused as ` +
   `branch_undetermined: ${JSON.stringify(finishedAttempt)}`);
const abandonedAttempt = await documentGuards(CHAIN, `${D}/findings.md`,
  doc({ title: "F", status: "approved", approved_by: "ada@zz.test", approved_at: "2026-09-25",
        outcome: "abandoned", closed_by: "ada@zz.test" }, "# F"),
  TEAM, "fixture");
is(abandonedAttempt === null,
   `an ABANDONED close was refused despite an undetermined branch, which the contract exempts: ` +
   `${JSON.stringify(abandonedAttempt)}`);

// 6. a document with no `when` carries no `applies` at all — today's behaviour, unchanged
const findingsE = st.documents?.find?.((d: { name: string }) => d.name === "findings.md");
is(findingsE === undefined || findingsE.applies === undefined,
   `findings.md, which declares no when, reports applies=${JSON.stringify(findingsE?.applies)} ` +
   "— a document with no when must be silent about applicability, exactly as before this task");


if (fail.length) {
  console.error(`flow-when-status: ${fail.length} failure(s)\n  - ${fail.join("\n  - ")}`);
  process.exit(1);
}
console.log("flow-when-status: not_applicable is discharged everywhere, undetermined blocks a " +
            "finished close and not an abandoned one, and a plain document is unaffected");
