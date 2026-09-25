#!/usr/bin/env node
// Replay isolation (0.76.0 release review): what a candidate session can reach, who can move a
// run through its lifecycle, how long a run lives against how long a launch can take, and what
// the launcher installs. Pure decisions on values, plus one real clone of a throwaway repository
// to prove the clone shares nothing with the repository it came from.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const load = (p: string) => import(pathToFileURL(join(process.cwd(), p)).href);
const plan = await load("packages/tools/dist/replay/plan.js");
const git = await load("packages/tools/dist/replay/git.js");
const sandbox = await load("packages/tools/dist/replay/sandbox.js");
const { detectSandbox, sandboxContext } = await load("packages/tools/dist/replay/session.js");
const { candidateCredentialRefusal, lifecycleGuard } = await load("services/zz-core/dist/eval/replay-close.js");
const { REPLAY_RUN_TTL_MS } = await load("services/zz-core/dist/eval/replay-runs.js");

// ---- candidateEnv: an allowlist. Every credential the launcher holds is absent; HOME is the
// temporary one; the candidate's only ZZ credential is its own replay PAT.
const launcherEnv = {
  PATH: "/usr/bin", LANG: "en_US.UTF-8", HOME: "/Users/operator",
  ANTHROPIC_API_KEY: "sk-model", CLAUDE_CODE_OAUTH_TOKEN: "oauth-model",
  ZZ_TOKEN: "zzp_principal", ZZ_TOKEN_FILE: "/Users/operator/.zz/token", ZZ_URL: "https://prod",
  REPLAY_TOKEN: "zzp_replay_cli", VERIFIER_TOKEN: "vt-secret", VERIFIER_ANYTHING: "x",
  AWS_SECRET_ACCESS_KEY: "aws", GITHUB_TOKEN: "gh", CLAUDE_CONFIG_DIR: "/Users/operator/.claude",
};
const cand = plan.candidateEnv(launcherEnv, {
  home: "/tmp/h", configDir: "/tmp/h/.claude", replayToken: "zzp_run", gatewayUrl: "http://gw",
});
assert.equal(cand.HOME, "/tmp/h", "HOME is the session's temporary one, never the operator's");
assert.equal(cand.CLAUDE_CONFIG_DIR, "/tmp/h/.claude");
assert.equal(cand.TMPDIR, "/tmp/h/tmp", "TMPDIR is inside the session home — the only writable place besides the clone");
assert.equal(cand.ZZ_TOKEN, "zzp_run", "the candidate's ZZ_TOKEN is its own replay PAT, not the principal's");
assert.equal(cand.ZZ_URL, "http://gw");
assert.equal(cand.ANTHROPIC_API_KEY, "sk-model", "the model credential still reaches the session");
assert.equal(cand.CLAUDE_CODE_OAUTH_TOKEN, "oauth-model");
assert.equal(cand.PATH, "/usr/bin");
for (const k of ["REPLAY_TOKEN", "VERIFIER_TOKEN", "VERIFIER_ANYTHING", "ZZ_TOKEN_FILE",
                 "AWS_SECRET_ACCESS_KEY", "GITHUB_TOKEN"]) {
  assert.equal(cand[k], undefined, `${k} must never reach a replay session`);
}
assert.ok(!Object.values(cand).includes("zzp_principal"), "the principal's PAT appears nowhere in the session env");
assert.ok(!Object.values(cand).includes("vt-secret"), "the verifier token appears nowhere in the session env");
const person = plan.candidateEnv(launcherEnv, { home: "/tmp/p", configDir: "/tmp/p/.claude" });
assert.equal(person.ZZ_TOKEN, undefined, "the simulated person holds no platform credential at all");
assert.equal(person.ZZ_URL, undefined);

// ---- lifecycleGuard: the candidate's credential, another principal, and a terminal run are
// each refused; the launcher's own credential on a live run is not.
const run = { principal: "a@x", team_slug: "replay-sdlc-a1b2c3d4", status: "running" };
assert.equal(lifecycleGuard("replay_close", { principal: "a@x", patTeam: null }, run), null);
assert.equal(lifecycleGuard("replay_begin", { principal: "a@x", patTeam: null }, { ...run, status: "registered" }), null);
assert.equal(lifecycleGuard("replay_close", { principal: "a@x", patTeam: "some-team" }, run), null,
  "a principal's token bound to an unrelated team is still the principal");
