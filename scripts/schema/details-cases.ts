/**
 * The complete-error and detail-page cases of `checks/document-normalize.ts` (AC-2.2), through a
 * real zz-core on a throwaway database: every fault of a call that depends on no other comes back in
 * one answer, and a list too long for a reply is a counted preview — its total exact, what it left
 * out counted — backed by a detail `document_read(path, details_ref, cursor)` returns whole, page by
 * page, the same bytes every time.
 *
 * A helper, not a check: every `.ts` under `checks/` is a check the gate runs. The close case needs a
 * flow no shipped catalog declares — hundreds of documents a close can be missing — so this module
 * also makes the catalog copy that carries it (`fixtureCatalog`), outside the checkout.
 */
import { cpSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { root } from "../deployment.ts";
import { addSources, esc, first, refusedUnchanged } from "./normalize-cases.ts";
import type { Core } from "./throwaway-core.ts";

/** The most a receipt or a refusal may carry, and the most one detail page does (document-details.ts). */
const REPLY_BUDGET = 16 * 1024;
const PAGE_BYTES = 12_000;
const bytes = (s: string): number => Buffer.byteLength(s, "utf8");

/** The fixture flow: a closing document, five gated ones and 250 required ones nobody writes. */
const FIXTURE_FLOW = "close-fixture";
const GATED = Array.from({ length: 5 }, (_, i) => `gated-${i + 1}.md`);
const REQUIRED = Array.from({ length: 250 }, (_, i) =>
  `required-${String(i + 1).padStart(3, "0")}-a-document-whose-name-is-long-enough-to-fill-a-reply.md`);

/** A copy of the checkout's catalog with the fixture flow added, in a directory of its own, and
 *  how to remove it. The checkout's `catalog/` is never written. */
export function fixtureCatalog(): { dir: string; remove: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "zz-normalize-catalog-"));
  cpSync(join(root, "catalog"), dir, { recursive: true });
  mkdirSync(join(dir, "fixture", FIXTURE_FLOW), { recursive: true });
  writeFileSync(join(dir, "fixture", FIXTURE_FLOW, "flow.json"), JSON.stringify({
    name: FIXTURE_FLOW,
    stages: [{ name: "fixture-write", produces: "close.md" }],
    documents: [
      ...GATED.map((name) => ({ name, gate: true })),
      ...REQUIRED.map((name) => ({ name, requiredForClose: true })),
      { name: "close.md", closing: true, stage: "fixture-write" },
    ],
  }, null, 2));
  return { dir, remove: () => rmSync(dir, { recursive: true, force: true }) };
}

/** One counted list of a reply: its label, the separator between entries, and the text after its
 *  preview on the same line. */
interface List { label: string; sep?: string; tail?: string }

/** How many entries of a counted list a reply shows whole, and its total. An entry cut short ends
 *  in `…` and is not shown whole; a preview cut short ends in a lone `…`. */
function shownOf(step: string, c: Core, line: string, l: List): { total: number; shown: number } {
  const m = new RegExp(`${esc(l.label)} \\((\\d+)\\): (.*)$`).exec(line) ?? c.fail(step, `no \`${l.label} (n)\` in: ${line}`);
  let preview = m[2];
  if (l.tail !== undefined) {
    if (!preview.endsWith(l.tail)) c.fail(step, `\`${l.label}\` does not end with its tail: ${line}`);
    preview = preview.slice(0, preview.length - l.tail.length);
  }
  const items = preview === "none" ? [] : preview.split(l.sep ?? ", ").filter((x) => x !== "…");
  return { total: Number(m[1]), shown: items.filter((x) => !x.endsWith("…")).length };
}

/** A reply that fits the budget, states every total exactly, and says how many entries it left out
 *  — every entry of every list not shown whole, and every one-entry line it dropped. `lines` are
 *  the counted lines the reply must carry, each matched by its own pattern; `dropped` the lines of
 *  the reply's own kind it is expected to be missing. Answers the details ref. */
