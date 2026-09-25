// Every rename in the alias maps resolves, every deletion does not, and the counts hold.
import { TOOL_ALIAS, MANAGE_ALIAS, EVAL_ALIAS, SKILL_ALIAS } from "../packages/contracts/dist/index.js";

const fail: string[] = [];
const size = (name: string, map: Record<string, string>, want: number) => {
  const n = Object.keys(map).length;
  if (n !== want) fail.push(`${name} has ${n} entries, expected ${want}`);
};
// 17 entries, not the 16 renames: block_skills is a merge rather than a rename, and still
// needs an entry so its history resolves.
size("TOOL_ALIAS", TOOL_ALIAS, 17);
// A rename map resolves a tool's history, so an entry normally outlives the rename. The
// third-party-server tools carry none: the name they would resolve to is on no door, and an
// alias pointing at a 404 turns "no such tool" into a call the client accepts and the
// gateway refuses.
size("MANAGE_ALIAS", MANAGE_ALIAS, 16);
// Task I-10 deleted the three ruler_* entries rather than repointing them at protocol_*, and
// 0.76.0 deleted `plugin_judge` and `round_recommend` with the round writers they resolved to —
// see EVAL_ALIAS's own comment for why — dropping this from 7 to 2.
size("EVAL_ALIAS", EVAL_ALIAS, 2);
size("SKILL_ALIAS", SKILL_ALIAS, 2);

const resolves: [Record<string, string>, string, string][] = [
  [TOOL_ALIAS, "get_my_info", "session_whoami"],
  [TOOL_ALIAS, "close", "initiative_close"],
  [TOOL_ALIAS, "reconcile", "knowledge_reconcile"],
  [TOOL_ALIAS, "block_skills", "skill_list"],
  [TOOL_ALIAS, "reindex_knowledge", "knowledge_reindex"],
  [MANAGE_ALIAS, "add_person", "person_add"],
  [MANAGE_ALIAS, "my_client_setup", "client_setup"],
  [EVAL_ALIAS, "plugin_scores", "round_scores"],
  [SKILL_ALIAS, "zz-backbone", "zz-platform"],
  [SKILL_ALIAS, "zz-knowledge", "zz-handover"],
];
for (const [map, from, to] of resolves) {
  if (map[from] !== to) fail.push(`${from} resolves to ${map[from]}, expected ${to}`);
}

// A deleted tool must not resolve: aliasing it would merge two distinct series.
for (const gone of ["issue_my_access_token", "my_access_tokens", "revoke_my_access_token"]) {
  if (MANAGE_ALIAS[gone]) fail.push(`${gone} was deleted and must have no alias`);
}
// Task I-10: the ruler_* tools and the pre-rename names that once resolved to them are all
// deleted, not renamed onto protocol_*. Neither half of that old rename may resolve.
for (const gone of ["plugin_ruler", "plugin_ruler_record", "plugin_affirm",
                    "plugin_judge", "round_recommend"]) {
  if (EVAL_ALIAS[gone]) fail.push(`${gone} was deleted and must have no alias`);
}
// An unchanged tool must not resolve either.
for (const same of ["initiative_status", "knowledge_add", "knowledge_supersede"]) {
  if (TOOL_ALIAS[same]) fail.push(`${same} is unchanged and must have no alias`);
}
// A control: a name nobody renamed must be absent from every map.
for (const [n, m] of Object.entries({ TOOL_ALIAS, MANAGE_ALIAS, EVAL_ALIAS, SKILL_ALIAS })) {
  if (m["a_name_nobody_ever_used"]) fail.push(`${n} resolves a name that does not exist`);
}

if (fail.length) { console.error(fail.join("\n")); process.exit(1); }
console.log("alias maps: ok");
