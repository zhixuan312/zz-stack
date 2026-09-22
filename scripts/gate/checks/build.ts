/**
 * The code compiles, and the artifact that ships is the code that compiled.
 *
 * FIRST, and the order is load-bearing rather than tidy: several checks here RUN something
 * instead of reading it, and everything in every other module may rely on the build having
 * succeeded. A check that needs `dist/` guards itself with `unbuilt()`, but a gate that
 * reported forty failures because nothing had been built would bury the one real answer.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { manifestPaths } from "../../manifests.ts";
import { asRecord, readJson, root, sourceFiles, trackedFiles, unbuilt } from "../read.ts";
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

/* ── 0. the code compiles, and everything after this may rely on it ─────────
 *
 * FIRST, not last. Eight checks here RUN something rather than read it — the identity
 * resolver's ordering, the credential resolver's precedence, the acting-team rule, the two
 * emitted schemas, the classifier, the markdown sanitiser, the monitor's silence — because
 * each is a claim about behaviour that any inspection of the source would have passed. They
 * need the compiled output, and this check is what produces it.
 *
 * With it last, a fresh checkout failed all eight with eight different "could not be run"
 * messages, built as a side effect, and passed on a second run. "Run it twice" is not an
 * answer, and eight cryptic failures with one cause is worse than one plain one. */

check("tsc -b", () => {
  try {
    execFileSync("npm", ["run", "-s", "build"], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
    return null;
  } catch (err) {
    const { stdout, stderr } = execFields(err);
    return String(stdout ?? stderr ?? err).slice(-600);
  }
});

/* THE BUG tsc CANNOT SEE, BECAUSE `tsc -b` DOES NOT LOOK AT `.mjs`.
 *
 * `scripts/` is plain ESM and outside every tsconfig, so a name used but never imported is a
 * ReferenceError that waits for the line to be REACHED. That is not a hypothetical: splitting
 * release.ts left `verify.ts` using PUBLIC, die and envToken without importing them and
 * `build.ts` using die and dryRun the same way. The dry run was green both times — build.ts's
 * eleven sit inside a branch that is skipped when the console is already at its target version,
 * and verify.ts's are in step 5, which does not run in a dry run at all. So 0.26.1 deployed,
 * failed six of eleven verifications with "PUBLIC is not defined", and rolled itself back. The
 * platform was healthy the whole time; the thing checking it was not.
 *
 * The rollback worked, which is the only reason that cost minutes instead of a morning. A
 * release step that cannot run is still a release step that will run one day, on the day it is
 * least convenient, so it is checked here where the answer is free.
 *
 * TS2304 AND TS2552 ONLY. checkJs over untyped ESM reports plenty besides — implicit any,
 * missing types on a destructure — and none of that is a defect in a script. "Cannot find name"
 * is, every time. */

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
  // WHO RUNS IT is the boundary between the three script surfaces, and testing/ is the one
  // that drives a RUNNING DEPLOYMENT by hand. See ARCHITECTURE.md.
  //
  // LENGTH IS THE WRONG TEST and this check was written with it first, with a ninety-line
  // ceiling that caught shell drivers for being long — and they are long because the protocol
  // they drive is long, not because they compute.
  //
  // The real line is COMPUTATION versus ORCHESTRATION. A file that touches no deployment and
  // no database is not driving anything: it is a program, it belongs where programs are
  // compiled and tested, and in testing/ nothing imports it and no test reaches it.
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
  // Three MCP servers each declared their own — "2.0.0", "1.0.0" — while the packages were
  // at 0.2.0, and that literal is what initialize hands every client as serverInfo.version.
  // Nothing failed; clients were simply told a number no release had produced.
  const bad: string[] = [];
  for (const rel of sourceFiles(["services", "packages"], [".ts"])) {
    const txt = readFileSync(join(root, rel), "utf8");
    // Line-wise and context-based, not a fixed `version: "x.y.z"` shape. The shape
    // missed `version: "${f.version || "1.0.0"}"` — a literal inside a template, which
    // is the same invented number arriving by a different route, and it shipped in
    // every generated command for a flow whose install recorded no version.
    //
    // "0.0.0" is exempt: it is the sentinel for "the manifest could not be read", which
    // is an honest unknown rather than a claim about a release.
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
  // set-version.ts calls itself "the one place this repo's version is set" and argues the
  // case in its own first paragraph: "keeping them in step by hand is a step that can be
  // half-done, and half-done is invisible: the build passes, the deploy succeeds, and the
  // wrong number ships". It rewrote seven manifests and the compose file and left the
  // LOCKFILE, which records a version nine times — the root, each of the seven workspace
  // members, and the top-level one npm writes beside the name.
  //
  // So package-lock.json said 0.4.0 while every manifest said 0.4.1, and 0.4.0 is the release
  // that was built, deployed, rolled back and spent — the number the changelog says "can never
  // mean anything else". `npm ci` tolerates the mismatch, verified both ways, so nothing said
  // anything: exactly the invisible half-done the script exists to prevent.
  //
  // Its sibling "every package manifest carries the same version" reads manifestPaths(), which
  // is the list of package.json files. The lockfile is not one, which is why it could drift
  // past a check whose name sounds like it covers this.
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
  // `npm run build` is `tsc -b`, which builds the project REFERENCES in tsconfig.json —
  // another hand-kept list of the same packages that set-version.ts and this file's first
  // check used to keep by hand. A package added under packages/ or services/ and not added
  // here compiles when you point tsc at it directly and is silently absent from the build
  // the image runs, the gate runs, and the release ships.
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
  // Only the root manifest carried `"private": true`. `npm publish` inside any of the five
  // workspace packages — or `npm publish -w` naming one — would push this platform's source
  // to the public registry, and services/gateway is the identity and credential layer.
  // Nothing else stands in the way: they have no license field either, so npm's own
  // unlicensed-package warning is the last line of defence.
  const bad = manifestPaths(root)
    .filter((m) => JSON.parse(readFileSync(join(root, m), "utf8")).private !== true)
    .map((m) => `${m} is not marked private`);
  return bad.length ? bad.join("; ") : null;
});

