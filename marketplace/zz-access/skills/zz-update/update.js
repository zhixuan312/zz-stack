#!/usr/bin/env node
/**
 * zz-update — bring every ZZ plugin on this machine up to date, in one command.
 *
 * Two acts in one order: refresh the marketplace, then update each plugin that is installed.
 * `marketplace update` alone leaves every plugin exactly where it was while looking like
 * success, and the wrong order updates nothing and says so in neither command's output.
 *
 * Prints the versions on both sides: "already at 0.29.0+1e7d702a" is a result, and a bare tick
 * is what a person reads for days while running a plugin several releases behind.
 *
 * Exit 0 = this machine is level with the shelf. 1 = something did not update.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
const MARKETPLACE = "zz-stack";
const CLIENT = "zz-update";
/** A caught value is never typed as an Error — narrow the shape actually being read rather than
 *  assume it. */
function errName(e) {
    return typeof e === "object" && e !== null && "name" in e
        ? String(e.name) : "Error";
}
/** Confirm the platform still answers, and say who as.
 *
 * An update that leaves you unable to connect is not a success, and every other check here is
 * about files on disk. So the run ends by actually using one.
 *
 * It is also what puts the run in the platform's telemetry: every tool call is recorded at the
 * door, by the gateway, as a by-product of being made. There is no reporting step, and a
 * separate "record that update ran" call would be a second thing to keep true. */
async function confirm(url) {
    const read = (p) => { try {
        return readFileSync(p, "utf8");
    }
    catch {
        return null;
    } };
    const token = (process.env.ZZ_TOKEN
        || (process.env.ZZ_TOKEN_FILE ? read(process.env.ZZ_TOKEN_FILE) : null)
        || read(join(homedir(), ".zz", "token")) || "").trim();
    if (!token)
        return { ok: false, why: "there is no token on this machine yet" };
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
        if (res.status === 401 || res.status === 403)
            return { ok: false, why: `the platform refused the token (${res.status})` };
        if (!res.ok)
            return { ok: false, why: `the platform answered ${res.status}` };
        const body = await res.text();
        // A 200 is not an answer until it parses. Returning ok on any 200 leaves `email` undefined
        // and the caller prints "you are undefined", which reads as an identity rather than as a
        // failure. A door answering 200 with a body this cannot read is what a renamed tool looks
        // like from a script one release behind.
        const email = /\\"email\\":\\"([^\\"]*)/.exec(body)?.[1];
        if (!email) {
            return { ok: false, why: `the platform answered 200 but nothing in its reply named a person — ` +
                    `this script may be older than the door it is asking` };
        }
        return { ok: true, email, team: /\\"team\\":\\"([^\\"]*)/.exec(body)?.[1] };
    }
    catch (e) {
        return { ok: false, why: `the platform did not answer (${errName(e)})` };
    }
}
/** A caught `execFileSync` failure, narrowed to the fields it actually carries — `stdout` and
 *  `stderr`, not a plain `message` the way a normal Error does. */
function execFields(e) {
    const rec = typeof e === "object" && e !== null ? e : {};
    return {
        stdout: typeof rec.stdout === "string" ? rec.stdout : "",
        stderr: typeof rec.stderr === "string" ? rec.stderr : "",
        message: typeof rec.message === "string" ? rec.message : String(e),
    };
}
const claude = (args) => {
    try {
        return { ok: true, out: execFileSync("claude", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) };
    }
    catch (e) {
        const { stdout, stderr, message } = execFields(e);
        return { ok: false, out: `${stdout}${stderr}`.trim() || message };
    }
};
/** `JSON.parse`'s result, narrowed to "an array of objects" — every field on it is read
 *  defensively below regardless. */
