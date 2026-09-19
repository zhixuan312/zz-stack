// Old name → new name, per door — read-only history for rows written before the rename.
// Nothing writes an old name after the rename lands; a lookup miss just means "this name was
// never renamed", not a failure.
//
// ONE MAP PER DOOR, because a tool name is unique only within its own door and a single flat
// map would collide. `TOOL_ALIAS` is `/core`'s, `MANAGE_ALIAS` is `/manage`'s, `EVAL_ALIAS` is
// `/eval`'s. Every entry here is taken verbatim from the spec's frozen tables — nothing is
// derived from a `<verb>_<noun>` → `<noun>_<verb>` pattern, because a pattern misses the
// mergers and exceptions (`get_my_info` → `session_whoami`, not `whoami`; `block_skills`
// merged into `skill_list` rather than renamed to it).

/** `/core`'s renames: the tools that rename and stay on `/core`, plus `block_skills`
 * (merged into `skill_list` rather than renamed, but aliased anyway so its history still
 * resolves) and `reindex_knowledge` (renamed AND moved to `/manage`; its alias lives here
 * because the old name lived on `/core`).
 *
 * `get_my_info` becomes `session_whoami`, not `whoami` — `/manage` already registers a bare
 * `whoami` and two doors sharing that name is the ambiguity this rename avoids.
 *
 * Absent by design: `whoami`, `initiative_status`, `knowledge_add`, `knowledge_supersede`,
 * `plugin_locate`, `plugin_profile` and `plugin_conform` are unchanged, so they take no entry.
 *
 * 17 entries, not 16 — the plan's AC-1.3a text originally said 16, which is the /core RENAME
 * count (15 core renames + `reindex_knowledge`, which is renamed as it moves). `block_skills`
 * is a MERGE, counted separately from renames in the spec's own table, but it still needs an
 * alias entry so its history resolves. checks/alias-maps.ts now pins 17.
 */
export const TOOL_ALIAS: Record<string, string> = Object.freeze({
  get_my_info: "session_whoami",
  list_skills: "skill_list",
  skill_view: "skill_read",
  list_files: "document_list",
  read_file: "document_read",
  show_document: "document_present",
  write_file: "document_write",
  patch_file: "document_patch",
  revise_document: "document_revise",
  approve: "document_approve",
  add_source: "source_add",
  list_sources: "source_list",
  close: "initiative_close",
  search_knowledge: "knowledge_search",
  reconcile: "knowledge_reconcile",
  block_skills: "skill_list",
  reindex_knowledge: "knowledge_reindex",
});
/** `/manage`'s 29 renames.
 *
 * `whoami` is unchanged — it is this door's one exception to the `<noun>_<verb>` shape.
 * `issue_my_access_token`, `my_access_tokens` and `revoke_my_access_token` are DELETED, not
 * renamed, so they take no entry: mapping them onto `pat_issue` / `pat_list` / `pat_revoke`
 * would merge two distinct series.
 */
export const MANAGE_ALIAS: Record<string, string> = Object.freeze({
  add_person: "person_add",
  deactivate_person: "person_deactivate",
  list_people: "person_list",
  create_team: "team_create",
  archive_team: "team_archive",
  list_teams: "team_list",
  switch_team: "team_switch",
  my_teams: "team_mine",
  add_member: "member_add",
  remove_member: "member_remove",
  issue_pat: "pat_issue",
  revoke_pat: "pat_revoke",
  list_pats: "pat_list",
  issue_enrolment: "enrolment_issue",
  my_client_setup: "client_setup",
  list_catalog: "catalog_list",
});
/** `/eval`'s 7 renames, across four nouns. `plugin_locate`, `plugin_profile` and
 * `plugin_conform` keep their names — `plugin` is already the noun and the form is already
 * correct — so they take no entry. */
export const EVAL_ALIAS: Record<string, string> = Object.freeze({
  plugin_ruler: "ruler_read",
  plugin_ruler_record: "ruler_record",
  plugin_affirm: "ruler_affirm",
  plugin_judge: "round_judge",
  plugin_scores: "round_scores",
  plugin_finding_record: "finding_record",
});
/** The two skill renames (FR-37a). A different mechanism from the tool maps above — this one
 * is consumed wherever a `zz.event.step` value is resolved against a skill name, because that
 * column holds the name as a string rather than joining on a version id — but the shape is the
 * same: old name to new name, read-only history. */
export const SKILL_ALIAS: Record<string, string> = Object.freeze({
  "zz-backbone": "zz-platform",
  "zz-knowledge": "zz-handover",
});

/** Which map answers for which door.
 *
 * KEYED BY THE SURFACE LITERAL THE GATEWAY ACTUALLY WRITES, which is `core` — not `zz-core`.
 * `server.ts` derives it as `url.startsWith("/manage") ? "manage" : "core"`, so a map keyed by
 * the plugin's name would have matched no row ever written while every check that only read
 * the map's contents still passed. The alias would have been correct and inert. Verified
 * against the resolver rather than against the plugin rename that shares the word.
 */
const SURFACE_ALIAS: Record<string, Record<string, string>> = {
  core: TOOL_ALIAS,
  manage: MANAGE_ALIAS,
  eval: EVAL_ALIAS,
};

