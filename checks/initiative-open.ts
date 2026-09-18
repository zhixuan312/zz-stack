#!/usr/bin/env node
/**
 * Opening is explicit and dated by the platform, and freeform is a first-class answer.
 *
 * WHY THIS IS NOT THE FILE THE PLAN AUTHORED. That one was six regular expressions over the
 * text of three source files, and the decisive one —
 *
 *     if (!/next_move[^\n]*null|null[^\n]*next_move/.test(status))
 *
 * — is satisfied by any COMMENT containing those two words near each other. The
 * implementation of this task necessarily writes such a comment: the whole point of
 * `next_move: null` is that it needs explaining, so the explanation goes in the file, and the
 * explanation alone turns that assertion green. `/isoToday|today/` over `initiative-acts.ts`
 * was ALREADY GREEN before this task began — that file imports `isoToday` for
 * `document_approve`. Measured against untouched code the plan's form reported 5 failures of
 * 6; the two that mattered most were the two a sentence could fix.
 *
 * AND THE SAME SHAPE HID TWO REAL BUGS FROM THE SAME GREP. The contract's own sentence —
 * "a freeform initiative accepts every document operation, gate and close that a governed one
 * does" — was FALSE when this task started. `document_approve` and `document_revise` tested
 * `!chain.docs.has(...)` against EMPTY_CHAIN's empty Set and refused every act on a freeform
 * initiative; `initiative_close` refused every freeform close because `closingDoc` was `""`;
 * `snapshotOnApproval` filed no frozen copy and `ledgerOnClose` appended no row. A grep for
 * that sentence would have matched the PROMISE — in the plan, and in the comments this task
 * necessarily writes — while the code did the exact opposite of it. That is the argument for
 * driving the code rather than reading it, in its most concrete form available.
 *
 * So this one RUNS the code, the way `checks/document-reads.ts` and `checks/attest-shown.ts`
 * do:
 *   - `initiativeState`, exported from initiative-status.ts and taking `root` explicitly, is
 *     driven over a fixture store. IN BOTH DIRECTIONS, which is the half a null-only check
 *     cannot see: a freeform initiative must answer null, AND a flow-driven one must still
 *     answer its real next document. An implementation that returns null always satisfies the
 *     first and is completely broken.
 *   - the real zod schemas, harvested by handing `registerInitiativeOpenTool` a stub server.
 *     `flow` being OPTIONAL is a fact about a schema; no sentence about freeform can make
 *     `z.string()` accept `undefined`.
 *   - `initiativeNameFor` against `isoToday`, both loaded from dist, so "the date is the
 *     platform's" is an equality rather than a grep for the word.
 *   - `slugRefusal`, `takenRefusal`, `recordOpen`, `openRecord` and `unopenedRefusal` called
 *     directly, each asserted to fire AND not to fire. (This list named a sixth,
 *     `declaredFlowContent`, which is defined nowhere in this repository and which nothing
 *     below calls — a docstring claiming coverage that could not exist.)
 *
 * WHAT IS NOT DRIVEN, and why. The handler resolves
 * through `userRoot()`, which is rooted at the hard-coded `/artifacts`. So the two assertions
 * about the WRITE path are source-level over comment-stripped text, labelled as such in
 * section 7, and each is written to fail on the specific defect the contract names rather
 * than on the absence of a word.
 *
 * Run: node checks/initiative-open.ts   (also run by scripts/gate.ts)
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// THE CATALOG, BEFORE ANY IMPORT. @zz/catalog reads CATALOG_DIR into a module-level const at
// load time and it defaults to the deployment's `/catalog` mount, which does not exist here.
// Section 4b drives the real `chainFor` against a real flow manifest, and without this it
// would resolve nothing and pass for the wrong reason.
process.env.ZZ_CATALOG_DIR = join(process.cwd(), "catalog");

const load = (p: string) => import(pathToFileURL(join(process.cwd(), p)).href);
const { initiativeState } = await load("services/zz-core/dist/tools/initiative-status.js");
const rec = await load("services/zz-core/dist/initiative-record.js");
const { slugRefusal } = await load("services/zz-core/dist/document-rules.js");
const { chainFor } = await load("services/zz-core/dist/chain.js");
const wg = await load("services/zz-core/dist/write-guards.js");
const { registerInitiativeActTools } = await load("services/zz-core/dist/tools/initiative-acts.js");
const { registerArtifactTools } = await load("services/zz-core/dist/tools/artifacts.js");
const { isoToday } = await load("services/zz-core/dist/write-guards.js");

const fail: string[] = [];
const is = (cond: unknown, why: string) => { if (!cond) fail.push(why); };

/** Every path this check reads goes through here.
 *
 * A SCAN THAT GOES BLIND MUST NOT READ AS A SCAN THAT FOUND NOTHING WRONG. Three checks in
 * this initiative have had unreachable failure paths, and the shape is always the same: a
 * file moves or a directory is renamed, the read yields nothing, and every assertion over it
 * passes on the empty string. Recorded FIRST, because a missing path invalidates everything
 * below it rather than adding one more line to a list. Copied from checks/core-surface-19.ts,
 * which arrived at it the same way. */
