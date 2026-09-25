#!/usr/bin/env node
// Candidate build isolation: what a candidate's build can reach, and what it is built from. Pure
// decisions on values, plus one real clone of a throwaway repository to prove the clone shares
// nothing with the repository it came from, and the sandbox live where this host has one.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const load = (p: string) => import(pathToFileURL(join(process.cwd(), p)).href);
const git = await load("packages/tools/dist/candidate/git.js");
const sandbox = await load("packages/tools/dist/candidate/sandbox.js");
const { detectSandbox, sandboxContext } = sandbox;

// ---- buildEnv: an allowlist. Every credential the CLI holds is absent; HOME is the build's
// temporary one.
const cliEnv = {
  PATH: "/usr/bin", LANG: "en_US.UTF-8", HOME: "/Users/operator", HTTPS_PROXY: "http://proxy.example.invalid:3128",
  ANTHROPIC_API_KEY: "sk-model", CLAUDE_CODE_OAUTH_TOKEN: "oauth-model",
  ZZ_TOKEN: "zzp_principal", ZZ_TOKEN_FILE: "/Users/operator/.zz/token", ZZ_URL: "https://prod",
  AWS_SECRET_ACCESS_KEY: "aws", GITHUB_TOKEN: "gh", NPM_TOKEN: "npm", CLAUDE_CONFIG_DIR: "/Users/operator/.claude",
};
const env = sandbox.buildEnv(cliEnv, "/tmp/h");
assert.equal(env.HOME, "/tmp/h", "HOME is the build's temporary one, never the operator's");
assert.equal(env.TMPDIR, "/tmp/h/tmp", "TMPDIR is inside the build home — the only writable place besides the tree");
assert.equal(env.PATH, "/usr/bin");
assert.equal(env.HTTPS_PROXY, "http://proxy.example.invalid:3128", "a proxy npm ci needs reaches it");
for (const k of ["ZZ_TOKEN", "ZZ_TOKEN_FILE", "ZZ_URL", "ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN",
                 "AWS_SECRET_ACCESS_KEY", "GITHUB_TOKEN", "NPM_TOKEN", "CLAUDE_CONFIG_DIR"]) {
  assert.equal(env[k], undefined, `${k} must never reach a candidate's build`);
}
assert.ok(!Object.values(env).includes("zzp_principal"), "the principal's PAT appears nowhere in the build env");

// ---- the subject's release: tag name and the lock comparison.
assert.equal(git.releaseTagFor("0.76.0"), "v0.76.0");
const lock = { "zz-plugin-eval": { version: "0.76.0", digest: "c6144b51", skills: {} } };
assert.equal(git.releaseLockMismatch(lock, "zz-plugin-eval", "0.76.0", "c6144b51"), null);
assert.match(git.releaseLockMismatch(lock, "zz-plugin-eval", "0.76.0", "deadbeef"), /content digest c6144b51/);
assert.match(git.releaseLockMismatch(lock, "zz-plugin-eval", "0.75.0", "c6144b51"), /version 0.76.0/);
assert.match(git.releaseLockMismatch(lock, "sdlc", "0.76.0", "c6144b51"), /records no plugin 'sdlc'/);
assert.match(git.releaseLockMismatch(null, "sdlc", "0.76.0", "c6144b51"), /records no plugin/);

// ---- a real clone: detached at the tag, its own object store, no remote back at the source.
const src = mkdtempSync(join(tmpdir(), "zz-candidate-src-"));
const g = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const slug = `isolation-check-${process.pid}`;
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

  const clone: { ref: string; path: string; gitDir: string; commit: string } = git.createWorktree(src, slug, "0.76.0");
  wt = clone;
  assert.equal(clone.ref, "refs/tags/v0.76.0", "the clone's ref is the base subject's release tag");
  assert.equal(clone.commit, tagged, "the clone sits at the release tag, not the source's HEAD");
  assert.equal(existsSync(join(clone.path, "later.txt")), false);
  assert.ok(!clone.gitDir.startsWith(`${clone.path}/`), "the build's repository is outside the tree");
  assert.equal(readFileSync(join(clone.path, ".git"), "utf8"), `gitdir: ${clone.gitDir}\n`,
    "the tree carries only a gitfile naming it, for the gate's own git");
  assert.equal(existsSync(join(clone.gitDir, "objects", "info", "alternates")), false,
    "the clone borrows no object store from the source");
  assert.equal(g(clone.path, "remote"), "", "the clone keeps no remote pointing back at the source");
  assert.equal(g(clone.path, "status", "--porcelain"), "", "the gate's git sees a clean tree through the gitfile");
  assert.equal(g(src, "worktree", "list").split("\n").length, 1, "the source registers no worktree");
  assert.equal(g(src, "for-each-ref", "--format=%(refname)").split("\n").filter((r) => !r.startsWith("refs/tags/") && !r.startsWith("refs/heads/")).length, 0,
    "the source gains no ref of the build's");
  assert.deepEqual(git.readReleaseLock(clone.path), lock);
  git.removeWorktree(clone);
  assert.equal(existsSync(clone.path), false);
  assert.equal(existsSync(clone.gitDir), false, "the repository goes with the tree");

  assert.throws(() => git.createWorktree(src, slug, "9.9.9"), /no release tag v9\.9\.9/,
    "a subject with no release tag is refused, never replaced by HEAD");
  assert.equal(existsSync(git.worktreePathFor(slug)), false, "a refused clone leaves nothing behind");
} finally {
  if (wt) git.removeWorktree(wt);
  rmSync(git.buildDirFor(slug), { recursive: true, force: true });
  rmSync(src, { recursive: true, force: true });
}

