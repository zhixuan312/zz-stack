#!/usr/bin/env node
/**
 * What `plugin_register` may read (subject-source.ts's `resolveSource`), driven through the real
 * reader with no network: every refusal here is decided before git or npm runs.
 *
 *   1. local_dir: a directory under the catalog root is read, with the `tree_digest` of every file
 *      it ships recorded; one outside it (`/etc`, a `..`
 *      escape) is refused, and so is one whose top-level `skills` or `flow.json` is a symlink —
 *      the shape a cloned repository or extracted tarball would use to walk the host — or that
 *      carries a symlink or a FIFO anywhere. So is a source the replay launcher would always
 *      refuse (`gitInstruction`, @zz/catalog, shared with it): a `.git` at any depth, or a
 *      `.gitattributes` assigning a filter (git-lfs's `filter=lfs`). A git or package source goes
 *      through the same reader after its fetch, so the rule is proven here once, offline.
 *   2. git: anything but https is refused (file://, http://, ssh, ext::), and so is https to a
 *      loopback, private, link-local or IPv4-mapped host — `localhost` by name included. A public
 *      host's clone is pinned to the addresses that were checked (`http.curloptResolve`), so a
 *      rebinding second lookup never happens — asserted against a stand-in `git` that records its
 *      argv, and only where this machine can resolve a public name at all.
 *   3. package: a path, a URL, `git+…`, `github:…`, `user/repo` or `file:` spec is refused as
 *      not a registry spec, and a pack whose own report unpacks past the size limit is refused
 *      before tar extracts it — asserted against a stand-in `npm` and `tar`.
 *
 * Run: node checks/plugin-register-source.ts   (also run by scripts/gate.ts)
 */
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

process.env.ZZ_CATALOG_DIR = join(process.cwd(), "catalog");

const { resolveSource } = await import(
  pathToFileURL(join(process.cwd(), "services/zz-core/dist/eval/subject-source.js")).href);

const fail: string[] = [];
const refused = async (kind: string, locator: string, why: RegExp) => {
  const got = await resolveSource(kind, locator);
  if (!("error" in got) || !why.test(got.error)) {
    fail.push(`${kind} ${locator} was not refused for ${why}: ${JSON.stringify(got).slice(0, 200)}`);
  }
};

// 1. local_dir
const inside = await resolveSource("local_dir", join(process.cwd(), "catalog/zz/zz-plugin-eval"));
if ("error" in inside || !inside.components.length) {
  fail.push(`a directory under the catalog root was not read: ${JSON.stringify(inside).slice(0, 200)}`);
} else if (!/^[0-9a-f]{64}$/.test(String(inside.identityExtra.tree_digest))) {
  fail.push(`a local_dir capture records no tree_digest for the replay launcher to check: ${JSON.stringify(inside.identityExtra)}`);
}
await refused("local_dir", "/etc", /only under the catalog root/);
await refused("local_dir", join(process.cwd(), "catalog/../services"), /only under the catalog root/);
// A throwaway directory under the catalog root, so confinement passes and the symlink rule is
// what answers.
const linked = mkdtempSync(join(process.cwd(), "catalog", ".plugin-register-source-"));
try {
  mkdirSync(join(linked, "skills-link"));
  symlinkSync("/", join(linked, "skills-link", "skills"));
  await refused("local_dir", join(linked, "skills-link"), /skills is a symlink/);
  mkdirSync(join(linked, "flow-link"));
  symlinkSync("/etc/hosts", join(linked, "flow-link", "flow.json"));
  await refused("local_dir", join(linked, "flow-link"), /flow\.json is a symlink/);
  // A plugin with one skill, and one thing wrong with it.
  const bad = async (name: string, plant: (dir: string) => void, why: RegExp) => {
    const dir = join(linked, name);
    mkdirSync(join(dir, "skills", "greet"), { recursive: true });
    writeFileSync(join(dir, "skills", "greet", "SKILL.md"), "---\nname: greet\n---\nSay hello.\n");
    plant(dir);
    await refused("local_dir", dir, why);
  };
  await bad("lfs", (d) => writeFileSync(join(d, ".gitattributes"), "*.md filter=lfs diff=lfs merge=lfs -text\n"),
    /\.gitattributes assigns a git filter/);
  await bad("nested-git", (d) => { mkdirSync(join(d, "skills", "greet", ".git")); writeFileSync(join(d, "skills", "greet", ".git", "config"), "[core]\n"); },
    /skills\/greet\/\.git is git metadata/);
  await bad("deep-link", (d) => { mkdirSync(join(d, "hooks")); symlinkSync("/etc/hosts", join(d, "hooks", "leak")); },
    /hooks\/leak is a symlink/);
  await bad("fifo", (d) => execFileSync("mkfifo", [join(d, "pipe")]), /pipe is not a regular file/);
} finally {
  rmSync(linked, { recursive: true, force: true });
}