function asPluginArray(v) {
    if (!Array.isArray(v))
        return [];
    return v.filter((p) => typeof p === "object" && p !== null);
}
const installed = () => {
    const r = claude(["plugin", "list", "--json"]);
    if (!r.ok)
        return null;
    try {
        return asPluginArray(JSON.parse(r.out)).filter((p) => typeof p.id === "string" && p.id.endsWith(`@${MARKETPLACE}`));
    }
    catch {
        return null;
    }
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
// 1b. A plugin that was renamed is not a plugin that left.
//
// `claude plugin update zz@zz-stack` fails once `zz` is no longer on the shelf, and the failure
// says only that it failed, with nothing pointing at the plugin that replaced it. Every existing
// installation hits that once, on the release that renames something.
//
// COUPLED: `packages/contracts/src/alias.ts` holds the same kind of frozen map for tools and
// skills. This one is written here rather than imported because the script runs on somebody
// else's machine, from inside the plugin directory, with no workspace around it;
// `checks/plugin-alias.ts` holds the two copies to each other.
const PLUGIN_ALIAS = { zz: "zz-core" };
const renamed = before.filter((p) => PLUGIN_ALIAS[p.id.split("@")[0]]);
for (const p of renamed) {
    const from = p.id.split("@")[0];
    const to = `${PLUGIN_ALIAS[from]}@${MARKETPLACE}`;
    process.stdout.write(`  ${p.id} was renamed to ${to}... `);
    const add = claude(["plugin", "install", to]);
    if (!add.ok) {
        console.log("FAILED.");
        console.error(`    ${add.out.split("\n").join("\n    ")}`);
        console.error(`\n  ${p.id} is still installed and nothing was removed. Install ${to} by hand.`);
        process.exit(1);
    }
    // Removed only after the replacement is in, so a failure leaves a working machine.
    const rm = claude(["plugin", "uninstall", p.id]);
    console.log(rm.ok ? "installed, old one removed." : "installed; the old one could not be removed.");
}
const current = renamed.length ? (installed() ?? before) : before;
// 2. Then each plugin this person has. Not a list written here: someone with only the baseline
// must not be told to install the flows, and someone with a flow we have never heard of must
// still get it updated.
let failed = 0;
for (const p of current) {
    process.stdout.write(`  ${p.id}... `);
    const r = claude(["plugin", "update", p.id]);
    console.log(r.ok ? "done." : "FAILED.");
    if (!r.ok) {
        failed++;
        console.error(`    ${r.out.split("\n").join("\n    ")}`);
    }
}
// 3. Say what actually moved. The only evidence that an update updated anything is the number
// being different afterwards.
const after = installed() ?? [];
const now = new Map(after.map((p) => [p.id, p.version]));
console.log("");
let moved = 0;
for (const p of current) {
    const to = now.get(p.id);
    if (to === undefined)
        console.log(`  ${p.id}  is no longer installed — it left the shelf`);
    else if (to === p.version)
        console.log(`  ${p.id}  already at ${p.version}`);
    else {
        moved++;
        console.log(`  ${p.id}  ${p.version} -> ${to}`);
    }
}
for (const p of after) {
    if (!current.some((b) => b.id === p.id)) {
        moved++;
        console.log(`  ${p.id}  newly installed at ${p.version}`);
    }
}
console.log("");
if (failed) {
    console.log(`${failed} plugin(s) did not update. Nothing else on this machine was changed.`);
    process.exit(1);
}
// One version across the shelf, because one build stamps them all as `<version>+<digest>`. Two
// numbers after a successful update means one plugin resolved against something else.
const versions = [...new Set(after.map((p) => p.version))];
if (versions.length > 1) {
    console.log(`These are not all on one version: ${versions.join(", ")}. That should not ` +
        `happen after an update — run /zz-access:doctor, which checks the rest of the picture.`);
    process.exit(1);
}
console.log(moved
    ? `Up to date at ${versions[0]}. Restart Claude Code so it picks up the new skills and MCP servers.`
    : `Already up to date at ${versions[0]}. Nothing changed.`);
// The URL comes from the plugin that was just updated, so this exercises what the update
// actually produced rather than an address written down here.
const url = after.flatMap((p) => Object.values(p.mcpServers ?? {}).map((sv) => sv?.url))
    .find((u) => typeof u === "string" && u.includes("/core/mcp"));
if (url) {
    const c = await confirm(url);
    if (c.ok)
        console.log(`Platform answers — you are ${c.email}${c.team ? ` on team ${c.team}` : ""}.`);
    else
        console.log(`NOTE: the plugins are updated, but ${c.why}. Run /zz-access:doctor.`);
}
