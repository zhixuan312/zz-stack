#!/usr/bin/env node
/**
 * zz-doctor — does THIS machine reach the platform, and is what is installed here whole?
 *
 * NOT `npm run doctor`. That one asks whether the deployment matches the checkout — six
 * layers, over the host, from inside this repository. This one asks the only question its
 * reader can act on: can the laptop I am sitting at talk to the platform, with the token it
 * has, through the plugins it installed? The person running this does not have the
 * repository. That is the whole reason it exists, and the reason it must never grow a check
 * that needs one.
 *
 * Everything is derived from the machine. The token comes off disk in the same order the MCP
 * header helper reads it; the gateway URL comes out of the installed plugin rather than being
 * written here, because a hardcoded base tells you the platform the script was written
 * against is healthy, which is never the question.
 *
 * Exit 0 = nothing to do. 1 = at least one FAIL.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const MARKETPLACE = "zz-stack";
let fails = 0, warns = 0;
const say = (level, subject, detail) => {
  if (level === "FAIL") fails++; else if (level === "WARN") warns++;
  console.log(`${level.padEnd(4)}  ${subject.padEnd(22)}  ${detail}`);
};

// ── 1. the token ───────────────────────────────────────────────────────────
// This order is the header helper's, exactly. A doctor that looked somewhere else would pass
// while every tool call returned 401, which is the failure it is here to catch.
const tokenFile = join(homedir(), ".zz", "token");
let token = "", source = "";
const readable = (p) => { try { return readFileSync(p, "utf8"); } catch { return null; } };
if (process.env.ZZ_TOKEN) { token = process.env.ZZ_TOKEN; source = "$ZZ_TOKEN"; }
else if (process.env.ZZ_TOKEN_FILE && readable(process.env.ZZ_TOKEN_FILE) !== null) {
  token = readable(process.env.ZZ_TOKEN_FILE); source = `$ZZ_TOKEN_FILE (${process.env.ZZ_TOKEN_FILE})`;
} else if (readable(tokenFile) !== null) { token = readable(tokenFile); source = "~/.zz/token"; }
token = token.trim();

if (!token) {
  say("FAIL", "token", "no token in $ZZ_TOKEN, $ZZ_TOKEN_FILE or ~/.zz/token — every tool " +
      "call will come back 401. Ask for a platform token, then: " +
      `(umask 077; mkdir -p ~/.zz) && (umask 077; printf '%s' "$ZZ_TOKEN" > ~/.zz/token)`);
} else {
  say("PASS", "token", `found in ${source}`);
  if (!token.startsWith("zzp_")) {
    say("WARN", "token", "does not start with zzp_, which is this platform's prefix — this " +
        "may be a credential for another system");
  }
  if (source === "~/.zz/token") {
    const mode = (statSync(tokenFile).mode & 0o777).toString(8);
    if (mode === "600") say("PASS", "token file mode", "600");
    else say("WARN", "token file mode", `${mode} — other users of this machine can read your ` +
             "credential. Fix with: chmod 600 ~/.zz/token");
  }
}

// ── 2. what is installed ───────────────────────────────────────────────────
// `claude plugin list --json` is the client's OWN answer — id, version, install path, and the
// MCP servers each plugin declares. Walking ~/.claude for the same facts would be this script
// guessing at a layout the client is free to change between releases.
let installed = [];
let haveCli = true;
try {
  installed = JSON.parse(execFileSync("claude", ["plugin", "list", "--json"],
    { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }));
} catch {
  haveCli = false;
  say("WARN", "plugins", "the claude CLI is not on PATH here, so what is installed cannot be " +
      "read and the gateway has to be guessed at below");
}

const mine = installed.filter((p) => typeof p.id === "string" && p.id.endsWith(`@${MARKETPLACE}`));
if (haveCli && !mine.length) {
  say("FAIL", "plugins", `nothing from the ${MARKETPLACE} marketplace is installed. Run: ` +
      `claude plugin marketplace add zhixuan312/${MARKETPLACE} && claude plugin install zz@${MARKETPLACE}`);
} else {
  for (const p of mine) {
    const off = p.enabled === false ? " — INSTALLED BUT DISABLED, it does nothing until you enable it" : "";
    say(p.enabled === false ? "WARN" : "PASS", "plugin", `${p.id} ${p.version}${off}`);
  }
  if (mine.length && !mine.some((p) => p.id === `zz@${MARKETPLACE}`)) {
    say("FAIL", "plugins", `the baseline zz@${MARKETPLACE} is not installed, and everything ` +
        `else needs it. Run: claude plugin install zz@${MARKETPLACE}`);
  }
  // One version across the shelf. Every plugin is stamped `<platform version>+<digest>` by the
  // same build, so two numbers here means one plugin did not update — which shows up later as
  // a skill that disagrees with the tool it is calling, a long way from its cause.
  const versions = [...new Set(mine.map((p) => p.version))];
  if (versions.length > 1) {
    say("WARN", "plugin versions", `${versions.join(" and ")} — these should all be one ` +
        "number. Run /zz:update to bring them level");
  }
}

// Plugins from a marketplace that is no longer the one in use are dead weight: they keep
// old skills in front of the model and old MCP servers in the connection list.
const stale = installed.filter((p) => typeof p.id === "string" && p.id.endsWith("@zz-platform"));
for (const p of stale) {
  say("WARN", "retired marketplace", `${p.id} comes from zz-platform, which was replaced by ` +
      `${MARKETPLACE}. Remove it: claude plugin uninstall ${p.id}`);
}

// ── 3. the doors ───────────────────────────────────────────────────────────
const declared = mine.flatMap((p) => Object.entries(p.mcpServers ?? {})
  .map(([name, sv]) => ({ plugin: p.id, name, url: sv?.url })).filter((s) => s.url));
let base = null;
for (const s of declared) {
  const m = /^(https?:\/\/[^/]+)/.exec(s.url);
  if (m) { base = m[1]; break; }
}
if (base) say("PASS", "gateway", `${base} (read from the installed plugins)`);
else {
  base = "https://api.165-232-169-165.nip.io";
  say("WARN", "gateway", `no installed plugin declares one, so checking the published ` +
      `gateway ${base} instead`);
}

// A door is probed with `tools/list`, and only its STATUS CODE is read.
//
// Not `initialize`: that would make this a second MCP client — it would have to name a
// protocol version, and that string is written once in `packages/mcp-client` so it cannot
// drift. The doors are stateless and answer a cold `tools/list`, and the status code is the
// entire question here: 200 is a door that works, 401 is the token, 404 is a plugin pointing
// at a path this gateway does not serve.
const CLIENT = "zz-doctor";
const PROBE = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });

/** Who the token belongs to — and the one call that puts this run in the telemetry.
 *
 * `tools/list` is a protocol method, not a tool, so a doctor built only from probes is a
 * thing that leaves NO TRACE: the platform would have no way to know anybody ever ran it, and
 * "how often does this fail for real people" is the question it exists to answer. `get_my_info`
 * is a tool call, recorded at the door like every other, tagged `zz-doctor` by the header
 * above — and it is not a call invented for the telemetry's sake: it answers the question a
 * person with a broken setup actually has, which is whether the platform knows who they are. */
