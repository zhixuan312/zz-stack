#!/usr/bin/env node
/**
 * Opening is explicit and dated by the platform, and freeform is a first-class answer.
 *
 * This check runs the code rather than grepping its source:
 *   - `initiativeState`, exported from initiative-status.ts and taking `root` explicitly, is
 *     driven over a fixture store, in both directions: a freeform initiative must answer null,
 *     and a flow-driven one must still answer its real next document.
 *   - the real zod schemas, harvested by handing `registerInitiativeOpenTool` a stub server.
 *   - `initiativeNameFor` against `isoToday`, both loaded from dist, so "the date is the
 *     platform's" is an equality rather than a grep for the word.
 *   - `slugRefusal`, `takenRefusal`, `recordOpen`, `openRecord` and `unopenedRefusal` called
 *     directly, each asserted to fire and not to fire.
 *
 * The write path is not driven: the handler resolves through `userRoot()`, rooted at the
 * hard-coded `/artifacts`. Its two assertions are source-level over comment-stripped text,
 * labelled as such in section 7.
 *
 * Run: node checks/initiative-open.ts   (also run by scripts/gate.ts)
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import pg from "pg";

// The catalog is set before any import: @zz/catalog reads CATALOG_DIR into a module-level
// const at load time, defaulting to the deployment's `/catalog` mount, which does not exist
// here. COUPLED: section 4b drives the real `chainFor` against a real flow manifest, and
// without this it would resolve nothing and pass for the wrong reason.
process.env.ZZ_CATALOG_DIR = join(process.cwd(), "catalog");
process.env.TEAM_DB_URL = "postgresql://stub@127.0.0.1:1/stub";

const TEAM = "t1";
/** One initiative's world: its own row, its documents, its branch facts and its stage records.
 *  A document is a `zz.doc` row plus the revision it points at — the store's files, as rows. */
interface W { flow: string | null; docs: Record<string, unknown>[]; facts: Record<string, string>;
             records: Record<string, Record<string, string>> }
const world = new Map<string, W>();
let seq = 0;
const ensure = (name: string): W => {
  let w = world.get(name);
  if (!w) { w = { flow: null, docs: [], facts: {}, records: {} }; world.set(name, w); }
  return w;
};
/** A document written into an initiative, from the envelope TEXT a caller would have sent. The
 *  columns come off the frontmatter and everything else is the revision's payload — which is
 *  exactly how the writer splits them. */
const COLUMN_KEYS = new Set(["status", "outcome", "closed_by", "approved_by", "approved_at", "title", "version", "flow"]);
const wrote = (initiative: string, path: string, text: string): void => {
  const w = ensure(initiative);
  const block = /^---\n([\s\S]*?)\n---/.exec(text);
  const env: Record<string, string> = {};
  for (const line of (block?.[1] ?? "").split("\n")) {
    const cut = line.indexOf(":");
    if (cut > 0) env[line.slice(0, cut).trim()] = line.slice(cut + 1).trim();
  }
  w.docs = w.docs.filter((d) => d.path !== path);
  w.docs.push({ id: `d${++seq}`, path, initiative, flow: env.flow ?? "", type: "",
    status: env.status ?? "", outcome: env.outcome ?? null, approved_by: env.approved_by ?? null,
    approved_at: env.approved_at ?? null, closed_by: env.closed_by ?? null,
    updated_at: "2026-09-14T00:00:00.000Z", title: env.title ?? path,
    body: text.slice(block ? block[0].length : 0).trim(), tags: [],
    current_revision: Number(env.version) || 1, approved_revision: null,
    // `supports` is a relation and not an envelope key, so it is read off the frontmatter into
    // the row's own list rather than left in the payload `docRows` would answer with.
    supports: (env.supports ?? "").split(",").map((x) => x.trim()).filter(Boolean),
    fields: Object.fromEntries(Object.entries(env)
      .filter(([k]) => !COLUMN_KEYS.has(k) && k !== "supports")) });
};

