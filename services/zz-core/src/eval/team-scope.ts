/**
 * Whose an evaluation is. An eval run carries the team that started it, and everything hanging off
 * the run — its findings, its improvement runs, their candidates — is that team's too. A tool handed
 * one of those ids answers it only for that team's caller: to anybody else the id names nothing, in
 * the tool's own "unknown" words, so an id says nothing about what exists elsewhere.
 *
 * COUPLED: candidate_read (candidate-build.ts) applies the same rule inside its own read.
 */
import type pg from "pg";

import { parseCaller } from "@zz/contracts";
import { requestHeaders } from "@zz/mcp-http";

import { teamFor } from "../platform-db.js";

/** The run each kind of id hangs off, as a join from the row named `$1` to `zz.eval_run er`. */
const TO_RUN = {
  eval_run: "zz.eval_run er where er.id = $1::uuid",
  finding: "zz.eval_finding f join zz.eval_run er on er.id = f.eval_run_id where f.id = $1::uuid",
  improvement_run: "zz.improvement_run i join zz.eval_run er on er.id = i.eval_run_id where i.id = $1::uuid",
  candidate: `zz.candidate c join zz.improvement_run i on i.id = c.improvement_run_id
              join zz.eval_run er on er.id = i.eval_run_id where c.id = $1::uuid`,
} as const;

/** Whether `id`, a well-formed uuid of `kind`, belongs to the team the caller acts for. */
export async function inCallerTeam(p: pg.Pool, kind: keyof typeof TO_RUN, id: string): Promise<boolean> {
  const team = await teamFor(parseCaller(requestHeaders()).email);
  if (!team) return false;
  const { rowCount } = await p.query(
    `select 1 from ${TO_RUN[kind]} and er.team_id = (select id from zz.team where slug = $2)`, [id, team]);
  return rowCount === 1;
}
