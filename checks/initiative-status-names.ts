#!/usr/bin/env node
/**
 * checks/initiative-status-names.ts — `initiative_status` answers a page of initiatives in one call,
 * and a console page's read of it records no event (AC-5.5).
 *
 *   node checks/initiative-status-names.ts   # needs Docker and a built tree (`npm run build`)
 *
 * It starts a throwaway PostgreSQL and a real zz-core on it (`withThrowawayCore`), opens one
 * initiative under sdlc-flow and closes another, and asks about those two and a name nobody
 * opened. What it establishes:
 *
 *   - `initiatives` naming the three answers three entries in the order asked, each equal to what
 *     naming that one alone answers, the unknown one `{initiative, error}` carrying the sentence its
 *     refusal says alone;
 *   - that call records one `initiative_status` event naming the three, for an agent's credential;
 *   - the same call under a console session's credential (`x-zz-via: session`) answers the same and
 *     records none, while an agent's call made after it records its own;
 *   - eleven names, an empty list, a path among the names, and `initiative` with `initiatives` are
 *     each refused in the tool's `ERROR:` form;
 *   - the single-name form answers a named initiative whatever its state, and refuses a name nobody
 *     opened in the `ERROR:` form;
 *   - the bare slug `initiative_open` was given is refused in the `ERROR:` form, naming the dated
 *     initiative it opened;
 *   - a closed initiative still owing a move (its handover) is listed under `closed_owing`, never
 *     under `open`.
 *   - a document the closed initiative does not hold is refused, as a closed record takes none;
 *   - a document name that does not end in `.md` is refused, as initiative_status would never list it;
 *   - a gated draft missing the sections its flow declares is routed back to the agent naming every
 *     one, not to the stakeholder's approval, and an approval asked anyway names them all at once.
 *   - a caller in no team is told that, not that the deployment may lack its database.
 *
 * The only database it touches is the one it started.
 *
 * Exit 0: every case held — one line per case, then the final line.
 * Exit 1: a case failed — the case and what was found.
 * Exit 2: Docker is not available — the check could not run, and that is not a pass.
 */
import { EXPLORE_BODY } from "../scripts/schema/spec-fixture.ts";
import { withThrowawayCore, type Core } from "../scripts/schema/throwaway-core.ts";

const NAME = "initiative-status-names";
const DONE = "initiative-status-names: a page of initiatives is answered in one call as each alone would be, " +
  "an agent's read records one event and a console session's none, and the old forms answer as before: ok";

/** A name nobody opened. */
const UNKNOWN = "2026-01-01-never-opened";

type Entry = { initiative: string; error?: string; outcome?: string | null; next_move?: { action?: string } | null };

/** The `initiative_status` events, oldest first. */
async function events(c: Core): Promise<{ subject: string; detail: { initiatives?: string[] } }[]> {
  return (await c.sql.query<{ subject: string; detail: { initiatives?: string[] } }>(
    "select subject, detail from zz.event where kind = 'initiative_status' order by ts, id")).rows;
}

/** The events once there are `n` of them, then once more after they have had time to grow past it:
 *  an event is written after the answer it describes, so it is polled for. */
async function settled(c: Core, step: string, n: number): Promise<Awaited<ReturnType<typeof events>>> {
  const until = Date.now() + 5000;
  let rows = await events(c);
  while (rows.length < n) {
    if (Date.now() > until) c.fail(step, `expected ${n} initiative_status events, found ${rows.length}`);
    await new Promise((r) => setTimeout(r, 100));
    rows = await events(c);
  }
  await new Promise((r) => setTimeout(r, 500));
  return events(c);
}

function parsed<T>(c: Core, step: string, reply: string): T {
  try {
    return JSON.parse(reply) as T;
  } catch {
    return c.fail(step, `reply was not JSON: ${reply}`);
  }
}