function accounted(c: Core, step: string, reply: string,
                   lists: (List & { at: RegExp; total: number })[], dropped = 0): string {
  if (bytes(reply) > REPLY_BUDGET) c.fail(step, `the reply is ${bytes(reply)} bytes, over ${REPLY_BUDGET}`);
  let missing = dropped;
  for (const l of lists) {
    const line = reply.split("\n").find((x) => l.at.test(x)) ?? c.fail(step, `no line matching ${l.at} in: ${reply}`);
    const got = shownOf(step, c, line, l);
    if (got.total !== l.total) c.fail(step, `\`${l.label}\` says ${got.total}, and there are ${l.total}: ${line}`);
    missing += got.total - got.shown;
  }
  const [ref, hidden] = /^details: `(dr_[a-z2-7]{26})` — (\d+) entr(?:y|ies) not shown above$/m.exec(reply)?.slice(1)
    ?? c.fail(step, `no details line counting what was left out: ${reply}`);
  if (Number(hidden) !== missing) c.fail(step, `the details line says ${hidden} not shown, and ${missing} are not shown whole`);
  return ref;
}

/** The detail a ref names, read back through `document_read` page by page — each page headed with
 *  the bytes it covers, at most PAGE_BYTES, starting where the last ended — and compared byte for
 *  byte with what the activity row stores. */
async function readDetail(c: Core, step: string, path: string, ref: string): Promise<string> {
  let text = "";
  let cursor: string | undefined;
  let pages = 0;
  for (;;) {
    const got = await c.ok(step, "document_read", { path, details_ref: ref, ...(cursor ? { cursor } : {}) });
    const lines = got.split("\n");
    const head = new RegExp(`^details \`${ref}\` of ${esc(path)} — bytes (\\d+)–(\\d+) of (\\d+)$`).exec(lines[0])
      ?? c.fail(step, `a page is not headed with its bytes: ${lines[0]}`);
    const page = lines.slice(1, -1).join("\n");
    if (Number(head[1]) !== bytes(text) || Number(head[2]) - Number(head[1]) !== bytes(page) || bytes(page) > PAGE_BYTES) {
      c.fail(step, `page ${pages + 1} is ${bytes(page)} bytes, headed ${lines[0]}, after ${bytes(text)} bytes`);
    }
    text += page;
    pages += 1;
    const next = /^Next: cursor (dc_[a-z2-7]+)$/.exec(lines[lines.length - 1]);
    if (!next) {
      if (lines[lines.length - 1] !== "complete") c.fail(step, `the last page ends with: ${lines[lines.length - 1]}`);
      break;
    }
    cursor = next[1];
    if (pages > 400) c.fail(step, "more than 400 pages");
  }
  const { rows } = await c.sql.query<{ details: string }>(
    "select detail->>'details' as details from zz.event where detail->>'details_ref' = $1", [ref]);
  if (rows.length !== 1) c.fail(step, `${rows.length} activity rows carry ${ref}`);
  if (rows[0].details !== text) c.fail(step, `the pages read back are not the stored detail (${bytes(text)} of ${bytes(rows[0].details)} bytes)`);
  if (bytes(text) > PAGE_BYTES && pages < 2) c.fail(step, `a ${bytes(text)}-byte detail came back in one page`);
  return text;
}

/** The detail reads back the same after the document it is about changed again. */
async function sameAfter(c: Core, step: string, path: string, ref: string, detail: string): Promise<void> {
  if (await readDetail(c, step, path, ref) !== detail) c.fail(step, `${ref} reads differently after a later edit of ${path}`);
}

