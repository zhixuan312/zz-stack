// Every rename the spec froze resolves, every deletion does not, and the counts hold.
import { TOOL_ALIAS, MANAGE_ALIAS, EVAL_ALIAS, SKILL_ALIAS } from "../packages/contracts/dist/index.js";

const fail = [];
const size = (name, map, want) => {
  const n = Object.keys(map).length;
  if (n !== want) fail.push(`${name} has ${n} entries, expected ${want}`);
};
// 17, not 16. Sixteen is the RENAME count for /core — the 15 tools that stay plus
// reindex_knowledge, which is renamed as it moves. block_skills is a MERGE, counted
// separately from renames in the spec's own table, but it still needs an alias entry so
// its history resolves. Renames and entries are different quantities and the plan's
// AC-1.3a conflated them.
size("TOOL_ALIAS", TOOL_ALIAS, 17);
size("MANAGE_ALIAS", MANAGE_ALIAS, 29);
size("EVAL_ALIAS", EVAL_ALIAS, 7);
size("SKILL_ALIAS", SKILL_ALIAS, 2);

const resolves = [
  [TOOL_ALIAS, "get_my_info", "session_whoami"],
  [TOOL_ALIAS, "close", "initiative_close"],
  [TOOL_ALIAS, "reconcile", "knowledge_reconcile"],
  [TOOL_ALIAS, "block_skills", "skill_list"],
  [TOOL_ALIAS, "reindex_knowledge", "knowledge_reindex"],
  [MANAGE_ALIAS, "add_person", "person_add"],
  [MANAGE_ALIAS, "my_client_setup", "client_setup"],
  [EVAL_ALIAS, "plugin_ruler", "ruler_read"],
  [EVAL_ALIAS, "plugin_judge", "round_judge"],
  [SKILL_ALIAS, "zz-backbone", "zz-platform"],
  [SKILL_ALIAS, "zz-knowledge", "zz-handover"],
];
for (const [map, from, to] of resolves) {
  if (map[from] !== to) fail.push(`${from} resolves to ${map[from]}, expected ${to}`);
}

// A deleted tool must NOT resolve: aliasing it would merge two distinct series.
for (const gone of ["issue_my_access_token", "my_access_tokens", "revoke_my_access_token"]) {
  if (MANAGE_ALIAS[gone]) fail.push(`${gone} was deleted and must have no alias`);
}
// An unchanged tool must NOT resolve either.
for (const same of ["initiative_status", "knowledge_add", "knowledge_supersede"]) {
  if (TOOL_ALIAS[same]) fail.push(`${same} is unchanged and must have no alias`);
}
// A control: a name nobody renamed must be absent from every map.
for (const [n, m] of Object.entries({ TOOL_ALIAS, MANAGE_ALIAS, EVAL_ALIAS, SKILL_ALIAS })) {
  if (m["a_name_nobody_ever_used"]) fail.push(`${n} resolves a name that does not exist`);
}

if (fail.length) { console.error(fail.join("\n")); process.exit(1); }
console.log("alias maps: ok");
