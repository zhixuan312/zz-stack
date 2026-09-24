/**
 * The code compiles, and the artifact that ships is the code that compiled.
 *
 * DELIBERATE: this module runs first, and the order is load-bearing. Checks in every module
 * may rely on the build having succeeded; one plain failure here beats forty elsewhere.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { manifestPaths } from "../../manifests.ts";
import { asRecord, readJson, root, sourceFiles, trackedFiles, unbuilt, withoutComments} from "../read.ts";
import { check, note } from "../run.ts";
import { MANIFESTS, catalogRoot, toolEntryPoints } from "../facts.ts";

/** A caught value is never typed as an Error — narrow the shape actually being read rather
 *  than assume it. Here it is an `execFileSync` failure, which carries `stdout`/`stderr`
 *  rather than a plain `message`; each is `undefined` exactly when the original untyped
 *  `err.stdout`/`err.stderr` would have been, so callers keep their own `??` chains. */
function execFields(err: unknown): { stdout: string | undefined; stderr: string | undefined } {
  if (err && typeof err === "object") {
    const e = err as Record<string, unknown>;
    return {
      stdout: e.stdout !== undefined ? String(e.stdout) : undefined,
      stderr: e.stderr !== undefined ? String(e.stderr) : undefined,
    };
  }
  return { stdout: undefined, stderr: undefined };
}

/* The code compiles, and everything after this may rely on it. Several checks in this gate
 * run the compiled output rather than reading source, so this check is what produces it. */

