/**
 * What each pending migration is expected to change — data, not code, so `scripts/rehearse.ts`
 * reads the intent someone wrote down instead of re-deriving it from the diff itself.
 *
 * Keyed by migration file name, exactly as `zz.schema_migration` and
 * `services/gateway/migrations/` name it. A table a pending migration does not mention here — and
 * every table when no migration is pending at all — defaults to: row count unchanged, and the
 * `md5` over its primary-key-ordered rows unchanged. A migration that changes a table's shape or
 * its data declares that table explicitly; everything else stays proven unchanged rather than
 * silently unchecked.
 */
import type pg from "pg";

import { SCHEMA_TARGET } from "../../schema-target.ts";

/**
 * `"unchanged"` (the default): row count must be identical before and after.
 * `{ delta: n }`: row count must have moved by exactly `n` (negative allowed, e.g. a migration
 * that deletes rows).
 * `"any"`: row count is not checked at all — the migration is expected to change it
 * unpredictably (e.g. a backfill driven by production data).
 */
export type CountExpectation = "unchanged" | "any" | { delta: number };

interface TableExpectation {
  /** Default: `"unchanged"`. */
  count?: CountExpectation;
  /** Default: `"unchanged"`. `"skip"` when the table is reshaped wholesale and no fixed column
   *  list survives to hash — every row deleted, or a backfill whose result only the data knows. */
  contentHash?: "unchanged" | "skip";
  /**
   * The columns the content hash is taken over, when the migration reshapes the table: only
   * columns that exist before and after, so the one query reads the same values on both sides.
   * Default: the whole row — a table the migration does not reshape hashes unchanged in every
   * column, and a table it reshapes without declaring this hashes differently, which is exactly
   * the disagreement the rehearsal exists to surface.
   */
  hashColumns?: string[];
  /**
   * The table's name before the migration, when the migration renames it. The before snapshot
   * reads this relation and files it under the target's name, so the rename is one line in the
   * report rather than a table removed and another added.
   */
  was?: string;
  /**
   * The migration drops this table. It is present before and absent after, and that is declared
   * rather than hashed: the content is gone on the after side, so there is nothing to compare it
   * with. Count and `contentHash` are ignored when this is set.
   */
  dropped?: boolean;
  /**
   * The migration creates this table: it is absent before and present after, so there is no
   * before side to compare a count or a hash with, and the count it holds is a property of the
   * data the migration wrote rather than of anything that survived it.
   *
   * DELIBERATE: `scripts/rehearse/diff.ts` does not read this field yet — its `TableExpectation`
   * vocabulary is `count`, `contentHash`, `hashColumns`, `was` and `dropped`, and its
   * `diffSnapshots` reports every table that is absent from the before snapshot and not declared
   * dropped as a disagreement ("no expectation declares the table dropped"). Until that file
   * grows the case, a migration that creates a table cannot rehearse clean, whichever way this
   * file declares it. The four tables phase 3 creates are declared here so that the expectation
   * is written down, and the report names the one change `scripts/rehearse/diff.ts` needs.
   */
  added?: boolean;
}

interface JoinExpectation {
  /** Named for the report line; never interpolated into SQL. */
  name: string;
  /** A query against the migrated database returning exactly one row with one integer column
   *  named `n`: the count of rows that violate the join. The expectation holds when it is 0. */
  violatingCount: string;
}

interface MigrationExpectation {
  tables?: Record<string, TableExpectation>;
  joins?: JoinExpectation[];
  /**
   * A phase step that needs the unpacked artifact store rather than the database — given the
   * directory `scripts/rehearse.ts` unpacked `--artifacts` into, and the migrated client, and
   * returning its own diff lines (empty means it held). Declared per migration, so a future
   * migration that touches the file store names what it needs without `scripts/rehearse.ts`
   * knowing anything about artifacts itself. None declared today.
   */
  withArtifacts?: (artifactsDir: string, client: pg.Client) => Promise<string[]>;
}