// ---- the OS sandbox, on values: Seatbelt rule order is the policy (later rules win), a
// re-allowed path gets metadata on its ancestors only, bwrap covers before it binds back, and a
// re-allow that would uncover a whole denied root is refused.
const spec = {
  denyRead: [{ path: "/Users/op", dir: true }, { path: "/etc/zz-token", dir: false }],
  allowRead: ["/Users/op/.local/share/npm"],
  writable: ["/private/tmp/h", "/private/tmp/clone"],
};
const profile = sandbox.seatbeltProfile(spec);
const at = (needle: string) => { const i = profile.indexOf(needle); assert.ok(i >= 0, `profile lacks ${needle}`); return i; };
assert.ok(at("(allow default)") < at('(deny file-read* (subpath "/Users/op") (subpath "/etc/zz-token"))'));
assert.ok(at("(deny file-read*") < at('(allow file-read* (subpath "/Users/op/.local/share/npm")'),
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
assert.ok(idx("--tmpfs", "/Users/op") < idx("--ro-bind", "/Users/op/.local/share/npm", "/Users/op/.local/share/npm"),
  "the re-allow is bound back on top of the cover, not under it");
assert.ok(idx("--bind", "/private/tmp/clone", "/private/tmp/clone") > 0);
assert.deepEqual(bw.slice(-2), ["--chdir", "/private/tmp/clone"]);
const cmd = sandbox.sandboxedCommand("bwrap", spec, "npm", ["ci", "x"], "/private/tmp/clone");
assert.equal(cmd.file, "bwrap");
assert.deepEqual(cmd.argv.slice(-4), ["--", "npm", "ci", "x"]);
assert.deepEqual(sandbox.sandboxedCommand("sandbox-exec", spec, "npm", ["ci"], "/").argv.slice(0, 1), ["-p"]);

// ---- the OS sandbox, live: a throwaway "home" holding a token file stands in for the operator's
// real one (the real token is never touched). Inside the sandbox that file cannot be read by
// absolute path, the build home can, a re-allowed install path under the fake home can, and
// nothing outside the writable paths can be written.
const tool = detectSandbox();
if (!tool) {
  console.log(`  (live sandbox half not run: no working sandbox-exec/bwrap on ${process.platform} here — ` +
    "candidate-build refuses to build on such a host)");
} else {
  const fakeHome = realpathSync(mkdtempSync(join(tmpdir(), "zz-fake-home-")));
  const buildHome = realpathSync(mkdtempSync(join(tmpdir(), "zz-fake-build-home-")));
  try {
    mkdirSync(join(fakeHome, ".zz"));
    writeFileSync(join(fakeHome, ".zz", "token"), "zzp_not_a_real_token");
    mkdirSync(join(fakeHome, "tools"));
    writeFileSync(join(fakeHome, "tools", "install.txt"), "install");
    writeFileSync(join(buildHome, "ok.txt"), "ok");
    const live = { denyRead: [{ path: fakeHome, dir: true }], allowRead: [join(fakeHome, "tools")], writable: [buildHome] };
    const run = (bin: string, args: string[]) => {
      const c = sandbox.sandboxedCommand(tool, live, bin, args, buildHome);
      return execFileSync(c.file, c.argv, { cwd: buildHome, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    };
    assert.throws(() => run("/bin/cat", [join(fakeHome, ".zz", "token")]),
      "a sandboxed read of the (fake) operator home's token by absolute path must fail");
    assert.equal(run("/bin/cat", [join(buildHome, "ok.txt")]), "ok", "the build home stays readable");
    assert.equal(run("/bin/cat", [join(fakeHome, "tools", "install.txt")]), "install",
      "a re-allowed install path under the denied home stays readable");
    assert.throws(() => run("/bin/sh", ["-c", `echo x > ${join(fakeHome, "tools", "planted")}`]),
      "a re-allowed path is read-only");
    assert.equal(existsSync(join(fakeHome, "tools", "planted")), false);
    run("/bin/sh", ["-c", `echo written > ${join(buildHome, "w.txt")}`]);
    assert.equal(readFileSync(join(buildHome, "w.txt"), "utf8").trim(), "written", "the build home stays writable");
    const outside = join(tmpdir(), `zz-sandbox-outside-${process.pid}`);
    assert.throws(() => run("/bin/sh", ["-c", `echo x > ${outside}`]), "nothing outside the writable paths is writable");
    assert.equal(existsSync(outside), false);

    // The whole temporary directory is denied — another build's home and tree live there — and
    // only this build's own home is bound back.
    const ctx = sandboxContext(tool, process.cwd(), "git");
    assert.ok(ctx.denyRead.some((d: { path: string }) => d.path === realpathSync(tmpdir())), "the real tmpdir is denied");
    const sibling = realpathSync(mkdtempSync(join(tmpdir(), "zz-candidate-home-")));
    try {
      writeFileSync(join(sibling, "secret.txt"), "another build's file");
      const scoped = { denyRead: ctx.denyRead, allowRead: ctx.allowRead, writable: [buildHome] };
      const inCtx = (args: string[]) => {
        const c = sandbox.sandboxedCommand(tool, scoped, "/bin/cat", args, buildHome);
        return execFileSync(c.file, c.argv, { cwd: buildHome, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      };
      assert.throws(() => inCtx([join(sibling, "secret.txt")]), "another build's home under tmpdir is unreadable");
      assert.equal(inCtx([join(buildHome, "ok.txt")]), "ok", "the build's own home, under the denied tmpdir, is readable");
    } finally {
      rmSync(sibling, { recursive: true, force: true });
    }
  } finally {
    rmSync(fakeHome, { recursive: true, force: true });
    rmSync(buildHome, { recursive: true, force: true });
  }
}

console.log("ok candidate-isolation-pure");
