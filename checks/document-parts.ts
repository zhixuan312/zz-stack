#!/usr/bin/env node
/**
 * A document too long for one result reads, and presents, in parts — and the parts round-trip.
 *
 *   1. a 130k-character body sliced by `offset` from each part's own "Next" line reassembles to
 *      exactly the body, every part under the limit, no surrogate pair split;
 *   2. `section` returns one heading's subtree, ignores a heading inside a code fence, and
 *      refuses an absent or ambiguous heading by name;
 *   3. presenting that document in parts records `shown_part` rows, counts as presented
 *      (shownSinceLastChange) only once the parts cover the body, appends exactly one `shown`,
 *      and a rewrite after that makes it unpresented again;
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
 * COUPLED: the fact behind "counts as presented" is `doc_revision.presented_at`, and the part
 * spans are `zz.event` rows — a column cannot hold a span set — so the fixture is a stubbed
 * `pg.Pool` that records what the presenter writes and answers what the reader asks. The span
 * bookkeeping is the one thing that still lives in the event table, and losing it makes a
 * partly-presented document read as unpresented: it fails CLOSED.
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

/** The fixture: one document, and the rows the presenter and the reader write. `twoRevisions` gives
 *  it a second revision, which is what makes the history guard in step 3b reachable — with one
 *  revision `revision === current_revision` is true for every ask. */
let twoRevisions = false;
const doc = { written_at: "2026-09-26T00:00:00.000Z", presented_at: null as string | null };
const events: { kind: string; subject: string; detail: Record<string, unknown> }[] = [];

pg.Pool.prototype.query = (async function query(text: string, values: unknown[] = []) {
  const sql = String(text).replace(/\s+/g, " ").trim();
  const one = (rows: Record<string, unknown>[]) => ({ rows, rowCount: rows.length });
  // `revisionsOf` — the bytes. DELIBERATE: two revisions once `twoRevisions` is set, so that
  // `loadDocument(team, rel, 1)` answers v1 while the document points at v2. A fixture with one
  // revision makes `revision === current_revision` true for every ask, and the guard keeping
  // presented history from vouching for the present is unreachable in it — which is why step 3b
  // could not catch the defect it exists for until this arm carried a second row.
  if (/from zz\.doc_revision r\b/.test(sql) && /where r\.doc_id = \$1::uuid/.test(sql)) {
    const first = { revision: 1, content_state: "retained", title: "Review", body: content, tags: [],
                    content_hash: "h", revision_note: null, fields: null, written_by: "u@zz.test",
                    written_at: doc.written_at, approved_by: null, approved_at: null };
    return one(twoRevisions
      ? [first, { ...first, revision: 2, body: `${content}\n\nrewritten`, content_hash: "h2" }]
      : [first]);
  }
  // `citationsOf`
  if (/from zz\.doc_link l\b/.test(sql)) return one([]);
  // THE FACT
  if (/select r\.presented_at::text as presented_at/.test(sql)) {
    if (values[0] !== TEAM || values[1] !== INIT || values[2] !== "review.md") return one([]);
    return one([{ presented_at: doc.presented_at, written_at: doc.written_at }]);
  }
  // THE WRITE
  if (/update zz\.doc_revision r set presented_at = now\(\)/.test(sql)) {
    doc.presented_at = new Date(Date.parse(doc.written_at) + 1000).toISOString();
    return { rows: [], rowCount: 1 };
  }
  // DELIBERATE: the routes that decide this check come FIRST. The generic `from zz.doc d` arm
  // matches the presented_at select's own text too — it has `d.path = $3` — and answering that
  // with a document row, which carries no `presented_at`, reads as "nobody was shown it"
  // whatever the fixture says. A router answers by first match.
  if (/from zz\.doc d\b/.test(sql) && /d\.path = \$3/.test(sql)) {
    if (values[0] !== TEAM || values[1] !== INIT || values[2] !== "review.md") return one([]);
    return one([{ id: "d1", initiative: INIT, path: "review.md", flow: "", type: "", status: "draft",
                  outcome: null, current_revision: twoRevisions ? 2 : 1, approved_revision: null,
                  updated_at: doc.written_at }]);
  }
  // The part spans, and the `shown` projection
  if (/select e\.kind, \(e\.detail->>'start'\)::int as start/.test(sql)) {
    return one(events.filter((e) => e.subject === String(values[3]) && e.kind !== "document.shown"
                               || (e.subject === String(values[3]) && e.kind === "document.shown"))
      .map((e) => ({ kind: e.kind, start: e.detail.start ?? null, end: e.detail.end ?? null,
                     total: e.detail.total ?? null })));
  }
  // `recordAct` -> `platformEvent`'s insert: four params are enough to keep what this check reads.
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
}) as unknown as typeof pg.Pool.prototype.query;

