/**
 * Give the rounds that were scored before migration 067 the two axes they always implied.
 *
 * WHAT IS BEING RECOVERED AND WHAT IS NOT. `round_recommend` has always computed effectiveness
 * and headroom from marks the round already stored, put them in front of the typed judge, and
 * returned them — it just never wrote them down. So for every round already on the record the
 * inputs are still there, unchanged, in `zz.eval_score` and `zz.rubric_dimension`: this is a
 * recomputation from stored evidence, not an estimate.
 *
 * THE INITIATIVE LINK IS NOT BACKFILLED AND WILL NOT BE. That one is genuinely absent — nothing
 * recorded which initiative produced a round before 067 — and the only way to invent it is to
 * match a round to a report by plugin name and a date window. It would be right for all four
 * rounds on this deployment today, which is exactly what makes it dangerous: journal 0116 is
 * the record of five defects in one day, every one an attribution through a link that was not
 * there. A round with no initiative keeps a null and the console draws a date with no link.
 *
 * ONE IMPLEMENTATION OF THE ARITHMETIC. `effectiveness` and `headroom` are imported from
 * judge-score.ts rather than restated here, so the weights, the band boundaries and the
 * collapse rule are the ones the reports were written against. A second copy in a script is how
 * a backfill quietly produces a different number from the tool it is backfilling for.
 *
 *   node scripts/backfill-eval-axes.ts            # say what it would write, change nothing
 *   node scripts/backfill-eval-axes.ts --write    # write it
 */
import pg from "pg";

import { effectiveness, headroom } from "../services/zz-core/dist/eval/judge-score.js";

const WRITE = process.argv.includes("--write");
const url = process.env.TEAM_DB_URL || process.env.DATABASE_URL;
if (!url) {
  console.error("no TEAM_DB_URL / DATABASE_URL in the environment");
  process.exit(1);
}
const db = new pg.Pool({ connectionString: url });

/** Every round that reached a verdict and has no score stored beside it. */
const rounds = (await db.query<{ id: string; plugin: string; version: string; rec: string }>(`
  select e.id::text as id, p.name as plugin, pv.version, e.recommendation as rec
    from zz.eval e
    join zz.plugin_version pv on pv.id = e.plugin_version_id
    join zz.plugin p on p.id = pv.plugin_id
   where e.is_control is false and e.recommendation is not null and e.effectiveness is null
   order by e.started_at`)).rows;

console.log(`${rounds.length} round(s) with a verdict and no stored score\n`);

for (const r of rounds) {
  // THE SAME THREE READS round_recommend makes, in the same shapes. Quantitative dimensions
  // are scored 5 for met and 1 for unmet because a line is binary, so "met" is mean >= 5.
  const dims = (await db.query<{ kind: string; mean: string }>(`
    select d.kind, round(avg(s.score),2)::text as mean
      from zz.eval_score s join zz.rubric_dimension d on d.id = s.dimension_id
     where s.eval_id = $1::uuid and not s.is_control
     group by d.name, d.kind, d.ordinal order by d.ordinal`, [r.id])).rows;

  // THE GAP COMES FROM THIS ROUND'S OWN CONTROL where one names it, and from the pooled
  // reading where none does — which is what every round recorded before migration 063 has.
  // Using the pooled figure for those is not a second rule: it is the figure their reports
  // were written against, and recomputing them under a rule that did not exist then would
  // make the stored number disagree with the document that explains it.
  const ctl = (await db.query<{ id: string }>(
    "select id::text as id from zz.eval where controls = $1::uuid limit 1", [r.id])).rows[0];
  const control = (await db.query<{ real: string | null; ctl: string | null }>(
    ctl
      ? `select round(avg(s.score) filter (where not s.is_control),2)::text as real,
                round(avg(s.score) filter (where s.is_control),2)::text as ctl
           from zz.eval_score s
           join zz.rubric_dimension d on d.id = s.dimension_id and d.kind <> 'quantitative'
          where s.eval_id in ($1::uuid, $2::uuid)`
      : `select round(avg(s.score) filter (where not s.is_control),2)::text as real,
                round(avg(s.score) filter (where s.is_control),2)::text as ctl
           from zz.eval_score s
           join zz.rubric_dimension d on d.id = s.dimension_id and d.kind <> 'quantitative'
          where s.eval_id in (
                  select e2.id from zz.eval e2
                   where e2.plugin_version_id = (select plugin_version_id from zz.eval where id = $1::uuid)
                     and e2.rubric_id = (select rubric_id from zz.eval where id = $1::uuid))`,
    ctl ? [r.id, ctl.id] : [r.id])).rows[0];

  const openFindings = (await db.query<{ n: string }>(`
    select count(*)::text as n
      from zz.eval_finding f
      join zz.eval e2 on e2.id = f.eval_id
      join zz.plugin_version pv2 on pv2.id = e2.plugin_version_id
     where pv2.plugin_id = (select pv.plugin_id from zz.eval e
                              join zz.plugin_version pv on pv.id = e.plugin_version_id
                             where e.id = $1::uuid)
       and f.scope = 'generic' and f.decision = 'deferred'`, [r.id])).rows[0];

  const gap = control?.real && control?.ctl
    ? Math.round((Number(control.real) - Number(control.ctl)) * 100) / 100 : null;
  const qual = dims.filter((d) => d.kind === "qualitative");
  const quant = dims.filter((d) => d.kind === "quantitative");
  const qualMean = qual.length
    ? Math.round((qual.reduce((a, d) => a + Number(d.mean), 0) / qual.length) * 100) / 100
    : null;
  const met = quant.filter((d) => Number(d.mean) >= 5).length;

  const score = effectiveness(qualMean, met, quant.length, gap);
  const room = headroom(score.score, quant.length - met, Number(openFindings.n));

  console.log(`${r.plugin} ${r.version}  ${r.rec}`);
  console.log(`  effectiveness ${score.score ?? "—"}  (${score.band})`);
  console.log(`  headroom      ${room.points ?? "—"} pts, ${room.named_changes} named`);
  console.log(`  gap ${gap ?? "—"}${ctl ? "" : "  [pooled — no control names this round]"}`);

  if (WRITE) {
    await db.query(`
      update zz.eval set effectiveness = $2, effectiveness_band = $3,
                         headroom_points = $4, headroom_named = $5
       where id = $1::uuid`,
      [r.id, score.score, score.band, room.points, room.named_changes]);
  }
}

console.log(WRITE ? "\nwritten." : "\nnothing written — pass --write to apply.");
await db.end();
