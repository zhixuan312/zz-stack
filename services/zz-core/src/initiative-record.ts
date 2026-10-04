/**
 * The record an initiative is opened with, and the questions asked of it.
 *
 * COUPLED: every one of these reads or writes a ROW, and none of them reads a file. The store
 * the platform kept for a team — its working tree, the per-initiative JSON state files and its
 * git repository — is retired, so the four facts that used to live beside a team's documents
 * live where the rest of the initiative does:
 *
 *   `_open.json`     → `zz.initiative` — `slug`, `flow`, `opened_at`, `opened_by`
 *   `_facts.json`    → `zz.initiative_fact`, keyed by the initiative's own id
 *   `_records.json`  → `zz.initiative_fact` too, under a two-part fact name — see `recordsFor`
 *
 * A declaration and no declaration are still different facts, which is why a freeform open still
 * writes a row (with `flow` null) and `openRecord` still returns null rather than an empty record
 * when nothing carries the slug. A helper collapsing both would let a fallback overrule a person
 * saying "nothing governs this".
 *
 * DELIBERATE: `chainFor` needs the flow of an initiative that has no document yet, which is the
 * window between `initiative_open` and the first write. The row answers it, and it is the same
 * answer the folder's `_open.json` gave.
 */
import { AsyncLocalStorage } from "node:async_hooks";

import { documentApplies, OUTCOME_STOPPED } from "@zz/contracts";
import type pg from "pg";

import { Refusal } from "./refusal.js";
import { ZZ_TZ, isoToday } from "./write-guards.js";

/** The query surface everything here takes: the pool, or a client already inside a transaction.
 *  ONE parameter rather than a resolved pool, so a caller inside a transaction reads the row it
 *  is about to write through the same connection that holds its lock. */
export type RecordClient = Pick<pg.PoolClient, "query">;

/** The declaration, as `zz.initiative` holds it.
 *
 * DELIBERATE: the shape is the file's, because that is what a caller reads and what
 * `initiative_open` hands back. `flow: null` is a declared freeform, never "no record". */
interface OpenRecord {
  initiative: string;
  /** The flow that governs this initiative, or null, which is a declared freeform rather than
   * an unanswered question. */
  flow: string | null;
  opened_by: string;
  opened_at: string;
}

/** The name the platform composes: today's date, from the platform's own clock, then the slug.
 *
 * DELIBERATE: there is no argument for the date and no way to pass one. `isoToday()` is the
 * same clock and timezone `envelopeFor` stamps `updated_at` from, so a document's date and
 * its initiative's cannot disagree. */
export function initiativeNameFor(slug: string): string {
  return `${isoToday()}-${slug.trim()}`;
}

/** The `zz.team.id` a slug names, or null when no team carries it. */
async function teamIdOf(client: RecordClient, team: string): Promise<string | null> {
  const { rows } = await client.query<{ id: string }>(
    "select id::text as id from zz.team where slug = $1", [team]);
  return rows[0]?.id ?? null;
}

/** Write the declaration. The initiative row IS the initiative: there is no folder to create,
 *  and a slug this team already carries is left exactly as it was rather than re-opened.
 *
 *  DELIBERATE: `do update set slug = excluded.slug` and not `do nothing`. A no-op update is what
 *  makes the `returning` clause answer on BOTH paths — a row that was already there comes back
 *  with its own opener and date rather than with nothing. */
export async function recordOpen(
  client: RecordClient, team: string, name: string, flow: string | null, who: string,
): Promise<OpenRecord> {
  const teamId = await teamIdOf(client, team);
  if (!teamId) {
    throw new Refusal(
      `ERROR: no team "${team}" — an initiative belongs to a team's roster, and nothing ` +
      "carries that slug on this deployment.");
  }
  const declared = flow?.trim() || null;
  const { rows } = await client.query<{ flow: string | null; opened_at: string; opened_by: string | null }>(
    // DELIBERATE: the row's `opened_at` is rendered in the DEPLOYMENT's zone, not the database's.
    // A `timestamptz` read by `to_char` alone comes back as the server's own date — UTC in these
    // images — so an initiative opened at 00:30 in Asia/Singapore was named `2026-10-05-…` and
    // reported `opened_at: 2026-10-04`, the same answer contradicting itself for the eight hours a
    // day the two calendars disagree. `initiativeNameFor` above promises these two cannot disagree;
    // `$5` is the zone it stamps the name with, bound rather than written down here.
    `insert into zz.initiative (team_id, slug, flow, opened_at, opened_by)
     values ($1::uuid, $2, $3, now(),
             (select p.id from zz.principal p where lower(p.email) = lower($4) and p.status = 'active'))
     on conflict (team_id, slug) do update set slug = excluded.slug
     returning flow, to_char(opened_at at time zone $5, 'YYYY-MM-DD') as opened_at,
               (select p.email from zz.principal p where p.id = opened_by) as opened_by`,
    [teamId, name, declared, who, ZZ_TZ]);
  const row = rows[0];
  return { initiative: name, flow: row?.flow ?? declared, opened_by: row?.opened_by ?? who,
           opened_at: row?.opened_at ?? isoToday() };
}

