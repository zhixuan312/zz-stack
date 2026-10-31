#!/usr/bin/env node
// handover.md follows whichever document closes the branch. zz-plugin-eval declares improvement.md
// as its closing document, which applies only when release_mode is promotable, and the handover
// was derived with `requires: improvement.md` — so on a findings-closing or proposal branch
// initiative_status named a prerequisite that will never exist.
//
// Over the REAL zz-plugin-eval manifest, through the real `chainFor`, `initiativeState` and
// `documentGuards`, on each of the three branches: the handover's requirement is the branch's
// closing document, the `close` move names that same document, and once the initiative closes
// there the handover is writable.
//
// The fixture is rows under a stubbed `pg.Pool` rather than a directory: a document is a `zz.doc`
// row, its branch facts are `zz.initiative_fact` rows and a stage's record is an
// `zz.initiative_record` row.
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { docRow, installWorld, type World } from "../scripts/schema/initiative-world.ts";

process.env.ZZ_CATALOG_DIR = join(process.cwd(), "catalog");

const TEAM = "t1";
const world = new Map<string, World>();
installWorld(world, "2026-09-26");

const load = (p: string) => import(pathToFileURL(join(process.cwd(), p)).href);
const { chainFor } = await load("services/zz-core/dist/chain.js");
const { documentGuards } = await load("services/zz-core/dist/guards.js");
const { initiativeState } = await load("services/zz-core/dist/tools/initiative-status.js");
const { db } = await load("services/zz-core/dist/platform-db.js");

const fail: string[] = [];
const is = (cond: unknown, why: string) => { if (!cond) fail.push(why); };

interface Doc { name: string; sections?: string[]; gate?: boolean }
const APPROVED = { status: "approved", approved_by: "ada@zz.test", approved_at: "2026-09-26" };
const CLOSED = { outcome: "delivered", closed_by: "ada@zz.test", no_signoff_reason: "nobody signed" };
const row = (initiative: string, path: string, fields: Record<string, string>, body: string) =>
  docRow(initiative, path, fields, body, "2026-09-26");

const branches: [string, Record<string, string>, string[], string][] = [
  ["skip", { improvement_mode: "skip", release_mode: "not_applicable" }, ["findings.md"], "findings.md"],
  ["proposal_only", { improvement_mode: "proposal", release_mode: "proposal_only" }, ["findings.md", "proposal.md"], "proposal.md"],
  ["promotable", { improvement_mode: "release", release_mode: "promotable" }, ["findings.md", "improvement.md"], "improvement.md"],
];

let n = 0;
for (const [label, facts, written, closing] of branches) {
  const name = `2026-09-26-handover-${++n}`;
  const w: World = { flow: "zz-plugin-eval", docs: [], facts: { protocol_action: "reuse", ...facts }, records: {} };
  world.set(name, w);
  for (const stage of ["zz-plugin-identify", "zz-plugin-observe", "zz-plugin-discover", "zz-plugin-evaluate"]) {
    w.records[stage] = { id: "x" };
  }
  const chain = await chainFor(db()!, TEAM, `${name}/x.md`);
  const body = (doc: string, fields: Record<string, string>) =>
    `---\n${Object.entries({ title: doc, flow: "zz-plugin-eval", ...fields }).map(([k, v]) => `${k}: ${v}`).join("\n")}\n---\n\n# ${doc}\n\n` +
    (chain.documents.find((d: Doc) => d.name === doc)?.sections ?? []).map((s: string) => `## ${s}\n\nText.\n`).join("\n");
  const docs = chain.documents;
  for (const doc of written) {
    const gate = chain.documents.find((d: Doc) => d.name === doc)?.gate;
    w.docs.push(row(name, doc, gate ? APPROVED : {}, body(doc, gate ? APPROVED : {})));
  }

  const state = await initiativeState(db()!, TEAM, name, chain, docs);
  const handover = state.documents.find((d: { name: string }) => d.name === "handover.md");
  is(handover?.requires === closing, `${label}: handover.md requires ${handover?.requires}, not ${closing}`);
  // NOT A TOOL: `close` is next_move.action's own vocabulary, not a tool name.
  is(state.next_move.action === "close" && state.next_move.document === closing,
     `${label}: next_move is ${JSON.stringify(state.next_move)}, not close on ${closing}`);

  // The close is where `initiative_close` would have recorded it: on the document, and on the
  // initiative's own row.
  const closeFields = closing === "improvement.md" ? { ...APPROVED, ...CLOSED } : CLOSED;
  w.docs = w.docs.filter((d) => d.path !== closing);
  w.docs.push(row(name, closing, closeFields, body(closing, closeFields)));
  Object.assign(w.facts, { outcome: CLOSED.outcome, closed_by: CLOSED.closed_by });
  const refused = await documentGuards(chain, `${name}/handover.md`, body("handover.md", { status: "draft" }), null, "fixture");
  is(refused === null, `${label}: closed on ${closing}, and handover.md is still refused: ${refused}`);
}

if (fail.length) { console.error(fail.join("\n")); process.exit(1); }
console.log("ok eval-handover-branch");
