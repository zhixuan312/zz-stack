/**
 * Plugin evaluation: what was scored — runs, their per-dimension results, their assessments and
 * the retry ledger.
 */
import type { TableTarget } from "../scripts/schema/types.ts";

export const EVAL_RUN: Record<string, TableTarget> = {
  eval_run: {
    columns: [
      [
        "id",
        "uuid",
        false,
        "gen_random_uuid()",
      ],
      [
        "protocol_version_id",
        "uuid",
        false,
        null,
      ],
      [
        "score_status",
        "text",
        true,
        null,
      ],
      [
        "overall_score",
        "numeric",
        true,
        null,
      ],
      [
        "guardrail_status",
        "text",
        true,
        null,
      ],
      [
        "created_at",
        "timestamp with time zone",
        false,
        null,
      ],
      [
        "team_id",
        "uuid",
        false,
        null,
      ],
      [
        "initiative_id",
        "uuid",
        true,
        null,
      ],
      [
        "observation_snapshot_id",
        "uuid",
        false,
        null,
      ],
      [
        "score_lower",
        "numeric",
        true,
        null,
      ],
      [
        "score_upper",
        "numeric",
        true,
        null,
      ],
      [
        "measure_coverage",
        "numeric",
        true,
        null,
      ],
      [
        "establishment_blocked_by",
        "text[]",
        true,
        null,
      ],
      [
        "scorer_version",
        "text",
        true,
        null,
      ],
      [
        "started_by",
        "uuid",
        false,
        null,
      ],
      [
        "scored_at",
        "timestamp with time zone",
        true,
        null,
      ],
    ],
    primaryKey: [
      "id",
    ],
    uniques: [
      [
        "id",
        "protocol_version_id",
      ],
    ],
    foreignKeys: [
      {
        columns: [
          "observation_snapshot_id",
        ],
        refTable: "eval_observation_snapshot",
        refColumns: [
          "id",
        ],
        onDelete: "NO ACTION",
        deferrable: false,
      },
      {
        columns: [
          "protocol_version_id",
        ],
        refTable: "eval_protocol_version",
        refColumns: [
          "id",
        ],
        onDelete: "NO ACTION",
        deferrable: false,
      },
      {
        columns: [
          "started_by",
        ],
        refTable: "principal",
        refColumns: [
          "id",
        ],
        onDelete: "NO ACTION",
        deferrable: false,
      },
      {
        columns: [
          "team_id",
          "initiative_id",
        ],
        refTable: "initiative",
        refColumns: [
          "team_id",
          "id",
        ],
        onDelete: "NO ACTION",
        deferrable: false,
      },
    ],
    // The lifecycle is `created -> scored`, and `scored_at` is the terminal marker: the run
    // carries a score status exactly when it has one, and a scored run refuses every later
    // re-scoring or result rewrite. `evidence_snapshot_id` was a second name for the observation
    // snapshot, `subject_version_id` was the release the snapshot already names, `run_status`,
    // `score_interval`, `guardrails` and `coverage` became columns or rows, and
    // `dimension_scores` became `eval_run_dimension`.
    checks: [
      "CHECK ((guardrail_status = ANY (ARRAY['pass'::text, 'fail'::text, 'not_established'::text])))",
      "CHECK (((overall_score >= (0)::numeric) AND (overall_score <= (10)::numeric)))",
      "CHECK ((score_status = ANY (ARRAY['established'::text, 'provisional'::text, 'not_established'::text])))",
      "CHECK (((scored_at IS NULL) = (score_status IS NULL)))",
    ],
    indexes: [
      "CREATE INDEX eval_run_protocol_version_id_created_at_idx ON zz.eval_run USING btree (protocol_version_id, created_at DESC)",
    ],
    comment: "class=state_machine; authority=this; question=which evaluation bound one protocol version to one observation snapshot, and what score, status, guardrail verdict and uncertainty did it publish?; transitions=created->scored",
    columnComments: {
      id: "class=state_machine; authority=this; question=what is this evaluation run's stable identity, the handle its assessments, findings, improvements and release verdicts hang off?",
      protocol_version_id: "class=relation; authority=this; question=which protocol version, with its dimensions and measures, did this run score against?",
      score_status: "class=state_machine; authority=this; question=is this run's published score established, provisional or not_established, and null only while the run has not been scored?",
      overall_score: "class=state_machine; authority=this; question=what score between 0 and 10 did this run publish?",
      guardrail_status: "class=state_machine; authority=this; question=did this run's critical guardrails pass or fail, or come back not_established?",
      created_at: "class=state_machine; authority=this; question=when was this run started?",
      team_id: "class=relation; authority=this; question=which team ran this evaluation, whose artifact store its document subjects were resolved against and which the named initiative must belong to?",
      initiative_id: "class=relation; authority=this; question=which initiative ran this evaluation, when it was started from one?",
      observation_snapshot_id: "class=relation; authority=this; question=which observation snapshot of real production use was this run scored against?",
      score_lower: "class=state_machine; authority=this; question=what is the lower bound of this run's published uncertainty interval?",
      score_upper: "class=state_machine; authority=this; question=what is the upper bound of this run's published uncertainty interval?",
      measure_coverage: "class=state_machine; authority=this; question=what share of the protocol's declared measure weight this run actually scored?",
      establishment_blocked_by: "class=state_machine; authority=this; question=which reasons stopped this run's score from being established, each named by the policy that failed?",
      scorer_version: "class=state_machine; authority=this; question=which platform version's scoring code produced this published result, so a recompute under newer code cannot silently move the comparison a rollback turns on?",
      started_by: "class=state_machine; authority=this; question=which principal started this run?",
      scored_at: "class=state_machine; authority=this; question=when was this run's result published, the terminal marker that closes it against every later re-scoring?",
    },
  },
  eval_run_dimension: {
    columns: [
      [
        "eval_run_id",
        "uuid",
        false,
        null,
      ],
      [
        "protocol_version_id",
        "uuid",
        false,
        null,
      ],
      [
        "dimension_id",
        "uuid",
        false,
        null,
      ],
      [
        "score",
        "numeric",
        true,
        null,
      ],
      [
        "coverage",
        "numeric",
        true,
        null,
      ],
    ],
    primaryKey: [
      "eval_run_id",
      "dimension_id",
    ],
    uniques: [],
    foreignKeys: [
      {
        columns: [
          "dimension_id",
          "protocol_version_id",
        ],
        refTable: "eval_dimension",
        refColumns: [
          "id",
          "protocol_version_id",
        ],
        onDelete: "NO ACTION",
        deferrable: false,
      },
      {
        columns: [
          "eval_run_id",
          "protocol_version_id",
        ],
        refTable: "eval_run",
        refColumns: [
          "id",
          "protocol_version_id",
        ],
        onDelete: "NO ACTION",
        deferrable: false,
      },
    ],
    // A run's published per-dimension result, inserted exactly once when the run is scored and
    // never updated: the score a reader sees is the score the run published. `score` and
    // `coverage` are nullable — a dimension that was not applicable and a coverage that was not
    // measured have always been recorded as absent, never as zero.
    checks: [
      "CHECK (((coverage >= (0)::numeric) AND (coverage <= (1)::numeric)))",
      "CHECK (((score >= (0)::numeric) AND (score <= (10)::numeric)))",
    ],
    indexes: [],
    comment: "class=immutable_history; authority=this; question=what score and coverage did one scored run publish for one dimension of its protocol?",
    columnComments: {
      eval_run_id: "class=relation; authority=this; question=which scored run published this per-dimension result?",
      protocol_version_id: "class=relation; authority=this; question=which protocol version do both the run and the dimension this row joins belong to, the shared key that keeps them from disagreeing?",
      dimension_id: "class=relation; authority=this; question=which declared dimension of that protocol version does this score belong to?",
      score: "class=immutable_history; authority=this; question=what score between 0 and 10 did the run publish for this dimension, null when the dimension did not apply?",
      coverage: "class=immutable_history; authority=this; question=what share of this dimension's declared measure weight was scored, null when it was not measured?",
    },
  },
  eval_assessment: {
    columns: [
      [
        "id",
        "uuid",
        false,
        "gen_random_uuid()",
      ],
      [
        "eval_run_id",
        "uuid",
        false,
        null,
      ],
      [
        "measure_id",
        "uuid",
        false,
        null,
      ],
      [
        "assessment_id",
        "bigint",
        true,
        null,
      ],
      [
        "qualification_id",
        "uuid",
        true,
        null,
      ],
      [
        "created_at",
        "timestamp with time zone",
        false,
        null,
      ],
      [
        "subject_kind",
        "text",
        false,
        null,
      ],
      [
        "run_id",
        "uuid",
        true,
        null,
      ],
      [
        "doc_id",
        "uuid",
        true,
        null,
      ],
      [
        "doc_revision",
        "integer",
        true,
        null,
      ],
      [
        "knowledge_node_id",
        "uuid",
        true,
        null,
      ],
      [
        "bug_id",
        "uuid",
        true,
        null,
      ],
      [
        "event_id",
        "bigint",
        true,
        null,
      ],
      [
        "value",
        "numeric",
        true,
        null,
      ],
      [
        "raw_value",
        "jsonb",
        true,
        null,
      ],
      [
        "numerator",
        "integer",
        true,
        null,
      ],
      [
        "denominator",
        "integer",
        true,
        null,
      ],
      [
        "excluded_reason",
        "text",
        true,
        null,
      ],
    ],
    primaryKey: [
      "id",
    ],
    uniques: [
      [
        "eval_run_id",
        "measure_id",
        "subject_kind",
        "run_id",
        "doc_id",
        "doc_revision",
        "knowledge_node_id",
        "bug_id",
        "event_id",
      ],
    ],
    foreignKeys: [
      {
        columns: [
          "assessment_id",
        ],
        refTable: "assessment",
        refColumns: [
          "id",
        ],
        onDelete: "NO ACTION",
        deferrable: false,
      },
      {
        columns: [
          "bug_id",
        ],
        refTable: "bug",
        refColumns: [
          "id",
        ],
        onDelete: "NO ACTION",
        deferrable: false,
      },
      {
        columns: [
          "doc_id",
        ],
        refTable: "doc",
        refColumns: [
          "id",
        ],
        onDelete: "NO ACTION",
        deferrable: false,
      },
      {
        // The composite key is what makes a document subject's pin mean something: a row naming
        // document X and revision N is held to a revision OF X. MATCH SIMPLE, so a `run_level`
        // row — which names no child subject at all — is admitted.
        columns: [
          "doc_id",
          "doc_revision",
        ],
        refTable: "doc_revision",
        refColumns: [
          "doc_id",
          "revision",
        ],
        onDelete: "NO ACTION",
        deferrable: false,
      },
      {
        columns: [
          "eval_run_id",
        ],
        refTable: "eval_run",
        refColumns: [
          "id",
        ],
        onDelete: "NO ACTION",
        deferrable: false,
      },
      {
        columns: [
          "event_id",
        ],
        refTable: "event",
        refColumns: [
          "id",
        ],
        onDelete: "NO ACTION",
        deferrable: false,
      },
      {
        columns: [
          "knowledge_node_id",
        ],
        refTable: "knowledge_node",
        refColumns: [
          "id",
        ],
        onDelete: "NO ACTION",
        deferrable: false,
      },
      {
        columns: [
          "measure_id",
        ],
        refTable: "eval_measure",
        refColumns: [
          "id",
        ],
        onDelete: "NO ACTION",
        deferrable: false,
      },
      {
        columns: [
          "qualification_id",
        ],
        refTable: "eval_evaluator_qualification",
        refColumns: [
          "id",
        ],
        onDelete: "NO ACTION",
        deferrable: false,
      },
      {
        columns: [
          "run_id",
        ],
        refTable: "skill_run",
        refColumns: [
          "id",
        ],
        onDelete: "NO ACTION",
        deferrable: false,
      },
    ],
    // The typed subject. `subject_ref` was free text carrying six shapes; the kind and the one
    // child key it names replace it, and the kind-shape check is what makes the pair truthful:
    // `run_level` is about the parent run's own observation snapshot and names no child subject,
    // and each other kind names exactly one. `evaluator_version_id` is reachable through the
    // measure, `evidence_ref` named the run's own snapshot, and `answer` jsonb became the four
    // columns a reducer reads. `doc_revision` was pinned in phase 6, with `doc_revision` itself,
    // the first column is NOT VALID because 64 legacy document subjects predate it, and AC-6.7
    // leaves an unpinnable legacy row null rather than choosing the revision nearest its timestamp.
    // It is enforced on every insert and update after the migration, which is where it matters.
    checks: [
      // NOT VALID on purpose: 64 legacy document subjects predate the column, and AC-6.7 leaves
      // an unpinnable legacy row null rather than choosing the revision nearest its timestamp.
      // It is enforced on every later insert and update, which is where it matters. It sorts
      // FIRST because `compare.ts` orders this array by constraint name, and the check's own
      // generated name sorts before `subject_kind`'s — the catalog is the authority on the order.
      "CHECK (((subject_kind <> 'document'::text) OR (doc_revision IS NOT NULL))) NOT VALID",
      "CHECK ((((subject_kind = 'run_level'::text) AND (run_id IS NULL) AND (doc_id IS NULL) AND (knowledge_node_id IS NULL) AND (bug_id IS NULL) AND (event_id IS NULL)) OR ((subject_kind = 'run'::text) AND (run_id IS NOT NULL) AND (doc_id IS NULL) AND (knowledge_node_id IS NULL) AND (bug_id IS NULL) AND (event_id IS NULL)) OR ((subject_kind = 'document'::text) AND (run_id IS NULL) AND (doc_id IS NOT NULL) AND (knowledge_node_id IS NULL) AND (bug_id IS NULL) AND (event_id IS NULL)) OR ((subject_kind = 'knowledge'::text) AND (run_id IS NULL) AND (doc_id IS NULL) AND (knowledge_node_id IS NOT NULL) AND (bug_id IS NULL) AND (event_id IS NULL)) OR ((subject_kind = 'bug'::text) AND (run_id IS NULL) AND (doc_id IS NULL) AND (knowledge_node_id IS NULL) AND (bug_id IS NOT NULL) AND (event_id IS NULL)) OR ((subject_kind = 'event'::text) AND (run_id IS NULL) AND (doc_id IS NULL) AND (knowledge_node_id IS NULL) AND (bug_id IS NULL) AND (event_id IS NOT NULL))))",
      "CHECK (((value IS NULL) = (excluded_reason IS NOT NULL)))",
    ],
    indexes: [
      "CREATE INDEX eval_assessment_eval_run_id_idx ON zz.eval_assessment USING btree (eval_run_id)",
    ],
    comment: "class=immutable_history; authority=this; question=in one evaluation, what did one measure answer about one subject, or why was it excluded from the score?",
    columnComments: {
      id: "class=immutable_history; authority=this; question=what is this assessment row's own identity, the id a finding cites as its reading?",
      eval_run_id: "class=relation; authority=this; question=which evaluation's score reduced this answer?",
      measure_id: "class=relation; authority=this; question=which measure of the run's protocol version was answered here?",
      assessment_id: "class=relation; authority=this; question=which stored model answer in zz.assessment backed this measurement, null where the measure called no model?",
      qualification_id: "class=relation; authority=this; question=which evaluator qualification was in force when this answer was taken or skipped?",
      created_at: "class=immutable_history; authority=this; question=when was this answer recorded?",
      subject_kind: "class=immutable_history; authority=this; question=what kind of subject this answer is about — run_level, meaning the parent run's own observation snapshot and no child key at all, or run named by run_id, document by doc_id and doc_revision, knowledge by knowledge_node_id, bug by bug_id, or event by event_id?",
      run_id: "class=relation; authority=this; question=which skill run was judged, when the subject kind is run?",
      doc_id: "class=relation; authority=this; question=which document was judged, when the subject kind is document?",
      doc_revision: "class=immutable_history; authority=this; question=which revision of that document pins the exact bytes judged, left null only on a legacy document subject whose revision cannot be reconstructed?",
      knowledge_node_id: "class=relation; authority=this; question=which knowledge node was judged, when the subject kind is knowledge?",
      bug_id: "class=relation; authority=this; question=which bug report was judged, when the subject kind is bug?",
      event_id: "class=relation; authority=this; question=which recorded event was judged, when the subject kind is event?",
      value: "class=immutable_history; authority=this; question=what value the measure returned for this subject, null exactly when the answer was excluded?",
      raw_value: "class=immutable_history; authority=this; question=what the measure's own unreduced reading was, kept so a reader can see past the reduced value?",
      numerator: "class=immutable_history; authority=this; question=what numerator the measure counted, when its answer was a rate rather than a single reading?",
      denominator: "class=immutable_history; authority=this; question=what denominator that rate was counted over?",
      excluded_reason: "class=immutable_history; authority=this; question=why this measure was excluded from the score rather than answering, set exactly when value is null?",
    },
  },
  eval_idempotency: {
    columns: [
      [
        "tool",
        "text",
        false,
        null,
      ],
      [
        "idempotency_key",
        "text",
        false,
        null,
      ],
      [
        "request_digest",
        "text",
        false,
        null,
      ],
      [
        "result_table",
        "text",
        false,
        null,
      ],
      [
        "result_id",
        "uuid",
        false,
        null,
      ],
      [
        "created_at",
        "timestamp with time zone",
        false,
        null,
      ],
      [
        "principal_id",
        "uuid",
        false,
        null,
      ],
    ],
    primaryKey: [
      "principal_id",
      "tool",
      "idempotency_key",
    ],
    uniques: [],
    foreignKeys: [
      {
        columns: [
          "principal_id",
        ],
        refTable: "principal",
        refColumns: [
          "id",
        ],
        onDelete: "NO ACTION",
        deferrable: false,
      },
    ],
    // Ephemeral, swept after 30 days, and keyed to the principal that made the call rather than
    // to the address it was made from.
    checks: [],
    indexes: [],
    comment: "class=ephemeral; authority=this; question=has this caller already made this call with this key, and which row did the first one produce?; retention=declared 30 days: past that age an entry is replay-dead, and no production path deletes one yet",
    columnComments: {
      tool: "class=ephemeral; authority=this; question=which mutating tool call is this retry ledger entry for?",
      idempotency_key: "class=ephemeral; authority=this; question=what key did the caller give this attempt, unique within the tool for that principal?",
      request_digest: "class=ephemeral; authority=this; question=what digest of the canonical arguments this call was made with, so a same-key call with different arguments is refused?",
      result_table: "class=ephemeral; authority=this; question=which table the first write landed in, naming a parent table where the call produced no single result row?",
      result_id: "class=ephemeral; authority=this; question=which row the first write produced, a polymorphic pointer with no foreign key because it may name any result table?",
      created_at: "class=ephemeral; authority=this; question=when the first write was recorded, the instant the 30-day sweep measures from?",
      principal_id: "class=relation; authority=this; question=which principal made the call, the first component of the key rather than an address that can change?",
    },
  },
};
