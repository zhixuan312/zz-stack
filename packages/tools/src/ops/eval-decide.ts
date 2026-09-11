/**
 * eval-decide — what we decided about an evaluation finding, and whether a run's work landed
 *
 *   zz-tool eval-decide --outcomes                       # what happened to each run's work
 *   zz-tool eval-decide --finding <id> --applied --skill sm-intent --version 1.1
 *   zz-tool eval-decide --finding <id> --rejected --why 'measured below the floor'
 *   zz-tool eval-decide --outcomes --psql '<command>'    # a database somewhere else
 *
 * THE LOOP IS NOT CLOSED BY MEASURING. A finding that nobody decides about is a note, and a
 * version cut without saying which finding it answers is a change nobody can later evaluate. Both
 * halves have to be written down or the next evaluation cannot ask the only question that matters
 * -- did the thing we changed actually help.
 *
 * REJECTED IS A REAL OUTCOME AND THE COMMON ONE. sm-intent 1.1 was written for a fault seen in 13
 * of 30 pieces of work, measured, and reverted: the comparison was invalid (the second version
 * resumed the first's initiatives) and the delta was 0.000 against a threshold of 0.31. Recording
 * that as `rejected` with the reason is the difference between a loop that learns and one that
 * quietly re-proposes the same change every round.
 *
 * OUTCOMES ARE READ FROM THE DOCUMENTS, not asked for. Whether a run's work was accepted is
 * already stamped on what it produced -- approve() writes the status and hand-writing it is
 * refused -- so this reads it rather than inviting anybody to assert it.
 */
import { die, optional, parseArgs, required } from "../lib/cli.js";
import { DEFAULT_PSQL, psqlRows, psqlText } from "../lib/psql.js";

const lit = (s: string): string => `'${String(s ?? "").replace(/'/g, "''")}'`;

/** What became of the work a run produced. `open` is not a failure and is kept apart from one:
 *  work in flight is neither accepted nor rejected, and folding it into either is how a report
 *  comes to claim a success rate it has not earned. */
const OUTCOMES = ["accepted", "delivered", "open", "abandoned"] as const;

function refreshOutcomes(psql: string): number {
  // A run's documents say it: anything approved is accepted, anything written but not approved is
  // still open.
  //
  // A RUN WITH NO DOCUMENT IS LEFT BLANK, NOT CALLED ABANDONED. The first version of this marked
  // it abandoned and reported 100 of 187 runs that way, which was an invented failure twice over:
  // sm-build, zz-backbone and every block usage skill OWE no document, so having none is them
  // working correctly; and documents written before attribution existed have no run to link to,
  // so their runs look empty when the work is sitting right there.
  //
  // No evidence is not evidence of failure. `abandoned` is reserved for a run that ended having
  // written nothing while owing something, which is knowable only once produced_by_run_id is
  // stamped at write time -- and that is the one thing this apparatus does not have yet.
  const sql = `
    update zz.run r set outcome = case
        when x.approved > 0 then 'accepted'
        when x.written  > 0 then 'open'
        else r.outcome end
      from (select r2.id,
                   count(d.id) filter (where d.approved_at is not null) as approved,
                   count(d.id) as written
              from zz.run r2 left join zz.doc d on d.produced_by_run_id = r2.id
             group by r2.id) x
     where x.id = r.id and r.ended_at is not null`;
  psqlText(psql, sql);
  const rows = psqlRows<{ outcome: string; n: string }>(psql,
    `select outcome, count(*)::text as n from zz.run where outcome <> '' group by 1 order by 2 desc`);
  console.log("\n  what became of the work each run produced\n");
  for (const r of rows) console.log(`    ${r.outcome.padEnd(11)} ${r.n}`);
  console.log("");
  return rows.length;
}

function main(argv: string[]): number {
  const args = parseArgs(argv, ["outcomes", "applied", "rejected"]);
  const psql = args.flags.get("psql") || DEFAULT_PSQL;

  if (args.flags.has("outcomes")) {
    if (!refreshOutcomes(psql)) {
      console.log("  No run has ended yet, so nothing has an outcome. That is not the same as");
      console.log("  everything having failed.\n");
    }
    return 0;
  }

  const finding = required(args, "finding", "which finding to decide about");
  const applied = args.flags.has("applied");
  const rejected = args.flags.has("rejected");
  if (applied === rejected) die("say either --applied or --rejected, and exactly one of them");

  if (applied) {
    const skill = required(args, "skill", "which skill was changed");
    const version = required(args, "version", "the version cut to answer this finding");
    const sv = psqlRows<{ id: string }>(psql,
      `select sv.id::text as id from zz.skill_version sv join zz.skill s on s.id = sv.skill_id
        where s.name = ${lit(skill)} and sv.version = ${lit(version)}`);
    if (!sv[0]) die(`zz.skill_version has no ${skill} ${version} — register it before claiming it fixed something`);
    psqlText(psql,
      `update zz.eval_finding set decision = 'applied', resulted_in_skill_version_id = ${lit(sv[0].id)}::uuid
        where id = ${lit(finding)}::uuid`);
    console.log(`\n  finding ${finding.slice(0, 8)} -> applied, answered by ${skill} ${version}`);
    console.log("  It is not an improvement until it is MEASURED on work it was not derived from,");
    console.log("  and clears the noise floor for that sample size. Until then it is a prediction.\n");
    return 0;
  }

  const why = optional(args, "why", "why it was not applied") ?? "";
  psqlText(psql,
    `update zz.eval_finding set decision = 'rejected',
            proposed_change = case when ${lit(why)} = '' then proposed_change
                                   else proposed_change || ' [rejected: ' || ${lit(why)} || ']' end
      where id = ${lit(finding)}::uuid`);
  console.log(`\n  finding ${finding.slice(0, 8)} -> rejected${why ? `: ${why}` : ""}`);
  console.log("  Recorded so the next round does not re-propose it as though it were new.\n");
  void OUTCOMES;
  return 0;
}

try {
  process.exit(main(process.argv.slice(2)));
} catch (err) {
  console.error(String((err as Error)?.message ?? err));
  process.exit(2);
}
