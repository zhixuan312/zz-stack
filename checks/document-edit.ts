#!/usr/bin/env node
/**
 * checks/document-edit.ts — `document_edit` through a real zz-core on a throwaway database: the
 * walking skeleton first, then every mode and every refusal (AC-0.1, AC-1.1).
 *
 *   node checks/document-edit.ts   # needs Docker and a built tree (`npm run build`)
 *
 * What it establishes, one line per case:
 *
 *   - the walking skeleton, first and on its own: a freeform `notes.md` is written, changed by a
 *     two-edit batch and read back byte-equal; a repeated `find` is refused with its line numbers
 *     and changes nothing; a `section` change lands in the same version; it is presented and
 *     approved; then a body change naming no cause is refused (`CAUSE_REQUIRED`) and changes
 *     nothing, and the same change with its cause as `source_content` opens v2;
 *   - every mode: an `edits` batch applied all or nothing; `section` chosen by text, then
 *     `section_level`, then `section_occurrence`; the whole body as `content`; metadata alone;
 *   - every step of the precedence a call is answered in, each refusal leaving the body and its
 *     content revision as they were — the path guards, the field and tag rules, a missing target,
 *     an `upload` or a `file` sent beside another body change, an upload nobody's or unstaged, a
 *     `file` while the route is off (no OPENAI_FILE_HOSTS, which names upload_start), a call sending
 *     no mode or two, the edit count, a stale `base` (named with
 *     the current token), the batch's and the section's own refusals, a body an edit makes open
 *     with a recognised envelope (one opening with a thematic break is markdown), `no_change` — a
 *     document read back and sent whole among them — and the guards; where two steps apply, the
 *     earlier answers;
 *   - normalisation: an envelope in whole `content` separated from the body, its title taken and
 *     every key the platform writes ignored, each reported; a conflicting or malformed key refused;
 *     tags lower-cased; a `supports` entry spelled `./notes` linked as `notes.md`; a source name
 *     already taken today suffixed, by `source_add` and by a captured `source_content` alike, and
 *     the reply naming the name it was filed under;
 *     — and the carried defects: a named source and a captured one asking for the same name are
 *     both linked, each as itself; content that is only an envelope is refused on both tools;
 *   - every fault of a call that depends on no other is said in one answer (AC-2.2): a malformed
 *     field, a bad tag and an unsupported envelope key; a malformed `sources` entry with every
 *     edit of a batch that cannot apply;
 *   - Chinese, emoji and CRLF bodies kept byte for byte through a create, a batch, a section and a
 *     whole body;
 *   - a 128-edit receipt naming 45 causes stays under 16 KiB with its totals, its previews cut and
 *     its details line saying how many entries it left out, and `document_read(path, details_ref)`
 *     returns every one of them, page by page; a details read combined with another mode is
 *     INVALID_MODE, and a ref on another path DETAILS_MISSING;
 *   - a stale `base` names what changed since it, at both sites — (7), and the compare-and-swap a
 *     change queued behind another meets — as the change set's records when the base snapshot is
 *     retained (it was presented, so the change filed a new row), and says it is not retained when
 *     the change rewrote it in place;
 *   - a current row written before generations were stored per row keeps the identity it was read
 *     under when a change supersedes it — by a new version or a new row beside a presented one — so
 *     its token still reads its bytes, and a stale `base` naming it lists what changed.
 *
 * The request key's conflict, step (0), is `checks/document-edit-races.ts`'s, with the races, the
 * replays, the injected failures and an upload's consumption.
 *
 * Exit 0: every case held — one line per case, then the final line.
 * Exit 1: a case failed — the case and what was found, then zz-core's last output.
 * Exit 2: Docker is not available — the check could not run, and that is not a pass.
 */
import { documentBody } from "@zz/contracts";

import { type Core, withThrowawayCore } from "../scripts/schema/throwaway-core.ts";

const NAME = "document-edit";
// `upload_start` builds its routes on the address a client dials; the child inherits it.
process.env.GATEWAY_PUBLIC_URL ??= "https://api.example.test";

const first = (reply: string): string => reply.split("\n")[0];
const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The body a read returns, every byte of it from its first character: `documentBody` returns
 *  what the author wrote, without the separator (checks/document-body-roundtrip.ts). */
async function bodyOf(c: Core, step: string, path: string): Promise<string> {
  return documentBody(await c.ok(step, "document_read", { path }));
}

/** The content revision a read of the current document states. */
async function tokenOf(c: Core, step: string, path: string): Promise<string> {
  const read = await c.ok(step, "document_read", { path });
  return /^content_revision: (cr_[a-z2-7]{26})$/m.exec(read)?.[1] ?? c.fail(step, `no content_revision in: ${read}`);
}

/** Body and content revision, as one comparable fact. */
async function stateOf(c: Core, step: string, path: string): Promise<{ body: string; token: string }> {
  return { body: await bodyOf(c, step, path), token: await tokenOf(c, step, path) };
}

/** A refusal that leaves the document exactly as it was: its body and its content revision. */
async function refusedUnchanged(c: Core, step: string, path: string, args: Record<string, unknown>,
                                expect: RegExp): Promise<string> {
  const before = await stateOf(c, step, path);
  const reply = await c.refused(step, "document_edit", { path, ...args }, expect);
  const after = await stateOf(c, step, path);
  if (after.body !== before.body) c.fail(step, `the refused call changed the body: ${JSON.stringify(after.body)}`);
  if (after.token !== before.token) c.fail(step, `the refused call moved the content revision to ${after.token}`);
  return reply;
}

