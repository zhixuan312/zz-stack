#!/usr/bin/env node
/**
 * checks/answer-indexes.ts — the four recurring filters are served by an index that says so on
 * both sides, and every `zz.model_call` index is held to a recorded decision.
 *
 *   node checks/answer-indexes.ts
 *
 * Three arms, one per line of the criterion.
 *
 *   (1) DECLARED ON BOTH SIDES. The index each filter is served by is written once, below, and
 *   both sides are held to that text: `schema-target/<module>.ts` must declare it and
 *   `services/gateway/migrations/` must build it. `checks/schema-inventory.ts` compares the whole
 *   target against the migrated catalog and so proves only that the two AGREE — a shape that moved
 *   on both sides at once is green there. Here the expected text is the check's own, the
 *   comparison is narrowed to these four indexes, and a disagreement names the filter.
 *
 *   (2) USED. An index that exists and that no plan chooses is a write cost with nothing bought,
 *   and it is invisible to every static check: the declaration matches and the catalog matches.
 *   So each filter's OWN statement is read out of the source that issues it — not copied here,
 *   which would drift — and PLANNED on a throwaway migrated from this tree, seeded to a
 *   population where the answer is a seek rather than a scan. The statement must name the index,
 *   and the buffers it touches must fall at least as low as the figure recorded beside it below.
 *   Those figures are the ratchet: they were measured on the same seed, and a statement that
 *   later grows a column, loses a predicate the index implies, or gains a sort costs pages and
 *   is reported here.
 *
 *   (3) THE RECORDED DECISION on `zz.model_call`. The table carried two indexes and neither is
 *   reached: `model_call_failed_ts (ts DESC) WHERE (NOT ok)` cannot serve the one `ok` predicate
 *   in the tree, which is a `count(*) filter (where not m.ok)` inside an unfiltered scan — a
 *   partial index is not consulted for a FILTER clause. `model_call_purpose_ts (purpose, ts)`
 *   was kept by an earlier draft because `usage-figures.ts`'s `modelDays` groups by `m.purpose`
 *   under a `ts` range; measured, that is false: `modelDays` has no `purpose` predicate, and the
 *   planner answers the range from `model_call_ts` (or, without it, from a sequential scan).
 *   Forced to it with `enable_seqscan = off`, `model_call_purpose_ts` costs 8609 where the
 *   sequential scan costs 5563, because a `(purpose, ts)` btree can only reach the range by
 *   reading every entry in it. Both are retired, and the migration that retires each one names
 *   it in a comment line — the half of "removed or justified" that a check can hold.
 *
 * DELIBERATE: the seed is this check's own, not production's shape. On the deployment these
 * tables are 5,391 / 4,327 / 5,951 / 15 rows (`zz.model_call`, `zz.doc`, `zz.doc_revision`,
 * `zz.eval_run`, read 2026-10-25), sizes at which the planner reads three of them whole and no
 * index can be observed being chosen. What the criterion asks is that each index CAN serve its
 * filter, so each population here is grown until the choice is a real one and the plan says
 * which index won. `eval_run` is the extreme case: 15 rows today and unbounded tomorrow, and
 * the index is the declaration that keeps its plan from degrading silently.
 *
 * DELIBERATE: parameters are bound through `PREPARE … EXECUTE` with the types the gateway's own
 * `query()` call binds, rather than textually substituted. A substituted literal is folded into
 * the plan and answers a statement nobody issues; a prepared custom plan is the one an unnamed
 * extended-protocol query gets.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const root = process.cwd();
const MIGRATIONS = "services/gateway/migrations";

type Reader = typeof import("../packages/tools/src/lib/sql-statements.ts");
type Target = typeof import("../schema-target.ts");
const { SCHEMA_TARGET }: Target =
  await import(pathToFileURL(join(root, "schema-target.ts")).href) as Target;
const { statementsOf, opensStatement }: Reader =
  await import(pathToFileURL(join(root, "packages/tools/dist/lib/sql-statements.js")).href) as Reader;

/** One filter the criterion names: the index that serves it, the source that issues its
 *  statement, and how to tell that statement apart from the others in the same file. */
