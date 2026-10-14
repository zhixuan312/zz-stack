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
 *     naming that one alone answers, the unknown one `no such initiative`;
 *   - that call records one `initiative_status` event naming the three, for an agent's credential;
 *   - the same call under a console session's credential (`x-zz-via: session`) answers the same and
 *     records none, while an agent's call made after it records its own;
 *   - eleven names, an empty list, a path among the names, and `initiative` with `initiatives` are
 *     each refused in the tool's `ERROR:` form;
 *   - the single-name form and the listing answer as before: a named initiative whatever its state,
 *     an unknown name `no such initiative`, and the open ones with a count of the closed.
 *
 * The only database it touches is the one it started.
 *
 * Exit 0: every case held — one line per case, then the final line.
 * Exit 1: a case failed — the case and what was found.
 * Exit 2: Docker is not available — the check could not run, and that is not a pass.
 */
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

  // Asked out of the slugs' own order, so the answer's order can only be the order asked.
  const asked = [open, UNKNOWN, closed];

  step = "each name alone answers as before";
  const alone: Record<string, string> = {};
  for (const name of asked) {
    alone[name] = JSON.stringify(parsed(c, step, await c.ok(step, "initiative_status", { initiative: name })));
  }
  const one = (name: string): Entry => JSON.parse(alone[name]) as Entry;
  if (one(open).initiative !== open || !one(open).next_move || one(open).next_move?.action === "closed") c.fail(step, alone[open]);
  if (one(closed).initiative !== closed || one(closed).next_move?.action !== "closed") c.fail(step, alone[closed]);
  if (alone[UNKNOWN] !== JSON.stringify({ initiative: UNKNOWN, error: "no such initiative" })) c.fail(step, alone[UNKNOWN]);
  c.pass(step);

  step = "the listing answers the open ones and counts the closed";
  const listing = parsed<{ open: Entry[]; closed_not_listed: number }>(c, step, await c.ok(step, "initiative_status", {}));
  if (JSON.stringify(listing.open.map((e) => e.initiative)) !== JSON.stringify([open]) || listing.closed_not_listed !== 1) {
    c.fail(step, JSON.stringify({ open: listing.open.map((e) => e.initiative), closed_not_listed: listing.closed_not_listed }));
  }
  if (JSON.stringify(listing.open[0]) !== alone[open]) c.fail(step, "the listing's entry is not what naming it answers");
  c.pass(step);

  step = "a page of three answers three entries in the order asked, each what naming it alone answers";
  // Every call so far was an agent's: three named ones and the listing, an event each.
  const before = (await settled(c, step, 4)).length;
  if (before !== 4) c.fail(step, `the four agent calls before the page recorded ${before} initiative_status events`);
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
}

process.exitCode = await withThrowawayCore(NAME, DONE, run);