pg.Pool.prototype.query = (async function query(text: string, values: unknown[] = []) {
  const sql = String(text).replace(/\s+/g, " ").trim();
  const one = (rows: Record<string, unknown>[]) => ({ rows, rowCount: rows.length });
  const bySlug = world.get(String(values[1] ?? ""));
  // `recordOpen` resolves the team id before it writes the row.
  if (/select id::text as id from zz\.team where slug = \$1/.test(sql)) return one([{ id: "t-1" }]);
  // `takenRefusal` asks the roster for the slugs that match a prefix.
  if (/i\.slug ~ \('\^\\d\{4\}-/.test(sql)) {
    return one([...world.keys()].filter((k) => new RegExp(`^\\d{4}-\\d{2}-\\d{2}-${values[1]}$`).test(k))
      .sort().map((slug) => ({ slug })));
  }
  if (/select i\.slug, i\.flow, i\.closed_at::text/.test(sql)) {
    const names = (values[1] as string[]) ?? [];
    return one(names.filter((n) => world.has(n)).map((n) => ({
      slug: n, flow: world.get(n)!.flow, closed_at: null, closed_by: null, outcome: null })));
  }
  if (/select i\.slug from zz\.initiative i join zz\.team t on t\.id = i\.team_id where t\.slug = \$1 order by i\.slug/.test(sql)) {
    return one([...world.keys()].sort().map((slug) => ({ slug })));
  }
  // `recordOpen` writes the initiative's own row, and that row IS the record.
  if (/insert into zz\.initiative\b/.test(sql)) {
    const w = ensure(String(values[1]));
    w.flow = values[2] === null || values[2] === undefined ? null : String(values[2]);
    return one([{ flow: w.flow, opened_at: isoToday(), opened_by: String(values[3]) }]);
  }
  if (/from zz\.initiative i join zz\.team t on t\.id = i\.team_id/.test(sql)) {
    return one(bySlug ? [{ id: "i1", flow: bySlug.flow, opened_at: "2026-09-14",
                           opened_by: "ada@zz.test", slug: String(values[1]) }] : []);
  }
  if (/from zz\.initiative_fact f\b/.test(sql)) {
    return one(Object.entries(bySlug?.facts ?? {}).map(([fact, value]) => ({ fact, value })));
  }
  if (/from zz\.initiative_record r\b/.test(sql)) return one([]);
  if (/from zz\.doc d\b/.test(sql)) return one(world.get(String(values[0]))?.docs ?? []);
  return one([]);
}) as unknown as typeof pg.Pool.prototype.query;

const load = (p: string) => import(pathToFileURL(join(process.cwd(), p)).href);
const { initiativeState } = await load("services/zz-core/dist/tools/initiative-status.js");
const { initiativeNameFor, openRecord, recordOpen, takenRefusal, unopenedRefusal } =
  await load("services/zz-core/dist/initiative-record.js");
const { db } = await load("services/zz-core/dist/platform-db.js");
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
 * A scan that goes blind must not read as a scan that found nothing wrong: a file that moves
 * yields an empty string, and every assertion over it passes. Recorded first, because a
 * missing path invalidates everything below it. */
const blind: string[] = [];
const readSrc = (p: string) => {
  try { return readFileSync(p, "utf8"); }
  catch { blind.push(p); return ""; }
};

// 1. The tool is on the core door, and its schema says what the contract says
//
// Registered through `registerInitiativeActTools`, not through its own registrar: what a
// client is offered is what server.ts wires up. Stubbing the acts registrar answers
// reachability and registration in one, whichever file the definition lives in.
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
  // A missing flow is not an error: `z.string()` refuses undefined and
  // `z.string().optional()` does not.
  is(shape.flow?.safeParse(undefined).success === true,
     "initiative_open's `flow` is not optional — a freeform open is refused by the schema " +
     "before any handler runs, which makes freeform an omission rather than a choice");
  is(shape.flow?.safeParse("sdlc-flow").success, "initiative_open's `flow` refuses a flow name");
  // The date is the platform's: there must be no way to pass one.
  const dateish = Object.keys(shape).filter((k) => /date|day|today|when|stamp/i.test(k));
  is(dateish.length === 0,
     `initiative_open takes ${dateish.join(", ")} — the date is the platform's, and an ` +
     "argument for it is the one thing document-rules.ts:64-71 says must not exist");
}