/** The record, or null when this team holds no initiative under `name`. */
export async function openRecord(
  client: RecordClient, team: string, name: string,
): Promise<OpenRecord | null> {
  const { rows } = await client.query<{ flow: string | null; opened_at: string; opened_by: string | null }>(
    // The same zone the name was stamped in — see the note on the insert above.
    `select i.flow, to_char(i.opened_at at time zone $3, 'YYYY-MM-DD') as opened_at,
            (select p.email from zz.principal p where p.id = i.opened_by) as opened_by
       from zz.initiative i join zz.team t on t.id = i.team_id
      where t.slug = $1 and i.slug = $2`, [team, name, ZZ_TZ]);
  const row = rows[0];
  return row ? { initiative: name, flow: row.flow, opened_by: row.opened_by ?? "",
                 opened_at: row.opened_at } : null;
}

/** The `zz.initiative.id` a slug names inside a team, or null. Resolved THROUGH the team, never
 * by the slug alone: two teams' initiatives may share one. */
export async function initiativeIdFor(
  client: RecordClient, team: string, initiative: string,
): Promise<string | null> {
  const { rows } = await client.query<{ id: string }>(
    `select i.id::text as id from zz.initiative i join zz.team t on t.id = i.team_id
      where t.slug = $1 and i.slug = $2`, [team, initiative]);
  return rows[0]?.id ?? null;
}

/* ──────────────────────────────────────────────────────────────────────────────────────────
 * An initiative's durable state, in two tables, because the two shapes are opposite:
 *
 *   `zz.initiative_fact`    a BRANCH FACT — `protocol_action`, `improvement_mode`, `release_mode`
 *                           — recorded once by the stage that decides it and never revised;
 *
 *   `zz.initiative_record`  a STAGE RECORD — `define_qualify.protocol_version_id` — the id a
 *                           `produces: "record"` stage minted, written again when that stage runs
 *                           again, because a second profile or a re-score SUPERSEDES what it
 *                           recorded before. "Resume from the initiative" is what latest-wins
 *                           means.
 * ────────────────────────────────────────────────────────────────────────────────────────── */

/** The durable branch facts, or `{}` when none are recorded.
 *
 * DELIBERATE: no damage case. The file could be truncated by a writer that died between two
 * bytes, and `factsFor` used to throw a `Refusal` naming it; a row is written whole by the
 * database or not at all, so there is nothing here to be damaged and no refusal to invent. */
export async function factsFor(
  client: RecordClient, team: string | null, initiative: string,
): Promise<Record<string, string>> {
  // A caller this deployment cannot place has no initiative, so it has no facts: `{}`, which is
  // every named fact reading `undetermined` rather than a guess at whose work this is.
  if (!team) return {};
  const { rows } = await client.query<{ fact: string; value: string }>(
    `select f.fact, f.value from zz.initiative_fact f
       join zz.initiative i on i.id = f.initiative_id
       join zz.team t on t.id = i.team_id
      where t.slug = $1 and i.slug = $2`,
    [team, initiative]);
  return Object.fromEntries(rows.map((r) => [r.fact, r.value]));
}

/** Write the durable branch facts.
 *
 * DELIBERATE: no merge and no refusal here — `writeBranchFacts` (eval/protocol.ts) reads the
 * current facts with `factsFor` above, decides whether a requested change is a refusal, and
 * passes the whole merged object down, so the only row this can meet is one already saying this.
 *
 * COUPLED: `on conflict do nothing`, never `do update`. A branch fact is recorded once by the
 * stage that decides it and is never revised — that is what makes the refuse-on-change rule safe,
 * and it is what `zz.initiative_fact`'s own comment states. An `update` here would make that
 * comment false, and a comment that is false is worse than no comment: a stage record, which IS
 * latest-wins, has its own table for exactly this reason. */