const load = (p: string) => import(pathToFileURL(join(process.cwd(), p)).href);
const { PART_LIMIT, locateSection, partHeader, replaceSection, sectionRange, slicePart } =
  await load("services/zz-core/dist/document-parts.js");
const { present } = await load("services/zz-core/dist/document-present.js");
const { shownSinceLastChange } = await load("services/zz-core/dist/attest.js");
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

// 3. Presenting in parts, and what it counts as
{
  /** Stand in for a write: the revision's bytes are new, so its `written_at` moves past the
   *  present. An in-place patch does exactly this, which is why the comparison is `>`. */
  const rewrite = () => {
    const base = doc.presented_at ? Date.parse(doc.presented_at) : Date.parse(doc.written_at);
    doc.written_at = new Date(base + 1000).toISOString();
  };
  const rows = () => events.filter((e) => e.kind === "document.shown" || e.kind === "document.shown_part");

  rewrite();
  const first = await present(db()!, TEAM, REL, undefined, "u@zz.test", {});
  is(first.includes("does NOT yet count as presented") && first.includes("Next: offset"),
     "a first part does not say it is incomplete and where to continue");
  // A client whose cached tool list predates `offset` cannot follow that line; it is told why.
  is(/no `offset` argument.*refresh or reconnect/.test(first),
     "a first part does not tell a client without `offset` that its tool list is stale");
  is(await shownSinceLastChange(db()!, TEAM, REL) === false, "one part of three counts as presented");

  let next = Number(/Next: offset (\d+)/.exec(first)?.[1]);
  let last = first;
  for (let i = 0; Number.isFinite(next) && i < 20; i++) {
    last = await present(db()!, TEAM, REL, undefined, "u@zz.test", { offset: next });
    next = Number(/Next: offset (\d+)/.exec(last)?.[1]);
  }
  is(last.includes("it counts as presented"), "the last part does not say the document now counts as presented");
  is(await shownSinceLastChange(db()!, TEAM, REL) === true,
     "every part presented, and the approval rule still reads it as unpresented");
  is(rows().filter((e) => e.kind === "document.shown").length === 1
     && rows().some((e) => e.detail.via === "parts"),
     "completing the parts did not append exactly one `shown` row marked as reached through parts");

  await present(db()!, TEAM, REL, undefined, "u@zz.test", { offset: 0 });
  is(rows().filter((e) => e.kind === "document.shown").length === 1, "presenting a part again appended a second `shown`");

  rewrite();
  is(await shownSinceLastChange(db()!, TEAM, REL) === false, "a rewrite after the parts left the document counted as presented");
  await present(db()!, TEAM, REL, undefined, "u@zz.test", { section: "Section 1" });
  is(await shownSinceLastChange(db()!, TEAM, REL) === false,
     "one section after a rewrite counts as presenting the whole document");

  // 3b. Presenting an OLDER revision does not vouch for the current one. `presented_at` is a
  // column on the revision row the document points at — `recordPresented` writes it
  // `where r.revision = d.current_revision` — so a part cut from v1 that covers v1's whole body
  // must not mark v2 as shown, or `document_approve` stamps an approval on bytes nobody read.
  // `presentDocument` guards this; `presentPart` did not, and the two take the same argument.
  //
  // DELIBERATE: `{ offset: 0, limit: <the whole body> }` and not `{}`. An empty ask on a short body
  // routes to `presentDocument`, which already carries the guard, and `{ offset: 0 }` on this 130k
  // body yields a PARTIAL. This ask reaches `presentPart` AND its slice covers the body — the pair
  // the defect needed.
  //
  // DELIBERATE: asserted on the ROW, not on the rule beside it. `shownSinceLastChange` reads the
  // `zz.event` rows and this branch writes none, so it answers the same either way — and the
  // sentence cannot distinguish either, because `current` is computed whether or not the guard
  // uses it. What the defect did was write `presented_at` on the CURRENT revision, and that is what
  // this reads: `recordPresented` is the statement whose WHERE clause names `d.current_revision`.
  twoRevisions = true;
  doc.presented_at = null;
  const old = await present(db()!, TEAM, REL, 1, "u@zz.test", { offset: 0, limit: 999999 });
  is(old.includes("version 1"), "presenting version 1 answered without saying which version it served");
  is(doc.presented_at === null,
     "presenting an older revision whole wrote `presented_at` on the CURRENT revision — an " +
     "approval could then land on bytes nobody was shown");
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
console.log("document-parts: a 130k document pages and sections round-trip; parts count as presented only when they cover the body; " +
            "lists are counted and detail pages read back whole");
