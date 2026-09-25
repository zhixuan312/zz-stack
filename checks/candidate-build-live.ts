#!/usr/bin/env node
// `npm run candidate-build`, live, end to end: the real CLI against a stub MCP door, a throwaway
// repository with a tagged release, and the real OS sandbox. Proves:
//   - a catalog candidate is cloned at its base release tag, patched, built and gated inside the
//     sandbox, and recorded ok with the digest of the patch actually applied and a key per lease;
//   - inside the build nothing outside the clone and its home is readable or writable, and no
//     credential of the CLI's (its platform token) is in the build's environment;
//   - a failing gate is recorded `stage: gate` with the gate's own output tail (exit 1), and a
//     patch that does not apply is recorded `stage: apply`;
//   - dependencies come from the clone's own package-lock.json (`npm ci`), never the operator's
//     node_modules, and a patch that breaks the lockfile is the candidate's `install` failure;
//   - a host problem never invalidates: a tool the preflight cannot run refuses before any clone
//     with nothing recorded (exit 2), and one that surfaces mid-build is recorded `stage: host`;
//   - a third-party (local_dir) subject is fetched at its captured digests, and its check is that
//     the patch applies — recorded ok, or `stage: apply`;
//   - a candidate that is not awaiting its build, or whose build this lease already recorded, is
//     refused with nothing recorded (exit 2);
//   - nothing the build made is left under the system temporary directory.
// Skipped (said, not failed) on a host with no working sandbox — the CLI refuses there by design.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const load = (p: string) => import(pathToFileURL(join(process.cwd(), p)).href);
const { detectSandbox } = await load("packages/tools/dist/replay/session.js");
const host = await load("packages/tools/dist/candidate/host.js");
const { IMAGE_UNSHIPPED, pluginContentDigest, pluginDirComponents, pluginTreeDigest } = await load("packages/catalog/dist/index.js");

// ---- the host line, on values: what the preflight runs, and which failures are the host's.
assert.deepEqual(host.preflightCommands(["npm", "run", "build"], ["npm", "run", "gate", "--", "--quiet"]),
  [["npm", "--version"], ["git", "--version"], ["docker", "compose", "version"]], "the default gate needs docker compose");
assert.deepEqual(host.preflightCommands(["node", "b.mjs"], ["make", "gate"]),
  [["npm", "--version"], ["git", "--version"], ["node", "--version"], ["make", "--version"]]);
for (const out of ["unknown shorthand flag: 'f' in -f", "Cannot connect to the Docker daemon at unix:///x",
  "Error: spawn docker ENOENT", "npm error code ENOTFOUND\nnpm error request to https://registry.npmjs.org/x failed"]) {
  assert.ok(host.hostFailure(out), `host: ${out}`);
}
for (const out of ["error TS2322: Type 'x' is not assignable", "GATE FAILED — 1 of 418 checks", "sh: frob: command not found",
  "npm error `npm ci` can only install packages when your package.json and package-lock.json are in sync"]) {
  assert.equal(host.hostFailure(out), null, `the patch's own: ${out}`);
}
if (!detectSandbox()) {
  console.log("skip candidate-build-live: no working sandbox on this host (sandbox-exec or bwrap)");
  process.exit(0);
}

const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const scratch = realpathSync(mkdtempSync(join(tmpdir(), "zz-candidate-build-live-")));
const canary = join(scratch, "canary-secret");
writeFileSync(canary, "operator secret\n");
const escaped = join(scratch, "escaped");
const TOKEN = "zzp_candidate_build_live_token";

