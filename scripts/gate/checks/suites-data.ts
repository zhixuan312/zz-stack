/**
 * What the platform records, and whether anything can read it back.

 * Columns against their writers, arity against the statements that bind it, the frozen alias
 * maps against the code that resolves through them, and the telemetry a call leaves behind.
 * A defect in any of these is silent by construction — a row is written, a query returns, and
 * the number is simply wrong — which is why they are checks and not tests.
 */
import { check } from "../run.ts";
import { runsCheck } from "../suite-runner.ts";

check("an aggregate nothing measured renders as null, never a confident zero",
      runsCheck("console-nulls.ts"));

check("SCHEMA.md states the standard the spec fixed", runsCheck("schema-standard.ts"));
check("the real migrations produce SCHEMA_TARGET's catalog, exactly", runsCheck("schema-inventory.ts"));
check("no initiative reader derives closed, outcome or flow from zz.doc", runsCheck("initiative-lifecycle-readers.ts"));
check("every tool the spec renamed resolves through one frozen map", runsCheck("alias-maps.ts"));
check("no statement in the write trees names a table or column the migration retires",
      runsCheck("dropped-columns.ts"));
// Phase 3's pair, registered by the integration step after wave 2 — the wave that creates them.
// `catalog-eval-columns.ts` reads whether a statement can still be READ once the migration lands;
// these two ask whether a row can still be WRITTEN (I-21) and whether a release identity is ever
// rewritten (I-22). The first is still in `notRegistered` in `suites.ts` until wave 6.
check("no insert under the write trees names a catalog table or column the phase retires",
      runsCheck("skill-row-shape.ts"));
check("a released plugin_version is written once, and no statement updates it",
      runsCheck("plugin-version-immutable.ts"));
// Wave 4's pair, registered by the integration step after wave 4 — the wave that creates them.
// I-24 split a failure mode into an identity and a sighting; I-25 made a scored run terminal and
// moved per-dimension results into their own table.
check("a failure mode is an identity and a discovery of it is a sighting: identified by (plugin_id, stable_key), carrying its own prevalence, owner and evidence, and always resolving to a mode",
      runsCheck("failure-mode-identity.ts"));
check("a scored run is terminal, and every result row names who produced it",
      runsCheck("scored-run-terminal.ts"));
// Wave 5's check, registered by the integration step after wave 5 — the wave that writes it. I-26
// gave an assessment its typed subject and put the idempotency ledger back on the column the
// migration left it, which is what made this check runnable at all.
check("an assessment names what it judged by kind and by exactly one child key, and the ledger keys on the principal's id",
      runsCheck("typed-subject.ts"));
// Wave 6's pair, registered by the integration step after wave 6 — the wave that writes the second
// of them. I-20's `catalog-eval-columns.ts` is the phase's OWN acceptance check: it could not pass
// before wave 6, which is why it sat in `suites.ts`'s not-registered list from wave 1 until now,
// and the entry is struck in the same pass. I-27's `eval-family-readers.ts` is the last reader
// sweep — it reads the same statements against the target and then PLANS them against a throwaway
// database migrated from this tree, counting the ones it cannot read rather than passing them.
check("no statement under the write trees names a catalog table or column the phase-3 migration retires",
      runsCheck("catalog-eval-columns.ts"));
check("every evaluation reader names a table and column the phase-3 migration leaves standing, and one it cannot read is counted rather than passed",
      runsCheck("eval-family-readers.ts"));
// Phase 4's checks, registered by the integration step after the wave that writes each — the same
// two-step Phase 1 used for the pat-label check, Phase 2 for `dropped-columns.ts` and Phase 3 for the
// five above. `improve-control-shape.ts` is I-28's, the wave-1 migration's own acceptance check: it
// reads the target's declared `uniques` and `foreignKeys` for the keys group G names, rather than
// matching a migration's text, because this check is frozen before that migration is written.
check("the improve and control tables hold group G's shape, and the keys it names are the target's own",
      runsCheck("improve-control-shape.ts"));
// Wave 2's three, registered by the integration step after wave 2 — the wave that writes them.
// I-29 versions the ids `control_evidence` is keyed by, which is what makes a second approval
// after a revision a fact of its own; I-30 moves the improve/promote ledgers' relations out of
// jsonb and into tables; I-31 leaves `eval_finding` one lifecycle, a strength terminal at insert.
check("a fact of a governed run is identified inside its run, and a revision withdraws exactly the approval it replaced",
      runsCheck("control-evidence-identity.ts"));
check("the improve and promote ledgers' relations are tables, and no file names a column the reshape retires",
      runsCheck("release-relations.ts"));
check("eval_finding holds one lifecycle, and a strength carries no decision",
      runsCheck("finding-one-lifecycle.ts"));
// Phase 5's four, registered by the integration step after the wave that writes each.
// `artifact-layer-removed.ts` is I-33's: the target declares none of the artifact/search
// tables, `knowledge_node` is the spec's fifteen columns, and the two trigram indexes are
// declared on it and on `doc`.
check("the artifact and search tables are gone, knowledge_node is the spec's shape, and Chinese retrieval has its index",
      runsCheck("artifact-layer-removed.ts"));
// `knowledge-node-ids.ts` is I-34's: no statement names the retired text relations, and each
// of `team_id`, `node_ordinal`, `slug` and `superseded_by_id` has a writer.
check("knowledge_node's writers and readers answer from the ids, and the evidence relation is written and read",
      runsCheck("knowledge-node-ids.ts"));

check("the resolvers are applied wherever a stored name is read", runsCheck("alias-applied.ts"));

check("a column nothing reads is not proof a column nothing needs", runsCheck("tool-key-read.ts"));

check("an insert names as many values as it names columns",
      runsCheck("insert-arity.ts"));

check("a query binds as many parameters as its statement names",
      runsCheck("query-arity.ts"));

check("one live token per purpose, on every writer of a platform access token",
      runsCheck("pat-one-live-per-label.ts"));

check("an authorization code is stored as its hash and spent exactly once",
      runsCheck("oauth-code-consumed.ts"));

check("the definition this platform is built on holds in its source",
      runsCheck("definition-rules.ts"));

check("the record's own columns exist, and a gap is nullable", runsCheck("record-and-cost-columns.ts"));

check("every tool call says which plugin it was made for", runsCheck("attribution.ts"));

check("what a call cost is a column, and detail keeps no second copy",
      runsCheck("telemetry-columns.ts"));

check("the chain check runs where a deployment exists, and not in this gate",
      runsCheck("chain-check-wiring.ts"));

check("every completion the judge asks for is recorded, and an unreported figure stays null",
      runsCheck("judge-usage.ts"));
