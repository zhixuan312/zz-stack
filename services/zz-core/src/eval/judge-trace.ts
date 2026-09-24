/**
 * One run's events rendered as the text a judge reads. `judge.ts` runs the round; this only
 * renders a run.
 */
import type pg from "pg";

/** Events shown to the judge, per subject. A run reaches hundreds of events, so the cap bites;
 *  it is announced in the text and recorded in the stored note. */
const TRACE_CAP = 400;

/** One run as the text a judge reads. Truncation is announced in the text and returned beside
 *  it, so neither the judgement nor the stored record can claim more coverage than it had. */
export async function traceOf(p: pg.Pool, runId: string): Promise<{ text: string; truncated: number }> {
  const total = Number((await p.query<{ n: string }>(
    "select count(*) as n from zz.event where run_id = $1::uuid", [runId])).rows[0]?.n ?? 0);
  const { rows } = await p.query<{ at: string; subject: string; ok: boolean | null; refusal: string }>(`
    -- The resolved name: a judge reading this transcript is asked which tools a run used, and a
    -- renamed tool must read as one. tool_key is the folded name; subject is the fallback for a
    -- row with no tool_key.
    select to_char(e.ts,'HH24:MI:SS') as at,
           coalesce(e.tool_key, e.subject) as subject, e.ok,
           coalesce(left(e.refusal, 160), '') as refusal
      from zz.event e where e.run_id = $1::uuid
     order by e.ts limit ${TRACE_CAP}`, [runId]);
  const body = rows.map((e) => `${e.at}  ${e.subject}  ${e.ok === false ? "REFUSED" : "ok"}` +
                               `${e.refusal ? `  ${e.refusal}` : ""}`).join("\n");
  const cut = total - rows.length;
  return cut > 0
    ? { text: `${body}\n[TRACE TRUNCATED: ${rows.length} of ${total} events shown]`, truncated: cut }
    : { text: body, truncated: 0 };
}