check("every service has source, not just build output", () => {
  // services/ops-core survived a rename as a dist/ with no src/ — invisible to git, since
  // dist is ignored, and harmless until the image started listing that directory to tell a
  // reader which services it could run. Then it began offering a service that cannot start.
  // It was also being COPYed into every image.
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
  // block-conformance printed ✗ against a block that failed a published requirement, or
  // "unreachable" against one that answered nothing, and exited 0. Its main() returned None
  // and was called bare. Anything running it in a release or a pipeline read that as a pass —
  // which is the same defect manifest-audit's own comment records having had: "It printed FAIL
  // and returned success."
  //
  // The convention is the check: main() returns a number and the entry point is
  // `process.exit(main(...))` or `process.exit(await main(...))`.
  //
  // This does not prove an engine's status is CORRECT — nothing static can. It makes the shape
  // one where a status exists and is read, so returning the wrong one is a visible choice
  // rather than the default.
  const bad: string[] = [];
  // ENTRY POINTS ONLY: a module an engine imports has no exit status to get wrong.
  // `toolEntryPoints` asks "what does nothing import" rather than "what has a main()", which
  // would go quiet on the file that lost the very thing this rule is about.
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

check("a shell that invokes an evaluation tool passes the flow it means", () => {
  // eval-judge, eval-grade and eval-store require --flow and have no default, so a caller
  // without it exits 2. measure-variance.sh was missed when the other three were migrated, and
  // its call is wrapped in `|| true` with the output redirected — so it would have failed
  // SILENTLY, the script printing "0 judged" and carrying on.
  //
  // The miss happened because the migration checked the three files someone had already decided
  // were the callers, rather than asking which files call. This asks.
  const dir = join(root, "testing");
  const bad: string[] = [];
  // TRACKED, SO ITS ABSENCE IS A DEFECT. `testing/` is committed; a checkout without it is a
  // broken one, and returning null here meant this check reported nothing at exactly the
  // moment it had nothing to read.
  if (!existsSync(dir)) return "testing/ does not exist, so no suite caller could be read at all";
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".sh"))) {
    const lines = readFileSync(join(dir, f), "utf8").split("\n");
    // A CALL CAN WEAR A VARIABLE'S NAME. judge-all.sh and deviate-all.sh do
    // `J=packages/tools/dist/testing/eval-judge.js` and then `node "$J" ...`, so a check
    // matching only the literal path inspects measure-variance.sh — the one script that WAS
    // broken — and never the two that were fixed. That is guarding the exception and leaving
    // the rule unwatched. Collect the variables holding an eval-tool path first, then treat a
    // call through any of them as a call.
    const alias = new Set<string>();
    for (const line of lines) {
      const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)=.*eval-(judge|grade|store)(\.js)?\b/.exec(line);
      if (m) alias.add(m[1]);
    }
    const callsATool = (line: string): boolean =>
      /eval-(judge|grade|store)(\.js)?\b/.test(line) ||
      [...alias].some((v) => new RegExp(`\\$\\{?${v}\\b`).test(line));
    lines.forEach((line, i) => {
      if (/^\s*(#|printf|echo)/.test(line)) return;          // a comment or a printed hint is not a call
      if (/^\s*[A-Za-z_][A-Za-z0-9_]*=/.test(line)) return;  // assigning the path is not a call
      if (!callsATool(line)) return;
      if (!/--flow\b/.test(line)) {
        bad.push(`testing/${f}:${i + 1} invokes an evaluation tool without --flow, which exits 2`);
      }
    });
  }
  return bad.length ? bad.join("; ") : null;
});

