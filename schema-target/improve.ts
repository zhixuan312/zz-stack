/**
 * What an evaluation concluded, and the improve and promote loop that acts on it.
 */
import type { TableTarget } from "../scripts/schema/types.ts";

export const IMPROVE: Record<string, TableTarget> = {
  eval_finding: {
    columns: [
      [
        "id",
        "uuid",
        false,
        "gen_random_uuid()",
      ],
      [
        "pattern",
        "text",
        false,
        null,
      ],
      [
        "decision",
        "text",
        true,
        null,
      ],
      [
        "created_at",
        "timestamp with time zone",
        false,
        "now()",
      ],
      [
        "decided_at",
        "timestamp with time zone",
        true,
        null,
      ],
      [
        "decision_note",
        "text",
        false,
        "''::text",
      ],
      [
        "owner_kind",
        "text",
        false,
        null,
      ],
      [
        "owner_ref",
        "text",
        true,
        null,
      ],
      [
        "measure_id",
        "uuid",
        true,
        null,
      ],
      [
        "evidence_refs",
        "jsonb",
        false,
        "'[]'::jsonb",
      ],
      [
        "expected_effect",
        "jsonb",
        true,
        null,
      ],
      [
        "eval_run_id",
        "uuid",
        false,
        null,
      ],
      [
        "kind",
        "text",
        false,
        null,
      ],
      [
        "superseded_by",
        "uuid",
        true,
        null,
      ],
      [
        "decided_by",
        "uuid",
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
        "id",
      ],
    ],
    foreignKeys: [
      {
        columns: [
          "decided_by",
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
          "eval_run_id",
          "superseded_by",
        ],
        refTable: "eval_finding",
        refColumns: [
          "eval_run_id",
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
    ],
    checks: [
      "CHECK ((decision = ANY (ARRAY['applied'::text, 'rejected'::text, 'deferred'::text])))",
      "CHECK ((kind = ANY (ARRAY['strength'::text, 'defect'::text, 'unknown'::text])))",
      "CHECK (((kind = 'strength'::text) = (decision IS NULL)))",
      "CHECK ((owner_kind = ANY (ARRAY['plugin'::text, 'dependency'::text, 'platform'::text, 'environment'::text, 'user_input'::text, 'unknown'::text])))",
      "CHECK (((owner_kind <> 'plugin'::text) OR (owner_ref IS NULL)))",
      "CHECK (((eval_run_id IS NULL) OR (kind IS NOT NULL)))",
      "CHECK (((superseded_by IS NULL) OR (decision = 'rejected'::text)))",
    ],
    indexes: [
      "CREATE INDEX eval_finding_eval_run_id_idx ON zz.eval_finding USING btree (eval_run_id)",
    ],
    comment: "class=state_machine; authority=this; question=what conclusion did one evaluation run reach about a plugin, whose problem it names, and whether that owner has since applied or rejected the fix?; transitions=deferred->applied,deferred->rejected",
    columnComments: {
      id: "class=state_machine; authority=this; question=what is this finding's stable identity, the row a correction and every decision hang from?",
      pattern: "class=state_machine; authority=this; question=what did the run find, in the one sentence findings.md and the proposal document print?",
      decision: "class=state_machine; authority=this; question=has the owner applied or rejected it — deferred while it is open, and null for a strength, which is not open work?",
      created_at: "class=state_machine; authority=this; question=when was it recorded, the order the documents print it in?",
      decided_at: "class=state_machine; authority=this; question=when was it applied or rejected?",
      decision_note: "class=state_machine; authority=this; question=why was it applied or rejected — for the 21 applied rows this prose is the only record of which release carried the fix, and it is empty while deferred, since the open state needs no reason and the two closed ones do?",
      owner_kind: "class=state_machine; authority=this; question=whose problem is it — the plugin's, a dependency's, the platform's, the environment's, the user's input, or unknown?",
      owner_ref: "class=state_machine; authority=this; question=which owner exactly, free prose for a platform, dependency or environment owner and always null when owner_kind is plugin, whose plugin is already reached through the run?",
      measure_id: "class=relation; authority=this; question=which measure of the run's protocol does it evidence, null when it evidences no single measure?",
      evidence_refs: "class=state_machine; authority=this; question=which typed references — an observation snapshot, an assessment, a document path — ground its claim, an open list by design?",
      expected_effect: "class=state_machine; authority=this; question=what movement does the fix it asks for expect, null wherever the finding is not a plugin-owned defect?",
      eval_run_id: "class=relation; authority=this; question=which evaluation run concluded it, the parent every current reader filters by, finding_record writing one on every finding since the legacy round column it shared this table with went with the round tables?",
      kind: "class=state_machine; authority=this; question=is it a strength, a defect or an unknown, the fact that decides whether it is open work at all, a strength being terminal at insert with a null decision?",
      superseded_by: "class=state_machine; authority=this; question=which later finding of the same run corrected it, null for a current one, a superseded finding also being decision=rejected so it stays closed for every reader?",
      decided_by: "class=state_machine; authority=this; question=which principal applied or rejected it?",
    },
  },
  improvement_run: {
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
        "created_at",
        "timestamp with time zone",
        false,
        null,
      ],
    ],
    primaryKey: [
      "id",
    ],
    uniques: [],
    foreignKeys: [
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
    ],
    checks: [],
    indexes: [
      "CREATE INDEX improvement_run_eval_run_id_created_at_idx ON zz.improvement_run USING btree (eval_run_id, created_at DESC)",
    ],
    comment: "class=immutable_history; authority=this; question=which evaluation run's plugin-owned findings were chosen as one improvement attempt's target?",
    columnComments: {
      id: "class=immutable_history; authority=this; question=what is this attempt's stable identity, the row its candidates hang from?",
      eval_run_id: "class=relation; authority=this; question=which evaluation run's findings seeded it, the run initiative_run resolves the initiative's newest attempt from?",
      created_at: "class=immutable_history; authority=this; question=when was it opened, the order the initiative's newest improvement run is taken in?",
    },
  },
  improvement_run_finding: {
    columns: [
      [
        "improvement_run_id",
        "uuid",
        false,
        null,
      ],
      [
        "finding_id",
        "uuid",
        false,
        null,
      ],
    ],
    primaryKey: [
      "improvement_run_id",
      "finding_id",
    ],
    uniques: [],
    foreignKeys: [
      {
        columns: [
          "finding_id",
        ],
        refTable: "eval_finding",
        refColumns: [
          "id",
        ],
        onDelete: "NO ACTION",
        deferrable: false,
      },
      {
        columns: [
          "improvement_run_id",
        ],
        refTable: "improvement_run",
        refColumns: [
          "id",
        ],
        onDelete: "CASCADE",
        deferrable: false,
      },
    ],
    checks: [],
    indexes: [],
    comment: "class=relation; authority=this; question=which findings did one improvement attempt take as its target, the join that makes finding-to-change provenance real rather than prose?",
    columnComments: {
      improvement_run_id: "class=relation; authority=this; question=which improvement attempt targeted this finding?",
      finding_id: "class=relation; authority=this; question=which finding did that attempt take as its target, always a plugin-owned one of the attempt's own evaluation run?",
    },
  },
  candidate: {
    columns: [
      [
        "id",
        "uuid",
        false,
        "gen_random_uuid()",
      ],
      [
        "improvement_run_id",
        "uuid",
        false,
        null,
      ],
      [
        "base_plugin_version_id",
        "uuid",
        false,
        null,
      ],
      [
        "hypothesis",
        "text",
        false,
        null,
      ],
      [
        "expected_effect",
        "jsonb",
        false,
        null,
      ],
      [
        "patch_digest",
        "text",
        false,
        null,
      ],
      [
        "complexity_delta",
        "integer",
        false,
        null,
      ],
      [
        "touched_components",
        "jsonb",
        false,
        null,
      ],
      [
        "status",
        "text",
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
        "build_requested_at",
        "timestamp with time zone",
        true,
        null,
      ],
      [
        "build_requested_by",
        "text",
        true,
        null,
      ],
      [
        "build_result",
        "jsonb",
        true,
        null,
      ],
      [
        "build_recorded_at",
        "timestamp with time zone",
        true,
        null,
      ],
      [
        "patch",
        "text",
        false,
        null,
      ],
      [
        "proposed_by",
        "uuid",
        false,
        null,
      ],
      [
        "proposer_client",
        "text",
        true,
        null,
      ],
    ],
    primaryKey: [
      "id",
    ],
    uniques: [],
    foreignKeys: [
      {
        columns: [
          "base_plugin_version_id",
        ],
        refTable: "plugin_version",
        refColumns: [
          "id",
        ],
        onDelete: "NO ACTION",
        deferrable: false,
      },
      {
        columns: [
          "improvement_run_id",
        ],
        refTable: "improvement_run",
        refColumns: [
          "id",
        ],
        onDelete: "NO ACTION",
        deferrable: false,
      },
      {
        columns: [
          "proposed_by",
        ],
        refTable: "principal",
        refColumns: [
          "id",
        ],
        onDelete: "NO ACTION",
        deferrable: false,
      },
    ],
    checks: [
      "CHECK ((status = ANY (ARRAY['recorded'::text, 'awaiting_build'::text, 'valid'::text, 'invalid'::text])))",
    ],
    indexes: [],
    comment: "class=state_machine; authority=this; question=which patch was proposed against which exact base plugin version, with what hypothesis and expected effect, and what did its local build and gate say?; transitions=recorded->awaiting_build,awaiting_build->valid,awaiting_build->invalid",
    columnComments: {
      id: "class=state_machine; authority=this; question=what is this candidate's stable identity, the row its release attempts bind to?",
      improvement_run_id: "class=relation; authority=this; question=which improvement attempt proposed it?",
      base_plugin_version_id: "class=relation; authority=this; question=which exact released plugin version it patches, the baseline it is built and gated against?",
      hypothesis: "class=state_machine; authority=this; question=what idea does this patch embody, the text whose normalised digest stops a hypothesis already rejected or rolled back from being proposed again?",
      expected_effect: "class=state_machine; authority=this; question=what is this patch predicted to move, the field FR-36 requires to be recorded with it?",
      patch_digest: "class=state_machine; authority=this; question=what is the sha256 of that diff, the immutable pin an approval and a build both bind to?",
      complexity_delta: "class=state_machine; authority=this; question=how much complexity does it add to or remove from its base, the axis a candidate is judged on?",
      touched_components: "class=state_machine; authority=this; question=which of the base version's components it touches, a snapshot derived against that version's manifest when the candidate was recorded and needed for display?",
      status: "class=state_machine; authority=this; question=where does it stand in its build lifecycle — recorded, awaiting a build, or judged valid or invalid — given that the attempt's own states, released and rolled_back, live on release_attempt and a reader joins that row rather than reading a copy here?",
      created_at: "class=state_machine; authority=this; question=when was it recorded, the moment FR-36 required before anything about the patch could execute?",
      build_requested_at: "class=state_machine; authority=this; question=when did the build lease begin, null until candidate_validate requested a build and cleared again when an expired lease returns the candidate to recorded?",
      build_requested_by: "class=state_machine; authority=this; question=which principal may record its build, the authorization the build rules read, set with the lease and null when no lease stands?",
      build_result: "class=state_machine; authority=this; question=what did npm run candidate-build record through candidate_build_record — {ok, stage, log_tail, commands, patch_digest} — kept once candidate_validate consumes it so improvement.md and the console can say how the released patch was built and gated, null before a build lands?",
      build_recorded_at: "class=state_machine; authority=this; question=when did the build land, the timestamp the candidate's own build rules read back?",
      patch: "class=state_machine; authority=this; question=what is the unified diff of it, the exact bytes the digest pins and a release applies?",
      proposed_by: "class=state_machine; authority=this; question=which principal proposed it?",
      proposer_client: "class=state_machine; authority=this; question=which client proposed it, null where the proposer's identity was not recorded?",
    },
  },
  release_attempt: {
    columns: [
      [
        "id",
        "uuid",
        false,
        "gen_random_uuid()",
      ],
      [
        "candidate_id",
        "uuid",
        false,
        null,
      ],
      [
        "status",
        "text",
        false,
        null,
      ],
      [
        "released_plugin_version_id",
        "uuid",
        true,
        null,
      ],
      [
        "release_ref",
        "text",
        true,
        null,
      ],
      [
        "verification",
        "jsonb",
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
        "reason",
        "text",
        true,
        null,
      ],
      [
        "plugin_id",
        "uuid",
        false,
        null,
      ],
      [
        "applying_at",
        "timestamp with time zone",
        true,
        null,
      ],
      [
        "verdict",
        "text",
        true,
        null,
      ],
      [
        "verified_at",
        "timestamp with time zone",
        true,
        null,
      ],
      [
        "applied_by",
        "uuid",
        true,
        null,
      ],
    ],
    primaryKey: [
      "id",
    ],
    uniques: [],
    foreignKeys: [
      {
        columns: [
          "applied_by",
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
          "candidate_id",
        ],
        refTable: "candidate",
        refColumns: [
          "id",
        ],
        onDelete: "NO ACTION",
        deferrable: false,
      },
      {
        columns: [
          "plugin_id",
        ],
        refTable: "plugin",
        refColumns: [
          "id",
        ],
        onDelete: "NO ACTION",
        deferrable: false,
      },
      {
        columns: [
          "released_plugin_version_id",
        ],
        refTable: "plugin_version",
        refColumns: [
          "id",
        ],
        onDelete: "NO ACTION",
        deferrable: false,
      },
    ],
    checks: [
      "CHECK (((release_ref IS NULL) OR (release_ref ~ '^[0-9a-f]{40}$'::text)))",
      "CHECK (((status = ANY (ARRAY['released'::text, 'rolled_back'::text])) = (released_plugin_version_id IS NOT NULL)))",
      "CHECK ((status = ANY (ARRAY['prepared'::text, 'applying'::text, 'released'::text, 'refused'::text, 'failed'::text, 'rolled_back'::text])))",
      "CHECK ((verdict = ANY (ARRAY['established'::text, 'rolled_back'::text, 'not_established'::text])))",
    ],
    indexes: [
      "CREATE UNIQUE INDEX release_attempt_applying_plugin_idx ON zz.release_attempt USING btree (plugin_id) WHERE (status = 'applying'::text)",
      "CREATE UNIQUE INDEX release_attempt_live_candidate_idx ON zz.release_attempt USING btree (candidate_id) WHERE (status = ANY (ARRAY['applying'::text, 'released'::text]))",
    ],
    comment: "class=state_machine; authority=this; question=what became of one attempt to promote one candidate — applied, refused, failed or rolled back — and did real use after the release establish it?; transitions=prepared->applying,applying->released,applying->failed,prepared->refused,released->rolled_back",
    columnComments: {
      id: "class=state_machine; authority=this; question=what is this attempt's stable identity, the row its required owners, audit and verdict hang from?",
      candidate_id: "class=relation; authority=this; question=which candidate it releases, the parent the console's newest-attempt query orders by?",
      status: "class=state_machine; authority=this; question=where does it stand — prepared, applying, released, refused, failed or rolled back — the field every reader of the promotion boundary gates on?",
      released_plugin_version_id: "class=relation; authority=this; question=which released plugin version it published, never null exactly when the status is released or rolled_back?",
      release_ref: "class=state_machine; authority=this; question=which 40-hex commit the release tag names, null until a release lands?",
      verification: "class=state_machine; authority=this; question=what evidence does the verdict rest on — {post_release_runs, released_eval_run_id, released_overall, base_eval_run_id, base_overall, delta, regression_band, guardrail_status} — null until the released subject has enough real runs and an evaluation to judge, the verdict itself being the verdict column and when it landed being verified_at?",
      created_at: "class=state_machine; authority=this; question=when was it prepared, the order the console prints attempts in?",
      reason: "class=state_machine; authority=this; question=why did this attempt end as it did — releaseDecision's own reason on a refusal, the failing command's output tail (release_record) on a failure, the operator's reason on a rollback, or the accepted override (--reconcile --accept-tag-without-candidate-commit) on a reconciled release — null for prepared and applying, and for a release proved without an override?",
      plugin_id: "class=relation; authority=this; question=which plugin this attempt releases — the base subject's own plugin, written by release_prepare — the column keying the index that allows at most one applying attempt per plugin?",
      applying_at: "class=state_machine; authority=this; question=when did release_apply move it to applying, an attempt still applying long after the CLI's own gate and release timeouts being stale and named by release_apply for reconciliation?",
      verdict: "class=state_machine; authority=this; question=what did the post-release check decide — established, rolled_back or not_established — null until real use of the released version has been judged?",
      verified_at: "class=state_machine; authority=this; question=when was that verdict recorded?",
      applied_by: "class=state_machine; authority=this; question=which principal's release_apply moved it to applying, since release_record and release_verify accept that principal or a member of a required owner team and nobody else?",
    },
  },
  release_attempt_owner: {
    columns: [
      [
        "release_attempt_id",
        "uuid",
        false,
        null,
      ],
      [
        "team_id",
        "uuid",
        false,
        null,
      ],
    ],
    primaryKey: [
      "release_attempt_id",
      "team_id",
    ],
    uniques: [],
    foreignKeys: [
      {
        columns: [
          "release_attempt_id",
        ],
        refTable: "release_attempt",
        refColumns: [
          "id",
        ],
        onDelete: "CASCADE",
        deferrable: false,
      },
      {
        columns: [
          "team_id",
        ],
        refTable: "team",
        refColumns: [
          "id",
        ],
        onDelete: "NO ACTION",
        deferrable: false,
      },
    ],
    checks: [],
    indexes: [],
    comment: "class=relation; authority=this; question=which teams' members must approve and apply a release attempt before it may cross the promotion boundary?",
    columnComments: {
      release_attempt_id: "class=relation; authority=this; question=which release attempt does this required-owner row gate?",
      team_id: "class=relation; authority=this; question=which team's members may approve that attempt, resolved live from the base subject's own release owners when it was prepared?",
    },
  },
};
