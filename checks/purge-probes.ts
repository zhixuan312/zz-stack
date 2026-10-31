#!/usr/bin/env node
/**
 * checks/purge-probes.ts — the release's probe purge deletes what chain-check made and nothing a person made, whatever
 * its name says.
 *
 *   node checks/purge-probes.ts   # needs Docker and a built tree (`npm run build`)
 *
 * A throwaway database holds one probe initiative in the exact shape chain-check mints, with a document and a lesson
 * citing it, and a person's work whose names carry the same words: an initiative `fix-chain-check-wiring` with a
 * document, and a lesson titled "Chain-check leaves litter" citing it. `scripts/ops/purge-probes.ts --apply` runs
 * against it; the probe's rows must be gone and every one of the person's must stand.
 *
 * Exit 0: the case held. Exit 1: it did not, naming the rows. Exit 2: Docker is not available — not a pass.
 */
import { execFileSync } from "node:child_process";
import { join } from "node:path";

import { root } from "../scripts/deployment.ts";
import { failing, withThrowawayDbCheck, type Fail } from "../scripts/schema/throwaway.ts";

const NAME = "purge-probes";
const DONE = "purge-probes: the purge takes chain-check's initiative, document and lesson, and leaves a person's " +
  "work named after chain-check: ok";
const fail: Fail = failing(NAME);

process.exitCode = await withThrowawayDbCheck(NAME, DONE, async (sql, url) => {
  const step = "a purge beside a person's work named after chain-check";
  const one = async (text: string, args: unknown[]): Promise<string> => (await sql.query<{ id: string }>(text, args)).rows[0].id;
  const person = await one("insert into zz.principal (email, display_name, role) values ('p@example.test', 'p', 'member') returning id", []);
  const team = await one("insert into zz.team (slug, name, created_by) values ('purge-team', 'purge-team', $1) returning id", [person]);
  const initiative = (slug: string) => one("insert into zz.initiative (team_id, slug, opened_by) values ($1, $2, $3) returning id", [team, slug, person]);
  const probe = await initiative("2026-10-31-chain-check-3110-a1b2");
  const real = await initiative("2026-10-31-fix-chain-check-wiring");
  for (const [init, path] of [[probe, "spec.md"], [real, "notes.md"]]) {
    await sql.query("insert into zz.doc (initiative_id, path, type, status, title, updated_at) values ($1, $2, 'seeded', 'draft', $2, now())", [init, path]);
  }
  const lesson = async (ordinal: number, title: string, slug: string, cites: string): Promise<void> => {
    const node = await one(
      `insert into zz.knowledge_node (kind, title, body, team_id, node_ordinal, slug)
       values ('knowledge', $1, $1, $2, $3, $4) returning id`, [title, team, ordinal, slug]);
    await sql.query("insert into zz.knowledge_node_evidence (node_id, initiative_id) values ($1, $2)", [node, cites]);
  };
  await lesson(1, "chain-check subject probe", "chain-check-subject-probe", probe);
  await lesson(2, "Chain-check leaves litter", "chain-check-leaves-litter", real);

  execFileSync(process.execPath, [join(root, "scripts/ops/purge-probes.ts"), "--apply"],
    { cwd: root, env: { ...process.env, TEAM_DB_URL: url }, stdio: "pipe" });

  const left = async (text: string): Promise<string[]> => (await sql.query<{ name: string }>(text)).rows.map((r) => r.name).sort();
  const initiatives = await left("select slug as name from zz.initiative");
  const docs = await left("select path as name from zz.doc");
  const nodes = await left("select title as name from zz.knowledge_node");
  const got = JSON.stringify({ initiatives, docs, nodes });
  const want = JSON.stringify({ initiatives: ["2026-10-31-fix-chain-check-wiring"], docs: ["notes.md"], nodes: ["Chain-check leaves litter"] });
  if (got !== want) fail(step, `left ${got}, not ${want}`);
  console.log(`  ${step}: the probe's rows are gone and the person's stand: ok`);
});