// 2. git
for (const url of ["file:///etc", "http://example.com/x.git", "ssh://git@example.com/x.git", "ext::sh -c id"]) {
  await refused("git", url, /only https:\/\/ repositories are read|not a URL/);
}
for (const url of ["https://127.0.0.1/x.git", "https://[::1]/x.git", "https://169.254.169.254/latest",
                   "https://10.1.2.3/x.git", "https://192.168.0.1/x.git", "https://[::ffff:127.0.0.1]/x.git", "https://[::ffff:7f00:1]/x.git",
                   "https://localhost/x.git#main"]) {
  await refused("git", url, /private, loopback or link-local/);
}

// A stand-in git on PATH records the argv it was handed and fails, so nothing is fetched.
{
  const bin = mkdtempSync(join(tmpdir(), "plugin-register-source-git-"));
  const argv = join(bin, "argv");
  writeFileSync(join(bin, "git"), `#!/bin/sh\nprintf '%s\\n' "$@" >> '${argv}'\nexit 1\n`);
  chmodSync(join(bin, "git"), 0o755);
  const path = process.env.PATH;
  process.env.PATH = `${bin}:${path}`;
  try {
    const got = await resolveSource("git", "https://example.com/x.git");
    if ("error" in got && /does not resolve/.test(got.error)) {
      console.log("plugin-register-source: no DNS here, so the address pin was not exercised");
    } else {
      let seen = "";
      try { seen = readFileSync(argv, "utf8"); } catch { /* git never ran */ }
      if (!/^http\.curloptResolve=example\.com:443:\S+$/m.test(seen)) {
        fail.push(`a public clone was not pinned to its checked addresses: ${JSON.stringify(seen.slice(0, 400))}`);
      }
    }
  } finally {
    process.env.PATH = path;
    rmSync(bin, { recursive: true, force: true });
  }
}

// 3. package
for (const spec of ["./plugin", "/tmp/x.tgz", "file:../x", "git+https://example.com/x.git",
                    "github:someone/x", "someone/x", "https://example.com/x.tgz", "--registry=http://x"]) {
  await refused("package", spec, /only a registry package spec/);
}

// A stand-in npm on PATH reports a pack whose content unpacks past the limit, and writes a
// tarball the size it reports — the shape of a compression bomb. The capture is refused from npm's
// own report, before tar extracts anything.
{
  const bin = mkdtempSync(join(tmpdir(), "plugin-register-source-npm-"));
  const tarRan = join(bin, "tar-ran");
  const report = JSON.stringify([{ filename: "bomb-1.0.0.tgz", size: 1024, unpackedSize: 300 * 1024 * 1024 }]);
  writeFileSync(join(bin, "npm"), `#!/bin/sh\nwhile [ "$1" != "--pack-destination" ]; do shift; done\n` +
    `: > "$2/bomb-1.0.0.tgz"\nprintf '%s' '${report}'\n`);
  writeFileSync(join(bin, "tar"), `#!/bin/sh\n: > '${tarRan}'\nexit 1\n`);
  chmodSync(join(bin, "npm"), 0o755);
  chmodSync(join(bin, "tar"), 0o755);
  const path = process.env.PATH;
  process.env.PATH = `${bin}:${path}`;
  try {
    const got = await resolveSource("package", "bomb@1.0.0");
    if (!("error" in got) || !/unpacks to 300MB/.test(got.error)) {
      fail.push(`a pack reporting 300MB unpacked was not refused by its report: ${JSON.stringify(got).slice(0, 300)}`);
    }
    let ran = false;
    try { readFileSync(tarRan); ran = true; } catch { /* tar never ran */ }
    if (ran) fail.push("tar ran on a pack whose report was already over the limit");
  } finally {
    process.env.PATH = path;
    rmSync(bin, { recursive: true, force: true });
  }
}

if (fail.length) {
  console.error(`plugin-register-source: ${fail.length} failure(s)\n  - ${fail.join("\n  - ")}`);
  process.exit(1);
}
console.log("plugin-register-source: local_dir stays under the catalog root, git is https to a public " +
            "host, and a package is a registry spec — each refused before anything is fetched");