/** One tool's current name, on one door. A miss returns the name unchanged: most names were
 *  never renamed, and that is an answer rather than a failure. */
export function resolveTool(surface: string, tool: string): string {
  return SURFACE_ALIAS[surface]?.[tool] ?? tool;
}

/** A stored `surface:tool` subject, with its tool half resolved.
 *
 * Split on the FIRST colon only. The subject is the shape `zz.event.subject` holds, and
 * grouping a report by the raw string counts one tool under two names for the whole window
 * that spans a rename. */
export function resolveToolKey(subject: string): string {
  const i = subject.indexOf(":");
  if (i < 0) return subject;
  return `${subject.slice(0, i)}:${resolveTool(subject.slice(0, i), subject.slice(i + 1))}`;
}

/** A stored `zz.event.step` value, resolved to the skill's current name. Separate from the
 *  tool resolvers because the column holds a bare skill name with no door to qualify it. */
export function resolveStep(step: string): string {
  return SKILL_ALIAS[step] ?? step;
}

/** THE DOORS THIS GATEWAY SERVES, as a person types them.
 *
 * The gateway's own `DOORS` in services/gateway/src/server.ts is the authority on what is
 * MOUNTED — it is keyed by the express path and cross-validated against express's router at
 * boot. This is the same set stated where a CLIENT can reach it: `packages/tools` cannot
 * import a service, and `zz-tool call` has to reject a door before it opens a socket if the
 * person is to get a useful error instead of a connection failure.
 *
 * IT IS NOT A SECOND SOURCE OF TRUTH. `scripts/gate/checks/catalog-servers.ts` reads
 * server.ts's DOORS and asserts these two agree, so a door added on one side and not the
 * other is red before it ships. That is the only reason a second statement is allowed to
 * exist at all: it is checked against the first.
 *
 * `admin` IS DELIBERATELY ABSENT. `zz-tool call` accepted `/admin/mcp` until this was
 * written, and that door was retired — see services/gateway/src/admin.ts, "There is no
 * separate admin door." A validator that accepts a path the gateway does not mount turns a
 * clear refusal into a connection error somewhere further down. */
export const FIXED_DOORS = Object.freeze(["/core/mcp", "/manage/mcp", "/eval/mcp"]);


/** Every door, for a usage line or an error message. */
export const DOORS_PRINTED: readonly string[] = Object.freeze([...FIXED_DOORS]);

/** Whether a string is a door this gateway mounts, with a real block name in the block door's
 *  slot. The block half is matched on shape — one path segment, the same character class the
 *  registry admits — because the set of blocks is a runtime fact no client carries. */
export const isDoor = (path: string): boolean =>
  FIXED_DOORS.includes(path) || /^\/p\/[a-z0-9-]+\/mcp$/.test(path);

/** WHAT SOMEBODY WITH NO TOKEN IS TOLD, in one place.
 *
 * The gateway's front door has said this since there was a front door, and it is the only
 * onboarding this platform has: there is no signup form and no token in a config file — an
 * agent issues one, once, against your own identity.
 *
 * IT IS HERE BECAUSE THE CLI NEEDS THE SAME SENTENCE. `zz-tool` used to fail with "no
 * ZZ_TOKEN: a platform token — every door authenticates the caller", which tells a person
 * what is missing and not one thing about how to get it. A dead end is not an error message
 * problem; it is a missing onboarding step, and the step already existed twenty feet away at
 * `GET /`. Two wordings of it would be two onboardings, so there is one, and
 * `scripts/gate/checks/catalog-servers.ts` holds the door's copy against this one.
 *
 * Written as lines rather than a paragraph because both readers print it to a terminal. */
export const NO_TOKEN_ONBOARDING: readonly string[] = Object.freeze([
  "No token yet?",
  "  Open the platform and pick the ZZ Access agent. Ask it for a token:",
  "  it is shown once, carries your identity and your team's access, and",
  "  you can revoke it yourself at any time. That same agent stores your",
  "  keys for the building blocks and prints the setup for Claude Code,",
  "  Codex or Hermes. One agent, everything about your access.",
]);

/** OLD PLUGIN NAME → NEW, for the one installable thing that had no alias map.
 *
 * TOOL_ALIAS, MANAGE_ALIAS, EVAL_ALIAS and SKILL_ALIAS all exist so a name written down before
 * a rename still RESOLVES. A plugin is the name a person types into
 * `claude plugin install <name>@zz-stack` and the one recorded in their installation — and it
 * was the one surface where a rename simply broke: `claude plugin update zz@zz-stack` fails
 * once `zz` is off the shelf, saying only that it failed, so somebody a release behind is told
 * their update is broken with nothing naming what replaced it.
 *
 * `zz` became `zz-core` in 0.34.0. The entry is frozen like the others: nothing writes an old
 * name after the rename, and a miss means "this plugin was never renamed", not a failure.
 *
 * COPIED, DELIBERATELY, INTO catalog/zz/zz-access/skills/zz-update/update.ts — that script
 * runs on somebody else's machine from inside a plugin directory with no workspace around it,
 * so it cannot import this. `checks/plugin-alias.ts` holds the two to each other, which is the
 * only thing that makes a second copy honest. */
export const PLUGIN_ALIAS: Record<string, string> = Object.freeze({
  zz: "zz-core",
});