check("a built package holds together", () => {
  const nothingToRun = unbuilt();
  if (nothingToRun) return nothingToRun;
  // The largest untested surface here: everything a person actually installs comes out of
  // buildClientPackage, and nothing offline could look at one. CATALOG_DIR was hardcoded to
  // the in-image path, so no test outside a container could build a package at all and the
  // only possible check was a regex over the source. It takes an override now, and this
  // builds real packages for all three clients and asserts what the module says about
  // itself.
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
    const call = src.slice(i, end + 1);
    if (!/,\s*true\s*[,)]/.test(call)) continue;      // only the ones expecting an ERROR
    if (/,\s*true\s*,\s*\//.test(call)) continue;       // has the pattern
    const line = src.slice(0, i).split("\n").length;
    bad.push(`chain-check.ts:${line} expects a refusal without saying which: ` +
             `${(lines[line - 1] ?? "").trim().slice(0, 70)}`);
  }
  return bad.join("\n");
});

check("the repository ships one runtime", () => {
  // "Everything is TypeScript. There is no Python left" is stated in the changelog, in
  // STATE.md §6b and in the README's opening line, and nothing enforced it. Thirteen files
  // were ported this release for one operational reason: a deploy host runs containers and
  // has no toolchain, which is why the Python that existed had to be standard-library-only
  // and why the tools now run in the image that is already there, through deploy/zz-tool.
  //
  // A single .py added back reintroduces that constraint silently — it would run on a
  // developer's laptop and not on the host, which is the worst order to find out in. Tracked
  // files only: `runs/` and `docs/support/` are gitignored working directories and hold
  // plenty, none of it shipped.
  const belongs = trackedFiles();
  if (!belongs) return null;                          // not a git checkout: nothing to read
  const bad = [...belongs].filter((f) => f.endsWith(".py"));
  return bad.length
    ? `${bad.join(", ")} — the repository is TypeScript, and a deploy host has no Python. ` +
      `Put it in packages/tools with an npm script, the way the thirteen ported ones went`
    : null;
});

