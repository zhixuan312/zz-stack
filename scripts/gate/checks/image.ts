/**
 * The image, and what may enter it.
 *
 * Split out of build.mjs, which had grown to hold two subjects: whether this workspace COMPILES
 * — tsc, the manifests, the lockfile, what a package may import — and what the Docker build
 * actually puts in the artefact people run. The two fail for different reasons and are read by
 * different people: one by whoever broke the build, the other by whoever is about to ship.
 *
 * Every rule here encodes something that shipped. A fixture directory that reached production, a
 * stale dist baked in from a dirty context, an image with no git in it for a store that is a git
 * repository, and two Dockerfiles building the same name.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { manifestPaths } from "../../manifests.ts";
import { flows } from "../facts.ts";
import { gateOwnSource, root, sourceFiles, trackedFiles } from "../read.ts";
import { check } from "../run.ts";

check("no fixture directory enters the image", () => {
  // A flow's tests directory is requirements, steps and expectations — it can run to megabytes.
  // Nothing at runtime reads them — eval-judge and eval-grade do, at test time, from the
  // repository. They were shipping because `COPY catalog /catalog` takes the whole tree and
  // .dockerignore's `runs` pattern matches the context ROOT only, so the nested one sailed
  // through. A fixture in a release image is weight, and worse, it is a second copy of the
  // expectations that can disagree with the first.
  const ignore = readFileSync(join(root, ".dockerignore"), "utf8");
  const shipped = [];
  for (const f of flows) {
    const t = join(f.dir, "tests");
    if (existsSync(t)) shipped.push(`catalog/${f.owner}/${f.flow}/tests`);
  }
  if (!shipped.length) return null;
  if (!/^catalog\/\*\*\/tests$/m.test(ignore)) {
    return `${shipped.join(", ")} enter the image — .dockerignore needs 'catalog/**/tests'`;
  }
  return null;
});

check("the build context cannot carry a stale dist into the image", () => {
  // `npm run build` is `tsc -b`, which is INCREMENTAL, and the Dockerfile COPYs packages/
  // and services/ wholesale. With no .dockerignore, a build run on a machine that has ever
  // built locally hands tsc that machine's dist/ and .tsbuildinfo — and tsc can then decide
  // there is nothing to recompile. The image ships whatever the developer's tree held, with
  // no error, and nothing about the running container would say so.
  const p = join(root, ".dockerignore");
  if (!existsSync(p)) return "no .dockerignore — the build context includes every local dist/";
  // Pattern LINES, not a substring of the file: a comment saying "excludes node_modules and
  // dist" satisfied all three while excluding nothing. Every other check here that searched
  // a whole document for a bare word has been fooled by prose eventually; this one had not
  // been yet, and there is no reason to wait.
  const patterns = new Set(readFileSync(p, "utf8").split("\n")
    .map((l) => l.trim()).filter((l) => l && !l.startsWith("#")));
  // The PATTERN that does the job, not the word. Substring matching passed on `dist/release`
  // — a line that excludes one directory at the repo root and none of packages/*/dist, which
  // is the whole point of the rule.
  const needs: [string, string[]][] = [
    ["packages/*/dist", ["**/dist", "*/*/dist"]],
    ["node_modules anywhere", ["**/node_modules"]],
    ["tsc's incremental state", ["**/*.tsbuildinfo", "*.tsbuildinfo"]],
  ];
  const missing = needs.filter(([, any]) => !any.some((g) => patterns.has(g))).map(([what]) => what);
  return missing.length ? `.dockerignore does not exclude: ${missing.join("; ")}` : null;
});

check("the image installs from the manifests, then copies the source", () => {
  // The Dockerfile said "Manifests first, so a change to source does not invalidate the
  // install layer" directly above `COPY packages packages` / `COPY services services` and
  // then `RUN npm ci`. The comment described the intent and the lines did the opposite: every
  // source edit invalidated the install, so a release build reinstalled the whole dependency
  // tree to compile one changed line. Verified both ways against the daemon — with the split,
  // `RUN npm ci` reports CACHED after a source edit.
  //
  // TWO PROPERTIES, and the second is why this is a check rather than a comment. Docker has
  // no glob for "every package.json two levels down", so the members are listed by hand — and
  // a member left off that list does NOT fail loudly. npm's workspace glob simply matches
  // fewer directories, installs less, and the image ships missing a package's dependencies.
  // manifestPaths() is where tsconfig.json's references and set-version.mjs already get this
  // same list, so there is one answer to "what are this repository's packages" and three
  // readers of it.
  const src = readFileSync(join(root, "Dockerfile"), "utf8");
  const lines = src.split("\n");
  const install = lines.findIndex((l) => /^RUN npm ci\s*$/.test(l));
  if (install < 0) return "the Dockerfile no longer runs `npm ci` in the build stage";
  const bad: string[] = [];

  const copied = new Set<string>();
  lines.slice(0, install).forEach((l) => {
    const m = /^COPY\s+(\S+\/package\.json)\s/.exec(l);
    if (m) copied.add(m[1]);
  });
  const wanted = manifestPaths(root).filter((m) => m !== "package.json");
  for (const m of wanted) {
    if (!copied.has(m)) {
      bad.push(`${m} is a workspace package and the build stage does not copy it before ` +
               "`npm ci` — npm's glob then matches one directory fewer and installs less, " +
               "silently");
    }
  }
  for (const c of copied) {
    if (!wanted.includes(c)) bad.push(`the Dockerfile copies ${c}, which is not a workspace package`);
  }
  // BEFORE the install, not anywhere in the file. The runtime stage copies the root manifest
  // and lockfile too, so a whole-file match was answered by that second stage and reported the
  // build stage as fine with the line deleted from it. Found by mutation, and it is the same
  // shape as the two-stage prune this Dockerfile already carries a paragraph about: in a
  // multi-stage file, "the Dockerfile does X" is never the question — which stage is.
  if (!lines.slice(0, install).some((l) => /^COPY package\.json package-lock\.json/.test(l))) {
    bad.push("the build stage does not copy the root package.json and lockfile before `npm ci`");
  }

  // And the source AFTER, which is the whole point: a COPY of the tree above the install
  // puts every edit in the install layer's hash.
  for (const dir of ["packages", "services"]) {
    const at = lines.findIndex((l) => new RegExp(`^COPY ${dir} ${dir}\\s*$`).test(l));
    if (at < 0) bad.push(`the build stage never copies ${dir}/ — it cannot compile`);
    else if (at < install) {
      bad.push(`COPY ${dir} ${dir} comes before \`npm ci\`, so editing one source file ` +
               "reinstalls the entire dependency tree");
    }
  }
  return bad.length ? bad.join("; ") : null;
});

