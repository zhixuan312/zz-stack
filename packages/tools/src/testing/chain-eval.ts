/**
 * The /eval door, walked against a live deployment.
 *
 * Every tool here takes `plugin`/`version`/`eval_id` identifiers and answers about a plugin's
 * release history — state this run's throwaway initiative does not create and this script does not
 * control — which makes it a different subject from the governed walk next door, where every
 * assertion is about one initiative's documents.
 *
 * COUPLED: `checks/chain-check-wiring.ts` follows this import, so a tool exercised here counts as
 * exercised.
 */
import { randomUUID } from "node:crypto";

/** The pieces chain-check owns, handed in rather than re-made, so this walks the same door
 *  into the same result set. */
interface EvalDeps {
  callEval: (tool: string, args: unknown) => Promise<string>;
  eitherOr: (name: string, got: string, acceptableRefusal: RegExp) => void;
  /** The plugin these tools are aimed at — the catalog entry this run's flow belongs to. */
  PLUGIN: string;
}

export async function walkEvalDoor({ callEval, eitherOr, PLUGIN }: EvalDeps): Promise<void> {
  // Whether this deployment has ever released plugin, run a judge round, or even holds a platform
  // database is state this throwaway initiative does not create. So each call below is aimed at a
  // refusal these tools document for exactly that case — "no released version is recorded",
  // "declares no ruler", "is not an evaluation" — rather than at manufacturing a real release, an
  // approved rubric and a scored round, which needs a live judge: round_judge takes about thirty
  // seconds per subject. Getting this far exercises the door, the schema and every refusal branch
  // that runs before a model is reached.
  eitherOr("plugin_locate answers or refuses by a named cause",
    await callEval("plugin_locate", { plugin: PLUGIN }),
    /no platform database|no released version/);
  eitherOr("plugin_conform reads this plugin's own catalog entry",
    await callEval("plugin_conform", { plugin: PLUGIN, version: "0" }),
    /is not in the catalog/);
  eitherOr("plugin_profile answers or refuses by a named cause",
    await callEval("plugin_profile", { plugin: PLUGIN, version: "0" }),
    /no platform database/);
  eitherOr("ruler_read answers or refuses by a named cause",
    await callEval("ruler_read", { plugin: PLUGIN, version: "0" }),
    /no platform database/);
  eitherOr("ruler_affirm refuses a version this deployment never released",
    await callEval("ruler_affirm", { plugin: PLUGIN, version: "0" }),
    /no platform database|no released version/);
  eitherOr("round_judge refuses a version that declares no ruler",
    await callEval("round_judge", { plugin: PLUGIN, version: "0", rubric_id: "0" }),
    /no platform database|declares no ruler/);
  eitherOr("round_scores refuses an eval_id nothing minted",
    await callEval("round_scores", { eval_id: randomUUID() }),
    /no platform database|is not an evaluation/);
  eitherOr("ruler_record refuses a quantitative dimension with no threshold",
    await callEval("ruler_record", {
      plugin: PLUGIN, version: "0", rubric_version: "0", subject: "auto",
      dimensions: [{ name: "chain-check probe", kind: "quantitative" }],
    }), /no platform database|carries no threshold/);
  // round_score computes both axes from the round's own figures and asks the typed service one thing
  // only — how strong the evidence is. On a throwaway stack there is no round to score, and there
  // may be no key either; both are named refusals, and either proves the door serves the tool and
  // reaches its argument checks before anything is spent.
  eitherOr("round_score refuses an eval_id nothing minted",
    await callEval("round_score", { eval_id: randomUUID() }),
    /no platform database|no plugin evaluation|TYPESAFE_API_KEY/);
  eitherOr("finding_record refuses an eval_id nothing minted",
    await callEval("finding_record", {
      eval_id: randomUUID(), findings: [{ pattern: "chain-check probe", scope: "specific" }],
    }), /no platform database|no evaluation/);
  // A random UUID decides nothing, which makes this probe safe against a live deployment:
  // finding_decide is the one tool on this door that closes a row somebody else recorded, and the id
  // below matches none.
  eitherOr("finding_decide refuses an id nothing minted",
    await callEval("finding_decide", {
      decisions: [{ finding_id: randomUUID(), decision: "rejected", note: "chain-check probe" }],
    }), /no platform database|names no finding/);

}
