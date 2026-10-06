#!/usr/bin/env node
/**
 * A document too long for one result reads, and presents, in parts — and the parts round-trip.
 *
 *   1. a 130k-character body sliced by `offset` from each part's own "Next" line reassembles to
 *      exactly the body, every part under the limit, no surrogate pair split;
 *   2. `section` returns one heading's subtree, ignores a heading inside a code fence, and
 *      refuses an absent or ambiguous heading by name;
 *   3. presenting that document in parts, in a review context: the first part names the context and
 *      the next offset to pass it with; parts continued without a context join that context, and
 *      the document counts as presented — an approval has a basis (approvalBasis) — only once they
 *      cover the body, and the context mid-presentation is told to finish rather than signed; pages
 *      of another snapshot — even one of the same length — and pages in another context never
 *      combine; a change set too long for one result is paged the same way, its continuation joins
 *      the open delta, and covering every delta page counts; a `section` read covers nothing; and
 *      history is a read that records nothing;
 *   5. `replaceSection` — what `document_edit` with `section` writes — replaces one heading's
 *      section and keeps every other character of the body byte for byte, refuses an absent or
 *      ambiguous heading and a replacement that does not start with a heading, and a heading inside
 *      a code fence is not one; the change service splices `content` into the current body;
 *   4. the real `document_read` and `document_present` schemas accept `section`, `offset` and
 *      `limit`;
 *   6. a heading's level and then its occurrence pick one of several same-named headings — the
 *      selectors `document_edit` takes — while the read path's ambiguity still sends a reader to
 *      `offset`; the edit path's candidates carry the level and occurrence that pick each one; the
 *      real `document_edit` schema takes all three; and a part of the current document states its
 *      content revision.
 *   7. counted lists and detail pages (AC-2.2): a list too long for 16 KiB comes back as a counted
 *      preview whose details line says how many entries it left out; a receipt fits 16 KiB with its
 *      totals intact and names `(complete)` when nothing was cut; a cut refusal's detail is recorded
 *      as a `document.refused` row before it is answered; and that detail reads back page by page —
 *      every page at most 12,000 UTF-8 bytes, cut on a code point, the pages joining to the stored
 *      text — while a cursor for another ref is INVALID_MODE and another path or an unknown ref is
 *      DETAILS_MISSING.
 *
 * COUPLED: the fact behind "counts as presented" is what an approval asks (`approvalBasis`,
 * attest.ts): a review context's pages — `zz.event` rows carrying the context, the target snapshot
 * and the span — covering the current snapshot; so the fixture is a stubbed `pg.Pool` (and its
 * `connect`, for the presentation's transaction) that records what the presenter writes and answers
 * what the reader asks. Losing those rows makes a partly-presented document read as unpresented: it
 * fails CLOSED.
 *
 * Run: node checks/document-parts.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import pg from "pg";

process.env.TEAM_DB_URL = "postgresql://stub@127.0.0.1:1/stub";

const TEAM = "t1";
const INIT = "2026-09-26-parts";
const REL = `${INIT}/review.md`;

// A body of ~130k characters, the size that could not be read, with an emoji every line so a
// cut that ignored surrogate pairs would show.
const lines: string[] = ["# Review", ""];
for (let s = 1; lines.join("\n").length < 130_000; s++) {
  lines.push(`## Section ${s}`, "", "```sh", "# not a heading", "```");
  for (let i = 0; i < 40; i++) lines.push(`Finding ${s}.${i} \u{1F50D} evidence at src/file-${i}.ts:${s}`);
  lines.push("");
}
lines.push("## Ends", "", "the last line");
const body = lines.join("\n");
const content = `---\ntitle: Review\nversion: 1\nstatus: draft\n---\n\n${body}\n`;

/** The fixture: one document, its stored rows, and the rows the presenter and the reader write. A
 *  change files a new row when `pinned` — a presented row is never rewritten — and rewrites the
 *  current one otherwise; either way the document's generation moves. */