check("a store the team can walk away with has git in the image", () => {
  // Every act that changes a team's store is a commit authored by whoever made it, so the
  // repository carries the attribution even after this platform is gone. node:alpine does
  // not ship git, and commitStore never throws — so without it every write would succeed,
  // log `git_failed`, and leave a store with no history that nobody notices until they go
  // looking for one. A silent degradation of the one property that makes the store portable.
  const df = readFileSync(join(root, "Dockerfile"), "utf8");
  const runtime = df.slice(df.lastIndexOf("\nFROM "));
  return /apk add[^\n]*\bgit\b/.test(runtime)
    ? null
    : "the runtime stage installs no git — commitStore would fail silently on every write";
});

check("one image, one recipe", () => {
  // There were two Dockerfiles building the same image: the root one, which
  // docker-compose.build.yml uses for development, and deploy/ts.Dockerfile, which
  // scripts/release.mjs used for the RELEASE. They had drifted where it mattered most — the
  // root installs git and says why (commitStore never throws, so without it every document
  // write succeeds, logs `git_failed`, and leaves a team's store with no history), and
  // ts.Dockerfile did not. Verified: node:22-alpine ships no git.
  //
  // So development built an image that could commit a store and production built one that
  // could not, and the check for exactly that read the root Dockerfile — passing, correctly,
  // about a file production was not built from. Every guarantee this gate makes about the
  // image is made about ONE file, so there has to be one.
  const named = new Map<string, string>();   // repo-relative path -> who names it
  // Repo-relative, or null for anything outside this checkout. zz-blocks is a sibling repo
  // with a Dockerfile of its own, reached through `context: ../../zz-blocks`; it is built by
  // this release and is not ours to make claims about, which is what the compose check
  // beside this one already says.
  const ours = (abs: string) => (abs === root || abs.startsWith(`${root}/`)) ? abs.slice(root.length + 1) : null;
  for (const f of sourceFiles(["scripts", "deploy", "testing"], [".ts", ".sh"])) {
    // Not this file. It quotes `docker build -f -` while explaining why that was wrong, and
    // a checker that reads its own prose as evidence finds a third recipe called "-".
    if (gateOwnSource(f)) continue;
    const src = readFileSync(join(root, f), "utf8");
    // A build invocation, not every -f in the file: `docker inspect -f {{.State.Running}}`
    // is a format string and reads exactly like a Dockerfile path to a looser pattern.
    for (const m of src.matchAll(/\[\s*"build"[\s\S]{0,300}?\]/g)) {
      const df = /"-f",\s*"([^"]+)"/.exec(m[0]);
      if (df) named.set(df[1], f);
    }
    for (const m of src.matchAll(/docker build\b[^\n]*?-f\s+(\S+)/g)) named.set(m[1], f);
  }
  for (const name of ["deploy/docker-compose.yml", "deploy/docker-compose.build.yml"]) {
    if (!existsSync(join(root, name))) continue;
    const text = readFileSync(join(root, name), "utf8");
    for (const [, ctx, df] of text.matchAll(/context:\s*(\S+)[\s\S]{0,120}?dockerfile:\s*(\S+)/g)) {
      // Relative to the context, which is relative to the compose file's own directory.
      const rel = ours(join(root, "deploy", ctx, df));
      if (rel) named.set(rel, name);
    }
  }
  if (!named.size) return "nothing in this repo names a Dockerfile — this check reads nothing";

  const bad = [];
  if (named.size > 1) {
    bad.push(`${named.size} recipes for one image: ` +
             [...named].map(([d, by]) => `${d} (${by})`).join(", "));
  }
  // A Dockerfile nobody builds from is the other half of the same defect: it is what the
  // next person edits, and what this gate's image checks would go on reading.
  for (const f of trackedFiles() ?? []) {
    if (!/(^|\/)Dockerfile$|\.Dockerfile$/.test(f)) continue;
    if (!named.has(f)) bad.push(`${f} is a Dockerfile nothing builds from`);
  }
  for (const [d] of named) {
    if (!existsSync(join(root, d))) bad.push(`${d} is built from and does not exist`);
  }
  return bad.length ? bad.join("; ") : null;
});
