// The /manage door: every tool it serves, cut by role, with the duplicates gone and one
// exception kept. The counts are printed by the check below, where they are measured — this
// line carried them as literals, on the file whose whole argument is that a number belongs
// where it is derived.
//
// WHAT THE PLAN'S DRAFT OF THIS FILE COULD NOT SEE, measured against untouched code before a
// line was changed. Three holes, all of which let a wrong implementation pass:
//
//  1. Its description scan was `registerTool\(\s*\n?\s*"name"[\s\S]{0,80}?description:`, and 80
//     characters cannot span the comment block that sits between the name and `description:`
//     on this door — which is most of the interesting tools, because a tool with a subtle
//     reason to exist is exactly the one whose registration carries a note. Six of the 33 were
//     never scanned at all: disconnect_block, my_teams, whoami, deactivate_person,
//     list_catalog and my_client_setup. my_teams' text contained no "when", no "return" and no
//     "refus" and would have produced three failures; it produced none. A CHECK THAT SILENTLY
//     SKIPS IS WORSE THAN ONE THAT IS MERELY WEAK: a weak check fails honestly on what it
//     examines, while a silent-skip reports success on what it never looked at. So the rule
//     here is that the set of tools with a captured description must EQUAL the set of
//     registrations, and the difference is named.
//
//  2. Its header said "16 for a member" and it asserted nothing whatever about visibility. The
//     role split is the substance of AC-2.29 — it is what "a member sees exactly the 16 the
//     spec froze" means — and it was the one property the check did not look at. Every
//     registration's gate is parsed here and pinned per tier, in BOTH directions: a member must
//     not see the other fourteen, and a superadmin must still see all thirty-one.
//
//  3. Its deletion test asked whether three names appear among the registrations IN THESE THREE
//     FILES. An implementation that moved `issue_my_access_token` into settings.ts, or left it
//     registered on another door, passes that. Absence is asserted here over every service and
//     package, with comments stripped, because a comment recording what a tool used to be is
//     history and this repository's files legitimately carry a lot of it.
//
// THE COUNT IS 31 SINCE TASK I-38, AND THE 31st IS `knowledge_reindex`. It is the tool the
// plan described as "arriving from the core door" and assigned to Task I-18, which delivered
// two of its three tools and left this one where it was: moving it needs `reindexTeam` and
// `indexDoc` reachable from the gateway, and a service cannot import another service. Task
// I-38 — opened against this initiative after I-18 hit that blocker, so it postdates plan.md
// and grepping the plan's 37 tasks for it correctly finds nothing — extracted them into
// `@zz/indexing`, which both services import, and the tool moved.
//
// For most of this initiative this file asserted 30 and said so in this paragraph, because
// asserting the end state early makes a check red for a reason that is not the task's, which
// is how a gate teaches people to read past it. The move has landed, so the name is in SUPER
// below AND in the `expected` set beside it — `knowledge_reindex` is a TOOL_ALIAS value and
// not a MANAGE_ALIAS one, because the old name lived on /core, so the derivation from
// MANAGE_ALIAS cannot produce it and it is named there explicitly.
//
// WHAT THIS FILE DELIBERATELY DOES NOT CHECK ABOUT IT. Its argument contract — `team?`,
// `force?`, omitted meaning every team, an unknown slug refused by name — and the proof that
// exactly one indexer exists both live in checks/core-surface-19.ts, section 4, which is the
// file that tracked the tool's departure from /core. Two files asserting the same thing is
// two files to edit the day it changes.
//
// WHY THE NAMES ARE DERIVED AND THE THREE TIERS ARE NOT. The name set is
// `Object.values(MANAGE_ALIAS)` plus `whoami` plus the one arrival named above, so it is the
// frozen rename table itself rather
// than a list anybody maintains: add an entry to the table without renaming the tool and this
// goes red on its own. The tiers cannot be derived — the spec froze "16 for a member" as a
// number and never enumerated them — so they are written out below, and their union is
// asserted against the derived set, which is what stops a name being quietly moved between
// tiers to make the numbers work.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { MANAGE_ALIAS } from "../packages/contracts/dist/index.js";