async function whoami(base) {
  try {
    const res = await fetch(`${base}/core/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json",
                 "Accept": "application/json, text/event-stream",
                 "Authorization": `Bearer ${token}`, "X-ZZ-Client": CLIENT },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call",
                             params: { name: "get_my_info", arguments: {} } }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null;
    const body = await res.text();
    return {
      email: /\\"email\\":\\"([^\\"]*)/.exec(body)?.[1],
      team: /\\"team\\":\\"([^\\"]*)/.exec(body)?.[1],
    };
  } catch { return null; }
}
async function probe(subject, url) {
  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json",
                 "Accept": "application/json, text/event-stream",
                 "Authorization": `Bearer ${token}`,
                 // The caller key the gateway correlates on. Without it this run joins the
                 // trace of the person's own chat session instead of being its own.
                 "X-ZZ-Client": CLIENT },
      body: PROBE, signal: AbortSignal.timeout(15_000),
    });
  } catch (e) {
    return say("FAIL", subject, `${url} did not answer (${e.name}) — no network, or the ` +
               "platform is down");
  }
  if (res.status === 200) return say("PASS", subject, `${url} answers`);
  if (res.status === 401 || res.status === 403) {
    // A refusal with NO credential is a different sentence from a refusal WITH one, and the
    // first line of this report already said which case it is. Repeating "your token is
    // expired" at somebody who has no token sends them to check a file that is not there.
    return say("FAIL", subject, token
      ? `${url} refused this token (${res.status}) — it is expired, mistyped, or issued by a ` +
        "different deployment. Ask for a new one"
      : `${url} refused the request (${res.status}), as it must with no token. Fix the token ` +
        "above and this clears with it");
  }
  if (res.status === 404) {
    return say("FAIL", subject, `${url} is not a door this gateway mounts (404) — the plugin ` +
               "declaring it is broken or out of date");
  }
  say("FAIL", subject, `${url} answered ${res.status}`);
}

// The core door always, plus every door the installed plugins actually declare — those are
// what this person's tools connect to, and a door that 404s is a plugin that silently has no
// tools rather than an error anybody sees.
await probe("core door", `${base}/core/mcp`);
const seen = new Set([`${base}/core/mcp`]);
for (const s of declared) {
  if (seen.has(s.url)) continue;
  seen.add(s.url);
  await probe(`${s.name} (${s.plugin.split("@")[0]})`, s.url);
}

// ── who this token is ──────────────────────────────────────────────────────
const who = await whoami(base);
if (who?.email) say("PASS", "identity", `${who.email}${who.team ? `, on team ${who.team}` : ""}`);
else if (token) say("WARN", "identity", "the platform did not say who this token belongs to");

// ── verdict ────────────────────────────────────────────────────────────────
console.log("");
if (fails) {
  console.log(`${fails} failed, ${warns} warned. Each FAIL above names what to do about it.`);
  process.exit(1);
}
console.log(warns
  ? `Everything works. ${warns} warning${warns > 1 ? "s" : ""} above worth reading.`
  : "Everything checks out.");
