/**
 * The legacy evaluation rounds, archived and dropped.
 *
 * `rubric`, `rubric_dimension`, `eval`, `eval_subject`, `eval_score`,
 * `eval_protocol`, `eval_evaluator`, `eval_evidence_snapshot` and `eval_subject_version` were
 * superseded by the plugin-eval family, and `002_catalog_evaluation.sql` archives every row of
 * them into a large object (so it travels in the deployment's own `pg_dump` backup, never to a
 * team shelf — the archived quotes carry quan's and xuan's text) and then drops the tables. The
 * file stays because the area it names stays: what it holds is now nothing, and an empty export
 * is how the target says so.
 */
import type { TableTarget } from "../scripts/schema/types.ts";

export const EVAL_LEGACY: Record<string, TableTarget> = {};
