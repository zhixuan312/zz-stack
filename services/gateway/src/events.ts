/**
 * Append-only platform event stream — the provenance record behind every admin action.
 *
 * Fire-and-forget: logging must never break the operation it describes. But "never break" is not
 * "never notice", and an event that vanishes because the database was briefly down is a hole in the
 * one record an audit later reads.
 *
 * One store and one fallback, not two stores. Events go to `zz.event`, which is what the console
 * read surface and the reports read back.
 * If, and only if, that write cannot happen, the event is appended to /data/events-unwritten.jsonl
 * and the failure is logged. That file existing means something needs attention; it is not a second
 * copy of the history.
 *
 * The identity is stamped here, in one transaction with the row it describes (FR-19, FR-20): the
 * actor, the team, the initiative within that team, the version of the skill that was loaded, the
 * conversation, and the run those four name. Two statements, not one, because a data-modifying CTE
 * and the statement around it share one snapshot — a run inserted by a CTE is invisible to the
 * `insert into zz.event` beside it, so the event could not carry the run's id. Written in order, the
 * second statement sees the first. The run is composed by runs.ts (`RUN_CONFLICT`, `versionAtEvent`);
 * what is here is the transaction that makes the two inseparable, and the fallback for when it
 * cannot run.
 *
 * Nothing refuses an event for want of an identity: the columns are nullable for exactly that
 * reason, and a call nobody can attribute is still evidence that a call happened. An event whose
 * team, initiative or skill version does not resolve is written with those columns null and no run —
 * the timer does not invent one later (runs.ts).
 *
 * COUPLED: `zz-tool watch-results` reads the stranded count off /health and alerts on it.
 */
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";

import { refusalOwner } from "@zz/contracts";
import type { PoolClient } from "pg";

import { platformDb, platformDbReady } from "./db.js";
import { RUN_CONFLICT, versionAtEvent } from "./runs.js";

const STRANDED_PATH = "/data/events-unwritten.jsonl";

/** How many events this process could not record, and when the last one was.
 *
 * Counted in memory rather than by reading the file, because /health must stay cheap enough
 * to poll. The file is the record; this is the signal that the record needs reading. */
let strandedCount = 0;
let strandedLast: string | null = null;

/** Seeded from the file at boot, once, so a restart does not erase the signal.
 *
 * /health omits the field entirely when the count is zero, and an event strands when the database
 * is unavailable — which is followed by a restart. Counted in memory only, the one signal saying
 * the audit record has gaps is wiped by the recovery.
 *
 * Read once here rather than per request, so /health stays cheap enough to poll. A file too large
 * to count at boot is itself the alarm. */
function seedFromFile(): void {
  let lines: string[];
  try {
    lines = readFileSync(STRANDED_PATH, "utf8").split("\n").filter((l) => l.trim());
  } catch {
    return;   // no file is the normal case, and an unreadable one is not worth a boot failure
  }
  if (!lines.length) return;
  // A line is the signal, not a parsable line. The timestamp is a nicety on top, so a
  // half-written final row — the likeliest corruption, since this file is appended to while
  // something is going wrong — must not cost the count or the warning.
  strandedCount = lines.length;
  try {
    strandedLast = (JSON.parse(lines[lines.length - 1]) as { ts?: string }).ts ?? null;
  } catch {
    strandedLast = null;
  }
  console.warn(`events: ${strandedCount} event(s) in ${STRANDED_PATH} were never written to ` +
               "the database — the audit record has holes");
}
seedFromFile();

export const strandedEvents = (): { count: number; last: string | null; file: string } =>
  ({ count: strandedCount, last: strandedLast, file: STRANDED_PATH });

/** Last resort for an event the database would not take. Never the normal path. */
function stranded(record: Record<string, unknown>, why: unknown): void {
  console.error("event not recorded in the database:", why);
  strandedCount++;
  strandedLast = new Date().toISOString();
  try {
    mkdirSync("/data", { recursive: true });
    appendFileSync(STRANDED_PATH, JSON.stringify(record) + "\n");
  } catch (err) {
    // Nothing left to try. Say so loudly rather than silently losing provenance.
    console.error("event could not be stranded to disk either:", err);
  }
}