// 2. The name the platform composes
is(initiativeNameFor("payment-retries") === `${isoToday()}-payment-retries`,
   `initiativeNameFor produced ${initiativeNameFor("payment-retries")}, not ` +
   `${isoToday()}-payment-retries — the folder is not stamped from the platform's own clock`);
is(initiativeNameFor("  spaced  ") === `${isoToday()}-spaced`,
   "a slug's surrounding whitespace reaches the folder name");
// The function takes no date. Arity is the only statement of that a comment cannot
// contradict.
is(initiativeNameFor.length === 1,
   `initiativeNameFor takes ${initiativeNameFor.length} arguments — the date must come ` +
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

// 3. The store, and the two directions of next_move

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

// 3a. Freeform: a folder somebody assembled by hand
const FREE = "2026-09-14-hand-assembled";

wrote(FREE, "notes.md", doc({ title: "Notes" }, "# Notes\n\nWhat we found."));
wrote(FREE, "decision.md", doc({ title: "Decision" }, "# Decision"));

const free = await initiativeState(db()!, TEAM, FREE, EMPTY, EMPTY.documents);
// Strictly null. `undefined` would serialise away entirely and the caller would read a
// response with no `next_move` key at all, which is a missing answer rather than an answer.
is(free.next_move === null,
   `a freeform initiative's next_move is ${JSON.stringify(free.next_move)}, not null — the ` +
   "platform is naming a next stage for an initiative that declared no chain, which is a guess");
is(typeof free.next_move_absent === "string" && free.next_move_absent.trim().length > 20,
   "next_move is null with no stated reason — a caller cannot tell `freeform, and that is " +
   "fine` from `the platform failed to compute one`, and those want opposite reactions");
// A freeform initiative is not degraded: it still reports its documents.
is(free.documents.map((d: { name: string }) => d.name).sort().join(",") === "decision.md,notes.md",
   `a freeform initiative lists ${JSON.stringify(free.documents.map((d: { name: string }) => d.name))} — its ` +
   "documents are not reported, so freeform is being treated as an empty initiative");

// 3a-ii. A closed freeform initiative is closed, and the listing has to see it. There is no
// manifest naming a closing document, so the outcome is read off whichever document carries
// one — the same document initiative_close was told to write it on. The no-argument listing
// filters on `next_move?.action === "closed"`, so reporting null here would make every
// freeform close invisible.
wrote(FREE, "decision.md",
  doc({ title: "Decision", outcome: "delivered", closed_by: "cy@zz.test" }, "# Decision"));
const freeClosed = await initiativeState(db()!, TEAM, FREE, EMPTY, EMPTY.documents);
is(freeClosed.outcome === "delivered",
   `a closed freeform initiative reports outcome ${JSON.stringify(freeClosed.outcome)} — with ` +
   "no manifest to name a closing document the outcome must be read off whichever document " +
   "carries one, or every freeform close is invisible to the platform that recorded it");
is(freeClosed.closed_by === "cy@zz.test",
   "a closed freeform initiative reports what it closed as without saying who closed it");
is(freeClosed.next_move?.action === "closed",
   `a closed freeform initiative's next_move is ${JSON.stringify(freeClosed.next_move)} — the ` +
   "no-argument listing filters on `closed`, so this one is reported as open for good");
// Restore the fixture to its open state; everything after this reads it as freeform-and-open.
wrote(FREE, "decision.md", doc({ title: "Decision" }, "# Decision"));
is((await initiativeState(db()!, TEAM, FREE, EMPTY, EMPTY.documents)).next_move === null,
   "an OPEN freeform initiative is reported closed — the outcome scan is matching a document " +
   "that carries none");

// 3b. Governed: the same function must still name the real next document
//
// This is the assertion a null-always implementation fails; everything in 3a is satisfied by
// `return { next_move: null }`.
const GOV = "2026-09-14-governed";


let gov = await initiativeState(db()!, TEAM, GOV, GOVERNED, GOVERNED.documents);
is(gov.next_move?.action === "write_document" && gov.next_move?.document === "spec.md",
   `an initiative governed by a flow answered ${JSON.stringify(gov.next_move)} — it must name ` +
   "the flow's first declared document, and a null here is the platform refusing to say what " +
   "it does know");
is(gov.next_move_absent === undefined,
   "a governed initiative carries a next_move_absent reason beside a real next move");

wrote(GOV, "spec.md", doc({ title: "Spec", status: "draft" }, "# Spec"));
gov = await initiativeState(db()!, TEAM, GOV, GOVERNED, GOVERNED.documents);
is(gov.next_move?.action === "await_approval" && gov.next_move?.document === "spec.md",
   `with spec.md written and unapproved the next move is ${JSON.stringify(gov.next_move)}, ` +
   "not the gate — the gates a flow declares are what a governed initiative gets and a " +
   "freeform one does not");

wrote(GOV, "spec.md",
  doc({ title: "Spec", status: "approved", approved_by: "ada@zz.test", approved_at: "2026-09-14" },
      "# Spec"));
gov = await initiativeState(db()!, TEAM, GOV, GOVERNED, GOVERNED.documents);
is(gov.next_move?.action === "write_document" && gov.next_move?.document === "plan.md",
   `once spec.md is approved the next move is ${JSON.stringify(gov.next_move)}, not plan.md — ` +
   "the flow's declared ORDER is not being walked");

// 3c. A stage that produces a source is a stage
//
// sdlc-flow declares seven stages and four documents. The two audit rounds produce a source
// supporting the document they audited rather than a document of their own, so a walk over the
// manifest's `documents` cannot see them.
//
// COUPLED: `services/zz-core/src/reviewed-modules.ts` asks each audit step for `1x audit`, and
// `initiative_close` refuses a close with a round unrun. next_move and the close must name the
// same rounds.
const AUDITED = ((): Chain => {
  const c = chainOf("sdlc-flow", [
    { name: "spec.md", role: "spec", gate: true, closing: true },
    { name: "plan.md", role: "plan", gate: true, requires: "spec.md" },
  ]);
  return { ...c, stages: [
    { name: "sdlc-spec", produces: "spec.md" },
    { name: "sdlc-spec-audit", produces: "source", supports: "spec.md" },
    { name: "sdlc-plan", produces: "plan.md" },
  ] };
})();
const AUD = "2026-09-14-audited";

wrote(AUD, "spec.md",
  doc({ title: "Spec", status: "approved", approved_by: "ada@zz.test", approved_at: "2026-09-14" },
      "# Spec"));
let aud = await initiativeState(db()!, TEAM, AUD, AUDITED, AUDITED.documents);
// NOT A TOOL: `add_source` is a member of next_move.action's own vocabulary, beside
// write_document and await_approval. The tool the move asks for is `source_add`.
is(aud.next_move?.action === "add_source" && aud.next_move?.document === "spec.md",
   `with spec.md approved and no audit source, the next move is ${JSON.stringify(aud.next_move)} ` +
   "— the flow declares sdlc-spec-audit between spec and plan, and a walk over documents alone " +
   "cannot see a stage that evidences itself with a source");

// And it stops asking once the round is on the record — a source naming its stage and the
// version it read. How many rounds follow is checks/audit-rounds.ts's subject.
wrote(AUD, "sources/spec-audit.md",
  doc({ title: "Spec audit round 1", supports: "spec.md", stage: "sdlc-spec-audit",
        audits_version: "1", added_at: "2026-09-14T10:00:00.000Z" }, "No blocking findings."));
aud = await initiativeState(db()!, TEAM, AUD, AUDITED, AUDITED.documents);
is(aud.next_move?.action === "write_document" && aud.next_move?.document === "plan.md",
   `with the audit source recorded the next move is ${JSON.stringify(aud.next_move)} — the ` +
   "stage is satisfied and the walk must move on to the next document the flow declares");

// A stage whose document is not yet finished is not owed: the document's own stage is unmet
// first.
const DRAFTED = "2026-09-14-audited-draft";

wrote(DRAFTED, "spec.md", doc({ title: "Spec", status: "draft" }, "# Spec"));
const drafted = await initiativeState(db()!, TEAM, DRAFTED, AUDITED, AUDITED.documents);
is(drafted.next_move?.action === "await_approval" && drafted.next_move?.document === "spec.md",
   `with spec.md still draft the next move is ${JSON.stringify(drafted.next_move)} — the audit ` +
   "of an unapproved document must not be demanded ahead of its gate");

// 3d. A closed initiative's answer says what is true of its own handover
//
// `next_move.why` is derived from the handover's own state, not stated once for every closed
// initiative: `states` holds the document and `isHandover` identifies it.
const CLOSING = ((): Chain => {
  const c = chainOf("sdlc-flow", [
    { name: "spec.md", role: "spec", gate: true, closing: true },
    { name: "handover.md", role: "handover", gate: true, requires: "spec.md" },
  ]);
  return { ...c, stages: [{ name: "sdlc-spec", produces: "spec.md" }] };
})();
const CLO = "2026-09-14-closed-with-a-handover";

const signedSpec = doc({ title: "Spec", status: "approved", approved_by: "ada@zz.test",
  approved_at: "2026-09-14", outcome: "accepted", closed_by: "ada@zz.test" }, "# Spec");

// (a) no handover at all — the invitation is the right answer.
wrote(CLO, "spec.md", signedSpec);
let clo = await initiativeState(db()!, TEAM, CLO, CLOSING, CLOSING.documents);
is(/skill_read/.test(clo.next_move?.why ?? ""),
   `a closed initiative with no handover was told ${JSON.stringify(clo.next_move?.why)} — it ` +
   "should be invited to write one, which is the only case the old static sentence fitted");

// (b) written and unapproved — waiting on a verdict, and owed by nobody.
wrote(CLO, "handover.md", doc({ title: "Handover", status: "draft" }, "# H"));
clo = await initiativeState(db()!, TEAM, CLO, CLOSING, CLOSING.documents);
is(!/skill_read/.test(clo.next_move?.why ?? "") && /verdict/.test(clo.next_move?.why ?? ""),
   `a closed initiative whose handover is written and unapproved was told ` +
   `${JSON.stringify(clo.next_move?.why)} — it is not being asked to write one again`);

// (c) approved — say so, and name who signed it.
wrote(CLO, "handover.md",
  doc({ title: "Handover", status: "approved", approved_by: "ada@zz.test", approved_at: "2026-09-14" }, "# H"));
clo = await initiativeState(db()!, TEAM, CLO, CLOSING, CLOSING.documents);
is(/recorded/.test(clo.next_move?.why ?? "") && /ada@zz\.test/.test(clo.next_move?.why ?? "")
   && !/skill_read/.test(clo.next_move?.why ?? ""),
   `a closed initiative with an APPROVED handover was told ${JSON.stringify(clo.next_move?.why)} ` +
   "— it was being told to write a document it had already signed");

// 4. The open record: written, invisible as a document, and read by chainFor
const GOVERNED_NAME = `${isoToday()}-with-a-flow`;
const written = await recordOpen(db()!, TEAM, GOVERNED_NAME, "sdlc-flow", "ada@zz.test");
is(written.flow === "sdlc-flow" && written.opened_by === "ada@zz.test"
   && written.opened_at === isoToday(),
   `the open record is ${JSON.stringify(written)} — it does not carry the flow, the opener ` +
   "and the platform's own date");
is((await openRecord(db()!, TEAM, GOVERNED_NAME))?.flow === "sdlc-flow",
   "the flow an initiative was opened with cannot be read back");

const FREEFORM_NAME = `${isoToday()}-opened-freeform`;
is((await recordOpen(db()!, TEAM, FREEFORM_NAME, null, "bo@zz.test")).flow === null,
   "a freeform open records something other than null for its flow");
// A declared freeform and no record at all are different facts, and the resolver has to tell
// them apart: one is a person saying nothing governs this, the other is silence. A helper
// collapsing both to null lets the single-flow fallback below overrule the first.
is((await openRecord(db()!, TEAM, FREEFORM_NAME))?.flow === null,
   "an initiative opened deliberately freeform reads back as governed by something");
is(await openRecord(db()!, TEAM, `${isoToday()}-never-opened`) === null,
   "an initiative with no record reports one");

// The record must not be mistaken for a document. Opening writes the initiative's OWN ROW and no
// document, so a record can never appear in a listing with no status, no gate and no place in any
// chain. Asked of what recordOpen actually wrote, not of a constant: the store's `_open.json` was
// a file in the folder, and the row is not a file at all.
{
  const heldAfterOpen = world.get(FREEFORM_NAME)!.docs.map((d) => d.path);
  is(heldAfterOpen.length === 0,
     `opening wrote ${JSON.stringify(heldAfterOpen)} as documents of the initiative — the record ` +
     "is the initiative's own row, and something nothing wrote must not be listed as a document");
}
wrote(FREEFORM_NAME, "notes.md", doc({ title: "N" }, "# N"));
const openedFree = await initiativeState(db()!, TEAM, FREEFORM_NAME, EMPTY, EMPTY.documents);
is(openedFree.documents.map((d: { name: string }) => d.name).join(",") === "notes.md",
   `an opened freeform initiative lists ${JSON.stringify(openedFree.documents.map((d: { name: string }) => d.name))}` +
   " — the platform's own record is being reported as one of the team's documents");
is(openedFree.next_move === null, "an initiative opened deliberately freeform is given a next move");

// 4b. What the record is for, driven through the real resolver
//
// `chainFor` resolves a flow from a document's envelope. A flow-driven initiative is an empty
// folder until its first document lands, so in that window no envelope can answer — and that
// is exactly when a resuming agent calls
// initiative_status. `chainFor` returns an unnamed chain with no record, so only the record
// written above can produce a named chain here.
const resolved = await chainFor(db()!, TEAM, `${GOVERNED_NAME}/x.md`);
is(resolved.name === "sdlc-flow",
   `chainFor answered ${JSON.stringify(resolved.name)} for an initiative opened WITH a flow ` +
   "and no documents yet — the open record is not consulted, so the platform reports work " +
   "somebody deliberately governed as freeform for as long as its folder is empty");
is(resolved.documents.length > 0,
   "the chain resolved off the open record declares no documents, so there is nothing to " +
   "compute a next move over and a governed initiative still answers like a freeform one");
// The control, in the other direction: an initiative opened freeform must not acquire one.
is((await chainFor(db()!, TEAM, `${FREEFORM_NAME}/x.md`)).name === null,
   "an initiative opened freeform resolves to a named chain — the record is being read as a " +
   "declaration where it declares nothing, which is the platform choosing a flow for somebody");

// 4c. A declared freeform outranks every fallback.
//
// `flow: null` in the record is a person saying nothing governs this work. chainFor's last
// resort does not know that on its own: the oldest-document walk takes whatever `flow:` it
// finds in an envelope. A stray envelope inside a declared-freeform initiative must not win.
const STRAY = `${isoToday()}-freeform-with-a-stray-envelope`;

await recordOpen(db()!, TEAM, STRAY, null, "cy@zz.test");
wrote(STRAY, "notes.md",
  doc({ title: "Notes", flow: "sdlc-flow" }, "# Notes"));
is((await chainFor(db()!, TEAM, `${STRAY}/other.md`)).name === null,
   "an initiative opened deliberately freeform picked up a flow from a fallback further down " +
   "chainFor — a `flow: null` record is a person declining a flow, and anything that overrules " +
   "it adopts one on their behalf at open time, which is adopting a flow after the fact");
// And the control for that: without a record, the envelope must still answer, or this
// short-circuit has broken resolution for every initiative written before the record existed.
const LEGACY = `${isoToday()}-no-record-at-all`;
// The flow a legacy initiative declares lives on its own row: the carry moved the file-only
// facts onto the anchor, so nothing walks the documents for one any more.
ensure(LEGACY).flow = "sdlc-flow";

wrote(LEGACY, "spec.md", doc({ title: "S", flow: "sdlc-flow" }, "# S"));
is((await chainFor(db()!, TEAM, `${LEGACY}/other.md`)).name === "sdlc-flow",
   "an initiative with NO open record no longer resolves its flow from its own documents — " +
   "every initiative written before the record existed just became ungoverned");

// 4d. The declaration survives a lost log line.
//
// `logActivity` (persist.ts) swallows every failure by design, and an append that fails
// creates no file at all, so the flow declaration cannot live only in the activity log: a lost
// line would convert an initiative somebody governed into one governed by nothing.
//
// Driven by deleting the log and re-asking. The event is still logged beside the record,
// because the open is an event; what this asserts is that nothing reads the declaration from
// there.
// The declaration is the initiative's own ROW, and nothing reads it out of telemetry: the store's
// per-initiative `activity.jsonl` is gone with the store, so there is no best-effort log an append
// could have failed to reach.
is((await chainFor(db()!, TEAM, `${GOVERNED_NAME}/x.md`)).name === "sdlc-flow",
   "with the activity log deleted the flow can no longer be resolved — the declaration is " +
   "being read out of best-effort telemetry, so an append that silently failed leaves an " +
   "initiative somebody governed reporting as freeform for the rest of its life");

// 5. The slug is what is taken
is(await takenRefusal(db()!, TEAM, "hand-assembled") !== null,
   "a slug an existing initiative already uses is accepted — two folders with the same slug " +
   "and different dates diverge, and nothing downstream can say which one was meant");
is(/2026-09-14-hand-assembled/.test(await takenRefusal(db()!, TEAM, "hand-assembled") ?? ""),
   "the taken refusal does not NAME the existing initiative, so the caller cannot continue it");
is(await takenRefusal(db()!, TEAM, "something-nobody-opened") === null,
   "an unused slug is refused as taken");
// A slug that is a prefix of an existing one is not the same slug.
await recordOpen(db()!, TEAM, `${isoToday()}-payment-retries`, null, "ada@zz.test");
is(await takenRefusal(db()!, TEAM, "payment") === null,
   "`payment` is refused because `payment-retries` exists — a prefix match blocks slugs " +
   "nobody has taken");

// 6. Neither write path creates any more: the refusal, driven
is(typeof await unopenedRefusal(db()!, TEAM, `${isoToday()}-never-opened/spec.md`) === "string",
   "a write into an initiative nobody opened is accepted — the write still creates the " +
   "initiative, and initiative_open is decorative");
is(/initiative_open/.test(await unopenedRefusal(db()!, TEAM, `${isoToday()}-never-opened/spec.md`) ?? ""),
   "the refusal does not name initiative_open, so it is a dead end rather than an instruction");
is(await unopenedRefusal(db()!, TEAM, `${FREE}/anything.md`) === null,
   "a write into an initiative that WAS opened is refused — the guard is too wide, and every " +
   "document after the first would be blocked");
is(await unopenedRefusal(db()!, TEAM, "README.md") === null,
   "a file at the root of the store is treated as an initiative document");

// 7. Two source-level assertions, and what each catches
//
// Neither can be run: `document_write` resolves through `safePath`, which resolves through
// `userRoot`, which is rooted at the hard-coded `/artifacts`. Comments are stripped first, so
// neither is satisfiable by an explanation of the change.
const stripped = (p: string) => readSrc(p)
  .split("\n").filter((l) => !l.trim().startsWith("//")).join("\n")
  .replace(/\/\*[\s\S]*?\*\//g, "");
const arts = stripped("services/zz-core/src/tools/artifacts.ts");

// COUPLED: the guards moved out of `services/zz-core/src/tools/artifacts.ts`, they were not
// copied. Two creation guards on the write path is two places a rule about creating can be
// changed independently — see `documentGuards`.
for (const g of ["initiativeNameShape", "initiativeNameTaken"]) {
  is(!new RegExp(`\\b${g}\\b`).test(arts),
     `artifacts.ts still calls ${g} — the creation guards must LEAVE document_write, not be ` +
     "duplicated onto both paths: opening is the only thing that creates an initiative now");
}
// Control: the guard has to have landed somewhere, or it was deleted rather than moved.
// Twice, because `source_add` is the second creation path — `mkdirSync(..., {recursive:true})`
// builds `<initiative>/sources/` for a folder that does not exist, conjuring the initiative
// document_write is refused for.
is((arts.match(/unopenedRefusal\s*\(/g) ?? []).length >= 2,
   "artifacts.ts calls unopenedRefusal " +
   `${(arts.match(/unopenedRefusal\s*\(/g) ?? []).length} time(s) — both document_write and ` +
   "source_add create, so both must ask");

// `document_write` must not take a flow. Asked of the real schema, not the source: an argument
// that declares a flow on a document is the adopt-a-flow tool the platform refuses, reached through a
// parameter instead of a verb.
const arttools = new Map<string, ToolDef>();
registerArtifactTools({ registerTool: (name: string, def: ToolDef) => arttools.set(name, def) });
is(arttools.get("document_write")?.inputSchema?.flow === undefined,
   "document_write still takes a `flow` argument — an initiative opened freeform acquires a " +
   "manifest on its next document, and the gates that manifest declares land on documents " +
   "already written and unapproved. A flow is never adopted after the fact.");
is(arttools.get("document_write")?.inputSchema?.content !== undefined,
   "document_write no longer takes `content` — this check is reading the wrong tool");

// No adopt-a-flow tool: a flow is decided at initiative_open or never. Asserted over every source file rather than over the tools
// directory: a registration moved one directory sideways is still a registration.
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
    fail.push(`an adopt-a-flow tool is registered in ${p} — retrofitting a ` +
              "manifest onto documents written without it is a migration dressed as a verb");
  }
}

// 8. "Freeform accepts every operation a governed one does"
//
// Three guards key off `chain.docs`, which is an empty set for a freeform initiative: the two
// value guards below go quiet, and the membership tests in document_approve, document_revise
// and initiative_close refuse outright unless written to allow it.

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
// And a flow's own declaration must still exempt a document it never named, or the change
// widened the guards instead of un-silencing them.
is(wg.statusCheck(GOVERNED, `${GOV}/stray.md`, "---\nstatus: nearly\n---\n") === null,
   "statusCheck now judges a document the flow never declared — the declaration must narrow " +
   "the guard, and its absence must not switch it off; those are different rules");

// 8b. The three membership tests, source-level and labelled. Each handler resolves through
// `userRoot()`, so the condition is read rather than run — after comments are stripped, and
// asserted on its exact shape rather than on a word.
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

// 8c. DELIBERATE: the file version's two assertions here read `services/zz-core/src/persist.ts`
// — `snapshotOnApproval`'s membership test and `ledgerOnClose`'s closing-document skip — and
// neither subject survives. The frozen copy an approval filed is a `doc_revision` row now, so
// there is no directory walk to widen or narrow; and the ledger is no longer a file the close
// appends a row to. Both modules were deleted with the store, and a check that read them would
// report a blind scan rather than a pass.

// First, ahead of everything else: if a path could not be read, every assertion over it passed
// on the empty string.
if (blind.length) {
  console.error(
    `could not read ${blind.join(", ")} — this check scans it, so every assertion about it ` +
    "passed on nothing. Fix the path before reading anything below as a pass.");
  process.exit(1);
}
if (fail.length) { console.error(fail.join("\n")); process.exit(1); }
console.log("initiative_open: ok");