/** The body as read equals `want`, byte for byte. */
async function bodyIs(c: Core, step: string, path: string, want: string): Promise<void> {
  const got = await bodyOf(c, step, path);
  if (got !== want) c.fail(step, `expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
}

/** Two calls on one document, granted its lock in the order they are started: the first queues
 *  behind the check's hold, the second — computed before it queued — behind the first. */
async function staged(c: Core, step: string, path: string, one: () => Promise<string>,
                      two: () => Promise<string>): Promise<[string, string]> {
  const key = c.docKey(path);
  await c.hold(key);
  let a: Promise<string>, b: Promise<string>;
  try {
    a = one();
    await c.waiters(step, key, 1);
    b = two();
    await c.waiters(step, key, 2);
  } finally {
    await c.release(key);
  }
  return Promise.all([a, b]);
}

async function skeleton(c: Core): Promise<void> {
  const name = await c.open("edit-skeleton");
  const path = `${name}/notes.md`;
  const original = "# Notes\n\nalpha line\n\nbeta line\n";
  const edited = "# Notes\n\nALPHA LINE\n\nBETA LINE\n";

  let step = "document_write";
  await c.ok(step, "document_write", { path, content: original });
  await bodyIs(c, "document_read (created)", path, original);
  c.pass(step);

  step = "document_edit (2 edits)";
  await c.ok(step, "document_edit", {
    path, edits: [{ find: "alpha line", replace: "ALPHA LINE" }, { find: "beta line", replace: "BETA LINE" }],
  });
  await bodyIs(c, "document_read (edited)", path, edited);
  c.pass(step);

  // Lines 3 and 5 are where `LINE` sits in what the author wrote. Before documentBody dropped the
  // envelope separator the tool answered 6 and 8 (checks/document-body-roundtrip.ts).
  step = "document_edit repeated find";
  await refusedUnchanged(c, step, path, { edits: [{ find: "LINE", replace: "x" }] },
    /^ERROR: MULTIPLE_MATCHES — edit 0 \(0-based\): `find` occurs 2 times in the body, on lines \(2\): 3, 5\. /);
  c.pass(step);

  // A draft's section changes in place: no cause, so the same public version.
  step = "document_edit with section";
  const bySection = "# Notes\n\nALPHA LINE\n\nBETA LINE, by section\n";
  const sectioned = await c.ok(step, "document_edit", { path, section: "Notes", content: bySection });
  if (first(sectioned) !== `edited: ${path} — v1`) c.fail(step, `expected the first line \`edited: ${path} — v1\`, got: ${sectioned}`);
  await bodyIs(c, step, path, bySection);
  c.pass(step);

  step = "document_present, document_approve";
  await c.sign(path);
  c.pass(step);

  // An approved body changes only with its cause, and the change opens the next version.
  const lower = { edits: [{ find: "ALPHA", replace: "alpha" }] };
  step = "document_edit on approved, no cause";
  await refusedUnchanged(c, step, path, lower, /^ERROR: CAUSE_REQUIRED — /);
  c.pass(step);
  step = "document_edit on approved, with its cause";
  const caused = await c.ok(step, "document_edit",
    { path, ...lower, source_content: "The stakeholder asked for the first line in lower case." });
  if (first(caused) !== `edited: ${path} — v2 (new version)` || !/^causes \(1\): .*\(agent\)$/m.test(caused)
      || !/^details: `dr_[a-z2-7]{26}` \(complete\)$/m.test(caused)) {
    c.fail(step, `expected v2 as a new version with an agent cause, got: ${caused}`);
  }
  await bodyIs(c, step, path, bySection.replace("ALPHA", "alpha"));
  c.pass(step);
  console.log("document-edit skeleton: create → edit (2) → present → approve: ok");
}

const DUPLICATES = "# Doc\n\nintro\n\n## Notes\n\nfirst\n\n## Notes\n\nsecond\n\n### Notes\n\nthird\n\n## End\n\nend\n";

async function modes(c: Core): Promise<void> {
  const I = await c.open("edit-modes");

  let step = "edits: a batch is applied all or nothing, every byte outside its finds kept";
  const b = `${I}/batch.md`;
  const batchBody = "# Batch\n\none  two\tthree\n\n- four\n- five\n\nsix\n";
  await c.ok(step, "document_write", { path: b, content: batchBody });
  await refusedUnchanged(c, step, b, { edits: [{ find: "one", replace: "ONE" }, { find: "four", replace: "FOUR" },
                                               { find: "seven", replace: "SEVEN" }] }, /^ERROR: NO_MATCH — edit 2 /);
  let reply = await c.ok(step, "document_edit", { path: b, edits: [
    { find: "one", replace: "ONE" }, { find: "- five\n", replace: "" }, { find: "six", replace: "six\n\nseven" }] });
  await bodyIs(c, step, b, "# Batch\n\nONE  two\tthree\n\n- four\n\nsix\n\nseven\n");
  if (!/^changed sections \(1\): Batch$/m.test(reply) || !/^causes \(0\): none$/m.test(reply)
      || !/^normalised \(0\): none$/m.test(reply)) c.fail(step, reply);
  c.pass(step);

  step = "section: one section among duplicate headings, chosen by text, level and occurrence";
  const s = `${I}/sections.md`;
  await c.ok(step, "document_write", { path: s, content: DUPLICATES });
  reply = await c.ok(step, "document_edit", { path: s, section: "Notes", section_level: 3, content: "### Notes\n\nTHIRD\n" });
  let want = DUPLICATES.replace("third", "THIRD");
  await bodyIs(c, `${step} (level 3)`, s, want);
  if (!/^changed sections \(1\): Notes \(3\)$/m.test(reply)) c.fail(step, `level 3: ${reply}`);
  reply = await c.ok(step, "document_edit",
    { path: s, section: "Notes", section_level: 2, section_occurrence: 1, content: "## Notes\n\nFIRST\n" });
  want = want.replace("first", "FIRST");
  await bodyIs(c, `${step} (level 2, occurrence 1)`, s, want);
  if (!/^changed sections \(1\): Notes$/m.test(reply)) c.fail(step, `occurrence 1: ${reply}`);
  // The second `## Notes` runs to the next heading of its level or above, its `### Notes` included.
  reply = await c.ok(step, "document_edit",
    { path: s, section: "## Notes", section_level: 2, section_occurrence: 2, content: "## Notes\n\nSECOND\n" });
  want = "# Doc\n\nintro\n\n## Notes\n\nFIRST\n\n## Notes\n\nSECOND\n\n## End\n\nend\n";
  await bodyIs(c, `${step} (level 2, occurrence 2)`, s, want);
  if (!/^changed sections \(2\): Notes \(2\), \(removed: Notes \(3\)\)$/m.test(reply)) c.fail(step, `occurrence 2: ${reply}`);
  c.pass(step);

  step = "content alone: the whole body, exactly";
  const w = `${I}/whole.md`;
  await c.ok(step, "document_write", { path: w, content: "# Whole\n\nold\n" });
  const whole = "# Whole\n\nnew first paragraph\n\n## Added\n\n  indented, trailing spaces  \n";
  reply = await c.ok(step, "document_edit", { path: w, content: whole });
  await bodyIs(c, step, w, whole);
  if (first(reply) !== `edited: ${w} — v1` || !/^changed sections \(2\): Whole, Added$/m.test(reply)) c.fail(step, reply);
  c.pass(step);

  step = "metadata alone: title, tags, stakeholder and a field change, the body untouched";
  const before = await stateOf(c, step, w);
  reply = await c.ok(step, "document_edit",
    { path: w, title: "Renamed", tags: ["alpha", "beta"], stakeholder: "Ana", fields: { component: "billing" } });
  if (first(reply) !== `edited: ${w} — v1` || !/^changed sections \(0\): none$/m.test(reply)) c.fail(step, reply);
  const read = await c.ok(step, "document_read", { path: w });
  for (const line of ["title: Renamed", "tags: alpha, beta", "stakeholder: Ana", "component: billing"]) {
    if (!new RegExp(`^${esc(line)}$`, "m").test(read)) c.fail(step, `no \`${line}\` in: ${read}`);
  }
  if (documentBody(read) !== before.body) c.fail(step, `the body moved: ${JSON.stringify(documentBody(read))}`);
  if ((await tokenOf(c, step, w)) === before.token) c.fail(step, "editable metadata changed and the content revision did not");
  c.pass(step);
}