const DOC = "00000000-0000-0000-0000-0000000000d2";
const rows: { revision: number; version: number; body: string; own: string }[] = [{ revision: 1, version: 1, body: content, own: "0" }];
const doc = { current: 1, generation: 0, written_at: "2026-09-26T00:00:00.000Z", presented_at: null as string | null };
const events: { kind: string; subject: string; detail: Record<string, unknown> }[] = [];
const cur = () => rows.find((r) => r.revision === doc.current)!;

async function route(text: string, values: unknown[] = []) {
  const sql = String(text).replace(/\s+/g, " ").trim();
  const one = (r: Record<string, unknown>[]) => ({ rows: r, rowCount: r.length });
  // `revisionsOf` — the bytes, each row with its own public version and generation.
  if (/from zz\.doc_revision r\b/.test(sql) && /where r\.doc_id = \$1::uuid/.test(sql)) {
    return one(rows.map((r) => ({ revision: r.revision, version: r.version, content_state: "retained", title: "Review",
                                  body: r.body, tags: [], content_hash: `h${r.revision}`, revision_note: null, fields: null,
                                  written_by: "u@zz.test", written_at: doc.written_at, approved_by: null, approved_at: null,
                                  content_generation: r.own })));
  }
  // `citationsOf`
  if (/from zz\.doc_link l\b/.test(sql)) return one([]);
  // `presented_at`, the pin rule's input, on the row the presentation pinned
  if (/update zz\.doc_revision r set presented_at = now\(\)/.test(sql)) {
    if (values[0] === DOC && values[1] === doc.current) doc.presented_at = new Date(Date.parse(doc.written_at) + 1000).toISOString();
    return { rows: [], rowCount: 1 };
  }
  // The row a presentation confirms it showed, and the pages a review context holds
  if (/as own_generation/.test(sql)) {
    return one([{ id: DOC, current_revision: doc.current, content_generation: String(doc.generation), own_generation: cur().own }]);
  }
  if (/e\.detail->>'review_context' as context/.test(sql)) {
    return one(events.filter((e) => e.subject === values[2] && e.detail.review_context
        && e.detail.user === values[3] && (e.detail.credential ?? "") === values[4]
        && (values[5] === null || e.detail.review_context === values[5]))
      .map((e) => ({ context: e.detail.review_context, target: e.detail.target, baseline: e.detail.baseline,
                     kind: e.detail.kind, start: e.detail.start, end: e.detail.end, total: e.detail.total })));
  }
  // DELIBERATE: the routes that decide this check come FIRST. The generic `from zz.doc d` arm
  // matches the row a presentation confirms too — it has `d.path = $3` — and a router answers by
  // first match.
  if (/from zz\.doc d\b/.test(sql) && /d\.path = \$3/.test(sql)) {
    if (values[0] !== TEAM || values[1] !== INIT || values[2] !== "review.md") return one([]);
    return one([{ id: DOC, initiative: INIT, path: "review.md", flow: "", type: "", status: "draft",
                  outcome: null, current_revision: doc.current, approved_revision: null, current_version: cur().version,
                  content_generation: String(doc.generation), updated_at: doc.written_at }]);
  }
  // `insertEvent`: four params are enough to keep what this check reads.
  if (/insert into zz\.event\b/.test(sql)) {
    events.push({ kind: String(values[3] ?? ""), subject: String(values[4] ?? ""),
                  detail: JSON.parse(String(values[5] ?? "{}")) });
    return one([]);
  }
  // A details read: the row a ref names, on the subject it was recorded about.
  if (/e\.detail->>'details_ref' = \$3/.test(sql)) {
    const hit = events.find((e) => e.subject === values[1] && e.detail.details_ref === values[2]);
    return one(hit ? [{ details: hit.detail.details }] : []);
  }
  if (/from zz\.team where slug = \$1|select slug from zz\.team/.test(sql)) return one([{ slug: TEAM }]);
  return one([]);
}
pg.Pool.prototype.query = route as unknown as typeof pg.Pool.prototype.query;
pg.Pool.prototype.connect = (async () => ({ query: route, release() {} })) as unknown as typeof pg.Pool.prototype.connect;