const fail: string[] = [];
// A LIST THAT GOES SHORT THE MOMENT A DOOR MODULE IS ADDED, and it did: the bug tools moved
// into admin/bugs.ts when bug_delete joined them, and this check reported a superadmin was no
// longer offered bug_list or bug_resolve — a door that had not changed at all. The list is kept
// rather than derived because a walk of services/gateway/src would also sweep up /core and the
// console, which are different doors; so the rule is that a new /manage module is added HERE in
// the same commit that creates it, and the count below is what catches forgetting.
const FILES = ["services/gateway/src/access-door.ts", "services/gateway/src/admin.ts",
               "services/gateway/src/admin/flows.ts", "services/gateway/src/admin/bugs.ts"];

/** Source with comments removed. Not for the description scan — a description is a string
 *  literal and survives this — but for every question of the form "is this name still HERE",
 *  where a note explaining what something used to be called is an answer of "no". */
const decomment = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

// ── every registration, with the role gate that gates it ────────────────────────────────
//
// The gate is the text between the start of the line and `server.registerTool`, and it must be
// EXACTLY one of three forms. Anything else — `if (!sup)`, `if (sup || lead)`, a gate computed
// somewhere else — is a failure rather than a shrug, because the alternative is reading an
// unrecognised gate as "ungated" and reporting a member who can see the whole door as correct.
const GATES: Record<string, string> = { "": "member", "if (sup) ": "sup", "if (lead) ": "lead" };
const registered = new Map<string, string>();   // name -> tier
for (const f of FILES) {
  const src = decomment(readFileSync(f, "utf8"));
  // The name is matched permissively and JUDGED after, not matched by the shape it is
  // supposed to have. A `[a-z0-9_]+` pattern does not fail on `credential_admin_DELETE` — it
  // fails to MATCH it, and a registration the scan never saw is a registration it vouches for.
  for (const m of src.matchAll(/^[ \t]*(.*?)server\.registerTool\(\s*\n?\s*"([^"]+)"/gm)) {
    const [, prefix, name] = m;
    if (!/^[a-z][a-z0-9_]*$/.test(name)) {
      fail.push(`${JSON.stringify(name)} is registered on /manage and is not a lowercase snake_case name`);
    }
    const tier = GATES[prefix];
    if (tier === undefined) {
      fail.push(`${name} is registered behind an unrecognised gate ${JSON.stringify(prefix)} — ` +
                "this check cannot tell who sees it, so it will not vouch for the door");
      continue;
    }
    if (registered.has(name)) fail.push(`${name} is registered twice on /manage`);
    registered.set(name, tier);
  }
}

// ── the three tiers the spec froze ──────────────────────────────────────────────────────
//
// DERIVED, and here is the derivation, because the spec froze "16 for a member" as a NUMBER and
// never enumerated it: a member sees every ungated registration, which is the nine in
// access-door.ts, the six in admin.ts, and catalog_list in admin/flows.ts. A lead adds the four
// `if (lead)` registrations; a superadmin adds the eight `if (sup)` ones in admin.ts, one in
// access-door.ts, and the three in admin/bugs.ts, which the door registers as one call. The numbers are not asserted against themselves — counting a list this file
// also wrote proves nothing. What carries the weight is the set equality below, against the gates
// parsed out of the source, and the cross-check against MANAGE_ALIAS above it.
const MEMBER = ["block_connect", "block_disconnect", "platform_list", "team_mine", "team_switch",
                "credential_set", "credential_list", "credential_delete", "client_setup",
                "whoami", "pat_issue", "pat_revoke", "pat_list", "team_list", "install_list",
                "catalog_list"];
const LEAD = ["member_add", "member_remove", "flow_install", "flow_uninstall"];
// `bug_list` and `bug_resolve` are superadmin and not lead, deliberately. A report is not
// team-scoped — the platform is one deployment and a defect one team hits is one every team
// has — so the list is everybody's reports, and handing it to a team's own admin would show
// them every other team's. That is a wider reading of "admin" than a team admin was given.
const SUPER = ["person_list", "person_add", "enrolment_issue", "person_deactivate",
               "team_create", "team_archive", "tool_grant", "tool_revoke",
               "credential_admin_set", "credential_admin_delete", "knowledge_reindex",
               "bug_list", "bug_resolve", "bug_delete"];

