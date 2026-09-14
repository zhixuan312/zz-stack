/**
 * Append-only platform event stream — the provenance record behind every admin action.
 *
 * Fire-and-forget: logging must never break the operation it describes. But "never break"
 * is not "never notice", and an event that vanishes because the database was briefly down
 * is a hole in the one record an audit later reads.
 *
 * So there is one store and one fallback, not two stores. Events go to `zz.event`, which
 * is what kb.ts reads. If — and only if — that write cannot happen, the event is appended
 * to /data/events-unwritten.jsonl and the failure is logged. That file existing means
 * something needs attention; it is not a second copy of the history.
 *
 * WHO NOTICES: `zz-tool watch-results` reads the count off /health and alerts on it. This
 * used to say "a monitor already polls this endpoint", which was an assumption about the
 * environment rather than a fact about this repository — nothing here polled /health, the
 * release checks it once, and so the one signal saying the audit record has holes in it was
 * reported to nobody.
 *
 * It used to double-write unconditionally, from a transition that had long finished: the
 * jsonl held 1892 lines and the table 716, nothing read the file, and the divergence was
 * invisible precisely because nobody was looking at either.
 */
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";

import { platformDb, platformDbReady } from "./db.js";

const STRANDED_PATH = "/data/events-unwritten.jsonl";

/** How many events this process could not record, and when the last one was.
 *
 * Counted in memory rather than by reading the file, because /health must stay cheap enough
 * to poll. The file is the record; this is the signal that the record needs reading. */
let strandedCount = 0;
let strandedLast: string | null = null;

/** Seeded from the file at boot, ONCE, so a restart does not erase the signal.
 *
 * The count was in-memory only, and /health omits the field entirely when it is zero — so
 * every restart reported a clean record while the holes sat in the file, and
 * `zz-tool watch-results` had nothing to alert on. That is the worst possible timing: an
 * event strands when the database is unavailable, and the thing that follows a database
 * outage is a restart. The one signal saying the audit record has gaps was reliably wiped by
 * the recovery.
 *
 * Read once here rather than per request, so /health stays cheap enough to poll. A file too
 * large to count at boot is itself the alarm, and it is bounded by how much a broken database
 * can strand before somebody looks. */
function seedFromFile(): void {
  let lines: string[];
  try {
    lines = readFileSync(STRANDED_PATH, "utf8").split("\n").filter((l) => l.trim());
  } catch {
    return;   // no file is the normal case, and an unreadable one is not worth a boot failure
  }
  if (!lines.length) return;
  // A LINE is the signal, not a parsable line. The timestamp is a nicety on top, so a
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

  /* ── the measurement columns, on a tool_call ───────────────────────────────
   *
   * These were keys in `detail`, which is right for an audit payload and wrong for anything
   * anybody groups by: the three questions an improvement loop asks became `detail->>'step'`,
   * and nothing about a row's shape said whether it could answer them at all.
   *
   * Every one of them earns its column by the same test — would somebody GROUP BY or WHERE on
   * it. What is read once and never filtered on stays in the bag. */
  initiative?: string;
  flow?: string;
  step?: string;
  stepVersion?: string;
  block?: string;
  blockVersion?: string;
  ok?: boolean;
  refusal?: string;

  /* ── what a tool call cost (AC-2.2) ────────────────────────────────────────
   *
   * Was `detail.ms` / `detail.bytes` — read once and never filtered on, until a latency or a
   * payload-size percentile turned out to be exactly the kind of question a column answers
   * and a jsonb reach does not. Nullable, and null means "not measured", never a guessed
   * zero: `requestBytes` is null whenever a caller's request carried no Content-Length (a
   * chunked body, or none at all), which is the one case tool-telemetry.ts cannot measure
   * today. `durationMs` and `responseBytes` are written on every tool_call row it produces —
   * `started` and `bytes` are both set before anything that call handles can fail — so their
   * being nullable here is future-proofing for a caller shape this file does not have, not a
   * gap in this one. `batched` is the one exception to nullable at all — the gateway always
   * knows whether a request carried more than one call, so it is `not null default false` at
   * the schema and always written here. */
  durationMs?: number;
  requestBytes?: number | null;
  responseBytes?: number;
  batched?: boolean;

  /* ── plugin attribution (AC-1.5, AC-1.6) ───────────────────────────────────
   *
   * Resolved by the caller from the loaded skill, through zz.plugin_version_skill — never
   * from `flow` and never from the x-zz-client header, both of which answer a different
   * question. Left unset when unresolvable; this insert writes that as a plain SQL null,
   * never a guessed value. */
  plugin?: string;
  pluginVersion?: string;
  toolKey?: string;
}): void {
  // ONE SPELLING OF A PERSON, folded here because this is the one place every gateway event
  // passes through. Eleven call sites reach it, all of them handing over a canonical address
  // today — from parseCaller, from the identity middleware's own header — but "all of them
  // today" is what a boundary exists to stop being load-bearing. The actor column is grouped
  // on by tool-report --actor, evolve-report and watch-results, and one person appearing as
  // two rows makes each half look like complete work.
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
  // team_id IS RESOLVED HERE, IN THE INSERT, from the slug the caller gave.
  //
  // 020_event_attribution.sql made team_id the real foreign key — "tenancy has to be
  // answerable without a join, because every query in the system filters by it" — and
  // backfilled every row that existed. It did not touch this statement, so from the moment
  // that migration landed every new event carried a slug and a null key: 36,784 of them
  // before anyone looked, which is a week of the console's team-scoped views reading empty
  // while the platform was busier than it had ever been. The console was right and the
  // data was wrong.
  //
  // A SUBSELECT, not a lookup in TypeScript: the id must come from the same statement that
  // writes the row, or two events a millisecond apart can disagree about a team that was
  // just renamed. An unknown slug resolves to null rather than raising — telemetry must
  // never be able to fail the operation it is describing, and a slug naming no team is
  // exactly as unattributed as no slug at all, which is the truth about it.
  void platformDb()
    .query(
      `insert into event (actor, team_slug, team_id, kind, subject, detail,
                          initiative, flow, step, step_version, block, block_version, ok, refusal,
                          plugin, plugin_version, tool_key,
                          duration_ms, request_bytes, response_bytes, batched)
       values ($1,$2,(select id from zz.team where slug = $2),$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,
               $14,$15,$16,$17,$18,$19,$20)`,
      [actor, e.teamSlug ?? null, e.kind, e.subject ?? "", JSON.stringify(e.detail ?? {}),
       e.initiative ?? null, e.flow ?? null, e.step ?? null, e.stepVersion ?? null,
       e.block ?? null, e.blockVersion ?? null, e.ok ?? null, e.refusal ?? null,
       e.plugin ?? null, e.pluginVersion ?? null, e.toolKey ?? null,
       e.durationMs ?? null, e.requestBytes ?? null, e.responseBytes ?? null, e.batched ?? false],
    )
    .catch((err: unknown) => { stranded(record, err); });
}
