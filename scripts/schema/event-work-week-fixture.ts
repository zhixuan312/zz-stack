/**
 * What the `zz.event_work_week` checks share: the call they seed, its insert, the week cut computed
 * outside PostgreSQL, and the register's budget as `ARCHITECTURE.md` spells it.
 *
 * COUPLED: checks/event-work-week.ts, event-work-week-rebuild.ts, event-work-week-reads.ts and
 * event-work-week-columns.ts.
 */
import type pg from "pg";

/** A call the model should hold: `origin` and `kind` are parameters so the two events it must IGNORE
 *  are spelled the same way the ones it must count are. */
export type Call = {
  readonly ts: string; readonly ok?: boolean; readonly team?: string | null; readonly tool?: string;
  readonly ms?: number | null; readonly batched?: boolean; readonly owner?: string;
  readonly kind?: string; readonly origin?: string;
};

/** An insert of one `zz.event` row per call, answering its id; a call naming no team is `team`'s. */
export const appender = (team: string) => async (client: pg.Client, c: Call): Promise<string> => {
  const { rows } = await client.query<{ id: string }>(
    `insert into zz.event (ts, kind, origin, ok, team_id, tool_key, duration_ms, batched, refusal_owner, subject)
     values ($1::timestamptz, $2::text, $3::text, $4::boolean, $5::uuid, $6::text, $7::integer, $8::boolean,
             $9::text, '')
     returning id::text`,
    [c.ts, c.kind ?? "tool_call", c.origin ?? "work", c.ok ?? true, c.team === undefined ? team : c.team,
      c.tool ?? "core:a", c.ms ?? null, c.batched ?? false, c.owner ?? null]);
  return rows[0]!.id;
};

/** A Monday in `zone`, from an instant — what the week cut SHOULD say, computed outside PostgreSQL so
 *  a check does not agree with a wrong zone by using the same expression twice. */
export function mondayInZone(instant: string | Date, zone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date(instant));
  const at = (type: string): string => parts.find((p) => p.type === type)!.value;
  const local = new Date(`${at("year")}-${at("month")}-${at("day")}T00:00:00Z`);
  local.setUTCDate(local.getUTCDate() - ((local.getUTCDay() + 6) % 7));
  return local.toISOString().slice(0, 10);
}

/** The body of a markdown section titled `heading` (levels 2 to 4), down to the next heading of its
 *  level or above; null when there is none. */
export function sectionOf(md: string, heading: string): string | null {
  const lines = md.split("\n");
  const start = lines.findIndex((l) => /^#{2,4}\s/.test(l) && l.replace(/^#{2,4}\s+/, "").trim() === heading);
  if (start < 0) return null;
  const level = (lines[start].match(/^#+/) ?? [""])[0].length;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const m = lines[i].match(/^(#+)\s/);
    if (m && m[1]!.length <= level) { end = i; break; }
  }
  return lines.slice(start + 1, end).join("\n");
}

/** `rows ≤ N, ms ≤ M` — a budget's two numbers, in the spelling the register uses. */
export const BUDGET = /rows\s*(?:≤|<=)\s*([\d,]+)\s*,\s*ms\s*(?:≤|<=)\s*([\d,]+)/i;