// The tiers and the frozen table have to describe the same door. Without this, a name could be
// dropped from a tier and from the rename table together and every count below would agree.
//
// THREE NAMES ARE NAMED AND NOT DERIVED, each for a reason worth stating rather than widening
// this to "or anything". `knowledge_reindex` arrived from /core at Task I-38 and its rename
// history is a TOOL_ALIAS entry, so MANAGE_ALIAS cannot produce it. `bug_list` and
// `bug_resolve` were born on this door and have never been renamed, so there is no alias entry
// to derive them from — a tool that has always had one name is invisible to a table of old
// names, and a rename map is the wrong place to register a new tool.
// NAMED RATHER THAN DERIVED, and each for the same reason: MANAGE_ALIAS is a table of names
// that CHANGED, so a tool that never had an old name cannot come out of it. `bug_list` and
// `bug_resolve` arrived from /core keeping their names; `bug_delete` was new at 0.38.1 and has
// never been called anything else.
const expected = new Set([...Object.values(MANAGE_ALIAS), "whoami", "knowledge_reindex",
                          "bug_list", "bug_resolve", "bug_delete"]);
const tiered = new Set([...MEMBER, ...LEAD, ...SUPER]);
for (const n of expected) {
  if (!tiered.has(n)) fail.push(`${n} is a current /manage name and no tier above claims it`);
}
for (const n of tiered) {
  if (!expected.has(n)) fail.push(`${n} is in a tier above and is not a name MANAGE_ALIAS produces`);
}

// ── what each role actually sees ────────────────────────────────────────────────────────
//
// BOTH DIRECTIONS, per tier. Asserting only that a member sees the sixteen passes a door that
// shows a member everything; asserting only that a superadmin sees thirty passes a door that
// shows a member everything too. So each tier is checked as a set equality against what the
// gates say, and the sets are named in the failure rather than counted.
const visibleTo = (role: string) => new Set([...registered.entries()]
  .filter(([, tier]) => tier === "member" || (role === "sup") ||
                        (role === "lead" && tier === "lead"))
  .map(([n]) => n));

const tierSets: [string, Set<string>, Set<string>][] = [
  ["a member", visibleTo("member"), new Set(MEMBER)],
  ["a team lead", visibleTo("lead"), new Set([...MEMBER, ...LEAD])],
  ["a superadmin", visibleTo("sup"), new Set([...MEMBER, ...LEAD, ...SUPER])],
];
for (const [who, got, want] of tierSets) {
  const extra = [...got].filter((n) => !want.has(n));
  const missing = [...want].filter((n) => !got.has(n));
  if (extra.length) fail.push(`${who} is offered ${extra.sort().join(", ")}, which that role does not carry`);
  if (missing.length) fail.push(`${who} is not offered ${missing.sort().join(", ")}`);
  if (!extra.length && !missing.length && got.size !== want.size) {
    fail.push(`${who} sees ${got.size} tools, expected ${want.size}`);
  }
}

// ONE PLACE, because the first version of this spelled the number in the condition and again
// in the sentence, and a mutation that changed the condition alone printed "/manage registers
// 31 tools, expected 31" — a failure a reader cannot act on, on a check that was right.
const DOOR_SIZE = 34;
if (registered.size !== DOOR_SIZE) {
  fail.push(`/manage registers ${registered.size} tools, expected ${DOOR_SIZE} ` +
            `(33 before this initiative, minus the 3 duplicates, plus knowledge_reindex ` +
            `arriving from /core at Task I-38, plus bug_delete at 0.38.1). ` +
            `Registered: ${[...registered.keys()].sort().join(", ")}`);
}

