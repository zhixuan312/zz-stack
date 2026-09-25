#!/usr/bin/env node
/**
 * A document too long for one result reads, and presents, in parts — and the parts round-trip.
 *
 * Runs the code over a fixture store rather than matching its text:
 *   1. a 130k-character body sliced by `offset` from each part's own "Next" line reassembles to
 *      exactly the body, every part under the limit, no surrogate pair split;
 *   2. `section` returns one heading's subtree, ignores a heading inside a code fence, and
 *      refuses an absent or ambiguous heading by name;
 *   3. presenting that document in parts records `shown_part` rows, counts as presented
 *      (shownSinceLastChange) only once the parts cover the body, appends exactly one `shown`,
 *      and a patch after that makes it unpresented again;
 *   4. the real `document_read` and `document_present` schemas accept `section`, `offset` and
 *      `limit`.
 *
 * Run: node checks/document-parts.ts
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const load = (p: string) => import(pathToFileURL(join(process.cwd(), p)).href);
const { PART_LIMIT, slicePart, presentPart } = await load("services/zz-core/dist/document-parts.js");
const { shownSinceLastChange } = await load("services/zz-core/dist/attest.js");
const { registerArtifactTools } = await load("services/zz-core/dist/tools/artifacts.js");

const fail: string[] = [];
const is = (cond: unknown, why: string) => { if (!cond) fail.push(why); };

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
  const root = mkdtempSync(join(tmpdir(), "zz-parts-"));
  const INIT = "2026-09-26-parts";
  const rel = `${INIT}/review.md`;
  mkdirSync(join(root, INIT), { recursive: true });
  writeFileSync(join(root, rel), `---\ntitle: Review\nversion: 1\nstatus: draft\n---\n\n${body}\n`);
  const act = (action: string) => appendFileSync(join(root, INIT, "activity.jsonl"),
    JSON.stringify({ ts: new Date().toISOString(), user: "u@zz.test", action, path: rel }) + "\n");
  const rows = () => readFileSync(join(root, INIT, "activity.jsonl"), "utf8").trim().split("\n")
    .map((l) => JSON.parse(l) as { action: string; via?: string });
  act("document_write");

  const first = presentPart(root, rel, undefined, "u@zz.test", {});
  is(first.includes("does NOT yet count as presented") && first.includes("Next: offset"),
     "a first part does not say it is incomplete and where to continue");
  is(shownSinceLastChange(root, rel) === false, "one part of three counts as presented");

  let next = Number(/Next: offset (\d+)/.exec(first)?.[1]);
  let last = first;
  for (let i = 0; Number.isFinite(next) && i < 20; i++) {
    last = presentPart(root, rel, undefined, "u@zz.test", { offset: next });
    next = Number(/Next: offset (\d+)/.exec(last)?.[1]);
  }
  is(last.includes("it counts as presented"), "the last part does not say the document now counts as presented");
  is(shownSinceLastChange(root, rel) === true, "every part presented, and the approval rule still reads it as unpresented");
  is(rows().filter((r) => r.action === "shown").length === 1 && rows().some((r) => r.via === "parts"),
     "completing the parts did not append exactly one `shown` row marked as reached through parts");

  presentPart(root, rel, undefined, "u@zz.test", { offset: 0 });
  is(rows().filter((r) => r.action === "shown").length === 1, "presenting a part again appended a second `shown`");

  act("document_patch");
  is(shownSinceLastChange(root, rel) === false, "a patch after the parts left the document counted as presented");
  presentPart(root, rel, undefined, "u@zz.test", { section: "Section 1" });
  is(shownSinceLastChange(root, rel) === false, "one section after a patch counts as presenting the whole document");
}

// 4. The real schemas take the part arguments
{
  interface ZodLike { safeParse: (v: unknown) => { success: boolean } }
  const tools = new Map<string, { inputSchema?: Record<string, ZodLike> }>();
  registerArtifactTools({ registerTool: (name: string, def: { inputSchema?: Record<string, ZodLike> }) => tools.set(name, def) });
  for (const name of ["document_read", "document_present"]) {
    const shape = tools.get(name)?.inputSchema ?? {};
    is(shape.section?.safeParse("Findings").success, `${name} takes no \`section\``);
    is(shape.offset?.safeParse(60000).success && !shape.offset?.safeParse(-1).success, `${name}'s \`offset\` is missing or takes a negative`);
    is(shape.limit?.safeParse(1000).success && !shape.limit?.safeParse(0).success, `${name}'s \`limit\` is missing or takes zero`);
  }
}

if (fail.length) {
  console.error(`document-parts: ${fail.length} failure(s)`);
  for (const f of fail) console.error(`  - ${f}`);
  process.exit(1);
}
console.log("document-parts: a 130k document pages and sections round-trip; parts count as presented only when they cover the body");