/**
 * The expectations of every pending migration, folded together — the last migration to name a
 * table wins over an earlier one naming the same table, the same "later entry overrides" rule a
 * single map would give for free, kept explicit because this is folding several maps rather than
 * reading one. `hashColumns` is `null` when nothing declared a column list: the whole row.
 */
export interface FoldedExpectation {
  count: CountExpectation;
  contentHash: "unchanged" | "skip";
  hashColumns: string[] | null;
  /** `null` unless a pending migration declares the table renamed. */
  was: string | null;
  dropped: boolean;
  /** `true` when a pending migration creates the table. See `TableExpectation.added`. */
  added: boolean;
}

export function foldedTableExpectation(
  table: string,
  pendingMigrations: readonly string[],
): FoldedExpectation {
  let count: CountExpectation = "unchanged";
  let contentHash: "unchanged" | "skip" = "unchanged";
  let hashColumns: string[] | null = null;
  let was: string | null = null;
  let dropped = false;
  let added = false;
  for (const migration of pendingMigrations) {
    const exp = MIGRATION_EXPECTATIONS[migration]?.tables?.[table];
    if (!exp) continue;
    if (exp.count !== undefined) count = exp.count;
    if (exp.contentHash !== undefined) contentHash = exp.contentHash;
    if (exp.hashColumns !== undefined) hashColumns = exp.hashColumns;
    if (exp.was !== undefined) was = exp.was;
    if (exp.dropped !== undefined) dropped = exp.dropped;
    if (exp.added !== undefined) added = exp.added;
  }
  return { count, contentHash, hashColumns, was, dropped, added };
}

/**
 * Every table name any pending migration declares, in the order the target names its own and
 * then the ones only a migration names — a dropped table is not in the target any more, and a
 * migration that removes it is exactly the thing this must still read on the before side.
 */
export function declaredTableNames(pendingMigrations: readonly string[]): string[] {
  const names = new Set(Object.keys(SCHEMA_TARGET.tables));
  for (const migration of pendingMigrations) {
    for (const table of Object.keys(MIGRATION_EXPECTATIONS[migration]?.tables ?? {})) names.add(table);
  }
  return [...names];
}

/**
 * What `002_catalog_evaluation.sql` is expected to move. Every hash lists only columns that exist
 * on both sides of a migration, and omits every column the migration owns — the ones it adds,
 * renames, fills from another source or deletes rows by — because a digest carrying them would
 * differ for that reason alone rather than proving the rest of the row survived.
 * `scripts/rehearse.ts:142` looks a migration up here BY FILENAME.
 */