// ---- a throwaway repository: one plugin at release v0.0.1, whose build reads the file a patch
// changes and whose gate fails when that file says so.
const repo = join(scratch, "repo");
mkdirSync(repo);
const g = (...a: string[]) => execFileSync("git", ["-c", "user.email=c@x", "-c", "user.name=c", ...a], { cwd: repo, stdio: "pipe" });
g("init", "-q");
writeFileSync(join(repo, "package.json"), JSON.stringify({
  name: "throwaway", version: "0.0.1", private: true,
  dependencies: { "locked-dep": "file:./locked-dep" },
  scripts: { build: "node build.mjs", gate: "node gate.mjs" },
}, null, 2) + "\n");
// One dependency the release's lockfile names — local, so `npm ci` needs no network.
mkdirSync(join(repo, "locked-dep"));
writeFileSync(join(repo, "locked-dep", "package.json"), JSON.stringify({ name: "locked-dep", version: "1.0.0" }));
execFileSync("npm", ["install", "--package-lock-only", "--offline", "--ignore-scripts", "--no-audit", "--no-fund"],
  { cwd: repo, stdio: "pipe" });
// The operator's installed set, which the build must never see: a node_modules --repo has and the
// release's lockfile does not name.
mkdirSync(join(repo, "node_modules", "operator-only"), { recursive: true });
writeFileSync(join(repo, "node_modules", "operator-only", "index.js"), "module.exports = 1;\n");
writeFileSync(join(repo, ".gitignore"), "node_modules\nbuilt.json\n");
// The shelf copy of a skill, which the real gate requires committed (scripts/gate/checks/marketplace.ts).
mkdirSync(join(repo, "marketplace", "acme", "skills", "greet"), { recursive: true });
writeFileSync(join(repo, "marketplace", "acme", "skills", "greet", "SKILL.md"), "---\nname: greet\n---\nSay hello.\n");
writeFileSync(join(repo, "plugins.lock.json"), JSON.stringify({ acme: { version: "0.0.1", digest: "dg-acme" } }));
writeFileSync(join(repo, "value.txt"), "before\n");
writeFileSync(join(repo, "build.mjs"), `
import { existsSync, readFileSync, writeFileSync } from "node:fs";
if (readFileSync("value.txt", "utf8").trim() === "host-fail") {
  console.error("Cannot connect to the Docker daemon at unix:///var/run/docker.sock"); process.exit(1);
}
if (existsSync("node_modules/operator-only")) { console.error("OPERATOR node_modules leaked"); process.exit(5); }
if (!existsSync("node_modules/locked-dep/package.json")) { console.error("the lockfile's dependency is missing"); process.exit(6); }
const probe = (f) => { try { f(); return "reachable"; } catch { return "denied"; } };
writeFileSync("built.json", JSON.stringify({
  value: readFileSync("value.txt", "utf8").trim(),
  canary: probe(() => readFileSync(${JSON.stringify(canary)})),
  write: probe(() => writeFileSync(${JSON.stringify(escaped)}, "x")),
  token: Object.values(process.env).some((v) => v && v.includes(${JSON.stringify(TOKEN)})) ? "present" : "absent",
}));
`);
writeFileSync(join(repo, "gate.mjs"), `
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
// What the real gate's marketplace check does: the shelf must be committed.
const stale = execFileSync("git", ["status", "--porcelain", "--", "."], { encoding: "utf8" }).trim();
if (stale) { console.error("SHELF-STALE: " + stale); process.exit(7); }
const b = JSON.parse(readFileSync("built.json", "utf8"));
if (b.value === "fail-gate") { console.error("GATE-RED: value says fail"); process.exit(3); }
if (b.canary !== "denied" || b.write !== "denied" || b.token !== "absent") { console.error("LEAK " + JSON.stringify(b)); process.exit(4); }
console.log("gate green");
`);
// A third-party plugin captured from --repo's own catalog (local_dir), beside the catalog release.
const plugin = join(repo, "catalog", "acme", "tool");
mkdirSync(join(plugin, "skills", "greet"), { recursive: true });
writeFileSync(join(plugin, "skills", "greet", "SKILL.md"), "---\nname: greet\n---\nSay hello.\n");
g("add", "-A");
g("commit", "-q", "-m", "release");
g("tag", "v0.0.1");
const components = pluginDirComponents(plugin);
assert.ok(!("error" in components));
const pluginTree = pluginTreeDigest(plugin, IMAGE_UNSHIPPED);
assert.ok(!("error" in pluginTree));

