/**
 * The release script and the documents that describe a release.
 *
 * The changelog's sections, the bundle's contents, the rollback path — a release step that
 * quietly does nothing is invisible from the release's own output.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { between, doctorSource, firstOf, functionBody, releaseSource, root, withoutComments } from "../read.ts";
import { check } from "../run.ts";
import { ourDocs } from "../facts.ts";

/** A caught value is never typed as an Error — narrow the shape actually being read rather
 *  than assume it. `unknown?.message` narrows to `{}`, which has no properties at all. */
function errMessage(err: unknown): string {
  if (err && typeof err === "object" && "message" in err) {
    const m = (err as Record<string, unknown>).message;
    if (m !== undefined && m !== null) return String(m);
  }
  return String(err);
}

/* The doctor and the release read one list of probes: verify.ts selects layers and defines no
 * probe of its own. A probe defined only in the release path runs during a release and at no
 * other time, so nothing exercises it in between. */
check("the release verifies through the doctor's probes, not a second list", () => {
  const rel = withoutComments(readFileSync(join(root, "scripts/release/verify.ts"), "utf8"));
  const bad = [];
  // `probe(` appearing here at all means a probe defined outside the doctor.
  if (/^\s*probe\(/m.test(withoutComments(rel))) {
    bad.push("scripts/release/verify.ts defines a probe of its own — probes belong in scripts/doctor/layers/");
  }
  if (!/from "\.\.\/doctor\/run\.ts"/.test(rel)) {
    bad.push("scripts/release/verify.ts no longer runs the doctor — this check cannot confirm the two share a list");
  }
  // Every layer it names must exist as a module, or a release silently verifies fewer layers
  // than it says it does.
  const named = [...(/RELEASE_LAYERS = \[([^\]]*)\]/.exec(rel)?.[1] ?? "").matchAll(/"([a-z-]+)"/g)].map((m) => m[1]);
  if (!named.length) bad.push("scripts/release/verify.ts declares no RELEASE_LAYERS — this check is reading nothing");
  for (const n of named) {
    if (!existsSync(join(root, `scripts/doctor/layers/${n}.ts`))) {
      bad.push(`the release verifies layer "${n}", and scripts/doctor/layers/${n}.ts does not exist`);
    }
  }
  return bad.length ? bad.join("\n      ") : null;
});

/* The doctor changes nothing, which is what makes it safe to run while something is already
 * broken. The risk is a probe reaching for a command that happens to mutate: a `docker
 * compose up -d` to "make sure it is running", a `git checkout` to compare against a tag, a
 * psql `delete` in a cleanup that seemed local.
 *
 * Read of the doctor as a subject rather than file by file, so a probe that moves between
 * layers stays covered. */