/** The identity both statements resolve, from the row's own stamps and nothing else.
 *
 *  Inline subqueries, not lookups in TypeScript: an id has to come from the same statement that
 *  writes the row, or two events a millisecond apart can disagree about a team that was just
 *  renamed. The skill version is the one `step` names, released at or before this transaction —
 *  `now()` is the same instant for both statements, and the same one the row's `ts` defaults to, so
 *  the version a call is filed under and the timestamp it is filed at cannot drift apart.
 *
 *  A slug or a name that resolves nothing is a null, not a refusal: telemetry must never be able to
 *  fail the operation it is describing, and a name nothing matches is exactly as unattributed as no
 *  name at all. */
const IDENTITY = `
    with id as (
      select (select p.id from zz.principal p where p.email = $1) as actor_id,
             (select t.id from zz.team t where t.slug = $2) as team_id,
             (select i.id from zz.initiative i
                join zz.team t on t.id = i.team_id
               where t.slug = $2 and i.slug = $3) as initiative_id,
             ${versionAtEvent("now()", "$4")} as skill_version_id
    )`;

/** The run, created or found, before the event that names it.
 *
 *  The identity tuple and nothing else decides the row, which is what one conflict target says.
 *  The aggregate includes the event being written — the row does not exist yet, so this statement
 *  counts it here rather than finding it in the table — and the guard runs the same comparison the
 *  timer does, so a recomputation that moved nothing writes nothing.
 *
 *  A run exists only where all four parts of the identity resolve. A conversation with no initiative
 *  names no piece of work, and a skill nothing released resolves no version: a run for either would
 *  be a row that groups calls under an identity nothing else can name, and the timer is not allowed
 *  to invent one later. The counters are recomputed rather than incremented, so writing the same
 *  event twice leaves the same run. */
const STAMP_RUN = `${IDENTITY}
    insert into zz.skill_run (team_id, initiative_id, skill_version_id, session,
                              calls, refusals, bytes_total, started_at, ended_at)
    select id.team_id, id.initiative_id, id.skill_version_id, $5,
           c.calls, c.refusals, c.bytes, c.first, c.last
      from id
      cross join lateral (
        select count(*)::int as calls,
               (count(*) filter (where x.ok is false))::int as refusals,
               sum(x.bytes) as bytes, min(x.ts) as first, max(x.ts) as last
          from (select e.ts, e.ok, e.response_bytes as bytes
                  from zz.event e
                 where e.team_id = id.team_id
                   and e.initiative_id = id.initiative_id
                   and e.skill_version_id = id.skill_version_id
                   and e.session = $5
                union all
                select now(), $6::boolean, $7::int) x
      ) c
     where id.team_id is not null
       and id.initiative_id is not null
       and id.skill_version_id is not null
       and $5 <> ''
    ${RUN_CONFLICT}`;

/** The first seven of the writer's parameters, and all the run statement names.
 *
 *  Postgres refuses a statement handed more parameters than it references, so the two statements
 *  cannot simply share one array: the event statement names all eighteen, the run statement the
 *  prefix — the identity, the session, and the outcome and size the event being written
 *  contributes to the aggregate. One numbering, so $5 is the session in both. */
const RUN_PARAMS = 7;

/** The row itself, carrying the run its identity names — null where nothing was stamped.
 *
 *  The run is found by the identity tuple rather than by the id the statement above wrote: the
 *  upsert returns no row when its guard suppresses the update, and the run it declined to rewrite
 *  is the run this event belongs to. */
const APPEND_EVENT = `${IDENTITY}
    insert into zz.event (actor_id, team_id, initiative_id, session, skill_version_id, run_id,
                          kind, subject, detail, ok, refusal, refusal_owner,
                          plugin, plugin_version, tool_key,
                          duration_ms, request_bytes, response_bytes, batched)
    select id.actor_id, id.team_id, id.initiative_id, $5, id.skill_version_id,
           (select r.id from zz.skill_run r
             where r.team_id = id.team_id and r.initiative_id = id.initiative_id
               and r.skill_version_id = id.skill_version_id and r.session = $5),
           $8, $9, $10::jsonb, $6, $11, $12, $13, $14, $15, $16, $17, $7, $18
      from id`;

/** The two statements, in one transaction, or nothing at all.
 *
 *  A failure rolls both back and strands the event: a run counting a call the record does not hold
 *  is worse than no run, because the trace is what a round is judged from. Every failure lands in
 *  `stranded` — an unhandled rejection here would take the process down, and this runs on the path
 *  of every tool call. */