const blind: string[] = [];
const readSrc = (p: string) => {
  try { return readFileSync(p, "utf8"); }
  catch { blind.push(p); return ""; }
};

// ── 1. The tool is on the core door, and its schema says what the contract says ───────────
//
// Registered through `registerInitiativeActTools`, NOT through its own registrar: what a
// client is offered is what server.ts wires up, and a tool defined in a file nothing calls is
// a tool nobody can reach. Stubbing the acts registrar answers reachability and registration
// in one, and does not care which file the definition lives in.
interface ZodLike { safeParse: (v: unknown) => { success: boolean } }
interface ToolDef { inputSchema?: Record<string, ZodLike>; [key: string]: unknown }

const tools = new Map<string, ToolDef>();
registerInitiativeActTools({ registerTool: (name: string, def: ToolDef) => tools.set(name, def) });

const def = tools.get("initiative_open");
if (!def) {
  fail.push("initiative_open is not registered on the core door — registerInitiativeActTools " +
            `offers ${[...tools.keys()].sort().join(", ") || "nothing"}`);
} else {
  const shape = def.inputSchema ?? {};
  is(shape.slug?.safeParse("payment-retries").success,
     "initiative_open does not take a `slug`");
  // A MISSING FLOW IS NOT AN ERROR. This is the schema-level half of "freeform is a choice":
  // `z.string()` refuses undefined and `z.string().optional()` does not, and no amount of
  // prose about freeform being first-class changes which one is written.
  is(shape.flow?.safeParse(undefined).success === true,
     "initiative_open's `flow` is not optional — a freeform open is refused by the schema " +
     "before any handler runs, which makes freeform an omission rather than a choice");
  is(shape.flow?.safeParse("sdlc-flow").success, "initiative_open's `flow` refuses a flow name");
  // THE DATE IS THE PLATFORM'S: there must be no way to pass one. An argument that accepts a
  // date is the defect document-rules.ts:64-71 records, restored under a new name.
  const dateish = Object.keys(shape).filter((k) => /date|day|today|when|stamp/i.test(k));
  is(dateish.length === 0,
     `initiative_open takes ${dateish.join(", ")} — the date is the platform's, and an ` +
     "argument for it is the one thing document-rules.ts:64-71 says must not exist");
}

// ── 2. The name the platform composes ────────────────────────────────────────────────────
is(rec.initiativeNameFor("payment-retries") === `${isoToday()}-payment-retries`,
   `initiativeNameFor produced ${rec.initiativeNameFor("payment-retries")}, not ` +
   `${isoToday()}-payment-retries — the folder is not stamped from the platform's own clock`);
is(rec.initiativeNameFor("  spaced  ") === `${isoToday()}-spaced`,
   "a slug's surrounding whitespace reaches the folder name");
// THE FUNCTION TAKES NO DATE. An argument for one is the defect document-rules.ts records —
// an agent inferring "today" — restored under a new name, and the arity is the only statement
// of that a comment cannot contradict.
is(rec.initiativeNameFor.length === 1,
   `initiativeNameFor takes ${rec.initiativeNameFor.length} arguments — the date must come ` +
   "from the platform's clock inside it, never from a caller");

