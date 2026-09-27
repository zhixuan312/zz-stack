/**
 * The store's other records, verified rather than copied.
 *
 * A team's store holds more than documents: `_open.json`, `_facts.json`, `_records.json`,
 * `_assessments/*.json` and `_knowledge/nodes/*.md`. Every one of them is already a row in the
 * database before this carry runs — the platform has been writing them since Phase 0 and Phase 5 —
 * so this module does not copy them. It asks, for each one, whether the row is there, and a record
 * the database does not have becomes a number in the report instead of a silent difference.
 *
 * The journal nodes are the same question asked of `zz.knowledge_node`: a node is addressed by its
 * ordinal, and a file whose ordinal has no row is a node the store holds and the database does not.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import type { Queryable } from "./model.ts";
import type { StoreReport } from "./report.ts";


/** Every id-valued field a stage record writes, and the table the id lands in. Declared here
 *  because the records are already rows and the only question left is whether the row is there. */
const RECORD_FIELDS: Record<string, string> = {
  observation_snapshot_id: "zz.eval_observation_snapshot",
  protocol_version_id: "zz.eval_protocol_version",
  eval_run_id: "zz.eval_run",
  subject_version_id: "zz.plugin_version",
};

/** The store's other records and its journal nodes, verified rather than copied: a record whose row
 *  is not there is a number in the report, never a silent difference. */
export async function countStoreRecords(
  db: Queryable, storeRoot: string, teamBySlug: Map<string, string>, report: StoreReport,
): Promise<void> {
  const teamsDir = join(storeRoot, "teams");
  if (!existsSync(teamsDir)) return;
  for (const team of readdirSync(teamsDir).sort()) {
    if (!teamBySlug.has(team)) continue;
    const teamDir = join(teamsDir, team);
    for (const entry of readdirSync(teamDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith("_") || entry.name.startsWith(".")) continue;
      const dir = join(teamDir, entry.name);
      const slug = entry.name;

      const open = join(dir, "_open.json");
      if (existsSync(open)) {
        const { rows } = await db.query(
          `select 1 from zz.initiative i join zz.team t on t.id = i.team_id
            where t.slug = $1 and i.slug = $2`, [team, slug]);
        if (!rows.length) report.records.unmatched.push(`${team}/${slug}/_open.json: no initiative row`);
        report.records.checked++;
      }

      const facts = join(dir, "_facts.json");
      if (existsSync(facts)) {
        const parsed = JSON.parse(readFileSync(facts, "utf8")) as Record<string, string>;
        for (const fact of Object.keys(parsed)) {
          const { rows } = await db.query(
            `select 1 from zz.initiative_fact f join zz.initiative i on i.id = f.initiative_id
               join zz.team t on t.id = i.team_id
              where t.slug = $1 and i.slug = $2 and f.fact = $3`, [team, slug, fact]);
          if (!rows.length) report.records.unmatched.push(`${team}/${slug}/_facts.json: no initiative_fact row for ${fact}`);
          report.records.checked++;
        }
      }

      const records = join(dir, "_records.json");
      if (existsSync(records)) {
        const parsed = JSON.parse(readFileSync(records, "utf8")) as Record<string, Record<string, unknown>>;
        for (const [stage, rec] of Object.entries(parsed)) {
          for (const [field, value] of Object.entries(rec)) {
            const table = RECORD_FIELDS[field];
            if (!table || typeof value !== "string") continue;
            const { rows } = await db.query(`select 1 from ${table} where id = $1`, [value]);
            if (!rows.length) {
              report.records.unmatched.push(`${team}/${slug}/_records.json: ${stage}.${field} names no ${table} row`);
            }
            report.records.checked++;
          }
        }
      }

      const assessments = join(dir, "_assessments");
      if (existsSync(assessments) && statSync(assessments).isDirectory()) {
        for (const f of readdirSync(assessments).sort()) {
          const parsed = JSON.parse(readFileSync(join(assessments, f), "utf8")) as
            { assessments?: { question_digest?: string }[] };
          for (const a of parsed.assessments ?? []) {
            const { rows } = await db.query(
              `select 1 from zz.assessment a join zz.initiative i on i.id = a.initiative_id
                 join zz.team t on t.id = i.team_id
                where t.slug = $1 and i.slug = $2 and a.question_digest = $3`,
              [team, slug, a.question_digest ?? ""]);
            if (!rows.length) {
              report.records.unmatched.push(`${team}/${slug}/_assessments/${f}: no assessment row for digest ${a.question_digest}`);
            }
            report.records.checked++;
          }
        }
      }
    }

    const nodes = join(teamDir, "_knowledge", "nodes");
    if (existsSync(nodes) && statSync(nodes).isDirectory()) {
      for (const f of readdirSync(nodes).sort()) {
        const m = /^([0-9]+)-.*\.md$/.exec(f);
        if (!m) continue;
        const { rows } = await db.query(
          `select 1 from zz.knowledge_node n join zz.team t on t.id = n.team_id
            where t.slug = $1 and n.node_ordinal = $2`, [team, m[1]]);
        if (!rows.length) report.journalNodes.unmatched.push(`${team}/_knowledge/nodes/${f}: no knowledge_node row`);
        report.journalNodes.checked++;
      }
    }
  }
}
