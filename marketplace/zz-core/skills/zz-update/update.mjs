#!/usr/bin/env node
/**
 * zz-update — bring every ZZ plugin on this machine up to date, in one command.
 *
 * Updating used to be two commands in an order nobody was told: refresh the marketplace, THEN
 * update each plugin you happen to have installed. Getting the order wrong updates nothing and
 * says so in neither command's output, and `marketplace update` alone — which is what the
 * docs suggested — leaves every plugin exactly where it was while looking like success.
 *
 * So this does both, in order, for whatever is actually installed, and PRINTS THE VERSIONS ON
 * BOTH SIDES. "already at 0.29.0+1e7d702a" is a result. A bare tick is the bug: it is what a
 * person reads for days while running a plugin several releases behind.
 *
 * Exit 0 = this machine is level with the shelf. 1 = something did not update.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const MARKETPLACE = "zz-stack";
const CLIENT = "zz-update";

/** Confirm the platform still answers, and say who as.
 *
 * AN UPDATE THAT LEAVES YOU UNABLE TO CONNECT IS NOT A SUCCESS, and until this ran the last
 * word was about files on disk — every plugin at the new number, and no evidence any of them
 * could reach anything. So the run ends by actually using one.
 *
 * It is also what puts the run in the platform's telemetry, and it is worth being exact about
 * how: this is not a beacon and there is no reporting step. Every tool call is recorded AT THE
 * DOOR, by the gateway, as a by-product of being made — so a real call made for a real reason,
 * tagged with who is calling, is the whole of the instrumentation. A separate "record that
 * update ran" call would be a second thing to keep true, and the first thing to rot. */
async function confirm(url) {
  const read = (p) => { try { return readFileSync(p, "utf8"); } catch { return null; } };
  const token = (process.env.ZZ_TOKEN
    || (process.env.ZZ_TOKEN_FILE ? read(process.env.ZZ_TOKEN_FILE) : null)
    || read(join(homedir(), ".zz", "token")) || "").trim();
  if (!token) return { ok: false, why: "there is no token on this machine yet" };
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json",
                 "Accept": "application/json, text/event-stream",
                 "Authorization": `Bearer ${token}`, "X-ZZ-Client": CLIENT },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call",
                             params: { name: "session_whoami", arguments: {} } }),
      signal: AbortSignal.timeout(15_000),
    });
    if (res.status === 401 || res.status === 403) return { ok: false, why: `the platform refused the token (${res.status})` };
    if (!res.ok) return { ok: false, why: `the platform answered ${res.status}` };
    const body = await res.text();
    return { ok: true, email: /\\"email\\":\\"([^\\"]*)/.exec(body)?.[1],
             team: /\\"team\\":\\"([^\\"]*)/.exec(body)?.[1] };
  } catch (e) { return { ok: false, why: `the platform did not answer (${e.name})` }; }
}

const claude = (args) => {
  try {
    return { ok: true, out: execFileSync("claude", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) };
  } catch (e) {
    return { ok: false, out: `${e.stdout ?? ""}${e.stderr ?? ""}`.trim() || e.message };
  }
};
const installed = () => {
  const r = claude(["plugin", "list", "--json"]);
  if (!r.ok) return null;
  try {
    return JSON.parse(r.out).filter((p) => typeof p.id === "string" && p.id.endsWith(`@${MARKETPLACE}`));
  } catch { return null; }
};

const before = installed();
if (before === null) {
  console.error(`Could not read what is installed — is the claude CLI on PATH?`);
  process.exit(1);
}
if (!before.length) {
  console.log(`Nothing from the ${MARKETPLACE} marketplace is installed yet, so there is nothing to update.`);
  console.log(`To install it:\n  claude plugin marketplace add zhixuan312/${MARKETPLACE}\n  claude plugin install zz-core@${MARKETPLACE}`);
  process.exit(0);
}

// 1. The shelf first. Every plugin is resolved against the marketplace's copy of
// marketplace.json, so updating a plugin before refreshing that re-reads the old shelf and
// truthfully reports the plugin is up to date — with the version it already had.
process.stdout.write(`Refreshing the ${MARKETPLACE} shelf... `);
const shelf = claude(["plugin", "marketplace", "update", MARKETPLACE]);
if (!shelf.ok) {
  console.log("failed.");
  console.error(shelf.out);
  console.error(`\nThe shelf is a git clone of the public repository. If that is a network or ` +
                `auth error, nothing was changed and it is safe to run again.`);
  process.exit(1);
}
console.log("done.");

// 2. Then each plugin THIS person has. Not a list written here: someone with only the
// baseline must not be told to install the flows, and someone with a flow we have never
// heard of must still get it updated.
let failed = 0;
for (const p of before) {
  process.stdout.write(`  ${p.id}... `);
  const r = claude(["plugin", "update", p.id]);
  console.log(r.ok ? "done." : "FAILED.");
  if (!r.ok) { failed++; console.error(`    ${r.out.split("\n").join("\n    ")}`); }
}

// 3. Say what actually moved. This is the part the two commands never had: the only evidence
// that an update updated anything is the number being different afterwards.
const after = installed() ?? [];
const now = new Map(after.map((p) => [p.id, p.version]));
console.log("");
let moved = 0;
for (const p of before) {
  const to = now.get(p.id);
  if (to === undefined) console.log(`  ${p.id}  is no longer installed — it left the shelf`);
  else if (to === p.version) console.log(`  ${p.id}  already at ${p.version}`);
  else { moved++; console.log(`  ${p.id}  ${p.version} -> ${to}`); }
}
for (const p of after) {
  if (!before.some((b) => b.id === p.id)) { moved++; console.log(`  ${p.id}  newly installed at ${p.version}`); }
}

console.log("");
if (failed) {
  console.log(`${failed} plugin(s) did not update. Nothing else on this machine was changed.`);
  process.exit(1);
}
// One version across the shelf, because one build stamps them all as `<version>+<digest>`.
// Two numbers after a successful update means one plugin resolved against something else.
const versions = [...new Set(after.map((p) => p.version))];
if (versions.length > 1) {
  console.log(`These are not all on one version: ${versions.join(", ")}. That should not ` +
              `happen after an update — run /zz-core:doctor, which checks the rest of the picture.`);
  process.exit(1);
}
console.log(moved
  ? `Up to date at ${versions[0]}. Restart Claude Code so it picks up the new skills and MCP servers.`
  : `Already up to date at ${versions[0]}. Nothing changed.`);

// The URL comes from the plugin that was just updated, so this exercises what the update
// actually produced rather than a address written down here.
const url = after.flatMap((p) => Object.values(p.mcpServers ?? {}).map((sv) => sv?.url))
  .find((u) => typeof u === "string" && u.includes("/core/mcp"));
if (url) {
  const c = await confirm(url);
  if (c.ok) console.log(`Platform answers — you are ${c.email}${c.team ? ` on team ${c.team}` : ""}.`);
  else console.log(`NOTE: the plugins are updated, but ${c.why}. Run /zz-core:doctor.`);
}
