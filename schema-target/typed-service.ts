/**
 * The model layer's own record: what the platform asked a model to do and what it cost, and what
 * the typed service answered to a bounded semantic question. `telemetry.ts` holds the other half
 * of group D — what the platform itself did.
 */
import type { TableTarget } from "../scripts/schema/types.ts";

export const TYPED_SERVICE: Record<string, TableTarget> = {
  model_call: {
    columns: [
      [
        "id",
        "bigint",
        false,
        null,
      ],
      [
        "ts",
        "timestamp with time zone",
        false,
        "now()",
      ],
      [
        "purpose",
        "text",
        false,
        null,
      ],
      [
        "model",
        "text",
        false,
        null,
      ],
      [
        "input_tokens",
        "integer",
        true,
        null,
      ],
      [
        "output_tokens",
        "integer",
        true,
        null,
      ],
      [
        "cache_read_tokens",
        "integer",
        true,
        null,
      ],
      [
        "duration_ms",
        "integer",
        true,
        null,
      ],
      [
        "ok",
        "boolean",
        false,
        null,
      ],
      [
        "attempts",
        "integer",
        false,
        "1",
      ],
      [
        "error",
        "text",
        true,
        null,
      ],
    ],
    primaryKey: [
      "id",
    ],
    uniques: [],
    foreignKeys: [],
    checks: [
      "CHECK (((error IS NULL) OR (NOT ok)))",
    ],
    indexes: [
      "CREATE INDEX model_call_failed_ts ON zz.model_call USING btree (ts DESC) WHERE (NOT ok)",
      "CREATE INDEX model_call_purpose_ts ON zz.model_call USING btree (purpose, ts)",
    ],
    comment: "class=immutable_history; authority=this; question=what one outbound model request the platform itself made cost and returned — which purpose, which model, how many tokens, how long, and whether it worked?; retention=kept indefinitely; it is the provenance an assessment names, and a row an evaluation cites is never purged",
    columnComments: {
      id: "class=immutable_history; authority=this; question=what this call's identity is, the one an assessment names as the call that produced its answer?",
      ts: "class=immutable_history; authority=this; question=when this call was made?",
      purpose: "class=immutable_history; authority=this; question=which caller path made this call — typed-judge, failure-discover, or the historic plugin-judge — from a small code-owned vocabulary?",
      model: "class=immutable_history; authority=this; question=which model was asked for, spelled <provider>/<model> so that one column carries one spelling?",
      input_tokens: "class=immutable_history; authority=this; question=how many input tokens the provider reported, null when it reported none?",
      output_tokens: "class=immutable_history; authority=this; question=how many output tokens the provider reported, null when it reported none?",
      cache_read_tokens: "class=immutable_history; authority=this; question=how many input tokens the provider served from cache, null when it reported no cache figure and 0 when it reported a cache of zero?",
      duration_ms: "class=immutable_history; authority=this; question=how long the call took, never null even when it failed?",
      ok: "class=immutable_history; authority=this; question=whether the call succeeded, never null even when the model never answered?",
      attempts: "class=immutable_history; authority=this; question=how many attempts the typed service needed inside one ask — a real retry loop that no row has exercised yet, so every row is 1, while the judge path deliberately makes one attempt?",
      error: "class=immutable_history; authority=this; question=why the call failed, set only when it did not succeed and kept for a transport failure that left no assessment behind, since a failure that produced an answer already carries its reason there?",
    },
  },
  assessment: {
    columns: [
      [
        "id",
        "bigint",
        false,
        null,
      ],
      [
        "family",
        "text",
        true,
        null,
      ],
      [
        "instruction_version",
        "integer",
        false,
        null,
      ],
      [
        "question_digest",
        "text",
        false,
        null,
      ],
      [
        "reading",
        "text",
        true,
        null,
      ],
      [
        "probability",
        "numeric",
        true,
        null,
      ],
      [
        "resolved_model",
        "text",
        true,
        null,
      ],
      [
        "identity_assurance",
        "text",
        true,
        null,
      ],
      [
        "reason",
        "text",
        true,
        null,
      ],
      [
        "about",
        "text",
        true,
        null,
      ],
      [
        "asked_at",
        "timestamp with time zone",
        false,
        "now()",
      ],
      [
        "evaluator_version_id",
        "uuid",
        true,
        null,
      ],
      [
        "distribution",
        "jsonb",
        true,
        null,
      ],
      [
        "answer_kind",
        "text",
        false,
        "'noul'::text",
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
        "model_call_id",
        "bigint",
        true,
        null,
      ],
      [
        "asked_by",
        "uuid",
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
          "asked_by",
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
          "evaluator_version_id",
        ],
        refTable: "eval_evaluator_version",
        refColumns: [
          "id",
        ],
        onDelete: "NO ACTION",
        deferrable: false,
      },
      {
        columns: [
          "model_call_id",
        ],
        refTable: "model_call",
        refColumns: [
          "id",
        ],
        onDelete: "NO ACTION",
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
        onDelete: "SET NULL",
        onDeleteColumns: [
          "initiative_id",
        ],
        deferrable: false,
      },
    ],
    checks: [
      "CHECK ((answer_kind = ANY (ARRAY['noul'::text, 'choice'::text, 'score'::text])))",
      "CHECK (((answer_kind <> ALL (ARRAY['choice'::text, 'score'::text])) OR (distribution IS NOT NULL) OR ((reading = 'unavailable'::text) AND (reason IS NOT NULL))))",
      "CHECK (((family IS NULL) OR ((reading IS NOT NULL) AND (answer_kind = 'noul'::text))))",
      "CHECK (((family IS NOT NULL) <> (evaluator_version_id IS NOT NULL)))",
      "CHECK ((reading = ANY (ARRAY['yes'::text, 'no'::text, 'unclear'::text, 'unavailable'::text])))",
      "CHECK (((reading = 'unavailable'::text) = (reason IS NOT NULL)))",
    ],
    indexes: [],
    comment: "class=immutable_history; authority=this; question=what the typed service answered to one bounded semantic question, and with what model provenance, for a platform question family or a plugin-eval evaluator version, a reading of unavailable carrying its reason?; retention=kept indefinitely as immutable provenance: no production path deletes a row, and the eval rows that cite it name it by id",
    columnComments: {
      id: "class=immutable_history; authority=this; question=what this answer's identity is, the one eval_assessment cites as its assessment_id?",
      family: "class=immutable_history; authority=this; question=which platform question family asked this question, from the nine names in @zz/contracts, set instead of an evaluator version so that exactly one of the two is non-null?",
      instruction_version: "class=immutable_history; authority=this; question=which version of the family instruction asked this question, or which version number of the evaluator asked it, never null?",
      question_digest: "class=immutable_history; authority=this; question=which exact question wording this answer belongs to, pinned by its digest?",
      reading: "class=immutable_history; authority=this; question=what the noul primitive read — yes, no, unclear or unavailable — required whenever a family asked the question?",
      probability: "class=immutable_history; authority=this; question=what probability the noul primitive put on yes?",
      resolved_model: "class=immutable_history; authority=this; question=which concrete model the supplier says answered, as distinct from the model that was asked for?",
      identity_assurance: "class=immutable_history; authority=this; question=how far the resolved model's identity is verified, from the contracts' assurance values?",
      reason: "class=immutable_history; authority=this; question=why there is no reading, set exactly when the reading is unavailable?",
      about: "class=immutable_history; authority=this; question=what was assessed, as the caller stated it — a document path such as spec.md#CS-1, a source ref or a finding id?",
      asked_at: "class=immutable_history; authority=this; question=when this question was asked, never null?",
      evaluator_version_id: "class=relation; authority=this; question=which plugin-eval evaluator version asked this question, set instead of family so that exactly one of the two is non-null?",
      distribution: "class=immutable_history; authority=this; question=what the full answer distribution over the evaluator's declared options is on a choice or score question, while probability keeps carrying the noul probability?",
      answer_kind: "class=immutable_history; authority=this; question=which typed-service primitive answered this question — noul, choice or score — where the default noul exists only so that rows written before migration 077 read as noul unchanged and every writer sets it?",
      team_id: "class=relation; authority=this; question=which team asked this question, never null, since a family row's team is otherwise only inferable through a team-scoped slug and an evaluator row's not at all?",
      initiative_id: "class=relation; authority=this; question=which initiative asked this question, null on every evaluator row?",
      model_call_id: "class=relation; authority=this; question=which model call produced this answer, null when no model was configured and so no call was made?",
      asked_by: "class=immutable_history; authority=this; question=which principal asked this question, never null?",
    },
  },
};