check("tsc -b", () => {
  try {
    execFileSync("npm", ["run", "-s", "build"], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
    return null;
  } catch (err) {
    const { stdout, stderr } = execFields(err);
    return String(stdout ?? stderr ?? err).slice(-600);
  }
});

check("every package manifest carries the same version", () => {
  const seen = MANIFESTS.map((m): [string, unknown] => [m, asRecord(readJson(m), m).version]);
  const versions = [...new Set(seen.map(([, v]) => v))];
  if (versions.length !== 1) {
    return seen.map(([m, v]) => `${m}=${v}`).join(", ");
  }
  note(`      version ${versions[0]}`);
  return null;
});

check("nothing in testing/ computes — it drives, and the computing lives in packages/tools", () => {
  // Who runs it is the boundary between the three script surfaces, and testing/ is the one
  // that drives a running deployment by hand. See ARCHITECTURE.md.
  //
  // The line is computation versus orchestration, not length. A file that touches no
  // deployment and no database is a program, and in testing/ nothing imports it and no test
  // reaches it.
  const dir = join(root, "testing");
  const bad: string[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".ts")) continue;                   // a shell is a driver by construction
    const body = readFileSync(join(dir, f), "utf8");
    const code = body.split("\n")
      .filter((l) => l.trim() && !/^\s*(#|\/\/|\*|\/\*)/.test(l.trim())).join("\n");
    if (!/\bfetch\s*\(|createServer|execFileSync|execSync|spawnSync|psql/.test(code)) {
      bad.push(`testing/${f} reaches no deployment and no database, so it computes rather ` +
               "than drives. Move it to packages/tools/src/testing and leave a caller.");
    }
  }
  return bad.length ? bad.join("; ") : null;
});

check("no version is written as a literal in the source", () => {
  // A version literal in the source is a number no release produced — and it is what
  // `initialize` hands every client as serverInfo.version.
  const bad: string[] = [];
  for (const rel of sourceFiles(["services", "packages"], [".ts"])) {
    const txt = readFileSync(join(root, rel), "utf8");
    // Line-wise and context-based, not a fixed `version: "x.y.z"` shape, which misses a
    // literal inside a template.
    //
    // DELIBERATE: "0.0.0" is exempt — it is the sentinel for a manifest that could not be
    // read, not a claim about a release.
    txt.split("\n").forEach((raw, i) => {
      const line = raw.trim();
      if (line.startsWith("//") || line.startsWith("*") || line.startsWith("/*")) return;
      if (!/version/i.test(line)) return;
      for (const m of line.matchAll(/"(\d+\.\d+\.\d+)"/g)) {
        if (m[1] === "0.0.0") continue;
        bad.push(`${rel}:${i + 1}: "${m[1]}" — derive it, never write it`);
      }
    });
  }
  return bad.length ? bad.join("; ") : null;
});

check("the lockfile records the version this release ships", () => {
  // package-lock.json records a version once per workspace member plus twice at the top, and
  // `npm ci` tolerates a mismatch with the manifests, so drift is silent.
  //
  // COUPLED: the sibling check "every package manifest carries the same version" reads
  // manifestPaths(), which is package.json files only — the lockfile is not one of them.
  const want = asRecord(readJson("package.json"), "package.json").version;
  const lock = asRecord(readJson("package-lock.json"), "package-lock.json");
  const packages = typeof lock.packages === "object" && lock.packages !== null
    ? lock.packages as Record<string, unknown> : {};
  const bad: string[] = [];
  if (lock.version !== want) {
    bad.push(`package-lock.json's own version is ${lock.version}, and package.json is ${want}`);
  }
  const members = manifestPaths(root).filter((m) => m !== "package.json")
    .map((m) => m.replace(/\/package\.json$/, ""));
  let seen = 0;
  for (const [where, rawEntry] of Object.entries(packages)) {
    // A node_modules entry is a dependency's own version and is not ours to hold.
    if (where.startsWith("node_modules/")) continue;
    if (where !== "" && !members.includes(where)) {
      bad.push(`the lockfile records a workspace at ${where}, which is not a package here`);
      continue;
    }
    const entryVersion = rawEntry && typeof rawEntry === "object" && "version" in rawEntry
      ? (rawEntry as Record<string, unknown>).version : undefined;
    if (typeof entryVersion !== "string") continue;
    seen++;
    if (entryVersion !== want) {
      bad.push(`the lockfile says ${where || "the root"} is ${entryVersion}, and its ` +
               `package.json says ${want}`);
    }
  }
  if (seen <= members.length) {
    bad.push(`only ${seen} workspace versions found in the lockfile for ${members.length + 1} ` +
             "packages — the shape moved and this check would pass by reading almost nothing");
  }
  for (const m of members) {
    if (!(m in packages)) bad.push(`${m} is a workspace package and the lockfile has no entry for it`);
  }
  return bad.length ? bad.join("; ") : null;
});

check("the workspace build covers every package", () => {
  // `npm run build` is `tsc -b`, which builds the project references in tsconfig.json. A
  // package not referenced there compiles when tsc is pointed at it directly and is silently
  // absent from the build the image runs, the gate runs, and the release ships.
  const expected = manifestPaths(root)
    .filter((m) => m !== "package.json")
    .map((m) => m.replace(/\/package\.json$/, ""))
    .sort();
  const tsconfigJson = asRecord(readJson("tsconfig.json"), "tsconfig.json");
  const rawRefs = Array.isArray(tsconfigJson.references) ? tsconfigJson.references : [];
  const refs = rawRefs
    .map((r: unknown) => {
      const p = r && typeof r === "object" && "path" in r ? (r as Record<string, unknown>).path : "";
      return String(p).replace(/^\.\//, "").replace(/\/$/, "");
    })
    .sort();
  const missing = expected.filter((e) => !refs.includes(e));
  const extra = refs.filter((r) => !expected.includes(r));
  const bad = [
    ...missing.map((m) => `${m} is a workspace package and tsconfig.json does not reference it`),
    ...extra.map((x) => `tsconfig.json references ${x}, which is not a workspace package`),
  ];
  return bad.length ? bad.join("; ") : null;
});

check("no workspace package can be published by accident", () => {
  // `npm publish` inside a workspace package, or `npm publish -w` naming one, pushes this
  // platform's source to the public registry unless that package is marked private. Nothing
  // else stands in the way — no package here declares a license either.
  const bad = manifestPaths(root)
    .filter((m) => JSON.parse(readFileSync(join(root, m), "utf8")).private !== true)
    .map((m) => `${m} is not marked private`);
  return bad.length ? bad.join("; ") : null;
});

check("every service has source, not just build output", () => {
  // A dist/ with no src/ is invisible to git, because dist is ignored — but the image lists
  // services/ to say which ones it can run, and COPYs every one of them in.
  const bad: string[] = [];
  for (const d of readdirSync(join(root, "services"), { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    if (!existsSync(join(root, "services", d.name, "src"))) {
      bad.push(`services/${d.name} has no src/ — dead build output from a rename?`);
    }
  }
  return bad.length ? bad.join("; ") : null;
});

check("a testing engine's exit status comes from its results", () => {
  // The convention is the check: main() returns a number and the entry point is
  // `process.exit(main(...))` or `process.exit(await main(...))`. An engine that prints a
  // failure and exits 0 reads as a pass to a release or a pipeline.
  //
  // It does not prove the status is correct, only that one exists and is read.
  const bad: string[] = [];
  // Entry points only: a module an engine imports has no exit status to get wrong.
  // `toolEntryPoints` asks what nothing imports, rather than what has a main() — which would
  // go quiet on the file that lost the thing this rule is about.
  for (const f of [...toolEntryPoints("packages/tools/src/testing"),
                   ...toolEntryPoints("packages/tools/src/ops")]) {
    const src = readFileSync(join(root, f), "utf8");
    if (!/function main\(/.test(src)) { bad.push(`${f}: has no main()`); continue; }
    if (!/function main\([^)]*\):\s*(Promise<number>|number)/.test(src)) {
      bad.push(`${f}: main() does not return a status`);
    }
    if (!/process\.exit\((await )?main\(/.test(src)) bad.push(`${f}: __main__ drops main()'s status`);
  }
  return bad.length ? bad.join("; ") : null;
});

check("a built package holds together", () => {
  const nothingToRun = unbuilt();
  if (nothingToRun) return nothingToRun;
  // Everything a person installs comes out of buildClientPackage. This builds a real package
  // through the catalog-dir override, and asserts what the module says
  // about itself.
  try {
    const out = execFileSync("node", [join(root, "scripts/probes/package-shape.ts")],
                             { encoding: "utf8", env: { ...process.env, ZZ_CATALOG_DIR: catalogRoot, ZZ_SKILLS_DIR: join(root, "skills") } });
    return out.trim() || null;
  } catch (err) {
    return `a package could not be built: ${String(execFields(err).stderr ?? err).slice(-300)}`;
  }
});

check("a probe that expects a refusal says which refusal", () => {
  const src = readFileSync(join(root, "packages/tools/src/testing/chain-check.ts"), "utf8");
  const lines = src.split("\n");
  const bad: string[] = [];
  // The whole call, not the line: these wrap across two and three lines.
  for (const m of src.matchAll(/\bcheck\(/g)) {
    let i = m.index, depth = 0, end = i;
    for (; end < src.length; end++) {
      if (src[end] === "(") depth += 1;
      else if (src[end] === ")") { depth -= 1; if (depth === 0) break; }
    }
    const call = withoutComments(src.slice(i, end + 1));
    if (!/,\s*true\s*[,)]/.test(call)) continue;      // only the ones expecting an error
    if (/,\s*true\s*,\s*\//.test(call)) continue;       // has the pattern
    const line = src.slice(0, i).split("\n").length;
    bad.push(`chain-check.ts:${line} expects a refusal without saying which: ` +
             `${(lines[line - 1] ?? "").trim().slice(0, 70)}`);
  }
  return bad.join("\n");
});

check("the repository ships one runtime", () => {
  // A deploy host runs containers and has no toolchain, so a .py would run on a laptop and
  // not on the host. Tracked files only: `runs/` and `docs/support/` are gitignored working
  // directories and nothing in them ships.
  const belongs = trackedFiles();
  if (!belongs) return null;                          // not a git checkout: nothing to read
  const bad = [...belongs].filter((f) => f.endsWith(".py"));
  return bad.length
    ? `${bad.join(", ")} — the repository is TypeScript, and a deploy host has no Python. ` +
      `Put it in packages/tools with an npm script, the way the thirteen ported ones went`
    : null;
});

check("a package that imports a workspace package declares it", () => {
  // npm workspaces hoist, so a cross-package import resolves whether or not the package
  // depends on it: the build passes and the dependency exists only as an accident of what
  // somebody else installed. `tsc -b` builds a package's project references first, so an
  // undeclared import compiles against whatever `dist` happens to be lying there.
  //
  // COUPLED: the check above covers whether the build reaches every package; this covers
  // whether each package names what it uses.
  const bad: string[] = [];
  // The root is a package too — its own code is scripts/ — and it gets its own entry rather
  // than being folded into the loop, which derives a package's sources from its directory.
  // The root's directory is the whole repository.
  const ROOTS: [string, string[]][] = [["package.json", ["scripts"]],
                 ...manifestPaths(root).filter((m) => m !== "package.json")
                   .map((m): [string, string[]] => [m, [m.replace(/\/package\.json$/, "")]])];
  for (const [manifest, srcDirs] of ROOTS) {
    const dir = manifest.replace(/\/?package\.json$/, "");
    const pkg = JSON.parse(readFileSync(join(root, manifest), "utf8"));
    // devDependencies count for the root, whose @zz imports are the probes the gate runs. A
    // workspace member's runtime import must be a runtime dependency.
    const declared = new Set<string>([...Object.keys(pkg.dependencies ?? {}),
                              ...(dir ? [] : Object.keys(pkg.devDependencies ?? {}))]);
    let refs = new Set<string>();
    const tsconfig = dir ? join(dir, "tsconfig.json") : "tsconfig.json";
    if (existsSync(join(root, tsconfig))) {
      const cfg = JSON.parse(readFileSync(join(root, tsconfig), "utf8"));
      // A reference is a path; the name it resolves to is in the package.json it points at.
      for (const r of cfg.references ?? []) {
        const at = join(dir, String(r.path), "package.json");
        try {
          refs.add(JSON.parse(readFileSync(join(root, at), "utf8")).name);
        } catch {
          bad.push(`${tsconfig} references ${r.path}, which has no package.json`);
        }
      }
    }
    const used = new Set<string>();
    for (const rel of sourceFiles(srcDirs, [".ts"])) {
      for (const m of readFileSync(join(root, rel), "utf8")
        .matchAll(/^\s*import\s[^;]*?from\s+"(@zz\/[a-z-]+)"/gm)) {
        used.add(m[1]);
      }
    }
    for (const name of [...used].sort()) {
      if (name === pkg.name) continue;            // a package may import from itself
      const who = dir || "the root package";
      if (!declared.has(name)) {
        bad.push(`${who} imports ${name} and ${manifest} does not depend on it — it resolves ` +
                 "today only because npm hoists");
      }
      if (!refs.has(name)) {
        bad.push(`${who} imports ${name} and ${tsconfig} does not reference it — tsc -b will ` +
                 "not rebuild it first, so it compiles against whatever dist is there");
      }
    }
  }
  return bad.length ? bad.join("; ") : null;
});

check("a package's own version is read in one place", () => {
  // @zz/mcp-http's serviceVersion is the one read of a package.json. A second copy of that
  // read — the same dirname, the same join, the same "0.0.0" on failure — is one rename from
  // being a second number, and this one is stamped into every plugin.json and into the shelf
  // digest that decides whether a runtime notices a changed skill.
  const bad: string[] = [];
  for (const rel of sourceFiles(["packages", "services"], [".ts"])) {
    if (rel === "packages/mcp-http/src/index.ts") continue;      // where the read lives
    const src = readFileSync(join(root, rel), "utf8");
    src.split("\n").forEach((ln, i) => {
      if (/^\s*(\/\/|\*|\/\*)/.test(ln)) return;
      if (/readFileSync\([^)]*package\.json/.test(ln)) {
        bad.push(`${rel}:${i + 1} reads a package.json itself — @zz/mcp-http's serviceVersion ` +
                 "is that read, and a second one is one rename from being a second number");
      }
    });
  }
  const http = withoutComments(readFileSync(join(root, "packages/mcp-http/src/index.ts"), "utf8"));
  if (!/export function serviceVersion\(/.test(http)) {
    bad.push("@zz/mcp-http no longer exports serviceVersion, so every caller must read the " +
             "manifest itself again");
  }
  return bad.length ? bad.join("; ") : null;
});

/* An npm script whose tool is gone fails with node's "Cannot find module" against a dist
 * path, which reads as a build problem rather than as a script that should not exist.
 *
 * COUPLED: "every tool in packages/tools is reachable from zz-tool" asks the other direction.
 *
 * DELIBERATE: the source file is checked, not the dist path — dist may be absent or stale in
 * a fresh checkout, so checking it would fail for the wrong reason. */
check("every npm script that runs a built tool has a source file", () => {
  const pkg = asRecord(readJson("package.json"), "package.json");
  const scripts = typeof pkg.scripts === "object" && pkg.scripts !== null
    ? pkg.scripts as Record<string, unknown> : {};
  const bad: string[] = [];
  for (const [name, cmd] of Object.entries(scripts)) {
    if (typeof cmd !== "string") continue;
    const m = /node ((?:packages|services)\/[\w/-]+)\/dist\/([\w/-]+)\.js/.exec(cmd);
    if (!m) continue;
    const src = `${m[1]}/src/${m[2]}.ts`;
    if (!existsSync(join(root, src))) bad.push(`${name} -> ${src}`);
  }
  return bad.length
    ? `${bad.join("; ")} — the script names a tool this repository does not have`
    : null;
});
