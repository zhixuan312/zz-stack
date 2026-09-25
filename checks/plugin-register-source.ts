#!/usr/bin/env node
/**
 * What `plugin_register` may read (subject-source.ts's `resolveSource`), driven through the real
 * reader with no network: every refusal here is decided before git or npm runs.
 *
 *   1. local_dir: a directory under the catalog root is read; one outside it (`/etc`, a `..`
 *      escape) is refused, and so is one whose top-level `skills` or `flow.json` is a symlink —
 *      the shape a cloned repository or extracted tarball would use to walk the host.
 *   2. git: anything but https is refused (file://, http://, ssh, ext::), and so is https to a
 *      loopback, private, link-local or IPv4-mapped host — `localhost` by name included. A public
 *      host's clone is pinned to the addresses that were checked (`http.curloptResolve`), so a
 *      rebinding second lookup never happens — asserted against a stand-in `git` that records its
 *      argv, and only where this machine can resolve a public name at all.
 *   3. package: a path, a URL, `git+…`, `github:…`, `user/repo` or `file:` spec is refused as
 *      not a registry spec.
 *
 * Run: node checks/plugin-register-source.ts   (also run by scripts/gate.ts)
 */
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

if (fail.length) {
  console.error(`plugin-register-source: ${fail.length} failure(s)\n  - ${fail.join("\n  - ")}`);
  process.exit(1);
}
console.log("plugin-register-source: local_dir stays under the catalog root, git is https to a public " +
            "host, and a package is a registry spec — each refused before anything is fetched");
