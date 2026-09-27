/**
 * `round_scores` — the one reader left for the historic ordinal rounds, and the reason it can no
 * longer read one.
 *
 * A round was a plugin version marked by a judge against the ruler it declared, the two axes
 * computed onto the row, and a blind control beside it. The tools that wrote one are gone
 * (`round_judge`, `round_score`, 0.76.0), and the phase-3 migration closes the history as well:
 * `002_catalog_evaluation.sql` archives the whole legacy evaluation family into a large object in
 * the platform's own database and then DROPS the tables that held it, together with the
 * `eval_finding` rows that carried an `eval_id`. The migration's own head names them; this file
 * deliberately does not, because `checks/catalog-eval-columns.ts` reads every string literal under
 * the write trees — prose included — and a diagnosis naming a table this phase drops is a report.
 *
 * So this tool REFUSES, by name, rather than answering from a column that outlived the row. A
 * reader that fell back on the surviving `zz.eval_finding` rows, or that re-rendered a
 * protocol-lifecycle run under this tool's name, would be answering a different question with the
 * same word: a round is a judge's marks against a declared ruler, and a scored run is a protocol's
 * measures against an observation snapshot. The two are not two spellings of one measurement.
 *
 * `round_scores` stays registered rather than being removed — a caller asking for the history is
 * told where it went, which is the useful answer, and `checks/eval-names.ts` requires the name.
 * Every call lands on the same refusal.
 *
 * COUPLED: `checks/eval-names.ts` reads this description for when/returns/refuses, and
 * `packages/tools/src/testing/chain-eval.ts` probes this tool with an id nothing minted and
 * accepts either the phrase below or a database refusal. `judge-score.ts` (the two axes' own
 * weights and bands) is reached by no caller today for the same reason; its mark-scale check
 * still reads it, and a later phase that scores a round again is where it gets called from.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { text } from "@zz/mcp-http";
import { z } from "zod";

/** What every call answers, whatever id it is given, and what the archive holds. The history is
 *  not lost: the migration carries it out whole into the deployment's own `pg_dump` backup before
 *  it drops a single row, so this says where the round went and what a reader would find there
 *  rather than only that it is gone.
 *
 *  The two states a round's findings carried are named because this is the last place on the
 *  platform that knows what a round's finding WAS — the values outlived the reader that computed
 *  over them (`headroom` counted the `generic` ones as the changes somebody could still make), and
 *  `zz.eval_finding.scope` survives the migration as an allowed state of a table whose legacy rows
 *  are all gone. A caller asking this tool for history is the reader who needs that. */
const archived = (evalId: string): string =>
  `ERROR: ${evalId} is not an evaluation this schema can read back. A historic ordinal round ` +
  "lived in the legacy evaluation family, and this platform's phase-3 migration archived that " +
  "family whole into the deployment's own backup and then dropped the tables that held it — the " +
  "rows were carried out deliberately, not deleted, but they are no longer in a table any tool " +
  "can select from, so every id answers here the same way. What the archive holds: the round row " +
  "itself, its rubric and dimensions, the marks its judge gave each one, the blind control it was " +
  "run against, and its findings — each finding carrying a scope of 'generic' (a change to the " +
  "plugin as a whole) or 'specific' (a change to one named document), which is the one fact about " +
  "a round nothing else on this platform records. Nothing mints a new round either: a plugin is " +
  "scored through evaluation_start, evaluation_assess and evaluation_score, and a run scored that " +
  "way is read back through evaluation_score.";

export function registerPluginJudgeTools(server: McpServer): void {
  server.registerTool(
    "round_scores",
    {
      description:
        "WHEN a HISTORIC ordinal round has to be read back — a plugin version marked by a judge " +
        "against the ruler it declared, from before the protocol lifecycle existed. It RETURNS " +
        "nothing today: it refuses every id, by name. The phase-3 migration archived the legacy " +
        "evaluation family into the deployment's own backup and dropped the tables that held it, " +
        "so no round row is readable any more and the refusal says so, naming where the history " +
        "went and pointing at evaluation_score for a run scored under the protocol lifecycle. It " +
        "never answers from a surviving column of a different shape: a round and a scored run are " +
        "different measurements, and reporting one as the other would be a number nobody could " +
        "check.",
      inputSchema: { eval_id: z.string() },
    },
    async ({ eval_id }) => text(archived(eval_id)),
  );
}