check("a package that imports a workspace package declares it", () => {
  // npm workspaces hoist, so `import { manifestAt } from "@zz/catalog"` RESOLVES from any
  // package here whether or not that package depends on it. The build passes, the tests pass,
  // and the dependency exists only as an accident of what somebody else installed.
  //
  // Two things then quietly stop being true. `npm install` in a checkout that resolves
  // differently has no reason to provide it. And `tsc -b` builds a package's project
  // REFERENCES first — so a package that imports across the workspace without referencing it
  // compiles against whatever `dist` happens to be lying there, which after a rename is the
  // previous shape of the module.
  //
  // Found on @zz/tools, which imported @zz/catalog from two files, declared it in neither
  // package.json nor tsconfig.json, and built cleanly because every other package's build
  // had already produced it.
  //
  // The root tsconfig check above covers a different thing: that the BUILD reaches every
  // package. This is about each package naming what it actually uses.
  const bad: string[] = [];
  // THE ROOT IS A PACKAGE TOO, and it was the one left out. Its own code is scripts/ — nothing
  // else at the top level is TypeScript or JavaScript we build — and scripts/probes/
  // envelope-shape.ts imports @zz/contracts, which resolved for exactly the reason the
  // paragraph above refuses everywhere else: npm hoists every workspace member into the root's
  // node_modules whether the root asked for it or not.
  //
  // Given its own entry rather than folded into the loop: the loop derives a package's sources
  // from its directory, and the root's directory is the whole repository, so it would have
  // claimed every import in every member as the root's own.
  const ROOTS: [string, string[]][] = [["package.json", ["scripts"]],
                 ...manifestPaths(root).filter((m) => m !== "package.json")
                   .map((m): [string, string[]] => [m, [m.replace(/\/package\.json$/, "")]])];
  for (const [manifest, srcDirs] of ROOTS) {
    const dir = manifest.replace(/\/?package\.json$/, "");
    const pkg = JSON.parse(readFileSync(join(root, manifest), "utf8"));
    // devDependencies count for the ROOT, whose @zz import is a dev script — the probes the
    // gate runs. A workspace member's runtime import must be a runtime dependency.
    const declared = new Set<string>([...Object.keys(pkg.dependencies ?? {}),
                              ...(dir ? [] : Object.keys(pkg.devDependencies ?? {}))]);
    let refs = new Set<string>();
    const tsconfig = dir ? join(dir, "tsconfig.json") : "tsconfig.json";
    if (existsSync(join(root, tsconfig))) {
      const cfg = JSON.parse(readFileSync(join(root, tsconfig), "utf8"));
      // A reference is a PATH; the name it resolves to is the package.json it points at.
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
    // .mjs too, and it is where the root's only such import is. The loop read .ts alone
    // because every workspace member is TypeScript; the root's code is scripts/, which is not.
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
  // serviceVersion exists because three servers each declared a literal — "2.0.0", "1.0.0" —
  // while the packages were at 0.2.0, and that literal is what `initialize` hands every
  // client as serverInfo.version. Its docblock: "three servers, three different wrong
  // numbers, none of which moved when the platform did".
  //
  // client-package then carried a byte-for-byte copy of the READ — the same dirname, the
  // same `join(here, "..", "package.json")`, the same "0.0.0" on failure — to stamp the
  // version into every plugin.json and into the shelf digest that decides whether a runtime
  // notices a changed skill. One number, found two ways, is one rename from being two
  // numbers.
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
  const http = readFileSync(join(root, "packages/mcp-http/src/index.ts"), "utf8");
  if (!/export function serviceVersion\(/.test(http)) {
    bad.push("@zz/mcp-http no longer exports serviceVersion, so every caller must read the " +
             "manifest itself again");
  }
  return bad.length ? bad.join("; ") : null;
});

/* AN npm SCRIPT THAT CANNOT RUN, which is the direction nothing was checking.
 *
 * "every tool in packages/tools is reachable from zz-tool" already asks whether each TOOL has
 * a way to be run. It cannot catch the reverse — a script whose tool is gone — and three had
 * accumulated: `provision` named a provisioner deleted when the front end went, `smoke` and
 * `classify-cases` named a testing engine that is no longer in the tree. Each fails with a
 * node "Cannot find module" against a dist path, which reads as a build problem rather than
 * as a script that should not exist.
 *
 * The source file, not the dist path: dist is a build artifact and may be absent or stale in
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