check("the doctor changes nothing", () => {
  const src = withoutComments(doctorSource());
  // DELIBERATE: the argument list of what executes, not the source as one text. The doctor
  // prints failure messages that name the very commands this forbids, and a scan over the
  // whole file goes red on prose about a command rather than on a command.
  const cmds = [];
  for (const m of src.matchAll(/\b(ssh|run|execSync|execFileSync)\s*\(/g)) {
    let depth = 0;
    let i = m.index + m[0].length - 1;
    for (; i < src.length; i++) {
      if (src[i] === "(") depth++;
      else if (src[i] === ")") { depth--; if (!depth) break; }
    }
    cmds.push(src.slice(m.index, i + 1));
  }
  if (!cmds.length) return "the doctor executes nothing at all — this check is reading nothing";
  const text = cmds.join("\n");
  const forbidden: [RegExp, string][] = [
    [/docker\s+compose[^"'`\n]*\s(up|down|restart|stop|start|rm)\b/, "a docker compose command that changes what is running"],
    [/\bdocker\s+(run|rm|kill|restart|pull|push)\b/, "a docker command that changes state"],
    [/\bgit\s+(checkout|commit|push|reset|clean|fetch|pull)\b/, "a git command that changes the tree or the remote"],
    [/\b(insert\s+into|update\s+\w+\s+set|delete\s+from|drop\s+table|truncate)\b/i, "a SQL statement that writes"],
    [/\bcrontab\s+-r\b/, "a crontab removal"],
    [/\brm\s+-[rf]/, "a recursive or forced remove"],
  ];
  const bad = forbidden.filter(([re]) => re.test(text)).map(([re, what]) =>
    `${what}: ${(text.split("\n").find((l) => re.test(l)) ?? "").trim().slice(0, 110)}`);
  // A filesystem write anywhere in the doctor, command position or not.
  if (/\b(writeFileSync|appendFileSync|mkdirSync|rmSync|unlinkSync)\b/.test(src)) {
    bad.push("a filesystem write — the doctor reads, it does not record");
  }
  return bad.length
    ? `the doctor is supposed to be safe to run during an outage, and it is not:\n      ${bad.join("\n      ")}`
    : null;
});

/* A layer missing from doctor.ts does not run, and the diagnosis it would have given is
 * absent, which reads like agreement. COUPLED: gate.ts's import list and the completeness
 * guard in gate/run.ts apply the same rule to the gate. */
check("the doctor runs every layer that is written", () => {
  const entry = readFileSync(join(root, "scripts/doctor.ts"), "utf8");
  const written = readdirSync(join(root, "scripts/doctor/layers")).filter((f) => f.endsWith(".ts")).sort();
  if (!written.length) return "scripts/doctor/layers/ holds no modules — this check is reading nothing";
  const missing = written.filter((f) => !entry.includes(`./doctor/layers/${f}`));
  if (missing.length) {
    return `scripts/doctor.ts does not import ${missing.join(", ")} — a layer that is not ` +
           `imported does not run, and a diagnosis it would have given is indistinguishable from agreement`;
  }
  // And every one of them must declare what it owns, or `--since` cannot correlate it.
  const noOwns = written.filter((f) => {
    const src = readFileSync(join(root, "scripts/doctor/layers", f), "utf8");
    return !/layer\(\s*"[a-z-]+",[\s\S]{0,200}?\[[^\]]+\]\s*\)/.test(src);
  });
  return noOwns.length
    ? `${noOwns.join(", ")} declare no paths in their layer() call, so --since cannot say what ` +
      `changed in them — the correlation would silently list nothing`
    : null;
});

check("the deploy stops what this release no longer defines", () => {
  // A release that removes a service does not stop it: compose cannot stop a container the
  // file no longer mentions, so it keeps running and release verification passes, because it
  // probes the new service and finds it healthy. `--remove-orphans` is what stops it.
  const rel = releaseSource();
  // Commands, not prose about commands: a comment line is this file's own explanation of
  // what the deploy does.
  const ups = rel.split("\n")
    .filter((l) => !/^\s*(\*|\/\/)/.test(l))
    .flatMap((l) => [...l.matchAll(/docker compose up -d([^;`"']*)/g)].map((m) => m[1]));
  const bare = ups.filter((tail) => !tail.includes("--remove-orphans"));
  if (ups.length === 0) return "release.ts no longer brings the stack up — this check needs rewriting";
  return bare.length ? `${bare.length} of ${ups.length} deploy commands omit --remove-orphans` : null;
});

check("no release document points at a repository path that does not exist", () => {
  // These documents are read by people outside this repository, where a path that does not
  // resolve reads as the thing having been withdrawn.
  const bad = [];
  for (const rel of ourDocs()) {
    // DELIBERATE: the changelog is exempt, and it is the only document that is. Its entries
    // describe past states, so naming a file that has since been deleted is the job. Every
    // other document here describes the present.
    if (rel === "CHANGELOG.md") continue;
    const txt = readFileSync(join(root, rel), "utf8");
    // Backticked paths that look like repo paths: a slash, no scheme, no leading dot-slash
    // wildcard. `<owner>` placeholders and glob-ish names are skipped.
    for (const m of txt.matchAll(/`((?:docs|services|packages|catalog|skills|deploy|scripts|testing)\/[A-Za-z0-9._/-]+)`/g)) {
      const p = m[1];
      if (p.includes("<") || p.endsWith("/")) continue;
      if (existsSync(join(root, p))) continue;
      // A gitignored path is one the reader creates — deploy/.env is the documented
      // example — so its absence from the repository is the point, not a broken link.
      try {
        execFileSync("git", ["check-ignore", "-q", p], { cwd: root, stdio: "ignore" });
        continue;
      } catch { /* not ignored: it really is missing */ }
      bad.push(`${rel} points at ${p}`);
    }
  }
  return firstOf(bad, 10);
});

check("the deploy bundle carries everything the install steps use", () => {
  // The bundle is the install: the compose file, the example environment, the front end's
  // config, and the scripts an operator runs by hand. Nothing in it is generated.
  const rel = releaseSource();
  const tar = rel.indexOf("tar czf");
  if (tar === -1) return "release.ts no longer packages a bundle — this check needs rewriting";
  const line = rel.slice(tar, rel.indexOf("\n", tar));
  const bad = [];
  // The files the install itself names, read from deploy/README.md. A script added to
  // deploy/ and never documented is not part of the install; one the README tells somebody
  // to run is. A list retyped here would agree with release.ts by construction and never ask
  // the question.
  const readme = readFileSync(join(root, "deploy/README.md"), "utf8");
  const invoked = new Set(
    [...readme.matchAll(/(?:\.\/|deploy\/)([A-Za-z0-9_.-]+\.sh|zz-tool)\b/g)].map((m) => m[1]));
  // Except the scripts that run against a host rather than on it — they take an ssh host and
  // reach it from a checkout, so they belong to the repository and not to the install.
  //
  // Derived from the script rather than listed here: a script that invokes `ssh` on a line
  // that is not a comment runs against a host; one that does not runs on it. Comments are
  // excluded because zz-tool's comments explain `ssh` at length and never invoke it.
  const runsAgainstAHost = (name: string): boolean => {
    const f = join(root, "deploy", name);
    if (!existsSync(f)) return false;
    return readFileSync(f, "utf8").split("\n")
      .filter((l) => !/^\s*#/.test(l))
      .some((l) => /(^|[^a-zA-Z_-])ssh /.test(l));
  };
  // Plus what the install's first commands read rather than run.
  const needs = new Set([...[...invoked].filter((n) => !runsAgainstAHost(n)),
                         "docker-compose.yml", ".env.example"]);
  for (const need of needs) {
    if (!line.includes(need)) {
      bad.push(`the bundle does not carry ${need}, which deploy/README tells an operator to use`);
    }
    if (!existsSync(join(root, "deploy", need))) bad.push(`deploy/${need} does not exist`);
  }
  // And the other direction: a bundle carrying a file the README never mentions is a sign
  // the README stopped mentioning something that still ships.
  for (const m of line.matchAll(/\s([A-Za-z0-9_./-]+\.(?:yml|sh|yaml|example)|zz-tool)(?=\s|`)/g)) {
    if (!needs.has(m[1]) && !m[1].startsWith("../")) {
      bad.push(`the bundle carries ${m[1]} and deploy/README never mentions it`);
    }
  }
  return bad.length ? bad.join("; ") : null;
});

check("a dry run cannot write git history", () => {
  // --dry-run verifies locally and touches nothing remote, so no git write may run before
  // its exit.
  //
  // DELIBERATE: scripts/release.ts specifically, not releaseSource(). This is about order —
  // what runs before the dry-run exit — and both the steps and the exit are in that one
  // file. Over the concatenated source, "before" would mean "in whichever module sorted
  // first".
  const src = readFileSync(join(root, "scripts/release.ts"), "utf8");
  const lines = src.split("\n");
  const exitLine = lines.findIndex((l) => l.includes("DRY RUN OK"));
  if (exitLine < 0) return "release.ts has no dry-run exit";
  const bad = [];
  for (let i = 0; i < exitLine; i++) {
    // Writes only. `git tag -l` lists, `git rev-parse` reads — neither changes anything.
    const m = lines[i].match(/run\("git", \["(commit|push|tag)"(.*)$/);
    if (!m) continue;
    if (m[1] === "tag" && /"-l"/.test(m[2])) continue;
    // The guard is a line, not a brace match: `{ cwd: ... }` on the intervening lines makes
    // brace counting say the block already closed when it has not.
    const guarded = lines.slice(Math.max(0, i - 6), i).some((l) => /if \(!dryRun\)/.test(l));
    if (!guarded) bad.push(`git ${m[1]} on line ${i + 1} runs before the dry-run exit `
                           + `without an if (!dryRun) guard`);
  }
  return bad.length ? bad.join("; ") : null;
});

check("the deployed image can be rebuilt from this repo", () => {
  // A Dockerfile in the repository root, so the recipe is in the checkout and .dockerignore
  // is in scope. An image that copies the host's node_modules and dist/ is one built with
  // that file out of scope.
  const bad = [];
  if (!existsSync(join(root, "Dockerfile"))) {
    return "no Dockerfile — the deployed artifact cannot be rebuilt from a checkout";
  }
  const df = readFileSync(join(root, "Dockerfile"), "utf8");
  if (/^COPY\s+node_modules/m.test(df) || /^COPY\s+.*\bdist\b/m.test(df)) {
    bad.push("the image copies host build output instead of building it — .dockerignore "
             + "excludes exactly these, so this only works by bypassing it");
  }
  if (!/npm ci/.test(df)) bad.push("the image does not install from the lockfile");
  if (!/tsc -b/.test(df)) bad.push("the image does not compile — it would ship stale dist/");
  // The compose file names a tag; the build script must produce that same name, or the
  // deployment pulls something nobody built.
  const compose = readFileSync(join(root, "deploy/docker-compose.yml"), "utf8");
  const img = compose.match(/image:\s*\$\{ZZ_IMAGE:-([^}]+)\}/);
  if (img && existsSync(join(root, "scripts/build-image.sh"))) {
    const sh = readFileSync(join(root, "scripts/build-image.sh"), "utf8");
    if (!sh.includes(img[1])) bad.push(`build-image.sh does not build ${img[1]}`);
    // And the same architecture. Two scripts build this one tag; if either pins no platform
    // it builds for whatever machine it runs on, and the image cannot start on the deploy
    // host. Compared as values, not for the flag's presence: pinning two different platforms
    // is the same defect.
    const shPlatform = /ZZ_PLATFORM:-([^}"\s]+)/.exec(sh)?.[1];
    const relPlatform = /process\.env\.ZZ_PLATFORM \|\| "([^"]+)"/
      .exec(releaseSource())?.[1];
    if (!shPlatform || !relPlatform) {
      bad.push("one of build-image.sh and release.ts does not pin a build platform — the "
               + "other does, so one of them builds for whatever machine it runs on");
    } else if (shPlatform !== relPlatform) {
      bad.push(`build-image.sh builds ${shPlatform} and release.ts builds ${relPlatform} — `
               + "one tag, two architectures");
    }
  }
  return bad.length ? bad.join("; ") : null;
});

check("a failed rollback is reported, not thrown", () => {
  // rollback() throws when the remote `docker compose up` cannot start the old version — a
  // pruned image is the obvious way. Unguarded, the worst case this script has (a bad
  // version live and the rollback failing) produces a stack trace instead of the
  // verification report and a statement of what is running.
  //
  // "Was rolled back to X" because a previous version was recorded is a different claim from
  // the rollback having worked, so the outcome line must distinguish them.
  const src = releaseSource();
  const bad = [];
  // The automatic rollback — the one that runs after a failed verification — must be guarded.
  //
  // DELIBERATE: both anchors are code, not section headers. Anchoring on a comment divider
  // means a comment sweep takes this check out with "cannot be located". Section 6 is
  // conditional and has no `step(6, …)` call, so its start is the condition that opens it;
  // both anchors are unique in releaseSource().
  const auto = between(src, "if (problems.length) {", 'step(7, "tag")');
  if (!auto.text) return `the rollback step cannot be located: ${auto.why}`;
  const block = auto.text;
  if (!/try\s*\{[\s\S]{0,200}rollback\(previous\)/.test(block)) {
    bad.push("the automatic rollback is unguarded — its failure throws over the verification report");
  }
  if (!/rolledBack/.test(block)) {
    bad.push("the outcome line does not distinguish a rollback that RAN from one that worked");
  }
  if (/\$\{previous \? `was rolled back/.test(block)) {
    bad.push("the outcome claims a rollback because a previous version was recorded, not because it succeeded");
  }
  return bad.length ? bad.join("; ") : null;
});

check("a breaking change says what to do about it", () => {
  // An upgrade-notes entry is the part of a changelog a reader has to act on. Two shapes are
  // checked: a bullet with nothing after its bold lead, and a bullet whose lead says
  // "Breaking" without saying what to do.
  const bad: string[] = [];
  for (const rel of ["CHANGELOG.md", "README.md"]) {
    const f = join(root, rel);
    if (!existsSync(f)) continue;
    const lines = readFileSync(f, "utf8").split("\n");
    lines.forEach((line, i) => {
      const m = /^- \*\*(.+?)\*\*\s*(.*)$/.exec(line);
      if (!m) return;
      const [, lead, rest] = m;
      const continued = (lines[i + 1] ?? "").startsWith("  ");
      if (!rest.trim() && !continued) {
        bad.push(`${rel}:${i + 1} "${lead.slice(0, 60)}" is a bullet with no explanation`);
      } else if (/breaking/i.test(lead) && !rest.trim() && !continued) {
        bad.push(`${rel}:${i + 1} announces a breaking change and says nothing to do about it`);
      }
    });
  }
  return bad.length ? bad.join("; ") : null;
});

check("the release script can read every fact it parses out of source", () => {
  // DELIBERATE: release.ts reads the MCP protocol version out of @zz/mcp-client's source
  // rather than importing it, because it must run before a build has necessarily produced
  // any JavaScript. COUPLED: the constant's spelling in packages/mcp-client/src/index.ts.
  // A reader that stops matching kills every path that builds an initialize frame, including
  // the verification step that decides whether to roll back.
  //
  // The reader is run with its collaborators injected and required to return what the client
  // declares; a regex over release.ts would only re-check the spelling.
  const rel = releaseSource();
  const body = functionBody(rel, "mcpProtocol");
  if (!body) return "release.ts no longer defines mcpProtocol — this check cannot run";
  let readProtocol: Function;
  try {
    readProtocol = new Function("readFileSync", "join", "root", "die", body)
      .bind(null, readFileSync, join, root, (m: string): never => { throw new Error(m); });
  } catch (err) {
    return `mcpProtocol could not be evaluated: ${errMessage(err)}`;
  }
  let got;
  try {
    got = readProtocol();
  } catch (err) {
    return `the release script cannot read the protocol it announces: ${errMessage(err)} — ` +
           "every initialize frame it builds dies here, including the one in the verification " +
           "step that decides whether to roll back";
  }
  const client = readFileSync(join(root, "packages/mcp-client/src/index.ts"), "utf8");
  const declared = /const PROTOCOL = "([^"]+)"/.exec(client)?.[1];
  if (!declared) return "@zz/mcp-client no longer declares PROTOCOL — nothing announces a version";
  if (got !== declared) {
    return `the release script announces protocol ${JSON.stringify(got)} and the client speaks ` +
           `${JSON.stringify(declared)} — a fourth version of a protocol that is supposed to have one`;
  }
  return null;
});

check("a release groups each kind of change once", () => {
  // Keep a Changelog is one grouping per kind of change per release. A second `### Fixed`
  // under the same version is a list that looks complete and is not: a reader who finds the
  // first has no reason to look for another.
  const bad: string[] = [];
  for (const rel of ["CHANGELOG.md", "README.md"]) {
    const f = join(root, rel);
    if (!existsSync(f)) continue;
    let release: string | null = null;
    const seen = new Map<string, number>();
    readFileSync(f, "utf8").split("\n").forEach((line, i) => {
      const version = /^## \[([^\]]+)\]/.exec(line);
      if (version) { release = version[1]; seen.clear(); return; }
      const heading = /^### (.+)$/.exec(line);
      if (!heading || !release) return;
      const name = heading[1].trim();
      const first = seen.get(name);
      if (first) {
        bad.push(`${rel}:${i + 1} opens a second \`### ${name}\` for ${release} (the first is ` +
                 `line ${first}) — a reader who finds one list has no reason to look for another`);
      } else {
        seen.set(name, i + 1);
      }
    });
  }
  return bad.join("\n");
});


