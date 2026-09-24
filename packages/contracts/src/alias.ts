// Old name → new name, per door — read-only history for rows written before the rename.
// Nothing writes an old name after the rename lands; a lookup miss just means "this name was
// never renamed", not a failure.
//
// One map per door, because a tool name is unique only within its own door and a flat map
// would collide. Every entry is written out rather than derived from a `<verb>_<noun>` →
// `<noun>_<verb>` pattern, because a pattern misses the mergers and exceptions.

/** `/core`'s renames, plus `block_skills` (merged into `skill_list`, aliased so its history
 * resolves).
 *
 * `get_my_info` becomes `session_whoami`, not `whoami` — `/manage` already registers a bare
 * `whoami`, and two doors sharing that name is the ambiguity this rename avoids.
 *
 * A tool that was never renamed takes no entry. COUPLED: checks/alias-maps.ts pins the count
 * at 17.
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
/** `/manage`'s renames.
 *
 * `whoami` is unchanged — it is this door's one exception to the `<noun>_<verb>` shape.
 * `issue_my_access_token`, `my_access_tokens` and `revoke_my_access_token` were deleted rather
 * than renamed, so they take no entry: aliasing them onto `pat_*` would merge two series.
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
/** `/eval`'s renames. `plugin_locate`, `plugin_profile` and `plugin_conform` keep their names,
 * `plugin` already being the noun, so they take no entry.
 *
 * `plugin_ruler`, `plugin_ruler_record` and `plugin_affirm` are gone from here, not repointed at
 * `protocol_read`/`protocol_record`/`protocol_affirm`: Task I-10 removed the `ruler_*` tools they
 * once resolved to, and `protocol_*` is a different measurement object with a different shape —
 * a genuinely new series, not the old one under a new name. The platform's own precedent for
 * exactly this (MANAGE_ALIAS's deleted `issue_my_access_token` and friends) is "deleted rather
 * than renamed, so they take no entry: aliasing them would merge two series." */
export const EVAL_ALIAS: Record<string, string> = Object.freeze({
  plugin_judge: "round_judge",
  plugin_scores: "round_scores",
  plugin_finding_record: "finding_record",
  round_recommend: "round_score",
});
/** The two skill renames. Consumed wherever a `zz.event.step` value is resolved against a
 * skill name, because that column holds the name as a string rather than a version id. */
export const SKILL_ALIAS: Record<string, string> = Object.freeze({
  "zz-backbone": "zz-platform",
  "zz-knowledge": "zz-handover",
});

/** Which map answers for which door.
 *
 * COUPLED: keyed by the surface literal the gateway writes, which is `core`, not `zz-core`.
 * `doorSurface` in tool-telemetry.ts derives it from the URL, so a key taken
 * from the plugin's name matches no row ever written while every check over the map's contents
 * still passes.
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
 * Split on the first colon only. The subject is the shape `zz.event.subject` holds, and
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

/** The doors this gateway serves, as a person types them.
 *
 * The gateway's own `DOORS` in services/gateway/src/server.ts is the authority on what is
 * mounted. This is the same set stated where a client can reach it: `packages/tools` cannot
 * import a service, and `zz-tool call` has to reject a door before it opens a socket.
 *
 * COUPLED: `scripts/gate/checks/catalog-servers.ts` reads server.ts's DOORS and asserts the
 * two agree, which is the only thing that makes a second statement honest.
 *
 * DELIBERATE: `admin` is absent. There is no separate admin door, and a validator that accepts
 * a path the gateway does not mount turns a clear refusal into a connection error. */
export const FIXED_DOORS = Object.freeze(["/core/mcp", "/manage/mcp", "/eval/mcp"]);


/** Every door, for a usage line or an error message. */
export const DOORS_PRINTED: readonly string[] = Object.freeze([...FIXED_DOORS]);

/** Whether a string is a door this gateway mounts. */
export const isDoor = (path: string): boolean => FIXED_DOORS.includes(path);

/** What somebody with no token is told, in one place: the only onboarding this platform has.
 *
 * COUPLED: the gateway's `GET /` and `zz-tool` both print it, and
 * `scripts/gate/checks/catalog-servers.ts` holds the door's copy against this one.
 *
 * Written as lines rather than a paragraph because both readers print it to a terminal. */
export const NO_TOKEN_ONBOARDING: readonly string[] = Object.freeze([
  "No token yet?",
  "  Sign in to the console with your passkey and issue one under Settings:",
  "  it is shown once, carries your identity and your team's access, and",
  "  you can revoke it yourself at any time. No passkey yet? Ask a",
  "  superadmin for an enrolment link. `client_setup` on the access door",
  "  prints the setup for Claude Code.",
]);

/** Old plugin name → new. A plugin is the name a person types into
 * `claude plugin install <name>@zz-stack` and the one recorded in their installation, so an
 * update against a name that has left the shelf fails with nothing naming what replaced it.
 *
 * COUPLED: copied into catalog/zz/zz-access/skills/zz-update/update.ts, which runs from inside
 * a plugin directory with no workspace around it and cannot import this.
 * `checks/plugin-alias.ts` holds the two to each other. */
export const PLUGIN_ALIAS: Record<string, string> = Object.freeze({
  zz: "zz-core",
});
