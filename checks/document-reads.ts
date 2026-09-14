#!/usr/bin/env node
/**
 * Arrays, versions, a discoverable history — and the attestation still counts per document.
 *
 * WHY THIS IS NOT THE FILE THE PLAN AUTHORED. That one was six regular expressions over the
 * text of `artifacts.ts`, and FOUR OF THE SIX WERE ALREADY GREEN against the untouched code
 * before this task began: `/version/` matched the word in document_present's description and
 * again in the activity payload it already wrote; `/shown/` matched that same payload;
 * `/_versions/` matched a comment in `paths.ts`; and the negative `/shown[^\n]*once|single
 * shown/` is satisfied by any file that happens not to contain those two phrases. A check
 * that is two-thirds green before the work starts is measuring prose — every one of those
 * assertions could have been made true by a sentence in a comment.
 *
 * So this one RUNS the code, the way `checks/attest-shown.mjs` does:
 *   - the real zod schemas, harvested by handing `registerArtifactTools` a stub server and
 *     parsing values through them. `path` accepting `["a","b"]` is a fact about a schema, not
 *     a word in a file;
 *   - `documentVersions`, `versionRefusal` and `presentDocument` driven over a fixture store,
 *     which is why they take `root` explicitly and touch no request;
 *   - `writeGuard` itself, asked whether `_versions/` is still unwritable;
 *   - `shownSinceLastChange` as the ORACLE for the per-document record — the same function an
 *     approval leans on is the one that has to answer "fetched" for both documents of a batch
 *     and for neither of them when history was what got opened.
 *
 * The two assertions that stay source-level are named as such below, with what each catches.
 *
 * Run: node checks/document-reads.mjs   (also run by scripts/gate.mjs)
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const load = (p: string) => import(pathToFileURL(join(process.cwd(), p)).href);
const { registerArtifactTools } = await load("services/zz-core/dist/tools/artifacts.js");
const { documentVersions, versionRefusal, presentDocument } =
  await load("services/zz-core/dist/versions.js");
const { writeGuard } = await load("services/zz-core/dist/paths.js");
const { shownSinceLastChange } = await load("services/zz-core/dist/attest.js");

const fail: string[] = [];
const is = (cond: unknown, why: string) => { if (!cond) fail.push(why); };

// ── 1. The real schemas, not the words around them ───────────────────────────────────────
//
// `registerTool(name, def, handler)` on a stub: the definitions that reach the MCP SDK are
// the definitions a client is offered, so parsing a value through one answers what the tool
// accepts. `z.string()` refuses `["a","b"]`, and no comment can change that.
interface ZodLike { safeParse: (v: unknown) => { success: boolean } }
interface ToolDef { inputSchema?: Record<string, ZodLike>; [key: string]: unknown }

const tools = new Map<string, ToolDef>();
registerArtifactTools({ registerTool: (name: string, def: ToolDef) => tools.set(name, def) });

for (const name of ["document_read", "document_present"]) {
  const def = tools.get(name);
  if (!def) { fail.push(`${name} is not registered`); continue; }
  const shape = def.inputSchema ?? {};
  const path = shape.path;
  if (!path) { fail.push(`${name} takes no \`path\``); continue; }
  is(path.safeParse("2026-01-01-x/spec.md").success,
     `${name} no longer accepts a single path as a string`);
  is(path.safeParse(["2026-01-01-x/spec.md", "2026-01-01-x/plan.md"]).success,
     `${name} does not accept an ARRAY of paths — its \`path\` schema refuses one`);
  const version = shape.version;
  if (!version) { fail.push(`${name} takes no \`version\``); continue; }
  is(version.safeParse(3).success, `${name}'s \`version\` refuses a version number`);
  is(version.safeParse(undefined).success, `${name}'s \`version\` is not optional`);
}
// The shelf argument is document_read's alone and this task does not touch it. Asserted
// because an inputSchema rewritten around `path` is exactly where it would be dropped.
is(tools.get("document_read")?.inputSchema?.scope?.safeParse("platform").success,
   "document_read lost `scope` — the platform journal became unreadable again");

// ── 2. A fixture store, and the history read out of it ───────────────────────────────────
const root = mkdtempSync(join(tmpdir(), "zz-docreads-"));
const INIT = "2026-01-01-fixture";
mkdirSync(join(root, INIT, "_versions"), { recursive: true });

const doc = (fields: Record<string, string>, body: string) =>
  `---\n${Object.entries(fields).map(([k, v]) => `${k}: ${v}`).join("\n")}\n---\n\n${body}\n`;

writeFileSync(join(root, INIT, "spec.md"),
  doc({ title: "Spec", version: "10", status: "draft" }, "# Spec\n\nThe current draft."));
writeFileSync(join(root, INIT, "plan.md"),
  doc({ title: "Plan", version: "1", status: "draft" }, "# Plan\n\nThe current plan."));
writeFileSync(join(root, INIT, "spec-review.md"),
  doc({ title: "Review", version: "1", status: "draft" }, "# Review"));
// Three approvals of spec.md, one of its NEIGHBOUR. v10 is there so the ordering is a real
// question: readdirSync hands back v1, v10, v2.
writeFileSync(join(root, INIT, "_versions", "spec.v1.md"),
  doc({ title: "Spec", version: "1", status: "approved", approved_by: "ada@zz.test",
        approved_at: "2026-01-05" }, "# Spec\n\nThe first approval."));
writeFileSync(join(root, INIT, "_versions", "spec.v2.md"),
  doc({ title: "Spec", version: "2", status: "approved", approved_by: "bo@zz.test",
        approved_at: "2026-02-09" }, "# Spec\n\nThe second approval."));
writeFileSync(join(root, INIT, "_versions", "spec.v10.md"),
  doc({ title: "Spec", version: "10", status: "approved", approved_by: "cy@zz.test",
        approved_at: "2026-03-14" }, "# Spec\n\nThe tenth approval."));
writeFileSync(join(root, INIT, "_versions", "spec-review.v1.md"),
  doc({ title: "Review", version: "1", status: "approved", approved_by: "dee@zz.test",
        approved_at: "2026-04-01" }, "# Review\n\nApproved."));

interface VersionRow {
  version: number; rel: string; approved_by?: string; approved_at?: string; status?: string;
}
const rows: VersionRow[] = documentVersions(root, `${INIT}/spec.md`);
is(rows.map((v) => v.version).join(",") === "1,2,10",
   `the version list is ${JSON.stringify(rows.map((v) => v.version))}, expected [1,2,10] — a ` +
   "history sorted by filename puts v10 between v1 and v2 and reads as a history with gaps");
// A shared PREFIX is not a shared document: spec-review.v1.md must not be filed under spec.md.
is(!rows.some((v) => v.rel.includes("spec-review")),
   "spec-review.v1.md is listed as a version of spec.md — a prefix match files one document's " +
   "approvals under its neighbour's history");
// Each row's approval comes off THAT SNAPSHOT's envelope. Read off the live document instead
// and every row would say "draft", with no approver and no date.
is(rows[0]?.approved_by === "ada@zz.test" && rows[0]?.approved_at === "2026-01-05"
   && rows[1]?.approved_by === "bo@zz.test" && rows[2]?.approved_by === "cy@zz.test",
   "a version's approval is not read from that version's own frozen copy — the rows carry " +
   `${JSON.stringify(rows.map((v) => v.approved_by))}, so the list repeats one signature ` +
   "or has none");
is(rows.every((v) => v.status === "approved"),
   "the version list does not say what each version was approved as");
is(rows[0]?.rel === `${INIT}/_versions/spec.v1.md`,
   `a version resolves to ${rows[0]?.rel}, not to <initiative>/_versions/<doc>.v<N>.md`);
is(documentVersions(root, `${INIT}/plan.md`).length === 0,
   "plan.md, which has never been approved, reports filed versions");

// A version that does not exist is refused, and the refusal names the ones that do.
const missing = versionRefusal(root, `${INIT}/spec.md`, 9);
is(typeof missing === "string" && /\bv1\b/.test(missing) && /\bv2\b/.test(missing)
   && /\bv10\b/.test(missing),
   `version 9 is not refused with the versions that exist — got ${JSON.stringify(missing)}`);
is(versionRefusal(root, `${INIT}/spec.md`, 2) === null,
   "version 2 is refused although spec.v2.md is filed");
is(typeof versionRefusal(root, `${INIT}/plan.md`, 1) === "string",
   "a version of a document with no filed versions is not refused");

// ── 3. The record, per document, with shownSinceLastChange as the oracle ─────────────────
const log = join(root, INIT, "activity.jsonl");
const seedWrites = () => writeFileSync(log,
  ["spec.md", "plan.md"].map((d) => JSON.stringify({
    ts: "2026-01-01T00:00:00.000Z", user: "u@zz.test", action: "document_write",
    path: `${INIT}/${d}`,
  })).join("\n") + "\n");
const shownRows = () => readFileSync(log, "utf8").split("\n").filter(Boolean)
  .map((l) => JSON.parse(l)).filter((e) => e.action === "shown");

seedWrites();
const presented = presentDocument(root, `${INIT}/spec.md`, undefined, "u@zz.test");
is(/# Spec/.test(presented) && /The current draft/.test(presented),
   "document_present does not return the document's body");
is(!/^---/m.test(presented) && !/^status:/m.test(presented),
   "the envelope is handed back as frontmatter for the reader to parse rather than stated");
is(/version 10/.test(presented) && /status draft/.test(presented),
   "the version and status are not stated separately");
is(/v1 approved by ada@zz\.test on 2026-01-05/.test(presented)
   && /v2 approved by bo@zz\.test on 2026-02-09/.test(presented)
   && /v10 approved by cy@zz\.test on 2026-03-14/.test(presented),
   "the response does not list the versions that exist with what each was approved as and when");
is(shownRows().length === 1 && shownRows()[0].path === `${INIT}/spec.md`,
   "presenting one document did not append exactly one `shown` row naming it");

// TWO DOCUMENTS, TWO ROWS. One row for a batch would let an approval on the document nobody
// opened read as attested, because shownSinceLastChange answers per document.
seedWrites();
presentDocument(root, `${INIT}/spec.md`, undefined, "u@zz.test");
presentDocument(root, `${INIT}/plan.md`, undefined, "u@zz.test");
is(shownRows().length === 2, `presenting two documents wrote ${shownRows().length} \`shown\` rows`);
is(shownSinceLastChange(root, `${INIT}/spec.md`) === true
   && shownSinceLastChange(root, `${INIT}/plan.md`) === true,
   "after presenting both documents the record still says one of them was never fetched");

// OPENING HISTORY MUST NOT VOUCH FOR THE PRESENT. shownSinceLastChange matches on path and
// ignores version by design, so a `shown` written against the live path when v1 was what came
// back would make "somebody read the first approval" answer for the current draft.
seedWrites();
const historical = presentDocument(root, `${INIT}/spec.md`, 1, "u@zz.test");
is(/The first approval/.test(historical) && !/The current draft/.test(historical),
   "`version: 1` did not return the copy filed at the first approval");
is(shownRows()[0]?.path === `${INIT}/_versions/spec.v1.md`,
   `a historical fetch recorded \`shown\` on ${shownRows()[0]?.path} — a fetch of v1 recorded ` +
   "against the live path makes reading history look like reading the document");
is(shownSinceLastChange(root, `${INIT}/spec.md`) === false,
   "fetching an old version marks the current document as fetched");

// A refusal fetched nothing, so it records nothing.
seedWrites();
const refused = presentDocument(root, `${INIT}/spec.md`, 9, "u@zz.test");
is(/^ERROR:/.test(refused), "presenting a version that does not exist is not refused");
is(shownRows().length === 0, "a refused present still wrote a `shown` row");

// ── 4. `_versions/` stays unwritable, asked of the guard itself ──────────────────────────
is(typeof writeGuard(`${INIT}/_versions/spec.v1.md`) === "string",
   "writeGuard no longer refuses a write to _versions/ — the frozen copy an approval signed " +
   "became editable, and provenance the platform cannot vouch for is worse than none");
is(typeof writeGuard(`${INIT}/x/../_versions/spec.v1.md`) === "string",
   "a traversal reaches _versions/ past the guard");
is(writeGuard(`${INIT}/spec.md`) === null,
   "writeGuard now refuses an ordinary document — the guard is too wide, not too narrow");

// ── 5. Two source-level assertions, and what each catches ────────────────────────────────
//
// Neither can be run: both handlers resolve through `safePath`, which resolves through
// `userRoot`, which is rooted at the hard-coded `/artifacts`. So the loops themselves are read
// rather than executed, and each assertion is written to fail on the specific defect the
// contract names rather than on the absence of a word.
const src = readFileSync("services/zz-core/src/tools/artifacts.ts", "utf8");
const slice = (tool: string) => {
  const at = src.indexOf(`registerTool(\n    "${tool}"`);
  return at < 0 ? null : src.slice(at, src.indexOf("\n  );", at));
};

// document_present must record NOTHING of its own. The per-document helper owns the `shown`
// row and section 3 proves the helper writes one per call, so the only way a batch collapses
// to a single row is a log hoisted back into the registration. This is that assertion.
const present = slice("document_present");
if (!present) fail.push("document_present is not registered");
else {
  is(/presentDocument\(/.test(present),
     "document_present no longer calls presentDocument — whatever it does instead is not the " +
     "per-document path this check drives");
  is(!/logActivity\(/.test(present) && !/action: "shown"/.test(present),
     "document_present writes the `shown` record in the registration rather than per document " +
     "— one row for a batch makes an approval look attested when only its neighbour was read");
}

// document_read must not return from inside its loop: an array where one path is unreadable
// returns the readable ones and names the failure for that entry. Everything between the loop
// and the handler's final `return text(` is loop body, so a `return` in that window is an
// entry that ends the whole call.
const read = slice("document_read");
if (!read) fail.push("document_read is not registered");
else {
  const loop = read.search(/for \(const \w+ of /);
  const last = read.lastIndexOf("return text(");
  if (loop < 0) {
    fail.push("document_read has no loop over its paths — it cannot be reading an array");
  } else if (last < loop) {
    fail.push("document_read returns before it loops — the array is resolved somewhere this " +
              "check cannot see");
  } else {
    is(!/\breturn\b/.test(read.slice(loop, last)),
       "document_read returns from inside its per-path loop — one unreadable path then costs " +
       "the caller every readable one");
  }
}

if (fail.length) { console.error(fail.join("\n")); process.exit(1); }
console.log("document reads: ok");
