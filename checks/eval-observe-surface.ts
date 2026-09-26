#!/usr/bin/env node
// OBSERVE counts only a plugin's own tools, and hands back the runs it observed.
//
// The live zz-core evaluation reported surface 16 observed over 15 total (tool_coverage 1.067,
// unscorable): its skills name /manage's team_switch, and its door serves tools no skill names.
// And its traces carried no run id, so no run-kind subject_ref could be obtained by any tool.
// Pure: the traces query runs against a fake pool that answers only the run-refs query.
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

const { ownTools, surfaceCoverage, pluginTraces } =
  await import(pathToFileURL(join(process.cwd(), "services/zz-core/dist/eval/plugin-profile.js")).href);

// -- surface: a cross-door fixture -------------------------------------------------------------
const namedBySkills = ["document_write", "knowledge_search", "session_whoami", "team_switch"];
const coreDoor = ["assess", "bug_report", "document_write", "knowledge_search", "session_whoami"];
const own = ownTools(namedBySkills, coreDoor);
assert.deepEqual(own, ["document_write", "knowledge_search", "session_whoami"], "a tool another door serves is not this plugin's");
// Called: two of its own, one served by the door but named by no skill, one from /manage.
const surface = surfaceCoverage(["core:document_write", "core:session_whoami", "core:assess", "manage:team_switch"], own);
assert.deepEqual(surface, { observed: 2, total: 3 });
assert.ok(surface.observed <= surface.total, "observed never exceeds total");
// A plugin with no door of its own keeps its skill-named set.
assert.deepEqual(ownTools(namedBySkills, null), namedBySkills);
assert.deepEqual(surfaceCoverage(["core:team_switch", "core:other_tool"], ownTools(namedBySkills, null)), { observed: 1, total: 4 });

// -- run ids -----------------------------------------------------------------------------------
const seen: string[] = [];
const runRow = { run_id: "0b7c7a9e-1111-4222-8333-444455556666", team: "zz", initiative: "2026-09-26-eval-zz-core",
                 started_at: "2026-09-26 08:00:00+08" };
const pool = {
  query: async (sql: string) => {
    seen.push(sql);
    return { rows: /as run_id/.test(sql) ? [runRow] : [] };
  },
};
const traces = await pluginTraces(pool, "zz-core", "0.75.0", own, [], true, { from: "-infinity", to: "infinity" });
assert.deepEqual(traces.run_refs, [runRow], "the observed runs come back with their ids and team");
assert.equal(traces.run_refs_truncated, false);
const runSql = seen.find((q) => /as run_id/.test(q)) ?? "";
assert.match(runSql, /zz\.team/, "the team is resolved, since an initiative slug is only unique within a team");
assert.match(runSql, /exists \(select 1 from zz\.event e where e\.run_id = r\.id\)/,
  "only runs a run-kind subject_ref can resolve (it needs zz.event rows) are listed");
console.log("ok eval-observe-surface");