assert.match(lifecycleGuard("replay_close", { principal: "a@x", patTeam: "replay-sdlc-a1b2c3d4" }, run),
  /candidate's credential/, "the run's own team credential — same principal — is refused");
assert.match(lifecycleGuard("replay_begin", { principal: "a@x", patTeam: "replay-sdlc-a1b2c3d4" }, run),
  /candidate's credential/);
assert.match(lifecycleGuard("replay_close", { principal: "b@x", patTeam: null }, run),
  /principal who started this run/);
for (const status of ["completed", "failed", "cancelled", "not_replayable"]) {
  assert.match(lifecycleGuard("replay_close", { principal: "a@x", patTeam: null }, { ...run, status }),
    new RegExp(`already ${status}`), `a ${status} run is never closed again — a sweep's cancel stands`);
}

assert.equal(candidateCredentialRefusal("replay_score", null, "replay-sdlc-a1b2c3d4"), null);
assert.equal(candidateCredentialRefusal("replay_score", "other-team", "replay-sdlc-a1b2c3d4"), null);
assert.match(candidateCredentialRefusal("replay_score", "replay-sdlc-a1b2c3d4", "replay-sdlc-a1b2c3d4"),
  /^ERROR: replay_score refuses a credential scoped to the run's own replay team/);
assert.match(candidateCredentialRefusal("replay_score", "replay-sdlc-99999999", "replay-sdlc-a1b2c3d4"),
  /^ERROR: replay_score refuses a credential scoped to another run's replay team \('replay-sdlc-99999999'\)/,
  "another run's candidate credential is refused too — same principal, different run");
assert.match(lifecycleGuard("replay_close", { principal: "a@x", patTeam: "replay-other-12345678" }, run),
  /candidate's credential/, "replay_close refuses any replay- credential, not only the run's own");

// ---- the TTL outlasts the launcher's worst case, with room for the calls around it.
assert.equal(typeof REPLAY_RUN_TTL_MS, "number");
const worst = plan.launchWorstCaseMs(plan.MAX_TURNS_CAP);
assert.ok(REPLAY_RUN_TTL_MS >= worst + 10 * 60_000,
  `REPLAY_RUN_TTL_MS (${REPLAY_RUN_TTL_MS}) must exceed the launcher's worst case (${worst}) by 10 minutes`);
assert.ok(plan.launchWorstCaseMs(plan.MAX_TURNS_CAP + 1) > worst, "the worst case grows with the turn cap");

// ---- the subject's release: tag name and the lock comparison.
assert.equal(plan.releaseTagFor("0.76.0"), "v0.76.0");
const lock = { "zz-plugin-eval": { version: "0.76.0", digest: "c6144b51", skills: {} } };
assert.equal(plan.releaseLockMismatch(lock, "zz-plugin-eval", "0.76.0", "c6144b51"), null);
assert.match(plan.releaseLockMismatch(lock, "zz-plugin-eval", "0.76.0", "deadbeef"), /content digest c6144b51/);
assert.match(plan.releaseLockMismatch(lock, "zz-plugin-eval", "0.75.0", "c6144b51"), /version 0.76.0/);
assert.match(plan.releaseLockMismatch(lock, "sdlc", "0.76.0", "c6144b51"), /records no plugin 'sdlc'/);
assert.match(plan.releaseLockMismatch(null, "sdlc", "0.76.0", "c6144b51"), /records no plugin/);

// ---- a real clone: detached at the tag, its own object store, no remote back at the source.
const src = mkdtempSync(join(tmpdir(), "zz-replay-src-"));
const g = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const slug = `replay-check-${process.pid}`;
let wt: { path: string; commit: string } | undefined;
try {
  g(src, "init", "-q");
  g(src, "config", "user.email", "check@example.invalid");
  g(src, "config", "user.name", "check");
  g(src, "config", "commit.gpgsign", "false");
  g(src, "config", "tag.gpgsign", "false");
  writeFileSync(join(src, "plugins.lock.json"), JSON.stringify(lock));
  g(src, "add", "plugins.lock.json");
  g(src, "commit", "-q", "-m", "release");
  g(src, "tag", "v0.76.0");
  const tagged = g(src, "rev-parse", "HEAD");
  writeFileSync(join(src, "later.txt"), "operator's HEAD moved on");
  g(src, "add", "later.txt");
  g(src, "commit", "-q", "-m", "later");

  const clone: { ref: string; path: string; commit: string } = git.createWorktree(src, slug, "0.76.0");
  wt = clone;
  assert.equal(clone.ref, "refs/tags/v0.76.0", "the clone's ref is the release tag replay_start records");
  assert.equal(clone.commit, tagged, "the clone sits at the release tag, not the source's HEAD");
  assert.equal(existsSync(join(clone.path, "later.txt")), false);
  assert.equal(existsSync(join(clone.path, ".git", "objects", "info", "alternates")), false,
    "the clone borrows no object store from the source");
  assert.equal(g(clone.path, "remote"), "", "the clone keeps no remote pointing back at the source");
  assert.equal(g(src, "worktree", "list").split("\n").length, 1, "the source registers no worktree");
  assert.equal(g(src, "for-each-ref", "refs/replay/"), "", "the source gains no refs/replay/* ref");
  assert.deepEqual(git.readReleaseLock(clone.path), lock);
  git.removeWorktree(clone);
  assert.equal(existsSync(clone.path), false);

  assert.throws(() => git.createWorktree(src, slug, "9.9.9"), /no release tag v9\.9\.9/,
    "a subject with no release tag is refused, never replaced by HEAD");
  assert.equal(existsSync(join(tmpdir(), "zz-replay", `replay-${slug}`)), false,
    "a refused clone leaves nothing behind");
} finally {
  if (wt) git.removeWorktree(wt);
  rmSync(src, { recursive: true, force: true });
}

// ---- the OS sandbox, on values: Seatbelt rule order is the policy (later rules win), a
// re-allowed path gets metadata on its ancestors only, bwrap covers before it binds back, and a
// re-allow that would uncover a whole denied root is refused.
const spec = {
  denyRead: [{ path: "/Users/op", dir: true }, { path: "/etc/zz-token", dir: false }],
  allowRead: ["/Users/op/.local/share/claude"],
  writable: ["/private/tmp/h", "/private/tmp/clone"],
};
const profile = sandbox.seatbeltProfile(spec);
const at = (needle: string) => { const i = profile.indexOf(needle); assert.ok(i >= 0, `profile lacks ${needle}`); return i; };
assert.ok(at("(allow default)") < at('(deny file-read* (subpath "/Users/op") (subpath "/etc/zz-token"))'));
assert.ok(at("(deny file-read*") < at('(allow file-read* (subpath "/Users/op/.local/share/claude")'),
  "the re-allow comes after the deny, or the deny would win");
assert.ok(profile.includes('(allow file-read-metadata (literal "/Users/op") (literal "/Users/op/.local") (literal "/Users/op/.local/share"))'),
  "metadata on each ancestor down to the re-allowed path, and nothing else under the denied root");
assert.ok(at("(deny file-write*)") < at('(allow file-write* (subpath "/private/tmp/h") (subpath "/private/tmp/clone") (subpath "/dev"))'));
assert.ok(profile.includes('(subpath "/private/tmp/h")') && !/allow file-write\*[^\n]*\/Users\/op/.test(profile),
  "nothing under the denied home is writable");
assert.match(sandbox.seatbeltProfile({ denyRead: [{ path: '/a"b\\c', dir: true }], allowRead: [], writable: [] }),
  /\(subpath "\/a\\"b\\\\c"\)/, "a quote or backslash in a path cannot end the Seatbelt string early");
assert.throws(() => sandbox.seatbeltProfile({ ...spec, allowRead: ["/Users"] }), /would re-allow all of denied/);
assert.throws(() => sandbox.bwrapArgs({ ...spec, writable: ["/Users/op"] }, "/"), /would re-allow all of denied/);
const bw: string[] = sandbox.bwrapArgs(spec, "/private/tmp/clone");
const firstMount = bw.indexOf("--ro-bind");
assert.deepEqual(bw.slice(0, firstMount), [...sandbox.BWRAP_NAMESPACES], "fresh namespaces (network shared back) before any mount");
assert.deepEqual(bw.slice(firstMount, firstMount + 3), ["--ro-bind", "/", "/"], "the root goes in read-only first");
const idx = (...a: string[]) => bw.findIndex((_: string, i: number) => a.every((x, j) => bw[i + j] === x));
assert.ok(idx("--tmpfs", "/Users/op") > 0, "a denied directory is covered by an empty tmpfs");
assert.ok(idx("--ro-bind", "/dev/null", "/etc/zz-token") > 0, "a denied file is covered by /dev/null");
assert.ok(idx("--tmpfs", "/Users/op") < idx("--ro-bind", "/Users/op/.local/share/claude", "/Users/op/.local/share/claude"),
  "the re-allow is bound back on top of the cover, not under it");
assert.ok(idx("--bind", "/private/tmp/clone", "/private/tmp/clone") > 0);
assert.deepEqual(bw.slice(-2), ["--chdir", "/private/tmp/clone"]);
const cmd = sandbox.sandboxedCommand("bwrap", spec, "claude", ["-p", "x"], "/private/tmp/clone");
assert.equal(cmd.file, "bwrap");
assert.deepEqual(cmd.argv.slice(-4), ["--", "claude", "-p", "x"]);
assert.deepEqual(sandbox.sandboxedCommand("sandbox-exec", spec, "claude", ["-p"], "/").argv.slice(0, 1), ["-p"]);

// ---- the OS sandbox, live: a throwaway "home" holding a token file stands in for the operator's
// real one (the real token is never touched). Inside the sandbox that file cannot be read by
// absolute path, the session home can, a re-allowed install path under the fake home can, and
// nothing outside the writable paths can be written.
const tool = detectSandbox();
if (!tool) {
  console.log(`  (live sandbox half not run: no working sandbox-exec/bwrap on ${process.platform} here — ` +
    "the launcher refuses to start on such a host)");
} else {
  const fakeHome = realpathSync(mkdtempSync(join(tmpdir(), "zz-fake-home-")));
  const sessionHome = realpathSync(mkdtempSync(join(tmpdir(), "zz-fake-session-")));
  try {
    mkdirSync(join(fakeHome, ".zz"));
    writeFileSync(join(fakeHome, ".zz", "token"), "zzp_not_a_real_token");
    mkdirSync(join(fakeHome, "tools"));
    writeFileSync(join(fakeHome, "tools", "install.txt"), "install");
    writeFileSync(join(sessionHome, "ok.txt"), "ok");
    const live = { denyRead: [{ path: fakeHome, dir: true }], allowRead: [join(fakeHome, "tools")], writable: [sessionHome] };
    const run = (bin: string, args: string[]) => {
      const c = sandbox.sandboxedCommand(tool, live, bin, args, sessionHome);
      return execFileSync(c.file, c.argv, { cwd: sessionHome, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    };
    assert.throws(() => run("/bin/cat", [join(fakeHome, ".zz", "token")]),
      "a sandboxed read of the (fake) operator home's token by absolute path must fail");
    assert.equal(run("/bin/cat", [join(sessionHome, "ok.txt")]), "ok", "the session home stays readable");
    assert.equal(run("/bin/cat", [join(fakeHome, "tools", "install.txt")]), "install",
      "a re-allowed install path under the denied home stays readable");
    assert.throws(() => run("/bin/sh", ["-c", `echo x > ${join(fakeHome, "tools", "planted")}`]),
      "a re-allowed path is read-only");
    assert.equal(existsSync(join(fakeHome, "tools", "planted")), false);
    run("/bin/sh", ["-c", `echo written > ${join(sessionHome, "w.txt")}`]);
    assert.equal(readFileSync(join(sessionHome, "w.txt"), "utf8").trim(), "written", "the session home stays writable");
    const outside = join(tmpdir(), `zz-sandbox-outside-${process.pid}`);
    assert.throws(() => run("/bin/sh", ["-c", `echo x > ${outside}`]), "nothing outside the writable paths is writable");
    assert.equal(existsSync(outside), false);

    // R2 item 4: the whole temporary directory is denied — another session's home (and its
    // run-scoped PAT) lives there — and only this session's own home is bound back.
    const ctx = sandboxContext(tool, process.cwd(), "git");
    assert.ok(ctx.denyRead.some((d: { path: string }) => d.path === realpathSync(tmpdir())), "the real tmpdir is denied");
    const sibling = realpathSync(mkdtempSync(join(tmpdir(), "zz-replay-home-")));
    try {
      writeFileSync(join(sibling, "mcp.json"), "zzp_other_run_token");
      const scoped = { denyRead: ctx.denyRead, allowRead: ctx.allowRead, writable: [sessionHome] };
      const inCtx = (args: string[]) => {
        const c = sandbox.sandboxedCommand(tool, scoped, "/bin/cat", args, sessionHome);
        return execFileSync(c.file, c.argv, { cwd: sessionHome, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      };
      assert.throws(() => inCtx([join(sibling, "mcp.json")]), "another session's home under tmpdir is unreadable");
      assert.equal(inCtx([join(sessionHome, "ok.txt")]), "ok", "the session's own home, under the denied tmpdir, is readable");
    } finally {
      rmSync(sibling, { recursive: true, force: true });
    }
  } finally {
    rmSync(fakeHome, { recursive: true, force: true });
    rmSync(sessionHome, { recursive: true, force: true });
  }
}

console.log("ok replay-isolation-pure");