// A slug that already carries a date would be dated twice, and the result still sorts, so
// nothing downstream would ever report it.
is(typeof slugRefusal("2026-09-13-payment-retries") === "string",
   "a slug that already begins with a date is accepted — the platform prepends today's on " +
   "top of it and files <today>-<yesterday>-slug, which sorts and is therefore never noticed");
is(typeof slugRefusal("../other-team") === "string", "a traversal is accepted as a slug");
is(typeof slugRefusal("") === "string", "an empty slug is accepted");
// The control. A refusal-only assertion is satisfied by refusing everything.
is(slugRefusal("payment-retries") === null,
   "an ordinary slug is refused — slugRefusal refuses more than the contract names");

// ── 3. The store, and the two directions of next_move ────────────────────────────────────
const root = mkdtempSync(join(tmpdir(), "zz-open-"));

/** The shape chain.ts derives. Built inline because EMPTY_CHAIN is not exported and
 * `deriveChain([], null)` is deterministic — a flow that declares nothing. */
interface DocSpec {
  name: string; role?: string; gate?: boolean; closing?: boolean;
  requires?: string; requiredForClose?: boolean;
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
const EMPTY = chainOf(null, []);
const GOVERNED = chainOf("sdlc-flow", [
  { name: "spec.md", role: "spec", gate: true, closing: true },
  { name: "plan.md", role: "plan", gate: true, requires: "spec.md" },
]);

const doc = (fields: Record<string, string>, body: string) =>
  `---\n${Object.entries(fields).map(([k, v]) => `${k}: ${v}`).join("\n")}\n---\n\n${body}\n`;

// ── 3a. FREEFORM: a folder somebody assembled by hand ────────────────────────────────────
const FREE = "2026-09-14-hand-assembled";
mkdirSync(join(root, FREE, "sources"), { recursive: true });
writeFileSync(join(root, FREE, "notes.md"), doc({ title: "Notes" }, "# Notes\n\nWhat we found."));
writeFileSync(join(root, FREE, "decision.md"), doc({ title: "Decision" }, "# Decision"));

const free = initiativeState(root, FREE, EMPTY, EMPTY.documents);
// STRICTLY null. `undefined` would serialise away entirely and the caller would read a
// response with no `next_move` key at all, which is a missing answer rather than an answer.
is(free.next_move === null,
   `a freeform initiative's next_move is ${JSON.stringify(free.next_move)}, not null — the ` +
   "platform is naming a next stage for an initiative that declared no chain, which is a guess");
is(typeof free.next_move_absent === "string" && free.next_move_absent.trim().length > 20,
   "next_move is null with no stated reason — a caller cannot tell `freeform, and that is " +
   "fine` from `the platform failed to compute one`, and those want opposite reactions");
// A freeform initiative is not DEGRADED: it still reports its documents.
is(free.documents.map((d: { name: string }) => d.name).sort().join(",") === "decision.md,notes.md",
   `a freeform initiative lists ${JSON.stringify(free.documents.map((d: { name: string }) => d.name))} — its ` +
   "documents are not reported, so freeform is being treated as an empty initiative");

// 3a-ii. A CLOSED freeform initiative is CLOSED, and the listing has to be able to see it.
//
// There is no manifest naming a closing document, so the outcome is read off whichever
// document carries one — the same document initiative_close was told to write it on.
// Reporting null here makes every freeform close invisible: the no-argument listing filters
// on `next_move?.action === "closed"`, so the initiative would be reported as open for good.
writeFileSync(join(root, FREE, "decision.md"),
  doc({ title: "Decision", outcome: "delivered", closed_by: "cy@zz.test" }, "# Decision"));
const freeClosed = initiativeState(root, FREE, EMPTY, EMPTY.documents);
is(freeClosed.outcome === "delivered",
   `a closed freeform initiative reports outcome ${JSON.stringify(freeClosed.outcome)} — with ` +
   "no manifest to name a closing document the outcome must be read off whichever document " +
   "carries one, or every freeform close is invisible to the platform that recorded it");
is(freeClosed.closed_by === "cy@zz.test",
   "a closed freeform initiative reports what it closed as without saying who closed it");
is(freeClosed.next_move?.action === "closed",
   `a closed freeform initiative's next_move is ${JSON.stringify(freeClosed.next_move)} — the ` +
   "no-argument listing filters on `closed`, so this one is reported as open for good");
// Restore the fixture to its OPEN state; everything after this reads it as freeform-and-open.
writeFileSync(join(root, FREE, "decision.md"), doc({ title: "Decision" }, "# Decision"));
is(initiativeState(root, FREE, EMPTY, EMPTY.documents).next_move === null,
   "an OPEN freeform initiative is reported closed — the outcome scan is matching a document " +
   "that carries none");

// ── 3b. GOVERNED: the same function must still name the real next document ───────────────
//
// THIS IS THE ASSERTION A NULL-ALWAYS IMPLEMENTATION FAILS. Everything in 3a is satisfied by
// `return { next_move: null }` for every initiative on the platform.
const GOV = "2026-09-14-governed";
mkdirSync(join(root, GOV), { recursive: true });

let gov = initiativeState(root, GOV, GOVERNED, GOVERNED.documents);
is(gov.next_move?.action === "write_document" && gov.next_move?.document === "spec.md",
   `an initiative governed by a flow answered ${JSON.stringify(gov.next_move)} — it must name ` +
   "the flow's first declared document, and a null here is the platform refusing to say what " +
   "it does know");
is(gov.next_move_absent === undefined,
   "a governed initiative carries a next_move_absent reason beside a real next move");

writeFileSync(join(root, GOV, "spec.md"), doc({ title: "Spec", status: "draft" }, "# Spec"));
gov = initiativeState(root, GOV, GOVERNED, GOVERNED.documents);
is(gov.next_move?.action === "await_approval" && gov.next_move?.document === "spec.md",
   `with spec.md written and unapproved the next move is ${JSON.stringify(gov.next_move)}, ` +
   "not the gate — the gates a flow declares are what a governed initiative gets and a " +
   "freeform one does not");

writeFileSync(join(root, GOV, "spec.md"),
  doc({ title: "Spec", status: "approved", approved_by: "ada@zz.test", approved_at: "2026-09-14" },
      "# Spec"));
gov = initiativeState(root, GOV, GOVERNED, GOVERNED.documents);
is(gov.next_move?.action === "write_document" && gov.next_move?.document === "plan.md",
   `once spec.md is approved the next move is ${JSON.stringify(gov.next_move)}, not plan.md — ` +
   "the flow's declared ORDER is not being walked");

// ── 4. The open record: written, invisible as a document, and read by chainFor ───────────
const GOVERNED_NAME = `${isoToday()}-with-a-flow`;
const written = rec.recordOpen(root, GOVERNED_NAME, "sdlc-flow", "ada@zz.test");
is(written.flow === "sdlc-flow" && written.opened_by === "ada@zz.test"
   && written.opened_at === isoToday(),
   `the open record is ${JSON.stringify(written)} — it does not carry the flow, the opener ` +
   "and the platform's own date");
is(rec.openRecord(root, GOVERNED_NAME)?.flow === "sdlc-flow",
   "the flow an initiative was opened with cannot be read back");

const FREEFORM_NAME = `${isoToday()}-opened-freeform`;
is(rec.recordOpen(root, FREEFORM_NAME, null, "bo@zz.test").flow === null,
   "a freeform open records something other than null for its flow");
// A DECLARED FREEFORM AND NO RECORD AT ALL ARE DIFFERENT FACTS, and the resolver has to be
// able to tell them apart: one is a person saying nothing governs this, the other is silence.
// A `declaredFlow(): string | null` helper collapses both to null and the single-flow
// fallback below then overrules the first of them.
is(rec.openRecord(root, FREEFORM_NAME)?.flow === null,
   "an initiative opened deliberately freeform reads back as governed by something");
is(rec.openRecord(root, `${isoToday()}-never-opened`) === null,
   "an initiative with no record reports one");

// The record must not be mistaken for a document. Every listing on this platform filters
// `_`-prefixed entries, and a record reported as a document would appear with no status, no
// gate and no place in any chain. Asked of what recordOpen actually wrote, not of a constant.
is(readdirSync(join(root, FREEFORM_NAME)).every((f) => f.startsWith("_")),
   `opening wrote ${JSON.stringify(readdirSync(join(root, FREEFORM_NAME)))} into the folder — ` +
   "anything without a leading underscore is listed as one of the team's documents");
writeFileSync(join(root, FREEFORM_NAME, "notes.md"), doc({ title: "N" }, "# N"));
const openedFree = initiativeState(root, FREEFORM_NAME, EMPTY, EMPTY.documents);
is(openedFree.documents.map((d: { name: string }) => d.name).join(",") === "notes.md",
   `an opened freeform initiative lists ${JSON.stringify(openedFree.documents.map((d: { name: string }) => d.name))}` +
   " — the platform's own record is being reported as one of the team's documents");
is(openedFree.next_move === null, "an initiative opened deliberately freeform is given a next move");

// ── 4b. WHAT THE RECORD IS FOR, driven through the real resolver ─────────────────────────
//
// This is the strongest assertion in the file. `chainFor` resolves a flow from a document's
// envelope or from the team's single install; a flow-driven initiative is an EMPTY FOLDER
// until its first document lands, so in that window neither source can answer — and that
// window is exactly when a resuming agent calls initiative_status. `chainForTeam(null)`
// returns null with no database, so the ONLY thing that can produce a named chain here is
// the record written above.
const resolved = chainFor(root, `${GOVERNED_NAME}/x.md`);
is(resolved.name === "sdlc-flow",
   `chainFor answered ${JSON.stringify(resolved.name)} for an initiative opened WITH a flow ` +
   "and no documents yet — the open record is not consulted, so the platform reports work " +
   "somebody deliberately governed as freeform for as long as its folder is empty");
is(resolved.documents.length > 0,
   "the chain resolved off the open record declares no documents, so there is nothing to " +
   "compute a next move over and a governed initiative still answers like a freeform one");
// The control, in the other direction: an initiative opened freeform must NOT acquire one.
is(chainFor(root, `${FREEFORM_NAME}/x.md`).name === null,
   "an initiative opened freeform resolves to a named chain — the record is being read as a " +
   "declaration where it declares nothing, which is the platform choosing a flow for somebody");

// 4c. A DECLARED FREEFORM OUTRANKS EVERY FALLBACK, which is where the real hole was.
//
// `flow: null` in the record is a person saying nothing governs this work. chainFor's last
// two resorts do not know that on their own: the oldest-document walk takes whatever `flow:`
// it finds in an envelope, and `chainForTeam` gives a team with exactly ONE installed flow
// that flow for any initiative naming none. So a deliberately freeform initiative on a
// single-flow team was governed by it — every write judged against a chain nobody asked for,
// stages named off a manifest the person declined. One install is not consent; it is the only
// thing there was to guess with, and chain.ts:75-82 calls guessing here a wrong answer rather
// than a fallback.
//
// The team fallback needs a database and cannot run in the gate, so the ENVELOPE fallback
// stands in for it: same position in the function, same question — does a declared freeform
// survive something further down that would happily answer?
const STRAY = `${isoToday()}-freeform-with-a-stray-envelope`;
mkdirSync(join(root, STRAY), { recursive: true });
rec.recordOpen(root, STRAY, null, "cy@zz.test");
writeFileSync(join(root, STRAY, "notes.md"),
  doc({ title: "Notes", flow: "sdlc-flow" }, "# Notes"));
is(chainFor(root, `${STRAY}/other.md`).name === null,
   "an initiative opened deliberately freeform picked up a flow from a fallback further down " +
   "chainFor — a `flow: null` record is a person declining a flow, and anything that overrules " +
   "it adopts one on their behalf at open time, which is what FR-30 forbids doing afterwards");
// And the control for THAT: without a record, the envelope must still answer, or this
// short-circuit has broken resolution for every initiative written before the record existed.
const LEGACY = `${isoToday()}-no-record-at-all`;
mkdirSync(join(root, LEGACY), { recursive: true });
writeFileSync(join(root, LEGACY, "spec.md"), doc({ title: "S", flow: "sdlc-flow" }, "# S"));
is(chainFor(root, `${LEGACY}/other.md`).name === "sdlc-flow",
   "an initiative with NO open record no longer resolves its flow from its own documents — " +
   "every initiative written before the record existed just became ungoverned");

// 4d. THE DECLARATION SURVIVES A LOST LOG LINE.
//
// `logActivity` swallows every failure by design — persist.ts:135, "telemetry must never
// break the operation it describes" — and an append that fails creates no file at all
// (verified: an unwritable directory produces no throw and no log). So the flow declaration
// cannot live only in the activity log: chainFor returns EMPTY_CHAIN for a record that says
// freeform, and a lost line would silently convert an initiative somebody governed into one
// governed by nothing, permanently, with nothing anywhere saying so — a failure "in the
// direction that looks like success", which is the phrase chain.ts uses for exactly this.
//
// Driven by deleting the log and re-asking. The event is still logged beside the record,
// because the open IS an event; what this asserts is that nothing READS the declaration from
// there.
rmSync(join(root, GOVERNED_NAME, "activity.jsonl"), { force: true });
is(chainFor(root, `${GOVERNED_NAME}/x.md`).name === "sdlc-flow",
   "with the activity log deleted the flow can no longer be resolved — the declaration is " +
   "being read out of best-effort telemetry, so an append that silently failed leaves an " +
   "initiative somebody governed reporting as freeform for the rest of its life");

// ── 5. The slug is what is taken ─────────────────────────────────────────────────────────
is(rec.takenRefusal(root, "hand-assembled") !== null,
   "a slug an existing initiative already uses is accepted — two folders with the same slug " +
   "and different dates diverge, and nothing downstream can say which one was meant");
is(/2026-09-14-hand-assembled/.test(rec.takenRefusal(root, "hand-assembled") ?? ""),
   "the taken refusal does not NAME the existing initiative, so the caller cannot continue it");
is(rec.takenRefusal(root, "something-nobody-opened") === null,
   "an unused slug is refused as taken");
// A slug that is a PREFIX of an existing one is not the same slug.
rec.recordOpen(root, `${isoToday()}-payment-retries`, null, "ada@zz.test");
is(rec.takenRefusal(root, "payment") === null,
   "`payment` is refused because `payment-retries` exists — a prefix match blocks slugs " +
   "nobody has taken");

// ── 6. Neither write path creates any more: the refusal, driven ──────────────────────────
is(typeof rec.unopenedRefusal(root, `${isoToday()}-never-opened/spec.md`) === "string",
   "a write into an initiative nobody opened is accepted — the write still creates the " +
   "initiative, and initiative_open is decorative");
is(/initiative_open/.test(rec.unopenedRefusal(root, `${isoToday()}-never-opened/spec.md`) ?? ""),
   "the refusal does not name initiative_open, so it is a dead end rather than an instruction");
is(rec.unopenedRefusal(root, `${FREE}/anything.md`) === null,
   "a write into an initiative that WAS opened is refused — the guard is too wide, and every " +
   "document after the first would be blocked");
is(rec.unopenedRefusal(root, "README.md") === null,
   "a file at the root of the store is treated as an initiative document");

// ── 7. Two source-level assertions, and what each catches ────────────────────────────────
//
// Neither can be run: `document_write` resolves through `safePath`, which resolves through
// `userRoot`, which is rooted at the hard-coded `/artifacts`. Comments are stripped first, so
// neither is satisfiable by an explanation of the change.
const stripped = (p: string) => readSrc(p)
  .split("\n").filter((l) => !l.trim().startsWith("//")).join("\n")
  .replace(/\/\*[\s\S]*?\*\//g, "");
const arts = stripped("services/zz-core/src/tools/artifacts.ts");

// THE GUARDS MOVED, they were not copied. Two creation guards left on the write path is two
// places a rule about creating can be changed independently — which is the shape of the
// defect `documentGuards`' own header comment describes ("a guard added later cannot land on
// one path only").
for (const g of ["initiativeNameShape", "initiativeNameTaken"]) {
  is(!new RegExp(`\\b${g}\\b`).test(arts),
     `artifacts.ts still calls ${g} — the creation guards must LEAVE document_write, not be ` +
     "duplicated onto both paths: opening is the only thing that creates an initiative now");
}
// Control: the guard has to have landed somewhere, or it was deleted rather than moved.
// Section 6 proves the refusal works; this proves the write paths are callers of it. TWICE,
// because `source_add` is the second creation path and it is the easy one to miss —
// `mkdirSync(..., {recursive:true})` builds `<initiative>/sources/` for a folder that does
// not exist, so attaching material used to conjure the initiative document_write is refused
// for, leaving a half-initiative nobody opened.
is((arts.match(/unopenedRefusal\s*\(/g) ?? []).length >= 2,
   "artifacts.ts calls unopenedRefusal " +
   `${(arts.match(/unopenedRefusal\s*\(/g) ?? []).length} time(s) — both document_write and ` +
   "source_add create, so both must ask");

// `document_write` MUST NOT TAKE A FLOW. Asked of the real schema, not the source: an
// argument that declares a flow on a document is the adopt-a-flow tool FR-30 forbids, reached
// through a parameter instead of a verb.
const arttools = new Map<string, ToolDef>();
registerArtifactTools({ registerTool: (name: string, def: ToolDef) => arttools.set(name, def) });
is(arttools.get("document_write")?.inputSchema?.flow === undefined,
   "document_write still takes a `flow` argument — an initiative opened freeform acquires a " +
   "manifest on its next document, and the gates that manifest declares land on documents " +
   "already written and unapproved. FR-30 forbids adopting a flow after the fact.");
is(arttools.get("document_write")?.inputSchema?.content !== undefined,
   "document_write no longer takes `content` — this check is reading the wrong tool");

// NO ADOPT-A-FLOW TOOL, per FR-30. Asserted over every source file rather than over the
// tools directory: a registration moved one directory sideways is still a registration.
const walk = (d: string): string[] => {
  let entries: string[];
  try { entries = readdirSync(d); } catch { blind.push(d); return []; }
  return entries.flatMap((f): string[] => {
    const p = join(d, f);
    return statSync(p).isDirectory() ? (f === "dist" || f === "node_modules" ? [] : walk(p)) : [p];
  });
};
const swept = walk("services/zz-core/src");
// The sweep's own control: a walk that returned nothing proves nothing about what is absent.
is(swept.length > 20,
   `the adopt-a-flow sweep walked ${swept.length} file(s) under services/zz-core/src — it has ` +
   "gone blind, and an absence asserted over nothing is not an absence");
for (const p of swept) {
  if (/registerTool\(\s*\n?\s*"initiative_adopt"/.test(readSrc(p))) {
    fail.push(`an adopt-a-flow tool is registered in ${p}; FR-30 forbids one — retrofitting a ` +
              "manifest onto documents written without it is a migration dressed as a verb");
  }
}

// ── 8. "Freeform accepts every operation a governed one does" — the half that was false ──
//
// The contract states it and nothing enforced it. Three guards keyed off `chain.docs`, which
// is an EMPTY SET for a freeform initiative, so each one silently changed meaning: the two
// value guards below went quiet, and the membership tests in document_approve, document_revise
// and initiative_close refused outright. A sentence in a plan cannot tell those apart from a
// working feature — only running them can.

// 8a. The value guards, driven. `statusCheck` and `outcomeCheck` are pure functions of a
// chain, a path and text, so both directions are one call each.
const freeChain = chainOf(null, []);
is(typeof wg.statusCheck(freeChain, `${FREE}/notes.md`, "---\nstatus: nearly\n---\n") === "string",
   "statusCheck is silent on a freeform document — `status: nearly` is accepted there, which " +
   "is the exact category error the guard exists to catch, switched off by the absence of a " +
   "manifest rather than by anything anybody decided");
is(typeof wg.outcomeCheck(freeChain, `${FREE}/notes.md`, "---\noutcome: banana\n---\n") === "string",
   "outcomeCheck is silent on a freeform document — an unvalidated word reaches the ledger " +
   "row the team's counts are totalled from");
// Both controls: a legal value must still pass, or the guards refuse everything.
is(wg.statusCheck(freeChain, `${FREE}/notes.md`, "---\nstatus: draft\n---\n") === null,
   "statusCheck refuses `status: draft` on a freeform document");
is(wg.outcomeCheck(freeChain, `${FREE}/notes.md`, "---\noutcome: delivered\n---\n") === null,
   "outcomeCheck refuses `outcome: delivered` on a freeform document");
// And a flow's OWN declaration must still exempt a document it never named, or the change
// widened the guards instead of un-silencing them.
is(wg.statusCheck(GOVERNED, `${GOV}/stray.md`, "---\nstatus: nearly\n---\n") === null,
   "statusCheck now judges a document the flow never declared — the declaration must narrow " +
   "the guard, and its absence must not switch it off; those are different rules");

// 8b. The three membership tests, source-level and labelled. Each handler resolves through
// `userRoot()`, so the CONDITION is read rather than run — but read after comments are
// stripped, and asserted on its exact shape rather than on a word.
const acts = stripped("services/zz-core/src/tools/initiative-acts.ts");
const bare = [...acts.matchAll(/if \(\s*!chain\.docs\.has\(/g)].length;
is(bare === 0,
   `initiative-acts.ts has ${bare} membership test written as a bare \`!chain.docs.has(...)\` ` +
   "— a freeform initiative resolves to EMPTY_CHAIN, whose docs Set is empty, so every " +
   "approval or revision on one is refused with an error naming a flow that does not exist");
is(/chain\.documents\.length && !chain\.docs\.has\(/.test(acts),
   "no membership test in initiative-acts.ts is narrowed by the flow's own declaration — the " +
   "guard has been deleted rather than corrected, and a flow that DID name its documents no " +
   "longer refuses one it never declared");
// initiative_close must not refuse a freeform close outright, and must ask which document
// records it rather than picking one.
is(!/if \(!chain\.closingDoc\) \{/.test(acts),
   "initiative_close still refuses outright when no flow declares a closing document — " +
   "EMPTY_CHAIN's closingDoc is the empty string, so no freeform initiative can ever close");
const closeDef = tools.get("initiative_close")?.inputSchema ?? {};
is(closeDef.document?.safeParse("notes.md").success
   && closeDef.document?.safeParse(undefined).success,
   "initiative_close takes no OPTIONAL `document` — a freeform close has no manifest to read " +
   "a closing document off, and the alternatives are all the platform guessing which file the " +
   "team's ledger row should sit on");

// 8c. The frozen copy and the ledger row, which are what make an approval and a close real.
const persist = stripped("services/zz-core/src/persist.ts");
is(!/\|\|\s*!chain\.docs\.has\(parts\[1\]\)\) return;/.test(persist)
   && /chain\.documents\.length && !chain\.docs\.has\(parts\[1\]\)\) return;/.test(persist),
   "snapshotOnApproval's membership test is not narrowed by the flow's own declaration — as " +
   "a bare `!chain.docs.has(...)` it returns for every document of a freeform initiative, so " +
   "an approval there files no frozen copy at all and the approver's name stands on bytes " +
   "with nothing recording what they were");
is(!/chain\.closingDoc && parts\[1\] !== chain\.closingDoc/.test(persist),
   "ledgerOnClose still skips a close that did not land on the manifest's closing " +
   "document. An ABANDONED initiative is exactly that close — the work stopped before the " +
   "closing document was written, so initiative_close records it on the furthest document " +
   "that exists — and the ledger, which the team's counts are totalled from, never received " +
   "the one outcome it most needs. The outcome's PRESENCE is the signal: outcomeCheck " +
   "refuses an outcome typed by hand, initiative_close writes exactly one, and the " +
   "already-closed test stops a second row");

// FIRST, ahead of everything else: if a path could not be read, every assertion over it
// passed on the empty string and this run measured less than it appears to have measured.
if (blind.length) {
  console.error(
    `could not read ${blind.join(", ")} — this check scans it, so every assertion about it ` +
    "passed on nothing. Fix the path before reading anything below as a pass.");
  process.exit(1);
}
if (fail.length) { console.error(fail.join("\n")); process.exit(1); }
console.log("initiative_open: ok");
