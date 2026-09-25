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
 * COUPLED: `zz-tool watch-results` reads the stranded count off /health and alerts on it.
 */
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";

import { refusalOwner } from "@zz/contracts";

import { platformDb, platformDbReady } from "./db.js";

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

export function logEvent(e: {
  actor: string;
  kind: string;
  subject?: string;
  teamSlug?: string | null;
  detail?: Record<string, unknown>;

  /* The measurement columns, on a tool_call. Each earns its column by the same test — would
   * somebody GROUP BY or WHERE on it. What is read once and never filtered on stays in `detail`. */
  initiative?: string;
  flow?: string;
  step?: string;
  stepVersion?: string;
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
   * zz.plugin_version_skill — never from `flow` and never from the x-zz-client header, which answer
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
  // team_id is resolved here, in the insert, from the slug the caller gave.
  //
  // A subselect, not a lookup in TypeScript: the id must come from the same statement that writes
  // the row, or two events a millisecond apart can disagree about a team that was just renamed. An
  // unknown slug resolves to null rather than raising — telemetry must never be able to fail the
  // operation it is describing, and a slug naming no team is exactly as unattributed as no slug.
  //
  // `|| null`, not `??`, on the two fields that have held an empty string: `??` coalesces only null
  // and undefined, so a `""` reaches the column verbatim and the table holds two spellings of
  // nothing where the index holds one. This is the second line of defence, at the one place every
  // row is written.
  void platformDb()
    .query(
      `insert into event (actor, team_slug, team_id, kind, subject, detail,
                          initiative, flow, step, step_version, ok, refusal, refusal_owner,
                          plugin, plugin_version, tool_key,
                          duration_ms, request_bytes, response_bytes, batched)
       values ($1,$2,(select id from zz.team where slug = $2),$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,
               $13,$14,$15,$16,$17,$18,$19)`,
      [actor, e.teamSlug ?? null, e.kind, e.subject ?? "", JSON.stringify(e.detail ?? {}),
       e.initiative || null, e.flow ?? null, e.step || null, e.stepVersion ?? null,
       e.ok ?? null, e.refusal ?? null,
       e.ok === false ? refusalOwner(e.refusal ?? "") : null,
       e.plugin ?? null, e.pluginVersion ?? null, e.toolKey ?? null,
       e.durationMs ?? null, e.requestBytes ?? null, e.responseBytes ?? null, e.batched ?? false],
    )
    .catch((err: unknown) => { stranded(record, err); });
}
