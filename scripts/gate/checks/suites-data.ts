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
check("every tool the spec renamed resolves through one frozen map", runsCheck("alias-maps.ts"));

check("the resolvers are applied wherever a stored name is read", runsCheck("alias-applied.ts"));

check("a column nothing reads is not proof a column nothing needs", runsCheck("tool-key-read.ts"));

check("an insert names as many values as it names columns",
      runsCheck("insert-arity.ts"));

check("a query binds as many parameters as its statement names",
      runsCheck("query-arity.ts"));

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
