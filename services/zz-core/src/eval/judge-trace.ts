/**
 * One run's events as the TEXT A JUDGE READS.
 *
 * SPLIT OUT OF judge.ts BY SUBJECT. That file runs the round; this answers one narrow question —
 * what does a run look like to somebody marking it — and the answer is a rendering problem, not
 * a judging one.
 *
 * TRUNCATION IS ANNOUNCED IN THE TEXT AND RETURNED BESIDE IT, and both halves matter. A run
 * reaches hundreds of events; a judge handed the first four hundred and told nothing scores a
 * different run from the one that happened, confidently. Saying so in the text stops that, and
 * returning the count stops the stored record claiming more coverage than it had.
 */
import type pg from "pg";

/** Events shown to the judge, per subject. The cap is announced in the text and recorded in
 *  the stored note — an ops-build run reaches 569 events, and a judge handed the first 400
 *  scores a different run from the one that happened. */
const TRACE_CAP = 400;

/** One run as the text a judge reads. Truncation is announced in the text AND returned, so
 *  neither the judgement nor the stored record can claim more coverage than it had. */
export async function traceOf(p: pg.Pool, runId: string): Promise<{ text: string; truncated: number }> {
  const total = Number((await p.query<{ n: string }>(
    "select count(*) as n from zz.event where run_id = $1::uuid", [runId])).rows[0]?.n ?? 0);
  const { rows } = await p.query<{ at: string; subject: string; ok: boolean | null; refusal: string }>(`
    -- THE RESOLVED NAME. A judge reading this transcript is asked which tools a run used,
    -- and a rename put one tool in it under two spellings -- so the same run read as though
    -- it had reached for two different things. tool_key is the folded name; subject is only
    -- the fallback for a row written before that column existed.
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