// ── the three duplicates, absent EVERYWHERE and not merely here ─────────────────────────
//
// Each is the same act as a survivor called with no arguments — `issue_my_access_token` is
// `pat_issue`, `my_access_tokens` is `pat_list`, `revoke_my_access_token` is `pat_revoke`, and
// admin.ts already lets a token's owner revoke it. They take no MANAGE_ALIAS entry on purpose:
// folding them onto the survivors would merge two genuinely distinct telemetry series.
const walk = (d: string, out: string[] = []) => {
  for (const e of readdirSync(d)) {
    if (["node_modules", "dist", ".git"].includes(e)) continue;
    const p = join(d, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|mjs|js)$/.test(p)) out.push(p);
  }
  return out;
};
const GONE = ["issue_my_access_token", "my_access_tokens", "revoke_my_access_token"];
let scanned = 0;
for (const f of [...walk("services"), ...walk("packages")]) {
  const src = decomment(readFileSync(f, "utf8"));
  scanned++;
  for (const gone of GONE) {
    if (new RegExp(`\\b${gone}\\b`).test(src)) {
      fail.push(`${f} still names ${gone}, a duplicate this task deleted`);
    }
  }
}
// A scan that reads nothing reports no failures, which is indistinguishable from a clean tree.
if (scanned < 50) fail.push(`the deletion scan read only ${scanned} files; it is looking in the wrong place`);

// ── no old name survives, and the shape holds ───────────────────────────────────────────
for (const old of Object.keys(MANAGE_ALIAS)) {
  if (registered.has(old)) fail.push(`${old} was not renamed — MANAGE_ALIAS says ${MANAGE_ALIAS[old]}`);
}
const NOUNS = ["person", "team", "member", "pat", "flow", "install", "tool",
               "enrolment", "block", "platform", "credential", "client", "catalog", "knowledge",
               // `bug` arrived with the tracker: filing is on /core, answering is here.
               "bug"];
for (const n of registered.keys()) {
  if (n === "whoami") continue;                       // the one exception, deliberately kept
  if (!NOUNS.some((x) => n.startsWith(`${x}_`))) fail.push(`${n} does not start with a noun`);
}
// Control: whoami must still be here. A convention sweep that renamed it broke the exception.
if (!registered.has("whoami")) fail.push("whoami was renamed; it is the shape's one exception");

// ── AC-2.13: every description says when / returns / refuses ────────────────────────────
//
// The scan takes the whole registration block and strips ITS comments, so the distance between
// the name and `description:` stops mattering. Then the two name sets are compared, because the
// failure this replaces was silence about the tools it never reached.
const described = new Set();
for (const f of FILES) {
  const src = readFileSync(f, "utf8");
  for (const m of src.matchAll(/server\.registerTool\(\s*\n?\s*"([^"]+)"([\s\S]*?)inputSchema:/g)) {
    const [, tool, body] = m;
    const d = decomment(body);
    const at = d.indexOf("description:");
    if (at < 0) continue;                         // reported below as an uncovered tool
    const desc = d.slice(at);
    described.add(tool);
    if (!/when\b/i.test(desc)) fail.push(`${tool}'s description does not say WHEN it is called`);
    if (!/return|comes back|answers/i.test(desc)) fail.push(`${tool}'s description does not say what it RETURNS`);
    if (!/refus|reject|never|cannot/i.test(desc)) fail.push(`${tool}'s description does not say what it REFUSES`);
  }
}
for (const n of registered.keys()) {
  if (!described.has(n)) {
    fail.push(`${n} is registered and this check captured no description for it — ` +
              "the scan is blind here, and a blind scan reports a clean subset as a clean whole");
  }
}

// NO HAND-MAINTAINED COUNT OF THIS DOOR, AND IT IS NO LONGER ASSERTED HERE. This file carried
// its own rule for it — a list of the number-words that happened to be wrong, held against
// three named files — which is the same hand-maintained thing it was refusing, one level up.
// checks/derived-counts.ts asks the question once, of everything git carries, by grammar
// rather than by a list. The numbers this door has live BELOW, where they are measured.

if (fail.length) { console.error(fail.join("\n")); process.exit(1); }
console.log(`manage surface: ok — ${registered.size} tools, ${MEMBER.length} for a member, ` +
            `+${LEAD.length} for a lead, +${SUPER.length} for a superadmin; ` +
            `${GONE.length} duplicates absent from ${scanned} files; ` +
            `${described.size} descriptions read`);