const load = (p: string) => import(pathToFileURL(join(process.cwd(), p)).href);
const { PART_LIMIT, locateSection, partHeader, replaceSection, sectionRange, slicePart } =
  await load("services/zz-core/dist/document-parts.js");
const { present: presentIn } = await load("services/zz-core/dist/document-present.js");
const { contentRevision } = await import("@zz/contracts");
const { approvalBasis } = await load("services/zz-core/dist/attest.js");
const { db } = await load("services/zz-core/dist/platform-db.js");

const fail: string[] = [];
const is = (cond: unknown, why: string) => { if (!cond) fail.push(why); };

// 1. Offset paging round-trips
{
  let at = 0, joined = "", parts = 0;
  for (;;) {
    const p = slicePart(body, { offset: at });
    if (typeof p === "string") { fail.push(`slicePart refused offset ${at}: ${p}`); break; }
    is(p.text.length <= PART_LIMIT, `a part is ${p.text.length} characters, over the ${PART_LIMIT} limit`);
    is(p.total === body.length, `a part states a total of ${p.total}, the body is ${body.length}`);
    is(!/[\uD800-\uDBFF]$/.test(p.text) && !/^[\uDC00-\uDFFF]/.test(p.text), "a part splits a surrogate pair");
    joined += p.text; parts += 1;
    if (p.end >= p.total) break;
    at = p.end;
    if (parts > 20) { fail.push("paging never reached the end"); break; }
  }
  is(joined === body, "the parts, joined in order, are not the body — characters were lost or repeated");
  is(parts >= 3, `a 130k body came back in ${parts} part(s); the limit is not applied`);
}

// 2. Sections
{
  const p = slicePart(body, { section: "Section 2" });
  is(typeof p !== "string" && p.text.startsWith("## Section 2") && !p.text.includes("## Section 3"),
     "`section` does not return exactly one heading's subtree");
  is(typeof slicePart(body, { section: "not a heading" }) === "string",
     "a heading inside a code fence was taken for a section");
  const missing = slicePart(body, { section: "No such" });
  is(typeof missing === "string" && missing.includes("Section 1"), "an absent section is not refused with the headings listed");
  const dup = slicePart("## A\n\nx\n\n## A\n\ny\n", { section: "A" });
  is(typeof dup === "string" && dup.includes("2 headings"), "an ambiguous section was answered instead of refused");
  is(typeof slicePart(body, { offset: body.length + 5 }) === "string", "an offset past the end was answered");
}