interface Filter {
  /** The index name, the one thing all three arms are keyed on. */
  index: string;
  /** The table the index is on, as `schema-target` and the catalog key it. */
  table: string;
  /** The exact `pg_get_indexdef` text both sides must carry. */
  def: string;
  /** The file that issues the statement, relative to the repository root. */
  file: string;
  /** What marks this filter's statement among that file's literals. */
  of: (sql: string) => boolean;
  /** The types the gateway binds, in `$n` order. */
  types: string;
  /** The values planned with, as SQL literals. */
  params: string;
  /** The top-level buffers this statement touched on the seeded throwaway, measured with the
   *  index in place. `shared hit` and `read` summed: which of the two a page is varies with the
   *  cache, the total does not. */
  buffers: number;
}

const FILTERS: Filter[] = [
  {
    index: "doc_revision_pending",
    table: "doc_revision",
    def: "CREATE INDEX doc_revision_pending ON zz.doc_revision USING btree (presented_at) " +
         "WHERE ((presented_at IS NOT NULL) AND (approved_at IS NULL))",
    file: "services/gateway/src/console/pending.ts",
    // The queue every team's reads count, not one of the two team-scoped copies beside it.
    of: (sql) => /join zz\.doc_revision r on/.test(sql) && /r\.presented_at is not null/.test(sql)
      && !/t\.slug = \$1/.test(sql),
    types: "timestamptz",
    params: "'2026-10-25T00:00:00Z'",
    buffers: 242,
  },
  {
    index: "doc_initiative_path",
    table: "doc",
    def: "CREATE INDEX doc_initiative_path ON zz.doc USING btree (initiative_id, path text_pattern_ops)",
    file: "services/zz-core/src/tools/source-list.ts",
    of: (sql) => /from zz\.doc d/.test(sql) && /d\.path like 'sources\/%'/.test(sql),
    types: "text, text",
    params: "'probe-team', '2026-10-01-probe-init'",
    buffers: 55,
  },
  {
    index: "eval_run_scored_at",
    table: "eval_run",
    def: "CREATE INDEX eval_run_scored_at ON zz.eval_run USING btree (scored_at) WHERE (scored_at IS NOT NULL)",
    file: "services/gateway/src/console/platform-evaluation.ts",
    of: (sql) => /r\.scored_at is not null/.test(sql) && /order by p\.name, r\.scored_at, r\.id\b/.test(sql),
    types: "timestamptz",
    params: "'2026-10-25T00:00:00Z'",
    buffers: 162,
  },
  {
    index: "model_call_ts",
    table: "model_call",
    def: "CREATE INDEX model_call_ts ON zz.model_call USING btree (ts)",
    file: "services/gateway/src/console/usage-figures.ts",
    of: (sql) => /from zz\.model_call m/.test(sql),
    types: "text, timestamptz, timestamptz",
    // The window Usage asks for: three local days of a record that spans a season.
    params: "'UTC', '2026-10-25T00:00:00Z', '2026-10-22T00:00:00Z'",
    buffers: 11,
  },
];

/** The two indexes `zz.model_call` carried, each retired by a measured decision. The migration
 *  that retires one must carry a comment line naming it — a drop with no line is a reader's
 *  question left unanswered, which is the half of "removed or justified" that prose cannot
 *  enforce and this can. */
const RETIRED = ["model_call_failed_ts", "model_call_purpose_ts"];

const fail: string[] = [];
const sqlOf = (file: string): string => readFileSync(join(root, file), "utf8");

/** This filter's statement, read out of the file that issues it. A marker that matches nothing
 *  is a failure and not a skip: a check that measures no statement would otherwise report a
 *  green line about an index nothing was asked of. */
function statementOf(f: Filter): string | null {
  const found = statementsOf(f.file, sqlOf(f.file), true)
    .map((s) => s.sql.replace(/--[^\n]*/g, " ").trim())
    .filter((sql) => opensStatement(sql) && !sql.includes("${") && f.of(sql));
  if (found.length === 0) {
    fail.push(`FAIL: ${f.file} issues no statement this check can read for ${f.index} — the marker ` +
      "beside it matched no literal, so the arm that proves the index is USED measured nothing");
    return null;
  }
  // The longest match, so a marker that also catches a fragment still plans the whole statement.
  return found.sort((a, b) => b.length - a.length)[0]!;
}