export async function writeFacts(
  client: RecordClient, initiativeId: string, facts: Record<string, string>,
): Promise<void> {
  for (const [fact, value] of Object.entries(facts)) {
    await client.query(
      `insert into zz.initiative_fact (initiative_id, fact, value) values ($1::uuid, $2, $3)
       on conflict (initiative_id, fact) do nothing`,
      [initiativeId, fact, value]);
  }
}

/** What each `produces: "record"` stage of an initiative minted — the ids a later stage needs
 *  and, being in no document, could otherwise only find in the conversation that ran it. A stage
 *  that starts in a new conversation reads them back through `initiative_status` (`records`),
 *  and `next_move` names the first record stage that has none yet.
 *
 *  Keyed by stage, then by id name. The rows are their own table and not
 *  `zz.initiative_fact` — see this module's header for why the two shapes cannot share one. */
export async function recordsFor(
  client: RecordClient, team: string | null, initiative: string,
): Promise<Record<string, Record<string, string>>> {
  if (!team) return {};
  const { rows } = await client.query<{ stage: string; id_name: string; value: string }>(
    `select r.stage, r.id_name, r.value from zz.initiative_record r
       join zz.initiative i on i.id = r.initiative_id
       join zz.team t on t.id = i.team_id
      where t.slug = $1 and i.slug = $2`,
    [team, initiative]);
  const out: Record<string, Record<string, string>> = {};
  for (const { stage, id_name, value } of rows) {
    out[stage] = { ...(out[stage] ?? {}), [id_name]: value };
  }
  return out;
}

/** Merge `ids` into `stage`'s record. Latest wins per id, which is what a stage run again means:
 *  a second profile or a re-score supersedes what it recorded before rather than adding to it. */
export async function writeStageRecord(
  client: RecordClient, initiativeId: string, stage: string,
  ids: Record<string, string>, replace = false,
): Promise<void> {
  if (replace) {
    // The whole stage, and the `stage` column is compared as a VALUE — never as a pattern. A
    // `like` here would read an underscore in a stage name as a wildcard and delete a
    // neighbouring stage's keys with it, which surfaces later as data nobody can account for.
    await client.query(
      "delete from zz.initiative_record where initiative_id = $1::uuid and stage = $2",
      [initiativeId, stage]);
  }
  for (const [idName, value] of Object.entries(ids)) {
    await client.query(
      `insert into zz.initiative_record (initiative_id, stage, id_name, value)
       values ($1::uuid, $2, $3, $4)
       on conflict (initiative_id, stage, id_name)
       do update set value = excluded.value, set_at = now()`,
      [initiativeId, stage, idName, value]);
  }
}

const factsLockHeld = new AsyncLocalStorage<ReadonlySet<string>>();
const inProcessFactsLocks = new Map<string, Promise<unknown>>();

/** Run `fn` holding this process's lock on an initiative's branch facts — the in-process half of
 *  a read-check-write (`writeBranchFacts`, eval/protocol.ts, and release_prepare /
 *  proposal_prepare), which two concurrent callers would otherwise both pass on the same old read
 *  and then both write. The cross-process half is `lockInitiativeFacts` below, taken by `fn` on
 *  the one transaction it writes through.
 *
 *  DELIBERATE: the queue comes first even with a database. Without it every waiter in this
 *  process would hold a pooled connection while blocked on the advisory lock — the pool is four.
 *  With it, one connection per initiative per process waits, at most.
 *
 *  DELIBERATE: reentrant within one async call chain (AsyncLocalStorage), so a caller holding the
 *  lock may call `writeBranchFacts`, which takes it too. Without that the inner call would queue
 *  behind the outer one, forever.
 *
 *  Keyed on the initiative name alone, not the team: two teams' same-named initiatives share a
 *  lock, which costs a wait and never a wrong answer. */
export async function withInitiativeFactsLock<T>(initiative: string, fn: () => Promise<T>): Promise<T> {
  const held = factsLockHeld.getStore();
  if (held?.has(initiative)) return fn();
  const inner = () => factsLockHeld.run(new Set([...(held ?? []), initiative]), fn);
  const before = inProcessFactsLocks.get(initiative) ?? Promise.resolve();
  const run = before.then(inner);
  const tail = run.catch(() => undefined);
  inProcessFactsLocks.set(initiative, tail);
  try {
    return await run;
  } finally {
    if (inProcessFactsLocks.get(initiative) === tail) inProcessFactsLocks.delete(initiative);
  }
}