export const MIGRATION_EXPECTATIONS: Record<string, MigrationExpectation> = {
  "002_catalog_evaluation.sql": {
    tables: {
      // `kind` (= `flow is null`) and `ordinal` are dropped; the three columns that carry the
      // catalog's own facts must hold on every row.
      skill: { hashColumns: ["id", "name", "flow", "retired"] },
      // `unique (skill_id, id)` and the `not valid` content-hash check are added; no column moves.
      skill_version: { hashColumns: ["id", "skill_id", "version", "content_hash", "released_at", "body_hash"] },
      skill_asset: { dropped: true },
      // `owner_team` becomes `owner_team_id` and the authority pair moves to
      // `plugin_release_owner`; a plugin's name and origin are its own.
      plugin: { hashColumns: ["id", "name", "origin"] },
      // Created by this migration. See `TableExpectation.added` for why the rehearsal cannot read
      // this declaration yet, and why four rows of its report are four new tables and not four
      // disagreements about data.
      plugin_release_owner: { added: true },
      // The four source columns, `released_at` and the loss of `rubric_id` — the identity itself
      // (`plugin_id`, `version`, `digest`) must hold, and `digest` is never rewritten.
      plugin_version: { hashColumns: ["id", "plugin_id", "version", "digest"] },
      // Exactly its five duplicate bindings go — the later version of a skill a plugin version
      // bound twice — and the earlier one stays, which is what the joins below prove. No hash:
      // the key changes from `(plugin_version_id, skill_version_id)` to
      // `(plugin_version_id, skill_id)`, so the two snapshots order the same rows differently and
      // a digest over them would differ for that reason alone.
      plugin_version_skill: { count: { delta: -5 }, contentHash: "skip" },
      // A new `door` check; no column moves.
      plugin_tool: {},
      // The two FK columns are repointed at `plugin_version` and nothing else moves.
      candidate: {
        hashColumns: [
          "id", "improvement_run_id", "hypothesis", "expected_effect", "patchset", "patch_digest",
          "complexity_delta", "touched_components", "touched_owners", "proposer_identity", "status",
          "created_at", "build_requested_at", "build_requested_by", "build_result", "build_recorded_at",
        ],
      },
      release_attempt: {
        hashColumns: [
          "id", "candidate_id", "approved_patch_digest", "required_owners", "approval_refs", "status",
          "release_ref", "verification", "rolled_back", "created_at", "reason", "plugin_id",
          "applied_by", "applying_at",
        ],
      },
      // The 11 rows that carry an `eval_id` are deleted, after the archive. No hash: a digest
      // over the surviving rows is taken over a different set of rows than the one before, so it
      // differs by the deletion alone. The join below is what says the deletion was exactly the
      // rows it named and not one report more.
      eval_finding: { count: { delta: -11 }, contentHash: "skip" },
      // `eval_protocol`'s two facts move onto the version and `failure_taxonomy` becomes a
      // relation; `subject_compatibility`, `suites` and `approved_document_path` go.
      eval_protocol_version: {
        hashColumns: [
          "id", "version", "purpose", "qualification_policy", "scoring_policy", "improvement_policy",
          "content_digest", "created_at",
        ],
      },
      // `name` is dropped; the dimension's own facts must hold.
      eval_dimension: {
        hashColumns: [
          "id", "protocol_version_id", "key", "canonical_kind", "weight", "required", "applicable",
          "not_applicable_reason",
        ],
      },
      // `suite` is dropped and the three new columns are derived; the measure's own payload and
      // the evaluator version it defers to must hold.
      eval_measure: {
        hashColumns: [
          "id", "dimension_id", "key", "evaluator_type", "weight", "required", "definition",
          "evaluator_version_id",
        ],
      },
      // `evaluator_id` moves in as `stable_key`, `polarity` becomes `positive_answer` and
      // `model_policy` goes.
      eval_evaluator_version: {
        hashColumns: ["id", "version", "question", "answer_schema", "content_digest"],
      },
      // `subject_scope` goes and the measure it was run for moves in; the evidence must hold.
      eval_evaluator_qualification: { hashColumns: ["id", "state", "evidence", "qualified_at"] },
      // The three jsonb bags collapse into columns; the counts and the digest that was computed
      // over them must hold.
      eval_observation_snapshot: {
        hashColumns: [
          "id", "usable_run_count", "total_run_count", "evidence_digest", "created_at", "facts",
        ],
      },
      // Split into an identity and a sighting. The candidate row IS the sighting — same id, same
      // snapshot, same prevalence, owner and evidence — which is what the rename declaration and
      // the digest over the columns both sides carry prove.
      eval_failure_mode_candidate: { dropped: true },
      // Created by this migration, holding one row per `(plugin, stable key)`.
      eval_failure_mode: { added: true },
      eval_failure_mode_sighting: {
        was: "eval_failure_mode_candidate",
        hashColumns: [
          "id", "observation_snapshot_id", "description", "owner_kind", "confidence",
          "evidence_refs", "created_at",
        ],
      },
      // Created by this migration, holding the taxonomy `failure_taxonomy` used to carry.
      eval_protocol_failure_mode: { added: true },
      // `evidence_snapshot_id` and `subject_version_id` are replaced by the observation snapshot
      // and the release it names, `run_status` by `scored_at`, and `score_interval`,
      // `guardrails`, `coverage` and `dimension_scores` by columns and rows.
      eval_run: {
        hashColumns: ["id", "protocol_version_id", "score_status", "overall_score", "guardrail_status", "created_at"],
      },
      // Created by this migration, one row per element of the jsonb snapshot it replaces.
      eval_run_dimension: { added: true },
      // `subject_ref` becomes the typed subject, `answer` becomes its four figures, and
      // `evaluator_version_id`, `evidence_ref`, `policy_version` and `resulting_action` go.
      eval_assessment: {
        hashColumns: ["id", "eval_run_id", "measure_id", "assessment_id", "qualification_id", "created_at"],
      },
      // `principal` becomes `principal_id`; every row's own ledger facts must hold.
      eval_idempotency: {
        hashColumns: ["tool", "idempotency_key", "request_digest", "result_table", "result_id", "created_at"],
      },
      // Dropped whole, with every row archived first. Declared, not hashed: there is no after
      // side to compare them with.
      eval_subject_version: { dropped: true },
      eval_evidence_snapshot: { dropped: true },
      eval_protocol: { dropped: true },
      eval_evaluator: { dropped: true },
      rubric: { dropped: true },
      rubric_dimension: { dropped: true },
      eval: { dropped: true },
      eval_subject: { dropped: true },
      eval_score: { dropped: true },
    },
    joins: [
      {
        // The 11 deleted findings are exactly the ones that carried an `eval_id`, and every
        // remaining finding is an EVALUATE-produced one — which is what the XOR check the table
        // still carries says, and the deletion is what makes it true of every row.
        name: "every surviving finding names its eval_run and no legacy round",
        violatingCount:
          "select count(*)::int as n from zz.eval_finding where eval_id is not null or eval_run_id is null",
      },
      {
        // One version per skill per plugin version, which is the new key — and the check that the
        // five deletions are complete rather than merely declared.
        name: "no plugin version binds two versions of one skill",
        violatingCount:
          "select count(*)::int as n from (select pvs.plugin_version_id, pvs.skill_id from zz.plugin_version_skill pvs group by 1, 2 having count(*) > 1) d",
      },
      {
        // The version kept is the one released earlier, which is the one the release shipped.
        name: "every plugin version skill binding keeps the earliest released version of its skill",
        violatingCount: `
          select count(*)::int as n
            from zz.plugin_version_skill pvs
            join zz.skill_version sv on sv.id = pvs.skill_version_id
           where exists (
             select 1 from zz.plugin_version_skill other
               join zz.skill_version osv on osv.id = other.skill_version_id
              where other.plugin_version_id = pvs.plugin_version_id
                and osv.skill_id = sv.skill_id
                and (osv.released_at, osv.id) < (sv.released_at, sv.id))`,
      },
      {
        // Every plugin that could be released names at least one team that may release it: the
        // rows `release_owners` held are the rows `plugin_release_owner` must hold now.
        name: "every plugin has a release owner",
        violatingCount:
          "select count(*)::int as n from zz.plugin p where not exists (select 1 from zz.plugin_release_owner o where o.plugin_id = p.id)",
      },
      {
        // The jsonb snapshot was expanded into rows, and a scored run's snapshot held one element
        // per applicable dimension: a scored run with no result row would mean an element the
        // expansion lost.
        name: "every scored run has at least one dimension result",
        violatingCount:
          "select count(*)::int as n from zz.eval_run r where r.scored_at is not null and not exists (select 1 from zz.eval_run_dimension d where d.eval_run_id = r.id)",
      },
      {
        // A failure mode is the plugin's own, and a sighting's identity must be the mode of the
        // plugin whose release that snapshot observed.
        name: "every failure-mode sighting's identity belongs to its snapshot's own plugin",
        violatingCount: `
          select count(*)::int as n
            from zz.eval_failure_mode_sighting s
            join zz.eval_observation_snapshot os on os.id = s.observation_snapshot_id
            join zz.plugin_version pv on pv.id = os.plugin_version_id
            join zz.eval_failure_mode fm on fm.id = s.failure_mode_id
           where fm.plugin_id <> pv.plugin_id`,
      },
      {
        // A protocol folds in failure modes of its own plugin, never another's.
        name: "every protocol failure-mode link is the protocol's own plugin's",
        violatingCount: `
          select count(*)::int as n
            from zz.eval_protocol_failure_mode l
            join zz.eval_protocol_version epv on epv.id = l.protocol_version_id
            join zz.eval_failure_mode fm on fm.id = l.failure_mode_id
           where fm.plugin_id <> epv.plugin_id`,
      },
    ],
    /**
     * The legacy family this migration archives and then drops.
     *
     * The archive is a large object inside the platform's own database — so it travels in the
     * deployment's `pg_dump` backup and never reaches a team shelf, which matters because the
     * archived quotes carry quan's and xuan's text — written the way `pg_dump --data-only` writes
     * a table: a `COPY zz.<table> (<columns>) FROM stdin;` header, the tab-separated rows, and a
     * `\.` terminator. The migration fails rather than dropping a row it could not write, and this
     * step is what proves the archive is still there afterwards and still carries a section for
     * every table: the tables themselves are gone, so no count of theirs survives to compare with.
     *
     * DELIBERATE: the unpacked artifact store is not read here. The archive is a database object
     * and its completeness is a statement about the database, not about the file tree the
     * `--artifacts` tarball holds.
     */
    withArtifacts: async (_artifactsDir, client) => {
      const diffs: string[] = [];
      const { rows } = await client.query<{ oid: string; description: string }>(`
        select m.oid::text as oid, d.description
          from pg_largeobject_metadata m
          join pg_description d on d.objoid = m.oid and d.classoid = 'pg_largeobject'::regclass
         where d.description like 'zz legacy evaluation archive%'
         order by m.oid desc`);
      if (rows.length === 0) {
        diffs.push("archive: no large object carries the zz legacy evaluation archive — the migration dropped the family without it");
        return diffs;
      }
      const payload = (await client.query<{ text: string }>(
        "select convert_from(lo_get($1::oid), 'UTF8') as text", [rows[0].oid],
      )).rows[0].text;

      const sections: [name: string, header: string][] = [
        ["rubric", "-- table zz.rubric:"],
        ["rubric_dimension", "-- table zz.rubric_dimension:"],
        ["eval", "-- table zz.eval:"],
        ["eval_subject", "-- table zz.eval_subject:"],
        ["eval_score", "-- table zz.eval_score:"],
        ["eval_protocol", "-- table zz.eval_protocol:"],
        ["eval_evaluator", "-- table zz.eval_evaluator:"],
        ["eval_evidence_snapshot", "-- table zz.eval_evidence_snapshot:"],
        ["eval_subject_version", "-- table zz.eval_subject_version:"],
        ["eval_finding", "-- table zz.eval_finding, rows with an eval_id:"],
      ];
      const lines = payload.split("\n");
      for (const [name, header] of sections) {
        const at = lines.findIndex((l) => l.startsWith(header));
        if (at < 0) { diffs.push(`archive: carries no section for zz.${name}`); continue; }
        const declared = Number(/:\s*(\d+)\s+row\(s\)$/.exec(lines[at])?.[1]);
        if (!Number.isInteger(declared) || declared <= 0) {
          diffs.push(`archive: the section for zz.${name} declares "${lines[at]}" — no row count`);
          continue;
        }
        // The rows run from the line after the section's `COPY … FROM stdin;` to the `\.` that
        // closes them.
        let rows_ = 0;
        for (let i = at + 1; i < lines.length && lines[i] !== "\\."; i++) {
          if (!lines[i].startsWith("COPY ")) rows_++;
        }
        if (rows_ !== declared) {
          diffs.push(`archive: zz.${name} declares ${declared} row(s) but carries ${rows_} line(s)`);
        }
      }
      return diffs;
    },
  },
};
