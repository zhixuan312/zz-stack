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
 *     `upload`/`file`, a call sending no mode or two, the edit count, a stale `base` (named with
 *     the current token), the batch's and the section's own refusals, a body an edit makes open
 *     with frontmatter, `no_change`, and the guards; where two steps apply, the earlier answers;
 *   - Chinese, emoji and CRLF bodies kept byte for byte through a create, a batch, a section and a
 *     whole body;
 *   - a 128-edit receipt naming 45 causes stays under 16 KiB, each list capped at 40 entries.
 *
 * The request key's conflict, step (0), is `checks/document-edit-races.ts`'s, with the races, the
 * replays and the injected failures.
 *
 * Exit 0: every case held — one line per case, then the final line.
 * Exit 1: a case failed — the case and what was found, then zz-core's last output.
 * Exit 2: Docker is not available — the check could not run, and that is not a pass.
 */
import { documentBody } from "@zz/contracts";

import { type Core, withThrowawayCore } from "../scripts/schema/throwaway-core.ts";

const NAME = "document-edit";

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
    /^ERROR: MULTIPLE_MATCHES — edit 0 \(0-based\): `find` occurs 2 times, on lines 3, 5 of the body/);
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
  if (first(caused) !== `edited: ${path} — v2 (new version)` || !/^causes: .*\(agent\)/m.test(caused)) {
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
  if (!/^changed sections: Batch$/m.test(reply) || !/^causes: none$/m.test(reply)) c.fail(step, reply);
  c.pass(step);

  step = "section: one section among duplicate headings, chosen by text, level and occurrence";
  const s = `${I}/sections.md`;
  await c.ok(step, "document_write", { path: s, content: DUPLICATES });
  reply = await c.ok(step, "document_edit", { path: s, section: "Notes", section_level: 3, content: "### Notes\n\nTHIRD\n" });
  let want = DUPLICATES.replace("third", "THIRD");
  await bodyIs(c, `${step} (level 3)`, s, want);
  if (!/^changed sections: Notes \(3\)$/m.test(reply)) c.fail(step, `level 3: ${reply}`);
  reply = await c.ok(step, "document_edit",
    { path: s, section: "Notes", section_level: 2, section_occurrence: 1, content: "## Notes\n\nFIRST\n" });
  want = want.replace("first", "FIRST");
  await bodyIs(c, `${step} (level 2, occurrence 1)`, s, want);
  if (!/^changed sections: Notes$/m.test(reply)) c.fail(step, `occurrence 1: ${reply}`);
  // The second `## Notes` runs to the next heading of its level or above, its `### Notes` included.
  reply = await c.ok(step, "document_edit",
    { path: s, section: "## Notes", section_level: 2, section_occurrence: 2, content: "## Notes\n\nSECOND\n" });
  want = "# Doc\n\nintro\n\n## Notes\n\nFIRST\n\n## Notes\n\nSECOND\n\n## End\n\nend\n";
  await bodyIs(c, `${step} (level 2, occurrence 2)`, s, want);
  if (!/^changed sections: Notes \(2\), \(removed: Notes \(3\)\)$/m.test(reply)) c.fail(step, `occurrence 2: ${reply}`);
  c.pass(step);

  step = "content alone: the whole body, exactly";
  const w = `${I}/whole.md`;
  await c.ok(step, "document_write", { path: w, content: "# Whole\n\nold\n" });
  const whole = "# Whole\n\nnew first paragraph\n\n## Added\n\n  indented, trailing spaces  \n";
  reply = await c.ok(step, "document_edit", { path: w, content: whole });
  await bodyIs(c, step, w, whole);
  if (first(reply) !== `edited: ${w} — v1` || !/^changed sections: Whole, Added$/m.test(reply)) c.fail(step, reply);
  c.pass(step);

  step = "metadata alone: title, tags, stakeholder and a field change, the body untouched";
  const before = await stateOf(c, step, w);
  reply = await c.ok(step, "document_edit",
    { path: w, title: "Renamed", tags: ["alpha", "beta"], stakeholder: "Ana", fields: { component: "billing" } });
  if (first(reply) !== `edited: ${w} — v1` || !/^changed sections: none$/m.test(reply)) c.fail(step, reply);
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
  await refusedUnchanged(c, step, p, { tags: ["Not A Tag"] }, /^ERROR: "Not A Tag" is not a tag/);
  // (2) before (3): the rules every write applies answer before the target is looked for.
  await c.refused(step, "document_edit", { path: `${I}/absent.md`, content: "# x\n", tags: ["Bad"] }, /is not a tag/);
  c.pass(step);

  step = "(3) a target that does not exist is TARGET_MISSING";
  await c.refused(step, "document_edit", { path: `${I}/absent.md`, content: "# x\n" },
    new RegExp(`^ERROR: TARGET_MISSING — ${esc(I)}/absent\\.md does not exist\\. document_write creates`));
  c.pass(step);

  step = "(4) `upload` and `file` are NOT_YET, naming Phase 4";
  for (const arg of [{ upload: "up_x" }, { file: { path: "x.md" } }]) {
    await refusedUnchanged(c, step, p, { ...arg, content: "# x\n" },
      /^ERROR: NOT_YET — `(upload|file)` arrives in Phase 4 of 2026-10-06-doc-write-and-update-paradigm; send the text as `content` until then$/);
  }
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
  await refusedUnchanged(c, step, p, { content: "---\nflow: x\n---\n# Notes\n" }, /^ERROR: document_edit takes the document's BODY/);
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
  await refusedUnchanged(c, step, p, { edits: [{ find: "beta", replace: "x" }] }, /^ERROR: MULTIPLE_MATCHES — edit 0 \(0-based\): `find` occurs 2 times, on lines 5, 7 of the body/);
  await refusedUnchanged(c, step, p, { edits: [{ find: "alpha\n\nbeta", replace: "x" }, { find: "beta\n\nALPHA", replace: "y" }] },
    /^ERROR: OVERLAPPING_EDITS — edit 1 \(0-based\)/);
  await refusedUnchanged(c, step, p, { edits: [{ find: "# Notes", replace: "# N" }, { find: "# Notes", replace: "# N" }] },
    /^ERROR: OVERLAPPING_EDITS — edit 1 \(0-based\)/);
  await refusedUnchanged(c, step, p, { edits: [{ find: "", replace: "x" }] }, /^ERROR: INVALID_EDIT — edit 0 \(0-based\): `find` must be a non-empty string/);
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
    /^ERROR: SECTION_MISSING — no heading "Notes" at level 2 \(occurrence 3\) in .*Its headings: # Doc, ## Notes, ## Notes, ### Notes, ## End\.$/);
  await refusedUnchanged(c, step, d, { section: "Elsewhere", content: "## Elsewhere\n" }, /^ERROR: SECTION_MISSING — no heading "Elsewhere"/);
  await refusedUnchanged(c, step, d, { section: "End", content: "no heading line\n" }, /^ERROR: INVALID_EDIT — with `section`, `content` replaces the heading/);
  c.pass(step);

  step = "(8) a body an edit batch or a section would make open with frontmatter is refused as whole content is";
  const f = `${I}/front.md`;
  await c.ok(step, "document_write", { path: f, content: "# Front\n\nbody\n" });
  await refusedUnchanged(c, step, f, { edits: [{ find: "# Front", replace: "---\nflow: sdlc-flow\n---\n# Front" }] },
    /^ERROR: document_edit takes the document's BODY/);
  await refusedUnchanged(c, step, f, { edits: [{ find: "# Front\n", replace: "\n---\r\nstatus: approved\r\n---\r\n# Front\n" }] },
    /^ERROR: document_edit takes the document's BODY/);
  await refusedUnchanged(c, step, f, { section: "Front", content: "---\nflow: sdlc-flow\n---\n# Front\n" }, /^ERROR: /);
  // Control: a rule further down the body is ordinary markdown.
  await c.ok(step, "document_edit", { path: f, edits: [{ find: "body", replace: "body\n\n---\n\nafter a rule" }] });
  await bodyIs(c, step, f, "# Front\n\nbody\n\n---\n\nafter a rule\n");
  c.pass(step);

  step = "(9) a change that changes nothing is no_change: nothing written, the content revision kept";
  const now = await stateOf(c, step, p);
  const rev = (await c.sql.query<{ r: number; at: string }>(
    `select d.current_revision as r, r.written_at::text as at from zz.doc d join zz.initiative i on i.id = d.initiative_id
       join zz.doc_revision r on r.doc_id = d.id and r.revision = d.current_revision where i.slug = $1 and d.path = 'notes.md'`, [I])).rows[0];
  for (const args of [{ content: now.body }, { edits: [{ find: "alpha\n", replace: "alpha\n" }] }, { section: "Notes", content: now.body }]) {
    reply = await c.ok(step, "document_edit", { path: p, ...args });
    if (first(reply) !== `edited: ${p} — v1 (no change)` || !reply.includes(`content revision: ${now.token}`)) c.fail(step, reply);
  }
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

  step = "CRLF line endings, through a create, a batch and a whole body, byte for byte";
  const r = `${I}/crlf.md`;
  body = "# Notes\r\n\r\nalpha 中文\r\n\r\n## Next\r\n\r\nbeta 🙂\r\n";
  await c.ok(step, "document_write", { path: r, content: body });
  await bodyIs(c, `${step} (create)`, r, body);
  await c.ok(step, "document_edit", { path: r, edits: [{ find: "alpha", replace: "ALPHA" }, { find: "beta 🙂\r\n", replace: "beta 🙂\r\ngamma\r\n" }] });
  body = "# Notes\r\n\r\nALPHA 中文\r\n\r\n## Next\r\n\r\nbeta 🙂\r\ngamma\r\n";
  await bodyIs(c, `${step} (batch)`, r, body);
  body = "# Whole\r\n\r\nline one\r\nline two\r\n";
  await c.ok(step, "document_edit", { path: r, content: body });
  await bodyIs(c, `${step} (whole)`, r, body);
  c.pass(step);
}

async function bigReceipt(c: Core): Promise<void> {
  const I = await c.open("edit-receipt");
  const step = "a 128-edit receipt with 45 causes stays under 16 KiB, each list capped at 40";
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
  if (bytes >= 16 * 1024) c.fail(step, `the receipt is ${bytes} bytes`);
  const changed = /^changed sections: (.*)$/m.exec(reply)?.[1] ?? c.fail(step, `no changed sections line: ${reply}`);
  const causes = /^causes: (.*)$/m.exec(reply)?.[1] ?? c.fail(step, `no causes line: ${reply}`);
  if (!changed.endsWith(", … and 88 more") || changed.split(", ").length !== 41) c.fail(step, `changed sections: ${changed}`);
  if (!causes.endsWith(", … and 5 more") || causes.split(", ").length !== 41) c.fail(step, `causes: ${causes}`);
  if (changed.split(", ").some((e) => e.length > 120)) c.fail(step, `an entry is not cut: ${changed}`);
  if (first(reply) !== `edited: ${path} — v2 (new version)`) c.fail(step, reply);
  c.pass(step);
}

process.exitCode = await withThrowawayCore(NAME,
  `${NAME}: the skeleton, every mode, every refusal in its order, byte fidelity and the receipt's bounds: ok`,
  async (c) => {
    await skeleton(c);
    await modes(c);
    await precedence(c);
    await fidelity(c);
    await bigReceipt(c);
  });