const patchTo = (value: string) =>
  "diff --git a/value.txt b/value.txt\n--- a/value.txt\n+++ b/value.txt\n@@ -1 +1 @@\n-before\n+" + value + "\n";

// ---- the stub door: candidate_read answers the candidate below; candidate_build_record is kept.
let candidate: Record<string, unknown> = {};
const records: Record<string, unknown>[] = [];
const server = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => { body += c; });
  req.on("end", () => {
    const msg = JSON.parse(body) as { id?: number; method: string; params?: { name: string; arguments: Record<string, unknown> } };
    const reply = (result: unknown) => {
      res.writeHead(200, { "content-type": "application/json", "mcp-session-id": "stub" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }));
    };
    if (msg.method === "initialize") return reply({ capabilities: {}, serverInfo: { name: "stub" } });
    if (msg.id === undefined) { res.writeHead(202); res.end(); return; }
    assert.equal(req.headers.authorization, `Bearer ${TOKEN}`, "the CLI calls with the platform token");
    const { name, arguments: args } = msg.params!;
    const text = name === "candidate_read" ? JSON.stringify(candidate)
      : name === "candidate_build_record" ? (records.push(args), JSON.stringify({ recorded: true }))
      : `ERROR: stub has no ${name}`;
    reply({ content: [{ type: "text", text }] });
  });
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const port = (server.address() as { port: number }).port;

// `--gate-cmd "npm run gate"`, not the default: the default's preflight needs docker compose, which
// this check must not require of the host. The default's own preflight is proven on values above.
function runCli(id: string, gateCmd = "npm run gate"): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["packages/tools/dist/candidate/build.js", "--candidate", id, "--repo", repo,
      "--gateway", `http://127.0.0.1:${port}`, "--gate-cmd", gateCmd],
      { env: { ...process.env, ZZ_TOKEN: TOKEN }, stdio: ["ignore", "pipe", "pipe"] });
    let out = ""; let err = "";
    child.stdout.on("data", (c) => { out += c; });
    child.stderr.on("data", (c) => { err += c; });
    child.on("close", (code) => resolve({ code: code ?? -1, out, err }));
  });
}

function candidateFor(id: string, diff: string, status = "awaiting_build") {
  return {
    candidate_id: id, status, patch_digest: sha256(diff), candidate_patchset: { diff },
    subject_plugin: "acme", subject_source_locator: { kind: "catalog", locator: "acme" },
    subject_declared_version: "0.0.1", subject_release_digest: "dg-acme",
    subject_content_digest: null, subject_release_identity: { released_digest: "dg-acme" },
    build_requested_at: "2026-09-25T12:00:00.000Z",
    build_lease_expires_at: "2026-09-25T13:00:00.000Z", build_recorded_at: null as string | null,
  };
}

function thirdPartyFor(id: string, diff: string) {
  return {
    ...candidateFor(id, diff), subject_plugin: "acme-tool",
    subject_source_locator: { kind: "local_dir", locator: "/catalog/acme/tool" },
    subject_declared_version: "1.0.0", subject_release_digest: null,
    subject_content_digest: pluginContentDigest(components.components),
    subject_release_identity: { tree_digest: pluginTree.digest },
  };
}
const skillPatch = (from: string, to: string) =>
  "diff --git a/skills/greet/SKILL.md b/skills/greet/SKILL.md\n--- a/skills/greet/SKILL.md\n+++ b/skills/greet/SKILL.md\n" +
  `@@ -1,4 +1,4 @@\n ---\n name: greet\n ---\n-${from}\n+${to}\n`;