// 3. Presenting in parts, in a review context, and what it counts as
{
  const who = { team: TEAM, email: "u@zz.test", credential: "pat", client: null };
  const present = async (ask: Record<string, unknown> = {}): Promise<string> =>
    (await presentIn(db()!, who, REL, ask, false)).text;
  const cr = (g: number) => contentRevision(DOC, g);
  /** Whether the current snapshot counts as presented: an approval of it has a basis — the answer
   *  `document_approve` asks, of the caller's contexts, or of the one passed. */
  const basis = async (context?: string): Promise<string> => {
    const b = await approvalBasis(db()!, who, REL, cr(doc.generation), context ? { context } : {});
    return "refusal" in b ? b.refusal : b.context;
  };
  const shown = async (): Promise<boolean> => !(await basis()).startsWith("ERROR");
  /** A change: new bytes, a new generation, the row's write past any present. */
  const change = (body: string, pinned: boolean, version = cur().version) => {
    doc.generation += 1;
    if (pinned) { rows.push({ revision: doc.current + 1, version, body, own: String(doc.generation) }); doc.current += 1; }
    else Object.assign(cur(), { body, own: String(doc.generation) });
    const base = doc.presented_at ? Date.parse(doc.presented_at) : Date.parse(doc.written_at);
    doc.written_at = new Date(base + 1000).toISOString();
  };
  /** Page from `first` to the end, each continuation with only the extra arguments given. */
  const pageOn = async (first: string, extra: Record<string, unknown>): Promise<string> => {
    let last = first;
    let next = Number(/Next: offset (\d+)/.exec(first)?.[1]);
    for (let i = 0; Number.isFinite(next) && i < 20; i++) {
      last = await present({ ...extra, offset: next });
      next = Number(/Next: offset (\d+)/.exec(last)?.[1]);
    }
    return last;
  };
  const pages = () => events.filter((e) => e.kind === "document.shown" || e.kind === "document.shown_part");

  change(cur().body, false);
  const first = await present();
  const rc = /^Review context: (rc_[a-z2-7]{26}) — full, target (\S+), baseline none, not yet covered\.$/m.exec(first);
  is(rc && rc[2] === cr(1), `a first part does not name a new context, its target and that it is not yet covered: ${first.slice(0, 400)}`);
  is(first.includes("does NOT yet count as presented") && new RegExp(`^Next: offset \\d+, with review_context "${rc?.[1]}"\\.`, "m").test(first),
     "a first part does not say it is incomplete and name the context to continue with");
  // A client whose cached tool list predates `offset` cannot follow that line; it is told why.
  is(/no `offset` argument.*refresh or reconnect/.test(first),
     "a first part does not tell a client without `offset` that its tool list is stale");
  is(await shown() === false, "one part of three counts as presented");
  is((await basis(rc?.[1])).startsWith(`ERROR: PRESENTATION_REQUIRED — the review context ${rc?.[1]} has not covered ${cr(1)}`),
     `an approval passing the context one part into its presentation is not told to finish it: ${await basis(rc?.[1])}`);
  const last = await pageOn(first, {});
  is(last.includes("counts as presented") && last.includes(`Review context: ${rc?.[1]} — full, target ${cr(1)}, baseline none, covered.`),
     `the last part, continued without a context, does not say the document now counts as presented: ${last.slice(0, 400)}`);
  is(await shown() === true, "every part presented, and the approval rule still reads it as unpresented");
  is(pages().every((e) => e.detail.review_context === rc?.[1] && e.detail.target === cr(1) && e.detail.kind === "full"),
     `continuations without a context did not join the open one: ${JSON.stringify(pages().map((e) => e.detail.review_context))}`);

  // Pages of another snapshot never combine — not even one of the same length, which the old
  // character-count matching merged — and pages of two contexts never do either.
  change(cur().body.replace("Finding 1.0", "Finding 1.X"), true);
  const second = await present();
  const rc2 = /^Review context: (rc_[a-z2-7]{26})/m.exec(second)?.[1];
  const offsets: number[] = [];
  for (let at = Number(/Next: offset (\d+)/.exec(second)?.[1]); Number.isFinite(at);) {
    offsets.push(at);
    at = Number(/Next: offset (\d+)/.exec(await present({ review_context: rc?.[1], full: true, offset: at }))?.[1]);
  }
  is(rc2 && rc2 !== rc?.[1] && offsets.length >= 2, "the second snapshot was not presented in a new context, in parts");
  is(await shown() === false,
     "the first part in one context and the rest in another, beside a whole earlier snapshot of the same length, count as presented");
  const done = await present({ review_context: rc?.[1], full: true, offset: 0 });
  is(done.includes(`Review context: ${rc?.[1]} — full, target ${cr(2)}, baseline ${cr(1)}, covered.`) && await shown() === true,
     `the missing part, in the context holding the rest, did not complete it: ${done.slice(0, 300)}`);

  // A change set too long for one result is paged too, and its continuation joins the open delta.
  const changed = cur().body.split("\n").map((l) => (/^Finding (\d+)\.\d+ /.exec(l) && Number(/^Finding (\d+)/.exec(l)![1]) % 2 ? `${l} (revised)` : l)).join("\n");
  change(changed, true);
  const d1 = await present({ review_context: rc?.[1] });
  is(new RegExp(`^Review context: ${rc?.[1]} — delta \\(\\d+ records\\), target ${cr(3)}, baseline ${cr(2)}, not yet covered\\.$`, "m").test(d1)
     && /Part of .*: characters 0–\d+ of \d+ \(the changes from /.test(d1),
     `a long change set is not presented as the delta, in parts: ${d1.slice(0, 500)}`);
  is(await shown() === false, "one part of a delta counts as presented");
  is((await basis(rc?.[1])).startsWith(`ERROR: PRESENTATION_REQUIRED — the review context ${rc?.[1]} has not covered ${cr(3)}`),
     `an approval passing the context one part into its delta is not told to finish it: ${await basis(rc?.[1])}`);
  const dLast = await pageOn(d1, {});
  is(dLast.includes(`Review context: ${rc?.[1]} — delta`) && dLast.includes("covered.") && await shown() === true,
     `continuing the delta without a context did not join it and complete it: ${dLast.slice(0, 300)}`);
  is(pages().slice(-2).every((e) => e.detail.kind === "delta" && e.detail.baseline === cr(2) && e.detail.target === cr(3)),
     "the delta's pages do not name their baseline and target");

  // A section is a read beside the review: it covers nothing, and its row carries no context.
  change(cur().body.replace("the last line", "the last line, changed"), true, 2);
  const before = pages().length;
  const section = await present({ section: "Section 1" });
  is(await shown() === false && pages().length === before + 1 && !pages()[before]?.detail.review_context
     && /counts nothing towards approval/.test(section),
     "a section read after a change counts as presenting the whole document, or joins a review context");

  // 3b. History is a read: it records nothing at all. `presented_at` — the pin rule's input — is a
  // column on the row the document points at, and a row for history would pin the CURRENT row,
  // which nobody was shown.
  doc.presented_at = null;
  const now = pages().length;
  const old = await present({ version: 1, offset: 0, limit: 999999 });
  is(old.includes("version 1") && /not the current one/.test(old), "presenting version 1 answered without saying which version it served");
  is(doc.presented_at === null && pages().length === now,
     "presenting an older revision recorded a presentation — an approval could then land on bytes nobody was shown");
}

// 4. The real schemas take the part arguments
{
  interface ZodLike { safeParse: (v: unknown) => { success: boolean } }
  const tools = new Map<string, { inputSchema?: Record<string, ZodLike> }>();
  const { registerArtifactTools } = await load("services/zz-core/dist/tools/artifacts.js");
  registerArtifactTools({ registerTool: (name: string, def: { inputSchema?: Record<string, ZodLike> }) => tools.set(name, def) });
  for (const name of ["document_read", "document_present"]) {
    const shape = tools.get(name)?.inputSchema ?? {};
    is(shape.section?.safeParse("Findings").success, `${name} takes no \`section\``);
    is(shape.offset?.safeParse(60000).success && !shape.offset?.safeParse(-1).success, `${name}'s \`offset\` is missing or takes a negative`);
    is(shape.limit?.safeParse(1000).success && !shape.limit?.safeParse(0).success, `${name}'s \`limit\` is missing or takes zero`);
  }
}

// 5. Revising one section of a long body
{
  const range = sectionRange(body, "Section 2");
  is(typeof range !== "string", `Section 2 was not found to replace: ${range}`);
  if (typeof range !== "string") {
    const next = "## Section 2\n\nOne sentence now, where a whole section was.\n";
    const got = replaceSection(body, "Section 2", next);
    is("body" in got, `replacing Section 2 was refused: ${JSON.stringify(got)}`);
    if ("body" in got) {
      is(got.body.slice(0, range.lo) === body.slice(0, range.lo), "the text before the section moved");
      is(got.body.endsWith(body.slice(range.hi)), "the text after the section moved");
      is(got.body.includes("One sentence now, where a whole section was.\n\n## Section 3"),
         "the replacement was not placed where the section was, one blank line before the next heading");
      const back = slicePart(got.body, { section: "Section 2" });
      is(typeof back !== "string" && back.text.trim() === next.trim(),
         "reading the replaced section back does not give what was sent");
    }
  }
  is("refusal" in replaceSection(body, "No such", "## No such\n\nx"), "an absent heading was replaced");
  is("refusal" in replaceSection("## A\n\nx\n\n## A\n\ny\n", "A", "## A\n\nz"), "an ambiguous heading was replaced");
  is("refusal" in replaceSection(body, "Section 2", "no heading line here"),
     "a replacement not starting with a heading was accepted");
  // The section's own code fence holds a `# not a heading` line: it must not end the section.
  const fenced = replaceSection("## Keep\n\nk\n\n## Swap\n\n```sh\n# not a heading\n```\nold\n\n## After\n\na\n",
                                "Swap", "## Swap\n\nnew");
  is("body" in fenced && fenced.body === "## Keep\n\nk\n\n## Swap\n\nnew\n\n## After\n\na\n",
     `a heading inside a code fence ended the section: ${JSON.stringify(fenced)}`);
  // A CRLF body stays CRLF: the blank line the splice adds is the body's own line ending, so a
  // section edit never leaves a document with two kinds of line ending.
  const crlf = replaceSection("## Keep\r\n\r\nk\r\n\r\n## Swap\r\n\r\nold\r\n\r\n## After\r\n\r\na\r\n",
                              "Swap", "## Swap\r\n\r\nMID\r\n\r\n");
  is("body" in crlf && crlf.body === "## Keep\r\n\r\nk\r\n\r\n## Swap\r\n\r\nMID\r\n\r\n## After\r\n\r\na\r\n",
     `a section edit on a CRLF body mixed in an LF line ending: ${JSON.stringify(crlf)}`);

  // `document_edit` takes `section` — its schema is asserted in 6 — and splices rather than
  // overwrites: a `section` accepted and then ignored would write one section's text over the whole
  // document, which is the worst thing this argument could do.
  const service = readFileSync(join(process.cwd(), "services/zz-core/dist/document-change.js"), "utf8");
  is(/const body = documentBody\(loaded\.text\);/.test(service) && /sectionBody\(path, body, a\)/.test(service)
     && /replaceSection\(body, section, a\.content \?\? "", pick\)/.test(service),
     "document_edit does not splice `content` into the current body when `section` is given");
}

// 6. Selectors
{
  const three = "# A\n\nx\n\n## A\n\ny\n\n## A\n\nz\n";
  const top = sectionRange(three, "A", { level: 1 });
  is(typeof top !== "string" && top.lo === 0 && top.hi === three.length,
     `level 1 did not pick the H1, whose section is the whole text: ${JSON.stringify(top)}`);
  const second = sectionRange(three, "A", { level: 2, occurrence: 2 });
  is(typeof second !== "string" && three.slice(second.lo, second.hi) === "## A\n\nz\n",
     `level 2, occurrence 2 did not pick the last heading: ${JSON.stringify(second)}`);
  const readAmbiguous = sectionRange(three, "A", { level: 2 });
  is(typeof readAmbiguous === "string" && readAmbiguous.includes("2 headings") && readAmbiguous.includes("offset"),
     `the read path's ambiguity text changed: ${JSON.stringify(readAmbiguous)}`);
  is(typeof sectionRange(three, "A", { level: 2, occurrence: 3 }) === "string",
     "an occurrence past the last matching heading was answered");
  const editAmbiguous = locateSection(three, "A");
  is("ambiguous" in editAmbiguous
     && JSON.stringify(editAmbiguous.ambiguous.map((c: { level: number; occurrence: number }) => [c.level, c.occurrence]))
        === "[[1,1],[2,1],[2,2]]",
     `the edit path's candidates do not carry the level and occurrence that pick each: ${JSON.stringify(editAmbiguous)}`);
  const swapped = replaceSection(three, "A", "## A\n\nZ", { level: 2, occurrence: 2 });
  is("body" in swapped && swapped.body === "# A\n\nx\n\n## A\n\ny\n\n## A\n\nZ\n",
     `replacing level 2, occurrence 2 touched more than that section: ${JSON.stringify(swapped)}`);

  interface ZodLike { safeParse: (v: unknown) => { success: boolean } }
  const tools = new Map<string, { inputSchema?: Record<string, ZodLike> }>();
  const { registerArtifactTools } = await load("services/zz-core/dist/tools/artifacts.js");
  registerArtifactTools({ registerTool: (name: string, def: { inputSchema?: Record<string, ZodLike> }) => tools.set(name, def) });
  const edit = tools.get("document_edit")?.inputSchema ?? {};
  is(edit.section?.safeParse("Phase 5").success && edit.section_level?.safeParse(2).success
     && edit.section_occurrence?.safeParse(1).success,
     "document_edit does not take `section`, `section_level` and `section_occurrence`");

  const current = `---\ntitle: Review\ncontent_revision: cr_abc\n---\n\n${body}`;
  const part = slicePart(current, { offset: 0 });
  is(typeof part !== "string" && partHeader(REL, part, "the whole file", current).includes("content revision: cr_abc"),
     "a part of the current document does not state its content revision");
}

// 7. Counted lists and detail pages
{
  const { composeReceipt, detailPage, readDetails, refusalText, settleRefusal, PAGE_BYTES } =
    await load("services/zz-core/dist/document-details.js");
  const bytes = (t: string) => Buffer.byteLength(t, "utf8");
  // 300 headings of ~90 bytes with a 3-byte character in each: about 27 KB, so the preview must shrink.
  const headings = Array.from({ length: 300 }, (_, i) => `Section ${String(i).padStart(3, "0")} — 中 ${"x".repeat(70)}`);
  const receipt = composeReceipt([`edited: ${REL} — v2 (new version)`, { label: "changed sections", items: headings },
                                  { label: "causes", items: [] }, { label: "normalised", items: [], sep: "; " }],
                                 "dr_aaaaaaaaaaaaaaaaaaaaaaaaaa", "Next move: present review.md (waiting on agent) — x");
  const shownCount = (/^changed sections \(300\): (.*), …$/m.exec(receipt.text)?.[1] ?? "").split(", ").length;
  const hidden = Number(/^details: `dr_a{26}` — (\d+) entries not shown above$/m.exec(receipt.text)?.[1] ?? -1);
  is(bytes(receipt.text) <= 16 * 1024 && shownCount + hidden === 300 && /^causes \(0\): none$/m.test(receipt.text),
     `a receipt over 16 KiB is not a counted preview naming what it left out (${bytes(receipt.text)} bytes, ` +
     `${shownCount} shown, ${hidden} hidden)`);
  is(receipt.details.text.split("\n").filter((l: string) => l.startsWith("- Section ")).length === 300,
     "the receipt's detail does not hold every changed section, one per line");
  const small = composeReceipt([`edited: ${REL} — v1`, { label: "changed sections", items: ["A", "B"] }], "dr_bbbbbbbbbbbbbbbbbbbbbbbbbb", "");
  is(/^changed sections \(2\): A, B\ndetails: `dr_b{26}` \(complete\)$/m.test(small.text),
     `a receipt that fits does not name its detail as complete: ${small.text}`);

  // A cut refusal: its detail recorded on the path before it is answered, then read in pages.
  const said = refusalText([{ lead: "ERROR: ", label: "named sources that are not documents", items: headings.map((h) => `${h}.md`),
                              tail: " — none can be named as a cause." }]);
  const ref = /`(dr_[a-z2-7]{26})`/.exec(said)?.[1] ?? "";
  is(bytes(said) <= 16 * 1024 && !!ref, `a refusal over 16 KiB is not cut with a details line (${bytes(said)} bytes)`);
  const answered = await settleRefusal(db()!, { who: "ada@zz.test", team: TEAM, path: REL }, said);
  const row = events.find((e) => e.kind === "document.refused" && e.detail.details_ref === ref);
  is(answered === said && row?.subject === REL && String(row?.detail.details).includes(`- ${headings[299]}.md`),
     `a cut refusal's detail was not recorded on its path before it was answered: ${JSON.stringify(row)}`);
  let cursor: string | undefined;
  let joined = "";
  for (let page = 0; page < 20; page++) {
    const got: string = await readDetails(db()!, TEAM, REL, ref, cursor);
    const lines = got.split("\n");
    const text = lines.slice(1, -1).join("\n");
    is(lines[0].startsWith(`details \`${ref}\` of ${REL} — bytes `) && bytes(text) <= PAGE_BYTES,
       `a detail page is not headed or exceeds ${PAGE_BYTES} bytes: ${lines[0]} (${bytes(text)})`);
    joined += text;
    const next = /^Next: cursor (dc_[a-z2-7]+)$/.exec(lines[lines.length - 1]);
    if (!next) { is(lines[lines.length - 1] === "complete", `a last page does not say complete: ${lines[lines.length - 1]}`); break; }
    cursor = next[1];
  }
  is(joined === row?.detail.details, "the detail's pages do not join to the stored detail");
  const other = refusalText([{ label: "x", items: headings.map((h) => `${h}.md`) }]);
  const otherRef = /`(dr_[a-z2-7]{26})`/.exec(other)?.[1] ?? "";
  await settleRefusal(db()!, { who: "ada@zz.test", team: TEAM, path: REL }, other);
  const firstOfOther = await readDetails(db()!, TEAM, REL, otherRef, undefined);
  const otherCursor = /Next: cursor (dc_[a-z2-7]+)$/.exec(firstOfOther)?.[1];
  is(/^ERROR: INVALID_MODE — cursor dc_/.test(await readDetails(db()!, TEAM, REL, ref, otherCursor)),
     "a cursor for another ref was not INVALID_MODE");
  is(await readDetails(db()!, TEAM, "elsewhere/doc.md", ref, undefined) === `ERROR: DETAILS_MISSING — ${ref} is not a detail of elsewhere/doc.md`,
     "a ref read on another path was not DETAILS_MISSING");
  is(/^ERROR: DETAILS_MISSING — dr_c{26} is not a detail of /.test(await readDetails(db()!, TEAM, REL, `dr_${"c".repeat(26)}`, undefined)),
     "an unknown ref was not DETAILS_MISSING");
  // A single line longer than the budget — a sentence naming every key it refuses — is cut, and
  // the cut is counted, so even it never exceeds 16 KiB unannounced.
  const sentence = refusalText([`ERROR: UNSUPPORTED_METADATA — the content's envelope carries ${"\"k中\", ".repeat(3000)}.`]);
  is(bytes(sentence) <= 16 * 1024 && /…\ndetails: `dr_[a-z2-7]{26}` — 1 entry not shown above$/.test(sentence),
     `one line past the budget is not cut and counted (${bytes(sentence)} bytes): ${sentence.slice(-120)}`);
  // A 3-byte character straddling the page boundary, with no line break to back up to: the page
  // stops before it, never inside it.
  const straddle = "a".repeat(PAGE_BYTES - 1) + "中" + "b".repeat(10);
  const first = detailPage(straddle, 0);
  is(first.end === PAGE_BYTES - 1 && first.text === "a".repeat(PAGE_BYTES - 1) && detailPage(straddle, first.end).text.startsWith("中"),
     `a page cut inside a code point: ends at ${first.end}`);
}

if (fail.length) {
  console.error(`document-parts: ${fail.length} failure(s)`);
  for (const f of fail) console.error(`  - ${f}`);
  process.exit(1);
}
console.log("document-parts: a 130k document pages and sections round-trip; parts count as presented only when they cover the body " +
            "in one review context, a change set pages the same way, and history records nothing; " +
            "lists are counted and detail pages read back whole");