/** Every comment line under the migrations, so a retired index can be looked for in prose. */
const migrationComments = (): { file: string; line: string }[] =>
  readdirSync(join(root, MIGRATIONS)).filter((n) => n.endsWith(".sql")).sort()
    .flatMap((name) => readFileSync(join(root, MIGRATIONS, name), "utf8").split("\n")
      .filter((line) => line.trimStart().startsWith("--"))
      .map((line) => ({ file: `${MIGRATIONS}/${name}`, line })));

/** The top-level `Buffers:` figure of an EXPLAIN text plan, hit and read summed. */
function buffersOf(plan: string[]): number | null {
  const line = plan.find((l) => /^\s+Buffers: /.test(l));
  if (line === undefined) return null;
  let total = 0;
  for (const [, key, n] of line.matchAll(/(\w+)=(\d+)/g)) {
    if (key === "hit" || key === "read" || key === "dirtied" || key === "written") total += Number(n);
  }
  return total;
}

async function main(): Promise<void> {
  const { withThrowawayDb } = await import(pathToFileURL(join(root, "scripts/schema/throwaway.ts")).href) as
    typeof import("../scripts/schema/throwaway.ts");
  const { readCatalog } = await import(pathToFileURL(join(root, "scripts/schema/catalog.ts")).href) as
    typeof import("../scripts/schema/catalog.ts");

  const statements = new Map<string, string>();
  for (const f of FILTERS) {
    const sql = statementOf(f);
    if (sql !== null) statements.set(f.index, sql);
  }

  let dockerDown = false;
  try {
    await withThrowawayDb(async (client) => {
      // ---- the population each filter is planned on. One team, one initiative of its own, and
      // enough rows in each of the four tables that the planner's choice is a real one.
      await client.query("set search_path = zz, public");
      const rows = async (sql: string, params: unknown[] = []): Promise<Record<string, string>[]> =>
        (await client.query(sql, params)).rows as Record<string, string>[];

      const who = (await rows(
        `insert into zz.principal (email, display_name) values ('probe@answer-indexes.test', 'probe')
         returning id::text as id`))[0]!.id;
      const team = (await rows(
        `insert into zz.team (slug, name, created_by) values ('probe-team', 'probe', $1) returning id::text as id`,
        [who]))[0]!.id;
      const initiatives: string[] = [];
      for (let n = 0; n < 100; n++) {
        initiatives.push((await rows(
          `insert into zz.initiative (team_id, slug, opened_by) values ($1, $2, $3) returning id::text as id`,
          [team, n === 0 ? "2026-10-01-probe-init" : `2026-10-01-filler-${String(n).padStart(3, "0")}`, who]))[0]!.id);
      }

      // `zz.model_call`: 20,000 calls across 120 days, a season's worth of the platform's own
      // spend. Three purposes and three models, so the group keys are distinct rows and not one.
      await client.query(
        `insert into zz.model_call (ts, purpose, model, input_tokens, output_tokens, duration_ms, ok, error)
         select '2026-06-27T00:00:00Z'::timestamptz + (g * interval '520 seconds'),
                (array['typed-judge','failure-discover','plugin-judge'])[1 + g % 3],
                (array['anthropic/x','openai/y','local/z'])[1 + g % 3],
                1000 + g % 500, 200 + g % 100, 400 + g % 900, g % 11 <> 0,
                case when g % 11 <> 0 then null else 'seeded failure' end
           from generate_series(1, 20000) g`);

      // `zz.doc`: 20,000 documents across the 100 initiatives, of which the probe's holds 60 —
      // five sources, which is what one initiative's sources list returns.
      await client.query(
        `insert into zz.doc (id, initiative_id, path, type, status, updated_at, body, title, tags,
                             created_at, current_revision, approved_revision, current_version, content_generation)
         select gen_random_uuid(), ($1::uuid[])[1 + (g % 100)],
                case when (1 + (g % 100)) = 1 and g < 200 then 'sources/note-' || g || '.md'
                     when g % 17 = 0 then 'sources/other-' || g || '.md'
                     else 'docs/chapter-' || g || '.md' end,
                'source', 'draft', '2026-10-01T00:00:00Z', '', 't', '{}', '2026-10-01T00:00:00Z',
                null, null, null, 0
           from generate_series(1, 20000) g`, [initiatives]);
      // `zz.doc_revision`: one retained revision per document, forty of them presented and not
      // yet approved — the queue `pending.ts` reads, small beside the history it sits in.
      await client.query(
        `insert into zz.doc_revision (doc_id, revision, content_state, title, body, tags, content_hash,
                                      written_by, written_at, version, presented_at, approved_by, approved_at)
         select d.id, 1, 'retained', 't', repeat('body ', 40), '{}', 'hash', $1::uuid,
                '2026-10-01T00:00:00Z', 1,
                case when n % 500 = 1 then '2026-10-02T00:00:00Z'::timestamptz else '2026-09-30T00:00:00Z'::timestamptz end,
                case when n % 500 = 1 then null else $1::uuid end,
                case when n % 500 = 1 then null else '2026-10-03T00:00:00Z'::timestamptz end
           from (select id, row_number() over (order by id) n from zz.doc) d`, [who]);
      await client.query("update zz.doc set current_revision = 1, current_version = 1");

      // `zz.eval_run`: 4,000 runs across 20 protocol versions, 40 of them scored.
      const protocols: string[] = [];
      const snapshots: string[] = [];
      for (let n = 0; n < 20; n++) {
        const plugin = (await rows(
          `insert into zz.plugin (name, origin, owner_team_id) values ($1, 'platform', $2) returning id::text as id`,
          [`probe-plugin-${n}`, team]))[0]!.id;
        protocols.push((await rows(
          `insert into zz.eval_protocol_version
             (version, purpose, qualification_policy, scoring_policy, improvement_policy, content_digest,
              created_at, plugin_id, protocol_key, observable_surfaces, recorded_by)
           values (1, 'probe', '{}', '{}', '{}', $1, '2026-09-01T00:00:00Z', $2, $3, '{}', $4)
           returning id::text as id`, [`digest-${n}`, plugin, `key-${n}`, who]))[0]!.id);
        const version = (await rows(
          `insert into zz.plugin_version (plugin_id, version, digest) values ($1, '1.0.0', $2) returning id::text as id`,
          [plugin, `digest-${n}`]))[0]!.id;
        snapshots.push((await rows(
          `insert into zz.eval_observation_snapshot
             (usable_run_count, total_run_count, evidence_digest, created_at, plugin_version_id,
              surface_observed, surface_total, surface_source, platform_version, recorded_by)
           values (1, 1, $1, '2026-09-01T00:00:00Z', $2, 1, 1, 'probe', '0.99.0', $3) returning id::text as id`,
          [`evidence-${n}`, version, who]))[0]!.id);
      }
      await client.query(
        `insert into zz.eval_run (protocol_version_id, score_status, overall_score, guardrail_status,
                                  created_at, team_id, initiative_id, observation_snapshot_id,
                                  score_lower, score_upper, scorer_version, started_by, scored_at)
         select ($1::uuid[])[1 + (g % 20)],
                case when g % 100 = 0 then 'established' else null end,
                case when g % 100 = 0 then 5 else null end, 'pass',
                '2026-09-01T00:00:00Z'::timestamptz + (g * interval '9 minutes'),
                $2, $3, ($4::uuid[])[1 + (g % 20)], 4, 6, '0.99.0', $5,
                case when g % 100 = 0
                     then '2026-09-01T00:00:00Z'::timestamptz + (g * interval '9 minutes') end
           from generate_series(1, 4000) g`,
        [protocols, team, initiatives[0]!, snapshots, who]);
      await client.query("vacuum analyze");

      // ---- arm 1: the declaration and the migration agree. `readCatalog` wants an empty
      // search_path so `pg_get_indexdef` renders `zz.*` in full, which is the spelling both
      // `schema-target` and the comparison in `scripts/schema/compare.ts` use.
      await client.query("set search_path = ''");
      const catalog = await readCatalog(client);
      for (const f of FILTERS) {
        const declared = SCHEMA_TARGET.tables[f.table]?.indexes ?? [];
        if (!declared.includes(f.def)) {
          fail.push(`FAIL: schema-target declares no index for ${f.index} — ${f.table}'s target ` +
            `carries ${declared.length} index(es) and none is\n         ${f.def}`);
        }
        const live = catalog[f.table]?.indexes ?? [];
        if (!live.includes(f.def)) {
          fail.push(`FAIL: the migrations build no index for ${f.index} — ${f.table} after every ` +
            `applied migration carries ${live.length} index(es) and none is\n         ${f.def}`);
        }
      }

      // ---- arm 2: the planner chooses it, on this filter's own statement.
      await client.query("set search_path = zz, public");
      for (const f of FILTERS) {
        const sql = statements.get(f.index);
        if (sql === undefined) continue;
        const name = `answer_indexes_${f.index}`;
        try {
          await client.query(`prepare ${name} (${f.types}) as ${sql}`);
        } catch (err) {
          fail.push(`FAIL: ${f.file} issues a statement the migrated database cannot prepare for ` +
            `${f.index}: ${(err as Error).message.split("\n")[0]}`);
          continue;
        }
        try {
          const { rows } = await client.query<Record<string, string>>(
            `explain (analyze, buffers) execute ${name}(${f.params})`);
          const plan = rows.map((r) => Object.values(r)[0] as string);
          if (!new RegExp(`\\b${f.index}\\b`).test(plan.join("\n"))) {
            const scans = plan.filter((l) => /Scan on /.test(l)).map((l) => l.trim()).slice(0, 3);
            fail.push(`FAIL: ${f.file} issues a statement ${f.index} does not serve — the plan on a ` +
              `throwaway seeded for it reads\n         ${scans.join("\n         ") || plan[0]?.trim()}`);
          }
          const touched = buffersOf(plan);
          if (touched === null) {
            fail.push(`FAIL: the plan for ${f.index} reports no buffers, so the figure recorded ` +
              "beside this filter cannot be compared with anything");
          } else if (touched > f.buffers) {
            fail.push(`FAIL: the statement ${f.index} serves touches ${touched} buffers where it ` +
              `was recorded at ${f.buffers} on this same seed — the plan it is planned with has ` +
              "grown, and an index the planner stops reaching costs a scan and returns nothing");
          }
        } finally {
          await client.query(`deallocate ${name}`);
        }
      }

      // ---- arm 3: what `zz.model_call` carries now, against the recorded decision.
      const liveModelCall = catalog.model_call?.indexes ?? [];
      if (!liveModelCall.includes("CREATE INDEX model_call_ts ON zz.model_call USING btree (ts)")) {
        fail.push("FAIL: the migrations build no model_call_ts — the ts filter the criterion names " +
          "is served by the index the retired (ts DESC) partial could not be, and it is missing");
      }
      for (const retired of RETIRED) {
        if (liveModelCall.some((def) => def.includes(` ${retired} ON `))) {
          fail.push(`FAIL: ${retired} is still on zz.model_call after every applied migration — ` +
            "this decision was to retire it, and an index retired in the target but left in the " +
            "migration (or the reverse) is the schema gate's other half");
        }
        if (!migrationComments().some(({ line }) => line.includes(retired))) {
          fail.push(`FAIL: no comment line under ${MIGRATIONS}/ names ${retired} — an index dropped ` +
            "with no line leaves the next reader no way to know it was a decision rather than a loss");
        }
      }
      const kept = liveModelCall.filter((def) => !def.includes(" model_call_ts ON "));
      if (kept.length > 0) {
        fail.push(`FAIL: zz.model_call carries ${kept.length} index(es) beyond model_call_ts, and no ` +
          `plan in this tree reaches one of them:\n         ${kept.join("\n         ")}`);
      }
    });
  } catch (err) {
    if (err instanceof Error && /Docker is not running/.test(err.message)) {
      console.error("answer indexes: Docker is not available — the gate requires Docker to run this check");
      dockerDown = true;
    } else {
      throw err;
    }
  }
  if (dockerDown) process.exit(2);

  if (fail.length) {
    console.error(fail.join("\n"));
    process.exit(1);
  }
  console.log(`answer indexes: ${FILTERS.length} filters are served by an index declared in ` +
    `schema-target/ and built by the migrations, each chosen by its own statement on a throwaway ` +
    `seeded for it and inside its recorded buffer figure (${FILTERS.map((f) => `${f.index} ${f.buffers}`).join(", ")}); ` +
    `zz.model_call carries model_call_ts alone, and ${RETIRED.join(" and ")} are retired by a ` +
    "migration that names each one.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
    process.exit(1);
  });
}
