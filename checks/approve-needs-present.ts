#!/usr/bin/env node
/**
 * `document_approve` refuses a document whose current content was never presented.
 *
 * The handler resolves through `userRoot` and request headers, so it cannot be driven over a
 * fixture; the two halves are proved separately:
 *   1. the fact it asks — `shownSinceLastChange` — over a fixture store driven by the real
 *      `presentDocument`: false after a write, true after a present, false again after a
 *      patch, true after a present of the patched bytes;
 *   2. the registration: it asks that fact and returns the "present it first" refusal on
 *      `false`, BEFORE it persists anything — a refusal after the write would record the
 *      approval it refused.
 *
 * Run: node checks/approve-needs-present.ts
 */
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const load = (p: string) => import(pathToFileURL(join(process.cwd(), p)).href);
const { shownSinceLastChange } = await load("services/zz-core/dist/attest.js");
const { presentDocument } = await load("services/zz-core/dist/versions.js");

const fail: string[] = [];
const is = (cond: unknown, why: string) => { if (!cond) fail.push(why); };

// 1. The fact, over the real present
const root = mkdtempSync(join(tmpdir(), "zz-approve-present-"));
const INIT = "2026-09-26-approve";
const rel = `${INIT}/spec.md`;
mkdirSync(join(root, INIT), { recursive: true });
writeFileSync(join(root, rel), "---\ntitle: Spec\nversion: 1\nstatus: draft\n---\n\n# Spec\n\nbody\n");
const act = (action: string) => appendFileSync(join(root, INIT, "activity.jsonl"),
  JSON.stringify({ ts: new Date().toISOString(), user: "u@zz.test", action, path: rel }) + "\n");

act("document_write");
is(shownSinceLastChange(root, rel) === false, "written and never presented, and the approval would pass");
presentDocument(root, rel, undefined, "u@zz.test");
is(shownSinceLastChange(root, rel) === true, "presented after the write, and the approval would still refuse");
act("document_patch");
is(shownSinceLastChange(root, rel) === false, "patched after the present, and the approval would pass on unseen bytes");
presentDocument(root, rel, undefined, "u@zz.test");
is(shownSinceLastChange(root, rel) === true, "the patched bytes presented, and the approval would still refuse");

// 2. The registration refuses on it, before it writes
const src = readFileSync("services/zz-core/src/tools/initiative-acts.ts", "utf8");
const at = src.indexOf('"document_approve"');
const handler = at < 0 ? "" : src.slice(at, src.indexOf("server.registerTool(", at + 1));
if (!handler) fail.push("document_approve is not registered in initiative-acts.ts");
else {
  const asked = handler.indexOf("shownSinceLastChange(");
  const refused = handler.search(/if \(fetched === false\)\s*\{\s*return text\(\s*`ERROR: present it first/);
  const persisted = handler.indexOf("persistDocument(");
  is(asked >= 0, "document_approve no longer asks shownSinceLastChange");
  is(refused > asked, "document_approve does not return the \"present it first\" refusal when the content was not presented");
  is(persisted < 0 || refused < persisted, "document_approve refuses only after it has persisted the approval");
  is(!/NOT FETCHED/.test(handler), "document_approve still carries the old note-instead-of-refusal text");
}

if (fail.length) {
  console.error(`approve-needs-present: ${fail.length} failure(s)`);
  for (const f of fail) console.error(`  - ${f}`);
  process.exit(1);
}
console.log("approve-needs-present: refused before a present, accepted after it, refused again after a patch");
