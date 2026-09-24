// The /manage door: every tool it serves, cut by role, with the duplicates gone. The counts
// are printed by the check below, where they are measured.
//
// Three properties, each written to fail loudly rather than skip:
//
//  1. The set of tools with a captured description must equal the set of registrations, and
//     the difference is named. A description scan that misses a registration reports success
//     on what it never looked at.
//
//  2. Every registration's gate is parsed and pinned per tier, in both directions: a member
//     must not see the gated tools, and a superadmin must see all of them.
//
//  3. The deleted duplicates are asserted absent over every service and package, with comments
//     stripped, not merely absent from the three door files.
//
// DELIBERATE: the names are derived and the tiers are not. The name set is
// `Object.values(MANAGE_ALIAS)` plus the names below that never had an old name, so adding an
// entry to the rename table without renaming the tool turns this red on its own. The tiers
// cannot be derived from anything but the gates themselves, so they are written out below and
// their union is asserted against the derived set, which stops a name being moved between
// tiers to make the numbers work.
//
// COUPLED: knowledge_reindex's argument contract, and the proof that exactly one indexer
// exists, are checks/core-surface.ts section 4's, not this file's.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { MANAGE_ALIAS } from "../packages/contracts/dist/index.js";

const fail: string[] = [];
// COUPLED: a new /manage module is added here in the same commit that creates it, or this
// check reports a superadmin losing the tools that moved into it. The count below catches
// forgetting. Kept rather than derived, because a walk of services/gateway/src would sweep up
// /core and the console, which are different doors — and a module that has moved to another
// door is removed from this list, never repointed at its new home.
const FILES = ["services/gateway/src/access-door.ts", "services/gateway/src/admin.ts",
               "services/gateway/src/admin/flows.ts"];

/** Source with comments removed. Not for the description scan — a description is a string
 *  literal and survives this — but for every question of the form "is this name still here". */
const decomment = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

// Every registration, with the role gate that gates it
//
// The gate is the text between the start of the line and `server.registerTool`, and it must be
// exactly one of three forms. Anything else — `if (!sup)`, `if (sup || lead)`, a gate computed
// elsewhere — fails, because reading an unrecognised gate as "ungated" would report a member
// who can see the whole door as correct.
const GATES: Record<string, string> = { "": "member", "if (sup) ": "sup", "if (lead) ": "lead" };
const registered = new Map<string, string>();   // name -> tier
for (const f of FILES) {
  const src = decomment(readFileSync(f, "utf8"));
  // The name is matched permissively and judged after: a `[a-z0-9_]+` pattern does not fail on
  // `credential_admin_DELETE`, it fails to match it, and a registration the scan never saw is
  // one it vouches for.
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

// The three tiers
//
// A member sees every ungated registration; a lead adds the `if (lead)` ones; a superadmin
// adds the `if (sup)` ones. The numbers are not asserted against themselves — counting a list
// this file also wrote proves nothing. The weight is on the set equality below, against the
// gates parsed out of the source, and the cross-check against MANAGE_ALIAS above it.
const MEMBER = ["team_mine", "team_switch", "client_setup",
                "whoami", "pat_issue", "pat_revoke", "pat_list", "team_list",
                "catalog_list"];
const LEAD = ["member_add", "member_remove"];
// The bug tools and knowledge_reindex are on /core, still superadmin: a tool's door is decided
// by its subject, and role decides only who sees it.
const SUPER = ["person_list", "person_add", "enrolment_issue", "person_deactivate",
               "team_create", "team_archive"];

// The tiers and the rename table have to describe the same door. Without this, a name could be
// dropped from a tier and from the rename table together and every count below would agree.
//
// `whoami` is named rather than derived: MANAGE_ALIAS is a table of names that changed, so a
// tool that never had an old name cannot come out of it.
const expected = new Set([...Object.values(MANAGE_ALIAS), "whoami"]);
const tiered = new Set([...MEMBER, ...LEAD, ...SUPER]);
for (const n of expected) {
  if (!tiered.has(n)) fail.push(`${n} is a current /manage name and no tier above claims it`);
}
for (const n of tiered) {
  if (!expected.has(n)) fail.push(`${n} is in a tier above and is not a name MANAGE_ALIAS produces`);
}

// What each role actually sees
//
// Both directions, per tier: asserting only what a member sees, or only what a superadmin
// sees, passes a door that shows a member everything. Each tier is a set equality against what
// the gates say, and the sets are named in the failure rather than counted.
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

// The size is written once, so the condition and the message cannot disagree.
const DOOR_SIZE = 17;
if (registered.size !== DOOR_SIZE) {
  fail.push(`/manage registers ${registered.size} tools, expected ${DOOR_SIZE}. ` +
            `Registered: ${[...registered.keys()].sort().join(", ")}`);
}

// The three duplicates, absent everywhere and not merely here
//
// Each is the same act as a survivor called with no arguments — `issue_my_access_token` is
// `pat_issue`, `my_access_tokens` is `pat_list`, `revoke_my_access_token` is `pat_revoke`.
//
// DELIBERATE: they take no MANAGE_ALIAS entry. Folding them onto the survivors would merge two
// distinct telemetry series.
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

// No old name survives, and the shape holds
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
// Control: whoami must still be here. The loop above skips it by name, so a rename would turn
// the exception into a check that silently covers nothing.
if (!registered.has("whoami")) fail.push("whoami was renamed; it is the shape's one exception");

// Every description says when / returns / refuses
//
// The scan takes the whole registration block and strips its comments, so the distance between
// the name and `description:` does not matter. The two name sets are then compared, so a tool
// the scan never reached is named rather than passed over.
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

// COUPLED: prose counts of this door are checks/derived-counts.ts's question, asked once over
// everything git carries. The numbers here are measured below, where they are printed.

if (fail.length) { console.error(fail.join("\n")); process.exit(1); }
console.log(`manage surface: ok — ${registered.size} tools, ${MEMBER.length} for a member, ` +
            `+${LEAD.length} for a lead, +${SUPER.length} for a superadmin; ` +
            `${GONE.length} duplicates absent from ${scanned} files; ` +
            `${described.size} descriptions read`);
