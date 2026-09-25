/**
 * The image, and what may enter it.
 *
 * COUPLED: split from build.ts, which holds the other subject — whether this workspace compiles
 * (tsc, the manifests, the lockfile, what a package may import). This file is about what the Docker
 * build actually puts in the artefact people run. The two fail for different reasons and are read by
 * different people.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { manifestPaths } from "../../manifests.ts";
import { flows } from "../facts.ts";
import { gateOwnSource, root, sourceFiles, trackedFiles } from "../read.ts";
import { check } from "../run.ts";

check("no fixture directory enters the image", () => {
  // A flow's tests directory is requirements, steps and expectations. Nothing at runtime reads
  // it; testing/eval-step.sh reads it from the repository. `COPY catalog /catalog` takes the
  // whole tree, so .dockerignore has to exclude it by its own pattern.
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
  // `npm run build` is `tsc -b`, which is incremental, and the Dockerfile COPYs packages/ and
  // services/ wholesale. With no .dockerignore, a build run on a machine that has ever built locally
  // hands tsc that machine's dist/ and .tsbuildinfo, and tsc can then decide there is nothing to
  // recompile: the image ships whatever the developer's tree held, with no error.
  const p = join(root, ".dockerignore");
  if (!existsSync(p)) return "no .dockerignore — the build context includes every local dist/";
  // Pattern lines, not a substring of the file: a comment saying "excludes node_modules and dist"
  // satisfies all three while excluding nothing.
  const patterns = new Set(readFileSync(p, "utf8").split("\n")
    .map((l) => l.trim()).filter((l) => l && !l.startsWith("#")));
  // The pattern that does the job, not the word. Substring matching passes on `dist/release` — a
  // line that excludes one directory at the repo root and none of packages/*/dist.
  const needs: [string, string[]][] = [
    ["packages/*/dist", ["**/dist", "*/*/dist"]],
    ["node_modules anywhere", ["**/node_modules"]],
    ["tsc's incremental state", ["**/*.tsbuildinfo", "*.tsbuildinfo"]],
  ];
  const missing = needs.filter(([, any]) => !any.some((g) => patterns.has(g))).map(([what]) => what);
  return missing.length ? `.dockerignore does not exclude: ${missing.join("; ")}` : null;
});

