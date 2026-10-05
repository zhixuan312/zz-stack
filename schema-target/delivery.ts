/**
 * The delivery record: initiatives, their facts, and bugs. The documents of an initiative and the
 * revisions they have had are the document store, declared beside this in `documents.ts`.
 */
import type { TableTarget } from "../scripts/schema/types.ts";

export const DELIVERY: Record<string, TableTarget> = {
  initiative: {
    columns: [
      [
        "id",
        "uuid",
        false,
        "gen_random_uuid()",
      ],
      [
        "team_id",
        "uuid",
        false,
        null,
      ],
      [
        "slug",
        "text",
        false,
        null,
      ],
      [
        "flow",
        "text",
        true,
        null,
      ],
      [
        "opened_at",
        "timestamp with time zone",
        false,
        "now()",
      ],
      [
        "opened_by",
        "uuid",
        true,
        null,
      ],
      [
        "closed_at",
        "timestamp with time zone",
        true,
        null,
      ],
      [
        "closed_by",
        "uuid",
        true,
        null,
      ],
      [
        "outcome",
        "text",
        true,
        null,
      ],
      [
        "accepted_by",
        "text",
        true,
        null,
      ],
      [
        "no_signoff_reason",
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
        "team_id",
        "id",
      ],
      [
        "team_id",
        "slug",
      ],
    ],
    foreignKeys: [
      {
        columns: [
          "closed_by",
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
          "opened_by",
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
        ],
        refTable: "team",
        refColumns: [
          "id",
        ],
        onDelete: "NO ACTION",
        deferrable: false,
      },
    ],
    checks: [
      "CHECK (((outcome <> 'accepted'::text) OR (accepted_by IS NOT NULL)))",
      "CHECK ((((closed_at IS NULL) = (outcome IS NULL)) AND ((closed_at IS NULL) = (closed_by IS NULL))))",
      "CHECK (((outcome IS NULL) OR (outcome = ANY (ARRAY['accepted'::text, 'delivered'::text, 'abandoned'::text]))))",
      "CHECK (((accepted_by IS NULL) OR (no_signoff_reason IS NULL)))",
      "CHECK ((slug ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}-[a-z0-9][a-z0-9-]*$'::text))",
    ],
    indexes: [],
    comment: "class=state_machine; authority=this; question=what is the lifecycle state of one piece of delivery work, from opened to its outcome?; transitions=open->accepted,open->delivered,open->abandoned",
    columnComments: {
      id: "class=state_machine; authority=this; question=what is this initiative's own identity?",
      team_id: "class=relation; authority=this; question=which team owns this initiative?",
      slug: "class=state_machine; authority=this; question=what is this initiative's stable, human-chosen identifier within its team?",
      flow: "class=state_machine; authority=this; question=which flow does this initiative run, if any?",
      opened_at: "class=state_machine; authority=this; question=when did this initiative's lifecycle begin?",
      opened_by: "class=state_machine; authority=this; question=which principal opened this initiative?",
      closed_at: "class=state_machine; authority=this; question=when did this initiative's lifecycle end, if it has?",
      closed_by: "class=state_machine; authority=this; question=which principal closed this initiative, if it has?",
      outcome: "class=state_machine; authority=this; question=what did this initiative's lifecycle conclude, if it has closed?",
      accepted_by: "class=state_machine; authority=this; question=who is recorded as having signed off on this initiative's accepted outcome, if it was accepted?",
      no_signoff_reason: "class=state_machine; authority=this; question=why was this initiative's accepted outcome accepted without a named sign-off, if so?",
    },
  },
  initiative_fact: {
    columns: [
      [
        "fact",
        "text",
        false,
        null,
      ],
      [
        "value",
        "text",
        false,
        null,
      ],
      [
        "set_at",
        "timestamp with time zone",
        false,
        "now()",
      ],
      [
        "initiative_id",
        "uuid",
        false,
        null,
      ],
    ],
    primaryKey: [
      "initiative_id",
      "fact",
    ],
    uniques: [],
    foreignKeys: [
      {
        columns: [
          "initiative_id",
        ],
        refTable: "initiative",
        refColumns: [
          "id",
        ],
        onDelete: "CASCADE",
        deferrable: false,
      },
    ],
    checks: [],
    indexes: [],
    comment: "class=immutable_history; authority=this; question=which branch facts has this initiative decided, each written once by the stage that decided it and never revised, now that the `_facts.json` copy is retired and the row is the authority?",
    columnComments: {
      fact: "class=immutable_history; authority=this; question=which named branch fact of this initiative's flow does this row record?",
      value: "class=immutable_history; authority=this; question=what did the deciding stage record this branch fact to be?",
      set_at: "class=immutable_history; authority=this; question=when was this branch fact decided?",
      initiative_id: "class=relation; authority=this; question=which initiative does this branch fact belong to?",
    },
  },
  bug: {
    columns: [
      [
        "id",
        "uuid",
        false,
        "gen_random_uuid()",
      ],
      [
        "reported_at",
        "timestamp with time zone",
        false,
        "now()",
      ],
      [
        "title",
        "text",
        false,
        null,
      ],
      [
        "detail",
        "text",
        false,
        null,
      ],
      [
        "surface",
        "text",
        true,
        null,
      ],
      [
        "platform_version",
        "text",
        true,
        null,
      ],
      [
        "impact",
        "text",
        false,
        "'wrong_result'::text",
      ],
      [
        "status",
        "text",
        false,
        "'open'::text",
      ],
      [
        "resolution",
        "text",
        true,
        null,
      ],
      [
        "resolved_at",
        "timestamp with time zone",
        true,
        null,
      ],
      [
        "team_id",
        "uuid",
        true,
        null,
      ],
      [
        "initiative_id",
        "uuid",
        true,
        null,
      ],
      [
        "duplicate_of",
        "uuid",
        true,
        null,
      ],
      [
        "reported_by",
        "uuid",
        false,
        null,
      ],
      [
        "resolved_by",
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
        "team_id",
        "id",
      ],
    ],
    foreignKeys: [
      {
        columns: [
          "team_id",
          "duplicate_of",
        ],
        refTable: "bug",
        refColumns: [
          "team_id",
          "id",
        ],
        onDelete: "NO ACTION",
        deferrable: false,
      },
      {
        columns: [
          "initiative_id",
        ],
        refTable: "initiative",
        refColumns: [
          "id",
        ],
        onDelete: "SET NULL",
        deferrable: false,
      },
      {
        columns: [
          "reported_by",
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
          "resolved_by",
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
      "CHECK (((status = 'duplicate'::text) = (duplicate_of IS NOT NULL)))",
      "CHECK ((impact = ANY (ARRAY['blocks_work'::text, 'wrong_result'::text, 'confusing'::text, 'cosmetic'::text])))",
      "CHECK (((initiative_id IS NULL) OR (team_id IS NOT NULL)))",
      "CHECK (((duplicate_of IS NULL) OR (duplicate_of <> id)))",
      "CHECK ((status = ANY (ARRAY['open'::text, 'fixed'::text, 'not_a_bug'::text, 'duplicate'::text])))",
    ],
    indexes: [
      "CREATE INDEX bug_open ON zz.bug USING btree (status, reported_at DESC)",
    ],
    comment: "class=current_state; authority=this; question=what did a person report as wrong with the platform, and how was it closed, in the one channel from a user that needs no evidence as knowledge does and has an author as telemetry does not?",
    columnComments: {
      id: "class=current_state; authority=this; question=what identifies this report?",
      reported_at: "class=current_state; authority=this; question=when was this report filed?",
      title: "class=current_state; authority=this; question=what one line names what was reported?",
      detail: "class=current_state; authority=this; question=what happened, in the reporter's own words?",
      surface: "class=current_state; authority=this; question=which door or tool did the reporter see this on?",
      platform_version: "class=current_state; authority=this; question=which platform release was running when this was reported?",
      impact: "class=current_state; authority=this; question=what did this cost the reporter, from blocked work to a cosmetic defect?",
      status: "class=current_state; authority=this; question=where does this report stand: open, fixed, not a bug or a duplicate?",
      resolution: "class=current_state; authority=this; question=what was decided about this report?",
      resolved_at: "class=current_state; authority=this; question=when was this report closed?",
      team_id: "class=relation; authority=this; question=which team did the reporter belong to when they filed it?",
      initiative_id: "class=relation; authority=this; question=which initiative was the reporter working on when they filed it?",
      duplicate_of: "class=current_state; authority=this; question=which earlier report does this one duplicate?",
      reported_by: "class=current_state; authority=this; question=which principal filed this report?",
      resolved_by: "class=current_state; authority=this; question=which principal closed this report?",
    },
  },
  // What each `produces: "record"` stage of an initiative minted: the ids a later stage needs
  // and, being in no document, could otherwise only find in the conversation that ran it.
  //
  // DELIBERATE: its own table, and NOT `initiative_fact` beside it. The two look alike — both
  // are key/value rows about one initiative — and they are opposite shapes. A branch fact is
  // recorded ONCE by the stage that decides it and is never revised; a stage record is
  // LATEST-WINS, because a second profile or a re-score supersedes what the stage recorded
  // before, which is exactly what "resume from the initiative" means. One table cannot be both,
  // and a row whose own comment says it is never updated while a writer updates it is a fact
  // with two homes and a false comment in one of them.
  //
  // This is the table that makes the spec's store-migration sentence true: `<initiative>/`
  // `_records.json` is one of the four per-initiative JSON state files it names as already in
  // tables, and it was the one with no table.
  initiative_record: {
    columns: [
      [
        "initiative_id",
        "uuid",
        false,
        null,
      ],
      [
        "stage",
        "text",
        false,
        null,
      ],
      [
        "id_name",
        "text",
        false,
        null,
      ],
      [
        "value",
        "text",
        false,
        null,
      ],
      [
        "set_at",
        "timestamp with time zone",
        false,
        "now()",
      ],
    ],
    primaryKey: [
      "initiative_id",
      "stage",
      "id_name",
    ],
    uniques: [],
    foreignKeys: [
      {
        columns: [
          "initiative_id",
        ],
        refTable: "initiative",
        refColumns: [
          "id",
        ],
        onDelete: "CASCADE",
        deferrable: false,
      },
    ],
    checks: [],
    indexes: [],
    comment: "class=current_state; authority=this; question=which ids did each stage of this initiative mint, latest-wins so a stage that runs again supersedes what it recorded before?",
    columnComments: {
      initiative_id: "class=relation; authority=this; question=which initiative does this stage record belong to?",
      stage: "class=current_state; authority=this; question=which stage of the flow minted these ids?",
      id_name: "class=current_state; authority=this; question=which of the ids the stage minted is this, under the name the stage itself gives it?",
      value: "class=current_state; authority=this; question=what is the id this stage recorded under that name?",
      set_at: "class=current_state; authority=this; question=when did this stage last record this id?",
    },
  },
};