async function precedence(c: Core): Promise<void> {
  const I = await c.open("edit-refusals");
  let said: string;
  const p = `${I}/notes.md`;
  await c.ok("write the refused document", "document_write", { path: p, content: "# Notes\n\nalpha\n\nbeta\n\nalpha beta\n" });

  let step = "(1) a source is immutable: an edit of one is refused, the source unchanged";
  const src = await c.source(step, { initiative: I, title: "Immutable", content: "as filed" });
  await refusedUnchanged(c, step, src, { edits: [{ find: "as filed", replace: "changed" }] }, /^ERROR: sources\/ holds the material/);
  c.pass(step);

  step = "(1) an initiative nobody opened is refused before its document is looked for";
  await c.refused(step, "document_edit", { path: "2026-01-01-never-opened/notes.md", content: "# x\n" },
    /^ERROR: there is no initiative named "2026-01-01-never-opened"/);
  c.pass(step);

  step = "(2) a reserved or malformed field name, and a malformed tag, are refused";
  await refusedUnchanged(c, step, p, { title: "x", fields: { status: "approved" } }, /^ERROR: status is written by the platform/);
  await refusedUnchanged(c, step, p, { fields: { "Due Date": "x" } }, /^ERROR: "Due Date" is not a frontmatter name/);
  // Lower-cased first, so what is refused is what lower-casing cannot fix: the spaces.
  await refusedUnchanged(c, step, p, { tags: ["Not A Tag"] }, /^ERROR: "not a tag" is not a tag/);
  // (2) before (3): the rules every write applies answer before the target is looked for.
  await c.refused(step, "document_edit", { path: `${I}/absent.md`, content: "# x\n", tags: ["Bad tag"] }, /is not a tag/);
  c.pass(step);

  step = "(2) every fault that depends on no other, in one answer: both field classes, a bad tag, an unsupported envelope key";
  said = await refusedUnchanged(c, step, p, { content: "---\ndueDate: x\n---\n# Notes\n", tags: ["Not A Tag"],
                                              fields: { status: "x", "Due Date": "y" } }, /^ERROR: /);
  for (const want of [/^ERROR: status is written by the platform/m, /^ERROR: "Due Date" is not a frontmatter name/m,
                      /^ERROR: "not a tag" is not a tag/m, /^ERROR: UNSUPPORTED_METADATA — the content's envelope carries "dueDate"/m]) {
    if (!want.test(said)) c.fail(step, `${want} is not reported: ${said}`);
  }
  if (/details:/.test(said)) c.fail(step, `an uncut refusal names a detail: ${said}`);
  c.pass(step);

  step = "(3) a target that does not exist is TARGET_MISSING";
  await c.refused(step, "document_edit", { path: `${I}/absent.md`, content: "# x\n" },
    new RegExp(`^ERROR: TARGET_MISSING — ${esc(I)}/absent\\.md does not exist\\. document_write creates`));
  c.pass(step);

  step = "(4) an `upload` sent with another body change is INVALID_MODE; one that is nobody's, or not staged, is refused";
  const unknown = `up_${"a".repeat(26)}`;
  await refusedUnchanged(c, step, p, { upload: unknown, content: "# x\n" }, /^ERROR: INVALID_MODE — send ONE body change/);
  await refusedUnchanged(c, step, p, { upload: unknown }, /^ERROR: FORBIDDEN — /);
  const minted = JSON.parse(await c.ok(step, "upload_start", { filename: "notes.md" })) as { upload: string };
  await refusedUnchanged(c, step, p, { upload: minted.upload }, /^ERROR: UPLOAD_MISSING — /);
  c.pass(step);

  step = "(4) a `file` sent with another body change is INVALID_MODE; with no OPENAI_FILE_HOSTS the route is off and names upload_start";
  const attached = { download_url: "https://files.example.com/f?sig=x", file_id: "file-1", file_name: "x.md" };
  await refusedUnchanged(c, step, p, { file: attached, content: "# x\n" }, /^ERROR: INVALID_MODE — send ONE body change/);
  await refusedUnchanged(c, step, p, { file: attached }, /^ERROR: FORBIDDEN — the ChatGPT file route is not enabled .*OPENAI_FILE_HOSTS.*upload_start/);
  c.pass(step);

  step = "(5) a call sending no change, or two body changes, or a malformed selector or source, is INVALID_MODE";
  for (const args of [
    {}, { note: "only a note" }, { sources: ["sources/x.md"] },
    { edits: [{ find: "alpha\n", replace: "x\n" }], content: "# x\n" },
    { section: "Notes" }, { section_level: 2, content: "# x\n" }, { section: "Notes", section_level: 5, content: "# Notes\n" },
    { section: "Notes", section_occurrence: 0, content: "# Notes\n" },
    { edits: [{ find: "beta\n", replace: "b\n" }], sources: ["../elsewhere.md"] },
  ]) {
    await refusedUnchanged(c, `${step}: ${JSON.stringify(args)}`, p, args, /^ERROR: INVALID_MODE — /);
  }
  c.pass(step);

  step = "(5) an envelope in whole `content` with a malformed key, or a value the named argument contradicts, is refused, every key named";
  said = await refusedUnchanged(c, step, p, { content: "---\ndueDate: x\nDue-Date: y\n---\n# Notes\n" },
    /^ERROR: UNSUPPORTED_METADATA — the content's envelope carries "dueDate", "Due-Date"/);
  said = await refusedUnchanged(c, step, p, { content: "---\ntitle: Alpha\n---\n# Notes\n", title: "Beta" },
    /^ERROR: METADATA_CONFLICT — title is "Alpha" in the content's envelope and "Beta" as the named argument/);
  if (/opens with one/.test(said)) c.fail(step, said);
  c.pass(step);

  step = "(6) a batch of none, or of more than 128, is EDIT_COUNT";
  const many = Array.from({ length: 129 }, (_, i) => ({ find: `z${i}`, replace: "y" }));
  for (const edits of [[], many]) {
    await refusedUnchanged(c, step, p, { edits }, /^ERROR: EDIT_COUNT — send between 1 and 128 edits in one call\.$/);
  }
  c.pass(step);

  step = "(7) a stale `base` is BASE_CONFLICT naming the current content revision, before the batch is tried";
  const stale = await tokenOf(c, step, p);
  await c.ok(step, "document_edit", { path: p, edits: [{ find: "beta\n\nalpha", replace: "beta\n\nALPHA" }] });
  const current = await tokenOf(c, step, p);
  const conflict = new RegExp(`^ERROR: BASE_CONFLICT — ${esc(p)} is at content revision ${current} now, not the one \`base\` names`);
  await refusedUnchanged(c, step, p, { base: stale, edits: [{ find: "gamma", replace: "x" }] }, conflict);
  // (6) before (7): a count refusal is answered whatever the base says.
  await refusedUnchanged(c, step, p, { base: stale, edits: [] }, /^ERROR: EDIT_COUNT/);
  c.pass(step);

  step = "(8) the batch's own refusals: NO_MATCH, MULTIPLE_MATCHES, OVERLAPPING_EDITS, INVALID_EDIT";
  await refusedUnchanged(c, step, p, { edits: [{ find: "gamma", replace: "x" }] }, /^ERROR: NO_MATCH — edit 0 \(0-based\): `find` does not occur/);
  await refusedUnchanged(c, step, p, { edits: [{ find: "beta", replace: "x" }] },
    /^ERROR: MULTIPLE_MATCHES — edit 0 \(0-based\): `find` occurs 2 times in the body, on lines \(2\): 5, 7\. /);
  await refusedUnchanged(c, step, p, { edits: [{ find: "alpha\n\nbeta", replace: "x" }, { find: "beta\n\nALPHA", replace: "y" }] },
    /^ERROR: OVERLAPPING_EDITS — edit 1 \(0-based\)/);
  await refusedUnchanged(c, step, p, { edits: [{ find: "# Notes", replace: "# N" }, { find: "# Notes", replace: "# N" }] },
    /^ERROR: OVERLAPPING_EDITS — edit 1 \(0-based\)/);
  await refusedUnchanged(c, step, p, { edits: [{ find: "", replace: "x" }] }, /^ERROR: INVALID_EDIT — edit 0 \(0-based\): `find` must be a non-empty string/);
  c.pass(step);

  step = "(8) every fault of the call, together: a malformed `sources` entry and every edit of the batch that cannot apply";
  said = await refusedUnchanged(c, step, p, { sources: ["sources/a b.md"], edits: [{ find: "gamma", replace: "x" },
    { find: "alpha\n\nbeta\n", replace: "ok\n" }, { find: "beta", replace: "x" }, { find: "", replace: "y" }] }, /^ERROR: INVALID_MODE — source "sources\/a b\.md"/);
  for (const want of [/^ERROR: NO_MATCH — edit 0 /m, /^ERROR: MULTIPLE_MATCHES — edit 2 /m, /^ERROR: INVALID_EDIT — edit 3 /m]) {
    if (!want.test(said)) c.fail(step, `${want} is not reported: ${said}`);
  }
  if (/edit 1 /.test(said)) c.fail(step, `an edit that applies is reported: ${said}`);
  c.pass(step);

  step = "(8) the section's own refusals: SECTION_MISSING, SECTION_AMBIGUOUS by level and occurrence, a replacement without its heading";
  const d = `${I}/sections.md`;
  await c.ok(step, "document_write", { path: d, content: DUPLICATES });
  let reply = await refusedUnchanged(c, step, d, { section: "Notes", content: "## Notes\n\nx\n" },
    /^ERROR: SECTION_AMBIGUOUS — 3 headings read "Notes": /);
  for (const cand of ["section_level 2, section_occurrence 1", "section_level 2, section_occurrence 2", "section_level 3, section_occurrence 1"]) {
    if (!reply.includes(cand)) c.fail(step, `the ambiguity does not list \`${cand}\`: ${reply}`);
  }
  if (/offset/.test(reply)) c.fail(step, `the edit path's ambiguity names \`offset\`: ${reply}`);
  reply = await refusedUnchanged(c, step, d, { section: "Notes", section_level: 2, content: "## Notes\n\nx\n" },
    /^ERROR: SECTION_AMBIGUOUS — 2 headings read "Notes" at level 2: /);
  await refusedUnchanged(c, step, d, { section: "Notes", section_level: 2, section_occurrence: 3, content: "## Notes\n\nx\n" },
    /^ERROR: SECTION_MISSING — no heading "Notes" at level 2 \(occurrence 3\) in .*Its headings \(5\): # Doc, ## Notes, ## Notes, ### Notes, ## End\.$/);
  await refusedUnchanged(c, step, d, { section: "Elsewhere", content: "## Elsewhere\n" }, /^ERROR: SECTION_MISSING — no heading "Elsewhere"/);
  await refusedUnchanged(c, step, d, { section: "End", content: "no heading line\n" }, /^ERROR: INVALID_EDIT — with `section`, `content` replaces the heading/);
  c.pass(step);

  step = "(8) a body an edit batch or a section would make open with a recognised envelope is refused; a thematic break is markdown";
  const f = `${I}/front.md`;
  await c.ok(step, "document_write", { path: f, content: "# Front\n\nbody\n" });
  const opens = /^ERROR: UNSUPPORTED_METADATA — this body would open with a frontmatter envelope .*Send `title`, `tags`, `stakeholder` and `fields` as named arguments/;
  said = await refusedUnchanged(c, step, f, { edits: [{ find: "# Front", replace: "---\nflow: sdlc-flow\n---\n# Front" }] }, opens);
  if (/opens with one/.test(said)) c.fail(step, `the edit path says "opens with one" to an edits caller: ${said}`);
  // After a blank line, in CRLF: recognised all the same.
  await refusedUnchanged(c, step, f, { edits: [{ find: "# Front\n", replace: "\n---\r\nstatus: approved\r\n---\r\n# Front\n" }] }, opens);
  await refusedUnchanged(c, step, f, { section: "Front", content: "---\nflow: sdlc-flow\n---\n# Front\n" }, /^ERROR: /);
  // A thematic break at the top is markdown, and so is a rule further down.
  await c.ok(step, "document_edit", { path: f, edits: [{ find: "# Front", replace: "---\n\n# Front" }] });
  await bodyIs(c, step, f, "---\n\n# Front\n\nbody\n");
  await c.ok(step, "document_edit", { path: f, edits: [{ find: "body", replace: "body\n\n---\n\nafter a rule" }] });
  await bodyIs(c, step, f, "---\n\n# Front\n\nbody\n\n---\n\nafter a rule\n");
  c.pass(step);

  step = "(9) a change that changes nothing is no_change: nothing written, the content revision kept";
  const now = await stateOf(c, step, p);
  const rev = (await c.sql.query<{ r: number; at: string }>(
    `select d.current_revision as r, r.written_at::text as at from zz.doc d join zz.initiative i on i.id = d.initiative_id
       join zz.doc_revision r on r.doc_id = d.id and r.revision = d.current_revision where i.slug = $1 and d.path = 'notes.md'`, [I])).rows[0];
  // The document as a read returns it, envelope and all, is the same document: every key the read
  // rendered is reported and none of them becomes a change.
  const whole = await c.ok(step, "document_read", { path: p });
  for (const args of [{ content: now.body }, { edits: [{ find: "alpha\n", replace: "alpha\n" }] }, { section: "Notes", content: now.body },
                      { content: whole }]) {
    reply = await c.ok(step, "document_edit", { path: p, ...args });
    if (first(reply) !== `edited: ${p} — v1 (no change)` || !reply.includes(`content revision: ${now.token}`)) c.fail(step, reply);
  }
  for (const key of ["content_revision", "version", "updated_at"]) {
    if (!new RegExp(`^normalised \\(\\d+\\): .*ignored ${key} from the content's envelope`, "m").test(reply)) c.fail(step, `${key} is not reported: ${reply}`);
  }
  // An unkeyed no_change writes no row of the document, and still the record its details_ref names.
  const noted = /^details: `(dr_[a-z2-7]{26})` \(complete\)$/m.exec(reply)?.[1] ?? c.fail(step, `no details line: ${reply}`);
  const page = await c.ok(step, "document_read", { path: p, details_ref: noted });
  if (!page.includes(`edited: ${p} — v1 (no change)`) || !/\ncomplete$/.test(page)) c.fail(step, `the no_change detail: ${page}`);
  const after = (await c.sql.query<{ r: number; at: string }>(
    `select d.current_revision as r, r.written_at::text as at from zz.doc d join zz.initiative i on i.id = d.initiative_id
       join zz.doc_revision r on r.doc_id = d.id and r.revision = d.current_revision where i.slug = $1 and d.path = 'notes.md'`, [I])).rows[0];
  if (after.r !== rev.r || after.at !== rev.at || (await tokenOf(c, step, p)) !== now.token) c.fail(step, "a no_change wrote");
  c.pass(step);

  step = "(10) an approved body changed with no cause named or owed is CAUSE_REQUIRED";
  await c.sign(p);
  await refusedUnchanged(c, step, p, { edits: [{ find: "ALPHA", replace: "omega" }] },
    new RegExp(`^ERROR: CAUSE_REQUIRED — ${esc(p)} is approved, so a change to its body opens a new version and needs its cause`));
  // (8) before (10): an edit that cannot apply is answered as such, cause or not.
  await refusedUnchanged(c, step, p, { edits: [{ find: "gamma", replace: "x" }] }, /^ERROR: NO_MATCH/);
  c.pass(step);

  step = "(11) the guards judge the candidate: a flow's declared section removed is refused";
  const X = await c.open("edit-guards", "sdlc-flow");
  const e = `${X}/explore.md`;
  await c.ok(step, "document_write", { path: e, content: "## Background\nx\n\n## Current state\nx\n\n## Rough direction\nx\n" });
  await refusedUnchanged(c, step, e, { edits: [{ find: "## Current state\nx\n\n", replace: "" }] },
    /^ERROR: explore\.md is missing the section `## Current state`\. This flow's manifest declares/);
  c.pass(step);
}

async function normalisation(c: Core): Promise<void> {
  const I = await c.open("edit-normalise");
  let said: string;
  const n = `${I}/notes.md`;
  await c.ok("write the normalised document", "document_write", { path: n, content: "# Notes\n\nold\n" });

  let step = "an envelope in whole `content` is separated: its title taken, the keys the platform writes ignored, each reported";
  let reply = await c.ok(step, "document_edit", { path: n,
    content: "\r\n---\r\ntitle: From The Envelope\r\nstatus: approved\r\nflow: some-other-flow\r\n---\r\n\r\n# Notes\r\n\r\nnew\r\n" });
  const normalised = /^normalised \(3\): (.*)$/m.exec(reply)?.[1] ?? c.fail(step, `no normalised (3) line: ${reply}`);
  for (const line of ["took title from the content's envelope", "ignored status from the content's envelope",
                      "ignored flow from the content's envelope"]) {
    if (!normalised.split("; ").some((x) => x.startsWith(line))) c.fail(step, `no \`${line}\` in: ${reply}`);
  }
  await bodyIs(c, step, n, "# Notes\r\n\r\nnew\r\n");
  const read = await c.ok(step, "document_read", { path: n });
  if (!/^title: From The Envelope$/m.test(read) || /^(status: approved|flow: some-other-flow)$/m.test(read)) c.fail(step, read);
  c.pass(step);

  step = "whole `content` opening with a thematic break is the body, every byte";
  await c.ok(step, "document_edit", { path: n, content: "---\n\n# Notes\n\nafter a rule\n" });
  await bodyIs(c, step, n, "---\n\n# Notes\n\nafter a rule\n");
  c.pass(step);

  step = "tags are lower-cased and reported";
  reply = await c.ok(step, "document_edit", { path: n, tags: ["Alpha", "beta"] });
  if (!/^normalised \(1\): tag "Alpha" lower-cased to "alpha"$/m.test(reply)) c.fail(step, reply);
  if (!/^tags: alpha, beta$/m.test(await c.ok(step, "document_read", { path: n }))) c.fail(step, "the tags were not stored lower-cased");
  c.pass(step);

  step = "a keyed retry of a normalised call replays: the key is held to what was sent, not to what it read as";
  for (const [tool, args] of [
    ["document_edit", { path: n, tags: ["Gamma"], request_id: "norm-edit-1" }],
    ["document_write", { path: `${I}/keyed.md`, content: "---\ntitle: Keyed\nstatus: approved\n---\n# Keyed\n", request_id: "norm-write-1" }],
  ] as const) {
    const once = await c.ok(step, tool, args);
    const again = await c.ok(step, tool, args);
    if (!/ \(replayed\)$/.test(first(again)) || first(again) !== `${first(once)} (replayed)`) c.fail(step, `${tool}: ${again}`);
  }
  c.pass(step);

  step = "a `supports` entry spelled `./notes` is linked to notes.md, and a source name taken today is suffixed";
  const one = await c.call(step, "source_add", { initiative: I, title: "Call notes", content: "first", supports: ["./notes"] });
  if (!/^source recorded: \S+\/sources\/\d{4}-\d{2}-\d{2}-call-notes\.md$/m.test(one) || !one.includes('normalised (1): "./notes" read as "notes.md"')
      || !/^supports \(1\): notes\.md$/m.test(one) || !/^details: `dr_[a-z2-7]{26}` \(complete\)$/m.test(one)
      || /NOT LINKED YET/.test(one)) c.fail(step, one);
  const two = await c.call(step, "source_add", { initiative: I, title: "Call notes", content: "second" });
  const taken = /^source recorded: (\S+)$/m.exec(one)?.[1] ?? "";
  if (!two.includes(`source recorded: ${taken.replace(/\.md$/, "-2.md")}`) || !two.includes(`source name: ${taken} was taken`)) c.fail(step, two);
  c.pass(step);

  step = "every `supports` entry that cannot be one is said in one answer";
  said = await c.refused(step, "source_add", { initiative: I, title: "Bad supports", content: "x", supports: ["../up.md", "has space"] },
    /^ERROR: INVALID_MODE — supports entry "\.\.\/up\.md" must be a path inside the initiative/);
  if (!/^ERROR: supports entry "has space\.md" must be a document name/m.test(said)) c.fail(step, said);
  c.pass(step);

  step = "a captured source whose name is taken is filed under the next one, and the receipt names it";
  reply = await c.ok(step, "document_edit", { path: n, edits: [{ find: "after a rule", replace: "after a call" }],
                                              source_content: "third", source_title: "Call notes" });
  const third = taken.replace(/\.md$/, "-3.md");
  if (!new RegExp(`^causes \\(\\d+\\): (.*, )?${esc(third)} \\(agent\\)`, "m").test(reply) || !reply.includes(`was taken, so the words were filed as ${third}`)) {
    c.fail(step, reply);
  }
  if ((await c.cites(n)).filter((x) => x.startsWith(third)).length !== 1) c.fail(step, `the cause is not linked to ${third}: ${(await c.cites(n)).join(" | ")}`);
  c.pass(step);

  // Carried into Phase 2's wave 3: the write repointed EVERY cause naming the asked name to the
  // captured source it suffixed, so a named source of exactly that name was linked as the capture.
  step = "a named source and a captured one asking for the same name are both linked, each as itself";
  const twin = await c.source(step, { initiative: I, title: "Twin notes", content: "the named one" });
  const twin2 = twin.replace(/\.md$/, "-2.md");
  reply = await c.ok(step, "document_edit", { path: n, edits: [{ find: "after a call", replace: "after two calls" }],
                                              sources: [twin.slice(I.length + 1)], source_content: "the captured one", source_title: "Twin notes" });
  if (!new RegExp(`^causes \\(2\\): ${esc(twin)} \\(agent\\), ${esc(twin2)} \\(agent\\)$`, "m").test(reply)) c.fail(step, reply);
  const cited = await c.cites(n);
  if (!cited.some((x) => x.startsWith(`${twin} `)) || !cited.some((x) => x.startsWith(`${twin2} `))) {
    c.fail(step, `both are not linked: ${cited.join(" | ")}`);
  }
  c.pass(step);

  // Decided in Phase 2's wave 3: whole content that is only an envelope would store an empty body.
  step = "content that is only an envelope is refused on both tools, saying what to send";
  await refusedUnchanged(c, step, n, { content: "---\ntitle: Retitled\n---\n" },
    /^ERROR: INVALID_MODE — the content held only an envelope.*send them as named arguments with no `content`/);
  await c.refused(step, "document_write", { path: `${I}/only.md`, content: "---\ntitle: Only\n---\n\n" },
    /^ERROR: INVALID_MODE — the content held only an envelope.*Send the body as `content`/);
  c.pass(step);
}

async function fidelity(c: Core): Promise<void> {
  const I = await c.open("edit-fidelity");

  let step = "Chinese and emoji, through a create, a batch, a section and a whole body, byte for byte";
  const z = `${I}/zh.md`;
  let body = "# 笔记 📝\n\n第一行：中文，标点。🙂\n\n## 第二节 👩‍👩‍👧\n\n内容 ✅ — é é\n";
  await c.ok(step, "document_write", { path: z, content: body });
  await bodyIs(c, `${step} (create)`, z, body);
  await c.ok(step, "document_edit", { path: z, edits: [{ find: "🙂", replace: "🚀" }, { find: "é", replace: "ё" }] });
  body = body.replace("🙂", "🚀").replace("é", "ё");
  await bodyIs(c, `${step} (batch)`, z, body);
  await c.ok(step, "document_edit", { path: z, section: "第二节 👩‍👩‍👧", content: "## 第二节 👩‍👩‍👧\n\n新的内容 🎉\n" });
  body = "# 笔记 📝\n\n第一行：中文，标点。🚀\n\n## 第二节 👩‍👩‍👧\n\n新的内容 🎉\n";
  await bodyIs(c, `${step} (section)`, z, body);
  body = "# 全文 🌏\n\n替换 👍🏽\n";
  await c.ok(step, "document_edit", { path: z, content: body });
  await bodyIs(c, `${step} (whole)`, z, body);
  c.pass(step);

  step = "CRLF line endings, through a create, a batch, a section and a whole body, byte for byte";
  const r = `${I}/crlf.md`;
  body = "# Notes\r\n\r\nalpha 中文\r\n\r\n## Next\r\n\r\nbeta 🙂\r\n\r\n## Last\r\n\r\nomega\r\n";
  await c.ok(step, "document_write", { path: r, content: body });
  await bodyIs(c, `${step} (create)`, r, body);
  await c.ok(step, "document_edit", { path: r, edits: [{ find: "alpha", replace: "ALPHA" }, { find: "beta 🙂\r\n", replace: "beta 🙂\r\ngamma\r\n" }] });
  body = "# Notes\r\n\r\nALPHA 中文\r\n\r\n## Next\r\n\r\nbeta 🙂\r\ngamma\r\n\r\n## Last\r\n\r\nomega\r\n";
  await bodyIs(c, `${step} (batch)`, r, body);
  // A section with a section after it, sent with no final line ending: the blank line the splice
  // adds before `## Last` is the body's own CRLF, never an LF.
  await c.ok(step, "document_edit", { path: r, section: "Next", content: "## Next\r\n\r\nsection 🎉" });
  body = "# Notes\r\n\r\nALPHA 中文\r\n\r\n## Next\r\n\r\nsection 🎉\r\n\r\n## Last\r\n\r\nomega\r\n";
  await bodyIs(c, `${step} (section)`, r, body);
  body = "# Whole\r\n\r\nline one\r\nline two\r\n";
  await c.ok(step, "document_edit", { path: r, content: body });
  await bodyIs(c, `${step} (whole)`, r, body);
  c.pass(step);
}

async function bigReceipt(c: Core): Promise<void> {
  const I = await c.open("edit-receipt");
  const step = "a 128-edit receipt with 45 causes stays under 16 KiB, its totals whole and every entry in its detail";
  const pad = "a long heading that a careless receipt would repeat in full ".repeat(4).trim();
  const nums = Array.from({ length: 128 }, (_, i) => String(i + 1).padStart(3, "0"));
  const body = `# Receipt\n\n${nums.map((n) => `## S${n} ${pad}\n\nt${n}\n`).join("\n")}`;
  const path = `${I}/big.md`;
  await c.ok(step, "document_write", { path, content: body });
  const sources: string[] = [];
  for (let i = 1; i <= 45; i++) {
    sources.push((await c.source(step, { initiative: I, title: `Cause ${i}`, content: `cause ${i}` })).slice(I.length + 1));
  }
  const reply = await c.ok(step, "document_edit",
    { path, edits: nums.map((n) => ({ find: `t${n}`, replace: `T${n}` })), sources });
  await bodyIs(c, step, path, nums.reduce((b, n) => b.replace(`t${n}`, `T${n}`), body));
  const bytes = Buffer.byteLength(reply, "utf8");
  if (bytes > 16 * 1024) c.fail(step, `the receipt is ${bytes} bytes`);
  const changed = /^changed sections \(128\): (.*)$/m.exec(reply)?.[1] ?? c.fail(step, `no changed sections (128) line: ${reply}`);
  const causes = /^causes \(45\): (.*)$/m.exec(reply)?.[1] ?? c.fail(step, `no causes (45) line: ${reply}`);
  // Shown whole: an entry cut short ends in `…`, and counts among those not shown.
  const shown = (line: string) => line.split(", ").filter((e) => !e.endsWith("…")).length;
  const [ref, hidden] = /^details: `(dr_[a-z2-7]{26})` — (\d+) entries not shown above$/m.exec(reply)?.slice(1) ?? c.fail(step, `no details line: ${reply}`);
  if (shown(changed) + shown(causes) + Number(hidden) !== 128 + 45) c.fail(step, `${shown(changed)} + ${shown(causes)} shown, ${hidden} hidden`);
  if (first(reply) !== `edited: ${path} — v2 (new version)`) c.fail(step, reply);
  // Every entry, page by page, through the read the reply names.
  let detail = "";
  let cursor: string | undefined;
  for (let page = 0; page < 10; page++) {
    const got = await c.ok(step, "document_read", { path, details_ref: ref, ...(cursor ? { cursor } : {}) });
    const lines = got.split("\n");
    if (!lines[0].startsWith(`details \`${ref}\` of ${path} — bytes `)) c.fail(step, `a page is not headed: ${lines[0]}`);
    detail += lines.slice(1, -1).join("\n");
    const next = /^Next: cursor (dc_[a-z2-7]+)$/.exec(lines[lines.length - 1]);
    if (!next) break;
    cursor = next[1];
  }
  if (!cursor) c.fail(step, "a detail of 173 entries came back in one page");
  for (const n of nums) if (!detail.includes(`\n- S${n} ${pad}`)) c.fail(step, `the detail does not name S${n}`);
  for (const src of sources) if (!detail.includes(`\n- ${I}/${src} (agent)`)) c.fail(step, `the detail does not name ${src}`);
  c.pass(step);

  const modes = "a details read combined with another mode is INVALID_MODE; a ref on another path is DETAILS_MISSING";
  for (const extra of [{ section: "Receipt" }, { offset: 0 }, { limit: 10 }, { version: 1 }, { scope: "platform" }, { path: [path] }]) {
    await c.refused(modes, "document_read", { path, details_ref: ref, ...extra }, /^ERROR: INVALID_MODE — `details_ref` reads one reply's/);
  }
  await c.refused(modes, "document_read", { path, cursor: cursor ?? "dc_x" }, /^ERROR: INVALID_MODE — `cursor` continues a details read/);
  await c.refused(modes, "document_read", { path: `${I}/other.md`, details_ref: ref },
    new RegExp(`^ERROR: DETAILS_MISSING — ${ref} is not a detail of ${esc(I)}/other\\.md$`));
  c.pass(modes);
}

const para = Array.from({ length: 30 }, (_, i) => `w${i}`).join(" ");
const planned = `# Plan\n\n${para}\n\n## Old\n\nkept ${para}\n\n## Gone\n\ngone ${para}\n`;
/** A change of `planned`: one section edited, one renamed over the same body. */
const replanned = { edits: [{ find: "# Plan\n\nw0", replace: "# Plan\n\nW0" }, { find: "## Old", replace: "## New" }] };
const AGAIN = "Read it again and apply the change to what it says now.";
const stale = (p: string, now: string) =>
  `ERROR: BASE_CONFLICT — ${p} is at content revision ${now} now, not the one \`base\` names`;
/** The reply to a stale `base` whose snapshot is retained: what changed, as records. */
const listed = (p: string, now: string) => new RegExp(`^${esc(`${stale(p, now)}; changed since \`base\` (2): ` +
  `edited "# Plan" at section 1; renamed "## Old" to "## New" at section 2. ${AGAIN}`)}$`);
/** The reply to a stale `base` whose snapshot was rewritten in place. */
const unretained = (p: string, now: string, base: string) => new RegExp(`^${esc(`${stale(p, now)}, and what changed ` +
  `since it cannot be named: ${base} was a working state that is not retained. ${AGAIN}`)}$`);

async function staleBase(c: Core): Promise<void> {
  const I = await c.open("stale-base");
  const second = c.client();
  for (const presented of [true, false]) {
    let step = `(7) a stale \`base\` ${presented ? "names the records of what changed since its retained snapshot"
                                                   : "says its snapshot was not retained"}`;
    let p = `${I}/planned-${presented}.md`;
    await c.ok(step, "document_write", { path: p, content: planned });
    let base = await tokenOf(c, step, p);
    if (presented) await c.ok(step, "document_present", { path: p });
    await c.ok(step, "document_edit", { path: p, ...replanned });
    let now = await tokenOf(c, step, p);
    await refusedUnchanged(c, step, p, { base, edits: [{ find: "## Gone", replace: "## Went" }] },
      presented ? listed(p, now) : unretained(p, now, base));
    c.pass(step);

    step = `the compare-and-swap: a change computed on \`base\` and queued behind another ${presented
      ? "names the records of what the other changed" : "says its base snapshot was not retained"}`;
    p = `${I}/raced-${presented}.md`;
    await c.ok(step, "document_write", { path: p, content: planned });
    base = await tokenOf(c, step, p);
    if (presented) await c.ok(step, "document_present", { path: p });
    const [a, b] = await staged(c, step, p,
      () => c.call(step, "document_edit", { path: p, ...replanned }),
      () => c.call(step, "document_edit", { path: p, base, edits: [{ find: "## Gone", replace: "## Went" }] }, second));
    now = await tokenOf(c, step, p);
    if (first(a) !== `edited: ${p} — v1`) c.fail(step, `the first change did not land: ${a}`);
    if (!(presented ? listed(p, now) : unretained(p, now, base)).test(b)) c.fail(step, `the queued change: ${b}`);
    c.pass(step);
  }
}

/** The current row of `path` made a row written before generations were stored per row. */
async function legacy(c: Core, path: string): Promise<void> {
  await c.sql.query(
    `update zz.doc_revision r set content_generation = null from zz.doc d join zz.initiative i on i.id = d.initiative_id
      where r.doc_id = d.id and r.revision = d.current_revision and i.slug = $1 and d.path = $2`,
    [path.split("/")[0], path.split("/").slice(1).join("/")]);
}

async function legacyRows(c: Core): Promise<void> {
  const I = await c.open("legacy-rows");
  for (const route of ["a new version", "a new row beside a presented one"]) {
    const step = `a legacy current row superseded by ${route} keeps the identity it was read under`;
    const p = `${I}/${route.startsWith("a new version") ? "versioned" : "pinned"}.md`;
    await c.ok(step, "document_write", { path: p, content: planned });
    await legacy(c, p);
    const old = await tokenOf(c, step, p);
    const cause = route.startsWith("a new version") ? { source_content: "Why the plan changed." } : {};
    if (!route.startsWith("a new version")) await c.ok(step, "document_present", { path: p });
    const edited = await c.ok(step, "document_edit", { path: p, ...replanned, ...cause });
    if (first(edited) !== `edited: ${p} — ${route.startsWith("a new version") ? "v2 (new version)" : "v1"}`) c.fail(step, edited);
    const read = await c.call(step, "document_read", { path: p, content_revision: old });
    if (documentBody(read) !== planned) c.fail(step, `the old token reads: ${read}`);
    await refusedUnchanged(c, step, p, { base: old, edits: [{ find: "## Gone", replace: "## Went" }] },
      listed(p, await tokenOf(c, step, p)));
    c.pass(step);
  }
}

process.exitCode = await withThrowawayCore(NAME,
  `${NAME}: the skeleton, every mode, every refusal in its order, byte fidelity and the receipt's bounds: ok`,
  async (c) => {
    await skeleton(c);
    await modes(c);
    await precedence(c);
    await normalisation(c);
    await fidelity(c);
    await bigReceipt(c);
    await staleBase(c);
    await legacyRows(c);
  });