check("every .gitignore pattern is mirrored in .dockerignore, so no ignored file enters the image", () => {
  // A release checks the tree is clean, and `git status` does not show ignored files: a `*.pem`
  // or `.env` lying in the build context reaches a published image unless .dockerignore drops it
  // too. Translated to Docker's rules: a .gitignore pattern with no slash but a trailing one
  // matches at any depth, a .dockerignore pattern only at the root — so `x` or `x/` needs `**/x`,
  // and one with an inner slash is anchored in both. A negation re-includes; excluding more from
  // the image is the safe direction, so negations are not mirrored.
  const lines = (f: string) => readFileSync(join(root, f), "utf8").split("\n")
    .map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
  const docker = new Set(lines(".dockerignore"));
  const missing: string[] = [];
  for (const pattern of new Set(lines(".gitignore"))) {
    if (pattern.startsWith("!")) continue;
    const bare = pattern.replace(/\/+$/, "");
    const anchored = bare.replace(/^\//, "");
    const want = bare.includes("/") ? anchored : `**/${bare}`;
    // A plain `x` or an anchored `x` also covers the root-only case; `**/x` covers every depth.
    if (!docker.has(want)) missing.push(`${pattern} (needs '${want}')`);
  }
  return missing.length ? `.dockerignore does not mirror: ${missing.join(", ")}` : null;
});

check("the image installs from the manifests, then copies the source", () => {
  // Manifests are copied before the source, so a change to source does not invalidate the install
  // layer. Interleaved, every source edit reinstalls the whole dependency tree to compile one line.
  //
  // Two properties, and the second is why this is a check rather than a comment. Docker has no glob
  // for "every package.json two levels down", so the members are listed by hand — and a member left
  // off that list does not fail loudly: npm's workspace glob matches fewer directories, installs
  // less, and the image ships missing a package's dependencies. manifestPaths() is where
  // tsconfig.json's references and set-version.ts already get this same list.
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
  // Before the install, not anywhere in the file. The runtime stage copies the root manifest and
  // lockfile too, so a whole-file match is answered by that second stage and reports the build stage
  // as fine with the line deleted from it. In a multi-stage file, which stage is the question.
  if (!lines.slice(0, install).some((l) => /^COPY package\.json package-lock\.json/.test(l))) {
    bad.push("the build stage does not copy the root package.json and lockfile before `npm ci`");
  }

  // And the source after, which is the whole point: a COPY of the tree above the install puts every
  // edit in the install layer's hash.
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
  // Every act that changes a team's store is a commit authored by whoever made it, so the repository
  // carries the attribution even after this platform is gone. node:alpine ships no git, and
  // commitStore never throws — so without it every write succeeds, logs `git_failed`, and leaves a
  // store with no history that nobody notices until they go looking for one.
  const df = readFileSync(join(root, "Dockerfile"), "utf8");
  const runtime = df.slice(df.lastIndexOf("\nFROM "));
  return /apk add[^\n]*\bgit\b/.test(runtime)
    ? null
    : "the runtime stage installs no git — commitStore would fail silently on every write";
});

check("one image, one recipe", () => {
  // Two Dockerfiles building the same image drift: the root one installs git and says why, and the
  // other may not — so development builds an image that can commit a store and production builds one
  // that cannot, while the check for exactly that reads the root Dockerfile and passes, correctly,
  // about a file production was not built from. Every guarantee this gate makes about the image is
  // made about one file, so there has to be one.
  const named = new Map<string, string>();   // repo-relative path -> who names it
  // Repo-relative, or null for anything outside this checkout, which is not ours to make claims
  // about.
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

  // One recipe per image, and this repository ships two images: the application, and a PostgreSQL
  // image pinned to an exact base digest and an exact pg_textsearch source, built in isolation to
  // prove a dependency before anything is deployed on it. They are different things, on different
  // schedules, for different readers — so the rule is per class: each class has one recipe, a
  // Dockerfile belongs to a class, and a class nothing builds from is still the other half of the
  // defect.
  //
  // DELIBERATE: the database image is declared here rather than detected. Its builder,
  // testing/tenant-info/deployment.ts, composes the path (`join(DEPLOY_DIR, "Dockerfile")`) instead
  // of writing it as a literal, so the scan above cannot see it — and a path spelled out to satisfy
  // a regex is a path that can drift from the one actually built.
  const CLASSES: readonly { name: string; is: (p: string) => boolean }[] = [
    { name: "database (dependency-proof)", is: (p) => p === "deploy/postgres/Dockerfile" },
    { name: "application", is: () => true },
  ];
  const classOf = (p: string) => CLASSES.find((c) => c.is(p))!.name;

  const bad = [];
  const byClass = new Map<string, [string, string][]>();
  for (const [d, by] of named) {
    const k = classOf(d);
    byClass.set(k, [...(byClass.get(k) ?? []), [d, by]]);
  }
  for (const [k, recipes] of byClass) {
    if (recipes.length > 1) {
      bad.push(`${recipes.length} recipes for the ${k} image: ` +
               recipes.map(([d, by]) => `${d} (${by})`).join(", "));
    }
  }
  // A Dockerfile nobody builds from is the other half of the same defect: it is what the
  // next person edits, and what this gate's image checks would go on reading.
  for (const f of trackedFiles() ?? []) {
    if (!/(^|\/)Dockerfile$|\.Dockerfile$/.test(f)) continue;
    if (named.has(f)) continue;
    // A declared class whose builder composes its path is accounted for; anything else is a
    // Dockerfile with no builder at all.
    if (CLASSES.some((c) => c.name !== "application" && c.is(f))) continue;
    bad.push(`${f} is a Dockerfile nothing builds from`);
  }
  for (const [d] of named) {
    if (!existsSync(join(root, d))) bad.push(`${d} is built from and does not exist`);
  }
  return bad.length ? bad.join("; ") : null;
});