type Rec = { candidate_id: string; patch_digest: string; result: { ok: boolean; stage?: string; log_tail?: string; commands?: string[] } };
const last = () => records[records.length - 1] as Rec;

const leftovers = () => {
  const dir = join(realpathSync(tmpdir()), "zz-candidate-build");
  return existsSync(dir) ? readdirSync(dir).filter((n) => n.startsWith("cb-")) : [];
};
const before = leftovers();

try {
  // ---- a passing build.
  const okId = "aaaaaaaa-0000-0000-0000-000000000001";
  candidate = candidateFor(okId, patchTo("after"));
  let r = await runCli(okId);
  assert.equal(r.code, 0, `a passing build exits 0: ${r.out}${r.err}`);
  assert.equal(records.length, 1);
  const okRec = records[0] as Rec & { idempotency_key: string };
  assert.equal(okRec.candidate_id, okId);
  assert.equal(okRec.patch_digest, sha256(patchTo("after")), "the digest of the patch actually applied");
  assert.equal(okRec.result.ok, true, "sandbox held, lockfile installed, operator node_modules unseen");
  assert.deepEqual(okRec.result.commands, ["npm ci --ignore-scripts --no-audit --no-fund", "npm run build", "npm run gate"]);
  assert.equal(okRec.idempotency_key, sha256(["candidate_build_record", okId, "2026-09-25T12:00:00.000Z"].join("\u0000")),
    "one key per lease");
  assert.equal(existsSync(escaped), false, "nothing escaped the sandbox");
  assert.deepEqual(JSON.parse(r.out.trim()), { candidate_id: okId, ok: true, stage: null, recorded: true });

  // ---- a skill-editing patch: committed in the clone before the build, so the gate's own
  // `git status` sees a clean shelf.
  const shelfId = "aaaaaaaa-0000-0000-0000-000000000009";
  const shelfPatch = "diff --git a/marketplace/acme/skills/greet/SKILL.md b/marketplace/acme/skills/greet/SKILL.md\n" +
    "--- a/marketplace/acme/skills/greet/SKILL.md\n+++ b/marketplace/acme/skills/greet/SKILL.md\n" +
    "@@ -1,4 +1,4 @@\n ---\n name: greet\n ---\n-Say hello.\n+Say hello warmly.\n" +
    // ...and the skill's own source beside its shelf copy, as a real skill edit carries both.
    "diff --git a/catalog/acme/tool/skills/greet/SKILL.md b/catalog/acme/tool/skills/greet/SKILL.md\n" +
    "--- a/catalog/acme/tool/skills/greet/SKILL.md\n+++ b/catalog/acme/tool/skills/greet/SKILL.md\n" +
    "@@ -1,4 +1,4 @@\n ---\n name: greet\n ---\n-Say hello.\n+Say hello warmly.\n";
  candidate = candidateFor(shelfId, shelfPatch);
  r = await runCli(shelfId);
  assert.equal(r.code, 0, `a skill-editing candidate passes a gate that requires a committed shelf: ${r.out}${r.err}`);
  assert.equal(last().result.ok, true);
  assert.doesNotMatch(r.err, /xcrun_db/, "no xcrun cache noise from a sandboxed git");

  // ---- a failing gate.
  const redId = "aaaaaaaa-0000-0000-0000-000000000002";
  candidate = candidateFor(redId, patchTo("fail-gate"));
  r = await runCli(redId);
  assert.equal(r.code, 1, "a failed build recorded exits 1");
  const red = last() as Rec & { result: { log_tail: string } };
  assert.equal(red.result.ok, false);
  assert.equal(red.result.stage, "gate");
  assert.match(red.result.log_tail, /GATE-RED: value says fail/, "the gate's own output tail");
  assert.doesNotMatch(red.result.log_tail, /xcrun_db/, "and no xcrun cache noise in it");

  // ---- a patch that does not apply.
  const badId = "aaaaaaaa-0000-0000-0000-000000000003";
  candidate = candidateFor(badId, "diff --git a/value.txt b/value.txt\n--- a/value.txt\n+++ b/value.txt\n@@ -1 +1 @@\n-nothing like this\n+x\n");
  r = await runCli(badId);
  assert.equal(r.code, 1);
  assert.equal(last().result.stage, "apply");

  // ---- not awaiting its build: refused, nothing recorded.
  const idleId = "aaaaaaaa-0000-0000-0000-000000000004";
  candidate = candidateFor(idleId, patchTo("after"), "valid");
  r = await runCli(idleId);
  assert.equal(r.code, 2);
  assert.match(r.err, /not awaiting_build/);
  assert.equal(records.length, 4, "nothing recorded");

  // ---- a build already recorded for this lease: refused before any clone, nothing recorded.
  candidate = { ...candidateFor(okId, patchTo("after")), build_recorded_at: "2026-09-25T12:10:00.000Z" };
  r = await runCli(okId);
  assert.equal(r.code, 2);
  assert.match(r.err, /already recorded for this lease/);
  assert.equal(records.length, 4, "nothing recorded");

  // ---- a tool the preflight cannot run: a host problem, refused before any clone, nothing recorded.
  candidate = candidateFor(okId, patchTo("after"));
  r = await runCli(okId, "zz-no-such-tool-anywhere gate");
  assert.equal(r.code, 2);
  assert.match(r.err, /this host cannot run `zz-no-such-tool-anywhere --version`[\s\S]*not the candidate's/);
  assert.equal(records.length, 4, "nothing recorded");

  // ---- a host problem mid-build: recorded as host, which returns the candidate to recorded.
  const hostId = "aaaaaaaa-0000-0000-0000-000000000005";
  candidate = candidateFor(hostId, patchTo("host-fail"));
  r = await runCli(hostId);
  assert.equal(r.code, 1);
  assert.equal(last().result.stage, "host", "a docker daemon out of reach is the host's, never the patch's");
  assert.match(last().result.log_tail ?? "", /Cannot connect to the Docker daemon/);

  // ---- a patch that breaks the lockfile: the candidate's own install failure.
  const lockId = "aaaaaaaa-0000-0000-0000-000000000006";
  candidate = candidateFor(lockId,
    "diff --git a/package.json b/package.json\n--- a/package.json\n+++ b/package.json\n@@ -5,4 +5,5 @@\n" +
    '   "dependencies": {\n-    "locked-dep": "file:./locked-dep"\n+    "locked-dep": "file:./locked-dep",\n+    "left-pad": "1.3.0"\n' +
    '   },\n   "scripts": {\n');
  r = await runCli(lockId);
  assert.equal(r.code, 1, `${r.out}${r.err}`);
  assert.equal(last().result.stage, "install", "npm ci against the clone's own lockfile");
  assert.match(last().result.log_tail ?? "", /in sync/);

  // ---- a third-party subject: fetched at its captured digests, patched, and nothing else run.
  const tpId = "aaaaaaaa-0000-0000-0000-000000000007";
  candidate = thirdPartyFor(tpId, skillPatch("Say hello.", "Say hello warmly."));
  r = await runCli(tpId);
  assert.equal(r.code, 0, `${r.out}${r.err}`);
  assert.deepEqual(last().result, { ok: true, commands: ["git apply"] });
  assert.equal(last().patch_digest, sha256(skillPatch("Say hello.", "Say hello warmly.")));
  const tpBadId = "aaaaaaaa-0000-0000-0000-000000000008";
  candidate = thirdPartyFor(tpBadId, skillPatch("Say goodbye.", "x"));
  r = await runCli(tpBadId);
  assert.equal(r.code, 1);
  assert.equal(last().result.stage, "apply");

  assert.deepEqual(leftovers(), before, "every build directory removed");
} finally {
  server.close();
  rmSync(scratch, { recursive: true, force: true });
}

console.log("ok candidate-build-live");