/** Every fault of one call that depends on no other, in one answer. */
export async function independentFaults(c: Core): Promise<void> {
  const I = await c.open("independent-faults");
  const p = `${I}/notes.md`;
  await c.ok("write the faulted document", "document_write", { path: p, content: "# Notes\n\nkept\n" });

  let step = "a malformed `sources` entry with a NO_MATCH edit: both reported";
  let said = await refusedUnchanged(c, step, p, { sources: ["sources/a b.md"], edits: [{ find: "nowhere", replace: "x" }] }, /^ERROR: /);
  for (const want of [/^ERROR: INVALID_MODE — source "sources\/a b\.md" must be a path inside the initiative/m,
                      /^ERROR: NO_MATCH — edit 0 \(0-based\): `find` does not occur/m]) {
    if (!want.test(said)) c.fail(step, `${want} is not reported: ${said}`);
  }
  c.pass(step);

  step = "a bad tag with a reserved field and an UNSUPPORTED_METADATA key: all reported, on both tools";
  const faulted = { content: "---\ndueDate: x\n---\n# Notes\n\nkept\n", tags: ["Not A Tag"], fields: { status: "approved" } };
  const wants = [/^ERROR: "not a tag" is not a tag/m, /^ERROR: status is written by the platform/m,
                 /^ERROR: UNSUPPORTED_METADATA — the content's envelope carries "dueDate"/m];
  said = await refusedUnchanged(c, step, p, faulted, /^ERROR: /);
  for (const want of wants) if (!want.test(said)) c.fail(step, `document_edit: ${want} is not reported: ${said}`);
  said = await c.refused(step, "document_write", { path: `${I}/faulted.md`, ...faulted }, /^ERROR: /);
  for (const want of wants) if (!want.test(said)) c.fail(step, `document_write: ${want} is not reported: ${said}`);
  c.pass(step);

  // Carried into Phase 2's wave 4: the named sources were looked up after the no_change test, so a
  // call that changed nothing and named a source that does not exist answered no_change.
  step = "a named source that does not exist is refused whatever the body does — a no_change included — and beside every other fault";
  const absent = `${I}/sources/2026-01-01-absent.md`;
  const missing = new RegExp(`^ERROR: named sources that are not documents in this team's store \\(1\\): ${esc(absent)} — none can be named`, "m");
  for (const args of [{ content: "# Notes\n\nkept\n" }, { title: "Notes" }, { edits: [{ find: "kept", replace: "kept" }] }]) {
    said = await refusedUnchanged(c, step, p, { ...args, sources: ["sources/2026-01-01-absent.md"] }, /^ERROR: /);
    if (!missing.test(said)) c.fail(step, `${JSON.stringify(args)}: ${said}`);
  }
  said = await refusedUnchanged(c, step, p, { edits: [{ find: "nowhere", replace: "x" }],
                                              sources: ["sources/a b.md", "sources/2026-01-01-absent.md"] }, /^ERROR: /);
  for (const want of [/^ERROR: INVALID_MODE — source "sources\/a b\.md"/m, /^ERROR: NO_MATCH — edit 0 /m, missing]) {
    if (!want.test(said)) c.fail(step, `${want} is not reported: ${said}`);
  }
  said = await c.refused(step, "document_write", { path: `${I}/created.md`, content: "# Created\n",
                                                   sources: ["../up.md", "sources/2026-01-01-absent.md"] }, /^ERROR: /);
  for (const want of [/^ERROR: INVALID_MODE — source "\.\.\/up\.md" must be a path inside the initiative/m,
                      new RegExp(`^ERROR: named sources that are not documents in this team's store \\(1\\): ${esc(absent)}`, "m")]) {
    if (!want.test(said)) c.fail(step, `document_write: ${want} is not reported: ${said}`);
  }
  c.pass(step);
}

/** Cause, match and normalisation lists past 16 KiB, and one sentence past it on its own. */
export async function longLists(c: Core): Promise<void> {
  const I = await c.open("details-lists");

  let step = "150 causes named as `./sources/<name>`: the receipt fits 16 KiB, `causes (150)` and `normalised (150)` exact, every page of its detail read back, the same after a later edit";
  const p = `${I}/causes.md`;
  await c.ok(step, "document_write", { path: p, content: "# Causes\n\nold\n" });
  const names = await addSources(c, step, Array.from({ length: 150 }, (_, i) => ({ initiative: I,
    title: `${String(i + 1).padStart(3, "0")} cause with a title long enough to fill a receipt line`, content: "why" })));
  const spelt = names.map((n) => `./${n.slice(I.length + 1).replace(/\.md$/, "")}`);
  let reply = await c.ok(step, "document_edit", { path: p, edits: [{ find: "old", replace: "new" }], sources: spelt });
  if (first(reply) !== `edited: ${p} — v2 (new version)`) c.fail(step, reply);
  let ref = accounted(c, step, reply, [
    { label: "changed sections", at: /^changed sections \(/, total: 1 },
    { label: "causes", at: /^causes \(/, total: 150 },
    { label: "normalised", sep: "; ", at: /^normalised \(/, total: 150 },
  ]);
  let detail = await readDetail(c, step, p, ref);
  for (const [i, n] of names.entries()) {
    if (!detail.includes(`\n- ${n} (agent)\n`) || !detail.includes(`\n- "${spelt[i]}" read as "${n.slice(I.length + 1)}"`)) {
      c.fail(step, `the detail does not name ${n} as a cause and as a normalisation`);
    }
  }
  await c.ok(step, "document_edit", { path: p, edits: [{ find: "new", replace: "newer" }] });
  await sameAfter(c, step, p, ref, detail);
  c.pass(step);

  step = "a `find` on 4,000 lines beside 127 that match nothing: the refusal fits 16 KiB, `lines (4000)` exact, every line it dropped counted, and its document.refused detail read back page by page";
  const m = `${I}/matches.md`;
  await c.ok(step, "document_write", { path: m, content: `# M\n\n${"zq\n".repeat(4000)}` });
  const misses = Array.from({ length: 127 }, (_, i) => ({ find: `text the body never held, number ${i + 1}, spelt out at length`, replace: "x" }));
  reply = await refusedUnchanged(c, step, m, { edits: [{ find: "zq", replace: "x" }, ...misses] }, /^ERROR: MULTIPLE_MATCHES — edit 0 /);
  const shownMisses = reply.split("\n").filter((l) => /^ERROR: NO_MATCH — edit \d+ /.test(l)).length;
  if (shownMisses === 127) c.fail(step, `a ${bytes(reply)}-byte refusal kept all 127 NO_MATCH lines`);
  ref = accounted(c, step, reply, [{ label: "lines", at: /^ERROR: MULTIPLE_MATCHES — edit 0 /, total: 4000,
    tail: ". Send a longer `find` that includes enough surrounding text to occur exactly once." }], 127 - shownMisses);
  detail = await readDetail(c, step, m, ref);
  for (let n = 3; n <= 4002; n++) if (!detail.includes(`\n- ${n}\n`)) c.fail(step, `the detail does not name line ${n}`);
  for (let i = 1; i <= 127; i++) if (!detail.includes(`edit ${i} (0-based)`)) c.fail(step, `the detail does not name edit ${i}`);
  await c.ok(step, "document_edit", { path: m, edits: [{ find: "# M", replace: "# Matches" }] });
  await sameAfter(c, step, m, ref, detail);
  c.pass(step);

  step = "400 flow fields in a created document's envelope: the receipt fits 16 KiB, `normalised (400)` exact, every field stored, every page of its detail read back, the same after a later edit";
  const f = `${I}/fields.md`;
  const fields = Array.from({ length: 400 }, (_, i) => `field_${String(i + 1).padStart(3, "0")}_named_long_enough_to_fill_a_receipt`);
  reply = await c.ok(step, "document_write", { path: f, content: `---\n${fields.map((k, i) => `${k}: v${i + 1}`).join("\n")}\n---\n# Fields\n\nbody\n` });
  if (!reply.startsWith(`written: ${f} (`)) c.fail(step, reply);
  ref = accounted(c, step, reply, [{ label: "normalised", sep: "; ", at: /^normalised \(/, total: 400 }]);
  const read = await c.ok(step, "document_read", { path: f });
  for (const [i, k] of fields.entries()) if (!read.includes(`\n${k}: v${i + 1}\n`)) c.fail(step, `${k} was not stored`);
  detail = await readDetail(c, step, f, ref);
  for (const k of fields) if (!detail.includes(`\n- took ${k} from the content's envelope`)) c.fail(step, `the detail does not name ${k}`);
  await c.ok(step, "document_edit", { path: f, edits: [{ find: "body", replace: "the body" }] });
  await sameAfter(c, step, f, ref, detail);
  c.pass(step);

  step = "one sentence past 16 KiB on its own — 600 tags that are not tags — is cut on a code point, ends `…`, counts as one entry not shown, and its detail holds it whole";
  const tags = Array.from({ length: 600 }, (_, i) => `Not a tag because it has spaces ${i + 1}`);
  const t = `${I}/tags.md`;
  reply = await c.refused(step, "document_write", { path: t, content: "# Tags\n", tags }, /^ERROR: "not a tag because it has spaces 1", /);
  if (bytes(reply) > REPLY_BUDGET) c.fail(step, `the refusal is ${bytes(reply)} bytes`);
  const lines = reply.split("\n");
  if (lines.length !== 2 || !lines[0].endsWith("…")) c.fail(step, `expected one cut line and the details line: ${reply.slice(0, 300)}…`);
  ref = /^details: `(dr_[a-z2-7]{26})` — 1 entry not shown above$/.exec(lines[1])?.[1] ?? c.fail(step, `the details line: ${lines[1]}`);
  detail = await readDetail(c, step, t, ref);
  if (!detail.startsWith(lines[0].slice(0, -1)) || !detail.includes("are not tags — a tag is lowercase letters")) c.fail(step, "the detail is not the sentence whole");
  for (const tag of tags) if (!detail.includes(JSON.stringify(tag.toLowerCase()))) c.fail(step, `the detail does not name "${tag}"`);
  c.pass(step);
}

/** A review ledger and a close whose problem lists run past 16 KiB. */
export async function longRefusals(c: Core): Promise<void> {
  let step = "a review ledger with 1,801 problems: the refusal fits 16 KiB, `problems (1801)` exact, and its document.refused detail read back page by page";
  const L = await c.open("details-ledger", "sdlc-flow");
  const findings = Array.from({ length: 300 }, (_, i) => ({ id: `F${String(i + 1).padStart(3, "0")}` }));
  const ledger = `# Review round 1\n\n\`\`\`json\n${JSON.stringify({ round: 1, findings })}\n\`\`\`\n`;
  let reply = await c.refused(step, "source_add", { initiative: L, title: "Review round 1", content: ledger,
                                                     supports: ["review.md"], stage: "sdlc-review" },
    /^ERROR: this review\.md review round is not recorded — problems \(1801\): /);
  let ref = accounted(c, step, reply, [{ label: "problems", sep: "; ", at: /^ERROR: this review\.md review round/, total: 1801,
                                         tail: ". The ledger's shape is in the sdlc-review skill." }]);
  // The row is on the path the source asked for: read it from there, as a caller would from the reply.
  const at = (await c.sql.query<{ subject: string }>("select subject from zz.event where detail->>'details_ref' = $1", [ref])).rows[0]?.subject
    ?? c.fail(step, `no row carries ${ref}`);
  if (!new RegExp(`^${esc(L)}/sources/\\d{4}-\\d{2}-\\d{2}-review-round-1\\.md$`).test(at)) c.fail(step, `the detail is recorded on ${at}`);
  let detail = await readDetail(c, step, at, ref);
  for (const f of findings) {
    for (const what of ["has no `locator`", "has no `claim`", "`impact` must be one of", "`evidence` must be one of",
                        "`reproducer` is a check or command, or null", "`introduced_by_scope` is true or false"]) {
      if (!detail.includes(`\n- finding ${f.id}${what.startsWith("has") ? " " : ": "}${what}`)) c.fail(step, `the detail does not say finding ${f.id} ${what}`);
    }
  }
  c.pass(step);

  step = `a close of a ${FIXTURE_FLOW} initiative missing 250 required documents with 5 gates unapproved: the refusal fits 16 KiB, both lists exact, and its document.refused detail read back page by page, the same after a later edit`;
  const K = await c.open("details-close", FIXTURE_FLOW);
  for (const g of GATED) await c.ok(step, "document_write", { path: `${K}/${g}`, content: `# ${g}\n\ndraft\n` });
  await c.ok(step, "document_write", { path: `${K}/close.md`, content: "# Close\n\nthe end\n" });
  reply = await c.refused(step, "initiative_close", { initiative: K, disposition: "finished" }, /^ERROR: /);
  ref = accounted(c, step, reply, [
    { label: "documents carrying a gate this flow declares that are not approved", at: /documents carrying a gate this flow declares/, total: 5,
      tail: ", so this initiative cannot close as accepted. Call document_approve on each once the stakeholder agrees — or, if the " +
        "work stopped rather than finished, call initiative_close(initiative, \"abandoned\"), which says so in the team's ledger. A gate left open is not a gate passed." },
    { label: "documents that do not exist", at: /documents that do not exist \(/, total: 250,
      tail: " — this flow's manifest requires each before the initiative can close as finished, under exactly that name. If the work STOPPED " +
        "rather than finished, initiative_close(initiative, \"abandoned\") records that and does not ask for them — a document nobody wrote is not made true by the close needing one." },
  ]);
  detail = await readDetail(c, step, `${K}/close.md`, ref);
  for (const d of [...GATED, ...REQUIRED]) if (!detail.includes(`\n- ${K}/${d}\n`) && !detail.endsWith(`\n- ${K}/${d}`)) c.fail(step, `the detail does not name ${d}`);
  await c.ok(step, "document_edit", { path: `${K}/close.md`, edits: [{ find: "the end", replace: "the end, again" }] });
  await sameAfter(c, step, `${K}/close.md`, ref, detail);
  c.pass(step);
}