/** The cross-process half of the facts lock: a transaction-level pg advisory lock on `client`,
 *  which must be inside an open transaction — every zz-core process sharing the database is
 *  serialized on it, and it releases at that transaction's COMMIT or ROLLBACK.
 *
 *  DELIBERATE: transaction-level, on the caller's own client, never a session lock on a second
 *  pooled connection. release_prepare writes its ledger row and its branch fact in one
 *  transaction; a lock held on another connection for the length of that transaction is two
 *  connections per call, and four such calls starve the pool. Re-taking it inside the same
 *  transaction (`writeBranchFacts` under release_prepare) is a no-op, as pg advisory locks are
 *  reentrant per session. */
export async function lockInitiativeFacts(
  client: { query(text: string, values?: unknown[]): Promise<unknown> }, initiative: string,
): Promise<void> {
  await client.query("select pg_advisory_xact_lock(hashtext($1))", [`initiative_facts:${initiative}`]);
}

/** Is the flow's DECLARED closing document (`chain.closingDoc`) ruled out for this initiative
 *  (FR-58, Task I-28)? `zz-plugin-eval` is the first flow whose closing document is itself
 *  `when`-conditional — `improvement.md`, promotable only — so a branch that never reaches
 *  `promotable` has to close on something else, and `chain.closingDoc` (chain.ts) is a static,
 *  per-flow answer that cannot see this initiative's own branch facts.
 *
 *  Read by BOTH `initiative_close` (initiative-close.ts, to fall back to the furthest document
 *  this branch actually wrote — the same fallback it already used for a stop that never reached
 *  its closing document, now also triggered by a branch that ruled it out) and `closeCheck`
 *  (guards.ts, to recognise a write reaching that fallback document as still the closing write) —
 *  one function, so the two never disagree about which document a close lands on.
 *
 *  A document with no `when` is never ruled out — this returns `false` unconditionally, which is
 *  every flow that predates FR-58 (sdlc-flow, zz-access): asking never changes their answer. */
export function closingDocRuledOut(
  declared: { name: string; when?: Record<string, string | string[]> } | undefined,
  facts: Record<string, string>,
): boolean {
  if (!declared?.when) return false;
  return documentApplies(declared, facts) === "not_applicable";
}

/** An initiative this slug would collide with, or null.
 *
 * DELIBERATE: the slug is what is taken, not the dated name. Testing `<today>-<slug>` alone
 * lets the same work be opened again tomorrow under a second initiative.
 *
 * Anchored, so a slug that is a prefix of an existing one is free: `payment` is not taken by
 * `payment-retries`. */
export async function takenRefusal(
  client: RecordClient, team: string, slug: string,
): Promise<string | null> {
  const v = slug.trim();
  if (!v) return null;
  const { rows } = await client.query<{ slug: string }>(
    `select i.slug from zz.initiative i join zz.team t on t.id = i.team_id
      where t.slug = $1 and i.slug ~ ('^\\d{4}-\\d{2}-\\d{2}-' || $2 || '$')
      order by i.slug`, [team, v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")]);
  const existing = rows.map((r) => r.slug);
  if (!existing.length) return null;
  return (
    `ERROR: "${v}" is already taken by ${existing.join(", ")}. Continue that one — ` +
    `initiative_status("${existing[0]}") says where it stands — or open this under a slug that ` +
    "says how it differs. Two initiatives with the same slug and different dates diverge, and " +
    "nothing downstream can say which one a person meant."
  );
}

/** The refusal for a path whose initiative nobody opened, or null. A single existence test
 * against the roster: the name shape, the taken check and the flow declaration are
 * `initiative_open`'s, asked once, before there is an initiative.
 *
 * A path that is not an initiative document — a bare file at the root of the store — is not
 * this function's business and passes. */
export async function unopenedRefusal(
  client: RecordClient, team: string, relPath: string,
): Promise<string | null> {
  const parts = relPath.replace(/^\/+/, "").split("/");
  if (parts.length < 2 || !parts[0]) return null;
  const id = await initiativeIdFor(client, team, parts[0]);
  if (id) return null;
  return (
    `ERROR: there is no initiative named "${parts[0]}" — writing into one no longer creates ` +
    "it. Open it first with `initiative_open(\"<slug>\")`: send the SLUG alone and use the " +
    "name it hands back, because the platform composes that name from its own clock. Pass " +
    "`flow` there if a flow governs this work; leaving it out is a choice the platform " +
    "supports, and documents, gates, approvals and closing all still work without one."
  );
}

/** The stop word, re-exported so a caller naming the abandon outcome does not reach past this
 *  module for it. See @zz/contracts for what it says. */
export { OUTCOME_STOPPED };