async function run(c: Core): Promise<void> {
  const open = await c.open("names-open", "sdlc-flow");
  const closed = await c.open("names-closed");
  let step = "close one of them";
  await c.ok(step, "document_write", { path: `${closed}/notes.md`, content: "# Notes\n\ndone\n" });
  const closing = await c.ok(step, "initiative_close", { initiative: closed, disposition: "finished", document: "notes.md" });
  if (!closing.startsWith(`${closed} closed as `)) c.fail(step, closing);
  // A closed initiative is a finished record: a new document is refused; its own documents still
  // take a correction through document_edit.
  await c.refused(step, "document_write", { path: `${closed}/later.md`, content: "# Later\n\nafter the close\n" },
    /^ERROR: .* is closed, .*takes no new document/);

  // initiative_status and document_list read `<name>.md`; a name without it was stored and never shown.
  step = "a document name without .md";
  await c.refused(step, "document_write", { path: `${open}/notes.txt`, content: "# Notes\n\nplain\n" },
    /^ERROR: "notes\.txt" is not a document name — /);
  await c.refused(step, "document_write", { path: `${open}/no-ext`, content: "# Notes\n\nplain\n" },
    /^ERROR: "no-ext" is not a document name — /);
  c.pass("document_write refuses a document name that does not end in .md, which no listing would show");

  // Asked out of the slugs' own order, so the answer's order can only be the order asked.
  const asked = [open, UNKNOWN, closed];

  step = "each name alone answers as before";
  const alone: Record<string, string> = {};
  for (const name of [open, closed]) {
    alone[name] = JSON.stringify(parsed(c, step, await c.ok(step, "initiative_status", { initiative: name })));
  }
  const one = (name: string): Entry => JSON.parse(alone[name]) as Entry;
  if (one(open).initiative !== open || !one(open).next_move || one(open).next_move?.action === "closed") c.fail(step, alone[open]);
  if (one(closed).initiative !== closed || one(closed).next_move?.action !== "closed") c.fail(step, alone[closed]);
  c.pass(step);

  // A name nobody opened is a refusal, not a success-shaped answer a client reads as a status; on
  // a page its entry carries the same sentence as its `error`.
  step = "a name nobody opened";
  const unknown = await c.refused(step, "initiative_status", { initiative: UNKNOWN },
    new RegExp(`^ERROR: no initiative named '${UNKNOWN}' in ${c.team} — initiative_status with no argument lists the open ones`));
  alone[UNKNOWN] = JSON.stringify({ initiative: UNKNOWN, error: unknown.replace(/^ERROR: /, "") });
  c.pass("initiative_status on a name nobody opened is refused in the ERROR form");

  // The name initiative_open was given is not the initiative's name: the answer names the dated one.
  step = "the slug initiative_open was given";
  await c.refused(step, "initiative_status", { initiative: "names-open" },
    new RegExp(`^ERROR: no initiative named 'names-open' in ${c.team} — did you mean ${open}\\?`));
  c.pass("initiative_status on the bare slug is refused in the ERROR form, naming the dated initiative");

  // A flow's initiative closed with its handover still to write: closed, so not under `open`, and
  // listed with what it still owes rather than counted away.
  const owing = await c.open("names-owing", "sdlc-flow");
  await c.sql.query(
    `update zz.initiative set outcome = 'delivered', closed_at = now(),
            closed_by = (select id from zz.principal where email = $2) where slug = $1`, [owing, c.email]);
  step = "the listing answers the open ones and counts the closed";
  const listing = parsed<{ open: Entry[]; closed_owing?: Entry[]; closed_not_listed: number }>(c, step,
    await c.ok(step, "initiative_status", {}));
  const owed = (listing.closed_owing ?? []).map((e) => `${e.initiative} ${e.outcome} ${e.next_move?.action}`);
  if (JSON.stringify(listing.open.map((e) => e.initiative)) !== JSON.stringify([open]) || listing.closed_not_listed !== 1
      || JSON.stringify(owed) !== JSON.stringify([`${owing} delivered write_document`])) {
    c.fail(step, JSON.stringify({ open: listing.open.map((e) => e.initiative), closed_owing: owed,
                                  closed_not_listed: listing.closed_not_listed }));
  }
  if (JSON.stringify(listing.open[0]) !== alone[open]) c.fail(step, "the listing's entry is not what naming it answers");
  c.pass("the listing answers the open ones under `open`, a closed one still owing a move under `closed_owing`, " +
         "and counts the rest");

  step = "a page of three answers three entries in the order asked, each what naming it alone answers";
  // Every answered call so far was an agent's: two named ones and the listing, an event each. The
  // two refusals record none.
  const before = (await settled(c, step, 3)).length;
  if (before !== 3) c.fail(step, `the three agent calls before the page recorded ${before} initiative_status events`);
  const page = parsed<{ initiatives: Entry[] }>(c, step, await c.ok(step, "initiative_status", { initiatives: asked }));
  if (Object.keys(page).join() !== "initiatives" || page.initiatives.length !== 3) c.fail(step, JSON.stringify(page));
  page.initiatives.forEach((entry, i) => {
    if (JSON.stringify(entry) !== alone[asked[i]]) {
      c.fail(step, `entry ${i} is ${JSON.stringify(entry)}, where naming ${asked[i]} alone answers ${alone[asked[i]]}`);
    }
  });
  c.pass(step);

  step = "an agent's page records one initiative_status event naming the page";
  const afterAgent = await settled(c, step, before + 1);
  const added = afterAgent.slice(before);
  if (added.length !== 1 || JSON.stringify(added[0].detail.initiatives) !== JSON.stringify(asked)
      || added[0].subject !== asked.join(",")) {
    c.fail(step, `the page added ${JSON.stringify(added)}`);
  }
  c.pass(step);

  step = "a console session's page answers the same and records no event";
  const session = c.client({ via: "session" });
  const reversed = [...asked].reverse();
  const seen = parsed<{ initiatives: Entry[] }>(c, step,
    await c.ok(step, "initiative_status", { initiatives: reversed }, session));
  if (JSON.stringify(seen.initiatives) !== JSON.stringify([...page.initiatives].reverse())) c.fail(step, JSON.stringify(seen));
  // An agent's call after it: once its event has landed, the session's would have too.
  await c.ok(step, "initiative_status", { initiative: open });
  const afterSession = (await settled(c, step, afterAgent.length + 1)).slice(afterAgent.length);
  if (afterSession.length !== 1 || afterSession[0].subject !== open) {
    c.fail(step, `the session's page and the agent's call after it added ${JSON.stringify(afterSession)}`);
  }
  c.pass(step);

  step = "eleven names, none, a path among them, and both arguments are refused";
  const eleven = Array.from({ length: 11 }, (_, i) => `2026-01-01-name-${i}`);
  await c.refused(step, "initiative_status", { initiatives: eleven }, /^ERROR: `initiatives` names 11 initiatives; one call answers at most 10/);
  await c.refused(step, "initiative_status", { initiatives: [] }, /^ERROR: `initiatives` names no initiative/);
  await c.refused(step, "initiative_status", { initiatives: [open, "a/b"] }, /^ERROR: a name in `initiatives` must be a single name/);
  await c.refused(step, "initiative_status", { initiative: open, initiatives: [open] }, /^ERROR: .*not both/);
  c.pass(step);

  // A gated draft without the sections its flow declares cannot be approved, so it is not sent to the
  // stakeholder: the next move goes back to the agent naming every missing section, and the approval,
  // if asked anyway, names all of them at once.
  step = "a gated draft missing sections";
  const half = await c.open("names-half", "sdlc-flow");
  await c.ok(step, "document_write", { path: `${half}/explore.md`, content: EXPLORE_BODY });
  const written = await c.ok(step, "document_write", { path: `${half}/spec.md`, content: "# Spec\n\n## Context\n\nctx\n\n## Problem\n\np\n" });
  const missing = ["Goals & Requirements", "Alternatives", "Approach, Method & Structure", "Verification Plan",
                   "Risks & Mitigations", "Stakeholders & Work", "Phase outline", "Core statements"];
  const move = (await c.status(half)).next_move as { action?: string; waiting_on?: string; why?: string } | null | undefined;
  if (move?.action === "await_approval" || move?.waiting_on !== "agent" || /await_approval/.test(written)
      || !missing.every((m) => move?.why?.includes(`\`## ${m}\``))) {
    c.fail(step, `the write answered ${JSON.stringify(written)} and the next move is ${JSON.stringify(move)}`);
  }
  await c.ok(step, "document_present", { path: `${half}/spec.md` });
  const approval = await c.refused(step, "document_approve", { path: `${half}/spec.md` }, /^ERROR: spec\.md is missing sections /);
  const unnamed = missing.filter((m) => !approval.includes(`\`## ${m}\``));
  if (unnamed.length) c.fail(step, `the approval's refusal does not name ${unnamed.join(", ")}: ${approval}`);
  c.pass("a gated draft missing its sections is routed back to the agent naming all eight, not to the stakeholder, " +
         "and its approval names all eight at once");

  step = "a caller in no team is told so, not that the database may be missing";
  await c.sql.query("insert into zz.principal (email, display_name) values ('nobody@example.test', 'Nobody')");
  await c.refused(step, "initiative_status", {}, /^ERROR: you are not in a team/, c.client({ email: "nobody@example.test" }));
  c.pass(step);
}

process.exitCode = await withThrowawayCore(NAME, DONE, run);