async function write(record: Record<string, unknown>, params: unknown[]): Promise<void> {
  let client: PoolClient | undefined;
  try {
    client = await platformDb().connect();
    await client.query("begin");
    await client.query(STAMP_RUN, params.slice(0, RUN_PARAMS));
    await client.query(APPEND_EVENT, params);
    await client.query("commit");
  } catch (err) {
    if (client) await client.query("rollback").catch(() => { /* nothing left to try */ });
    stranded(record, err);
  } finally {
    client?.release();
  }
}

export function logEvent(e: {
  actor: string;
  kind: string;
  subject?: string;
  teamSlug?: string | null;
  detail?: Record<string, unknown>;

  /* The measurement columns, on a tool_call. Each earns its column by the same test — would
   * somebody GROUP BY or WHERE on it. What is read once and never filtered on stays in `detail`. */
  initiative?: string;
  /** The skill this call was following, as the trace last had it — resolved here to the version
   *  released at or before now. Absent when nothing was loaded, and absent is the honest answer:
   *  a call under no version is one no per-version report can name. */
  step?: string;
  /** The conversation this call belongs to — `step-trace.ts`'s `run`, which rotates on the same
   *  idle window that ends a step. It lands in the `session` column, which with the team, the
   *  initiative and the skill version is the run's identity. Empty where there is no conversation,
   *  which is also what makes an event under no run. */
  run?: string;
  ok?: boolean;
  refusal?: string;
  /** Who the refusal belongs to — guardrail, ours, theirs or other, from @zz/contracts'
   *  refusalOwner(). Derived here rather than asked of the caller, so one table does not end up
   *  holding four vocabularies. Null whenever `ok` is not false. */
  refusalOwner?: string;

  /* What a tool call cost. Nullable, and null means "not measured", never a guessed zero:
   * `requestBytes` is null whenever a caller's request carried no Content-Length — a chunked body,
   * or none at all — which is the one case tool-telemetry.ts cannot measure. `durationMs` and
   * `responseBytes` are written on every tool_call row it produces. `batched` is the exception to
   * nullable: the gateway always knows whether a request carried more than one call, so it is
   * `not null default false` at the schema and always written here. */
  durationMs?: number;
  requestBytes?: number | null;
  responseBytes?: number;
  batched?: boolean;

  /* Plugin attribution, resolved by the caller from the loaded skill through
   * zz.plugin_version_skill — never from a flow and never from the x-zz-client header, which answer
   * a different question. Left unset when unresolvable, and written as a plain SQL null. */
  plugin?: string;
  pluginVersion?: string;
  toolKey?: string;
}): void {
  // One spelling of a person, folded here because this is the one place every gateway event passes
  // through. The actor column is grouped on by tool-report --actor and watch-results, and one
  // person appearing as two rows makes each half look like complete work.
  const actor = e.actor.trim().toLowerCase();
  const record = {
    ts: new Date().toISOString(),
    actor,
    team: e.teamSlug ?? null,
    kind: e.kind,
    subject: e.subject ?? "",
    ...(e.detail && Object.keys(e.detail).length ? { detail: e.detail } : {}),
  };

  if (!platformDbReady()) {
    stranded(record, "platform database not configured");
    return;
  }

  // `|| null`, not `??`, on the two fields that have held an empty string: `??` coalesces only null
  // and undefined, so a `""` reaches the column verbatim and the table holds two spellings of
  // nothing where the index holds one. For `step` that is the difference between a version and no
  // version at all: no skill is named `""`.
  void write(record, [
    actor,                                   // $1  the actor's email address
    e.teamSlug ?? null,                      // $2  the acting team's slug
    e.initiative || null,                    // $3  the initiative within that team
    e.step || null,                          // $4  the skill loaded, resolved to a version
    e.run ?? "",                             // $5  the conversation, and the run's session
    e.ok ?? null,                            // $6
    e.responseBytes ?? null,                 // $7
    e.kind,                                  // $8
    e.subject ?? "",                         // $9
    JSON.stringify(e.detail ?? {}),          // $10
    e.refusal ?? null,                       // $11
    e.ok === false ? refusalOwner(e.refusal ?? "") : null,   // $12
    e.plugin ?? null,                        // $13
    e.pluginVersion ?? null,                 // $14
    e.toolKey ?? null,                       // $15
    e.durationMs ?? null,                    // $16
    e.requestBytes ?? null,                  // $17
    e.batched ?? false,                      // $18
  ]);
}
