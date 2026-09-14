/**
 * The release script and the documents that describe a release.
 *
 * STATE.md's counts, the changelog's sections, the bundle's contents, the rollback path. A
 * release step that quietly does nothing is the specific failure this module has caught more
 * than once, and it is invisible from the release's own output.
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

/* THE DOCTOR AND THE RELEASE READ ONE LIST OF PROBES.
 *
 * Step 5 used to own eleven live checks of its own, which ran for forty seconds during a
 * release and at no other time. Nothing exercised them in between, so when the release.mjs
 * split left three of them calling names they never imported, nothing found out until 0.26.1
 * deployed, reported six ReferenceErrors as deployment failures, and rolled a healthy platform
 * back. A second list is not a duplication problem here; it is a list that is only ever read
 * at the moment it is most expensive to be wrong about.
 *
 * So verify.mjs selects layers and defines no probe, and this is what keeps it that way. */
check("the release verifies through the doctor's probes, not a second list", () => {
  const rel = readFileSync(join(root, "scripts/release/verify.ts"), "utf8");
  const bad = [];
  // `probe(` appearing here at all means a probe defined outside the doctor.
  if (/^\s*probe\(/m.test(withoutComments(rel))) {
    bad.push("scripts/release/verify.mjs defines a probe of its own — probes belong in scripts/doctor/layers/");
  }
  if (!/from "\.\.\/doctor\/run\.ts"/.test(rel)) {
    bad.push("scripts/release/verify.mjs no longer runs the doctor — this check cannot confirm the two share a list");
  }
  // Every layer it names must exist as a module, or a release silently verifies fewer layers
  // than it says it does.
  const named = [...(/RELEASE_LAYERS = \[([^\]]*)\]/.exec(rel)?.[1] ?? "").matchAll(/"([a-z-]+)"/g)].map((m) => m[1]);
  if (!named.length) bad.push("scripts/release/verify.mjs declares no RELEASE_LAYERS — this check is reading nothing");
  for (const n of named) {
    if (!existsSync(join(root, `scripts/doctor/layers/${n}.ts`))) {
      bad.push(`the release verifies layer "${n}", and scripts/doctor/layers/${n}.ts does not exist`);
    }
  }
  return bad.length ? bad.join("\n      ") : null;
});

/* THE DOCTOR CHANGES NOTHING, which is the property that makes it safe to run while something
 * is already broken — the only time anybody actually will. Its own header promises this, and a
 * promise in a header is enforced by nobody.
 *
 * The risk is not somebody deciding to make it write. It is a probe reaching for a command
 * that happens to mutate: `docker compose up -d` to "make sure it is running" before checking
 * whether it is, a `git checkout` to compare against a tag, a psql `delete` in a cleanup that
 * seemed local. Each is a reasonable-looking line inside a diagnostic, and each turns the tool
 * you run during an outage into one that changes the outage.
 *
 * Read of the doctor AS A SUBJECT rather than file by file, so a probe that moves between
 * layers stays covered. */
check("the doctor changes nothing", () => {
  const src = withoutComments(doctorSource());
  // COMMAND POSITIONS ONLY, and that distinction is the whole check.
  //
  // The first version scanned the source as one text and went red twice on its own failure
  // MESSAGES — a sentence saying "a bare `docker compose up` would run this version" and one
  // telling an operator to re-run install-backup-cron.sh. Both are prose the doctor prints;
  // neither runs anything. A check that cannot tell a command from a sentence about a command
  // fails on exactly the files that explain themselves best, which teaches people to explain
  // less. So: the argument list of what actually EXECUTES, and nothing else.
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

/* A LAYER MISSING FROM doctor.mjs IS A LAYER THAT DOES NOT RUN, and the diagnosis it would
 * have given is simply absent — which reads exactly like agreement. Same rule, same reason, as
 * gate.mjs's own import list and the completeness guard in gate/run.mjs. */
check("the doctor runs every layer that is written", () => {
  const entry = readFileSync(join(root, "scripts/doctor.ts"), "utf8");
  const written = readdirSync(join(root, "scripts/doctor/layers")).filter((f) => f.endsWith(".ts")).sort();
  if (!written.length) return "scripts/doctor/layers/ holds no modules — this check is reading nothing";
  const missing = written.filter((f) => !entry.includes(`./doctor/layers/${f}`));
  if (missing.length) {
    return `scripts/doctor.mjs does not import ${missing.join(", ")} — a layer that is not ` +
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
  // file no longer mentions. Removing the old front end while leaving it RUNNING is the
  // worst available shape — people keep landing on it, and every tool call it makes now
  // fails because zz-core no longer trusts it — and release verification passes throughout,
  // because it probes the new front end and finds it healthy.
  const rel = releaseSource();
  // Commands, not prose about commands: a line beginning with ` * ` is this file's own
  // explanation of what the deploy does, and matching it reported a fault in a comment.
  const ups = rel.split("\n")
    .filter((l) => !/^\s*(\*|\/\/)/.test(l))
    .flatMap((l) => [...l.matchAll(/docker compose up -d([^;`"']*)/g)].map((m) => m[1]));
  const bare = ups.filter((tail) => !tail.includes("--remove-orphans"));
  if (ups.length === 0) return "release.mjs no longer brings the stack up — this check needs rewriting";
  return bare.length ? `${bare.length} of ${ups.length} deploy commands omit --remove-orphans` : null;
});

check("no release document points at a repository path that does not exist", () => {
  // state.md (then direction.md) sent readers to `docs/building-block-contract.md` twice —
  // it ships with the skill that teaches it — and named a "Component Register" and an
  // "Atlas" as companion references that have never existed. These documents are read by
  // people outside this repository, including the block teams the contract binds, so a path
  // that does not resolve is the reader concluding the standard was withdrawn.
  const bad = [];
  for (const rel of ourDocs()) {
    // THE CHANGELOG IS EXEMPT, and it is the only document that is.
    //
    // Its entries describe past states, so naming a file that has since been deleted is the
    // job rather than a defect — and this repository deletes aggressively, by standing rule.
    // Every removal would otherwise turn an accurate historical entry red, and the only way
    // to clear it would be to stop naming what was removed, which is the one thing somebody
    // reading a changelog came for. Every other document here describes the PRESENT, where a
    // path that does not resolve reads as "the thing was withdrawn".
    if (rel === "CHANGELOG.md") continue;
    const txt = readFileSync(join(root, rel), "utf8");
    // Backticked paths that look like repo paths: a slash, no scheme, no leading dot-slash
    // wildcard. `<owner>` placeholders and glob-ish names are skipped.
    for (const m of txt.matchAll(/`((?:docs|services|packages|catalog|skills|deploy|scripts|testing)\/[A-Za-z0-9._/-]+)`/g)) {
      const p = m[1];
      if (p.includes("<") || p.endsWith("/")) continue;
      if (existsSync(join(root, p))) continue;
      // A gitignored path is one the reader CREATES — deploy/.env is the documented
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
  // The bundle IS the install. It used to carry a script that wrote agent presets into the
  // front end's database, plus prompts generated from the catalog and gitignored — so a
  // release cut on a clean machine shipped a bundle whose very first command died on a
  // missing file. Nothing is generated now: agents come from the registry at provisioning
  // time. What ships is the compose file, the example environment, the front end's config,
  // and the two scripts an operator runs by hand.
  const rel = releaseSource();
  const tar = rel.indexOf("tar czf");
  if (tar === -1) return "release.mjs no longer packages a bundle — this check needs rewriting";
  const line = rel.slice(tar, rel.indexOf("\n", tar));
  const bad = [];
  // The files the INSTALL ITSELF names, which is what this check is called and was not doing.
  // It retyped the same five names release.mjs retypes, so the two agreed by construction and
  // the question "does the bundle carry what an operator is told to run" was never asked.
  //
  // It was wrong. deploy/README.md's Day-2 section opens "Every command below runs from
  // deploy/, which is what the release bundle unpacks to" and then tells an operator to run
  // backup.sh and install-backup-cron.sh — neither of which shipped. A bundle recipient had
  // no way to back the platform up and nothing saying so.
  //
  // From the README, because the README is the install. A script added to deploy/ and never
  // documented is not part of it; one the README tells somebody to run is, by having been
  // written there.
  const readme = readFileSync(join(root, "deploy/README.md"), "utf8");
  const invoked = new Set(
    [...readme.matchAll(/(?:\.\/|deploy\/)([A-Za-z0-9_.-]+\.sh|zz-tool)\b/g)].map((m) => m[1]));
  // EXCEPT THE ONES THAT RUN AGAINST A HOST RATHER THAN ON IT.
  //
  // provision-host.sh, install-caddy.sh and sync.sh each take an ssh host and reach it from a
  // checkout. Shipping them inside the bundle would be shipping, to a machine somebody is
  // already logged into, the scripts whose whole job is to log into it. They belong to the
  // repository, not to the install.
  //
  // DERIVED FROM THE SCRIPT, not from a list here. A list would have to be kept in step by
  // hand, which is the failure this check's own history is made of — it once retyped the five
  // names release.mjs retypes, so the two agreed by construction and the question was never
  // asked. A script that invokes `ssh` on a line that is not a comment runs against a host;
  // one that does not runs on it. Comments are excluded because zz-tool's explain `ssh` at
  // length and invoke it never.
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
  // And the other direction: a bundle carrying a file nobody is told about is weight, and
  // more usefully it is a sign the README stopped mentioning something that still ships.
  for (const m of line.matchAll(/\s([A-Za-z0-9_./-]+\.(?:yml|sh|yaml|example)|zz-tool)(?=\s|`)/g)) {
    if (!needs.has(m[1]) && !m[1].startsWith("../")) {
      bad.push(`the bundle carries ${m[1]} and deploy/README never mentions it`);
    }
  }
  return bad.length ? bad.join("; ") : null;
});

check("a dry run cannot write git history", () => {
  // --dry-run is documented as "verify locally, touch nothing remote", and it committed:
  // the zz-blocks VERSION bump ran unguarded, so every rehearsal left a "zz-blocks
  // <version>" commit behind and a second run started from different state than the first.
  // A rehearsal that mutates what it is rehearsing is not one.
  // THE ENTRY FILE SPECIFICALLY, and this is the one release check where that is right.
  // It is about ORDER — what runs before the dry-run exit — and the steps and that exit
  // are both in release.mjs. Asked of the concatenated service, "before" means "in
  // whichever module sorted first", which is not a fact about the release at all.
  const src = readFileSync(join(root, "scripts/release.ts"), "utf8");
  const lines = src.split("\n");
  const exitLine = lines.findIndex((l) => l.includes("DRY RUN OK"));
  if (exitLine < 0) return "release.mjs has no dry-run exit";
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
  // The running image was built for a while by piping a heredoc into `docker build -f -`
  // from the PARENT directory. Two consequences: `docker history` was the only surviving
  // record of the recipe, and building one level up put .dockerignore out of scope — so the
  // image copied the host's node_modules and dist/ straight in, which is exactly the failure
  // that file exists to prevent and describes in its own comment.
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
    // AND THE SAME ARCHITECTURE. Two scripts build this one tag, and they disagreed: the
    // release pins `--platform`, build-image.sh pinned nothing — so on an arm64 machine it
    // produced an arm64 image under the release's exact tag, which cannot run on the amd64
    // deploy host. Nothing said so; a container simply fails to start, later, somewhere else.
    //
    // Compared as VALUES, not merely for the flag's presence: agreeing to pin and pinning
    // two different platforms is the same defect wearing a fix.
    const shPlatform = /ZZ_PLATFORM:-([^}"\s]+)/.exec(sh)?.[1];
    const relPlatform = /process\.env\.ZZ_PLATFORM \|\| "([^"]+)"/
      .exec(releaseSource())?.[1];
    if (!shPlatform || !relPlatform) {
      bad.push("one of build-image.sh and release.mjs does not pin a build platform — the "
               + "other does, so one of them builds for whatever machine it runs on");
    } else if (shPlatform !== relPlatform) {
      bad.push(`build-image.sh builds ${shPlatform} and release.mjs builds ${relPlatform} — `
               + "one tag, two architectures");
    }
  }
  return bad.length ? bad.join("; ") : null;
});

// THE TWO STATE.md CHECKS ARE GONE WITH THE FILE. One held its declared check count against
// the gate's real one, the other held its version stamp against package.json. Both existed
// because a number in prose about a thing that grows is a claim that goes stale, and both
// caught that happening. STATE.md itself is what was removed: the changelog is the record
// now, and a changelog entry is written per release rather than maintained between them, so
// there is no standing number in it for a check to hold anything against.


check("a failed rollback is reported, not thrown", () => {
  // rollback() throws when the remote `docker compose up` cannot start the old version — a
  // pruned image is the obvious way. Both calls to it were unguarded, so the worst case this
  // script has, a bad version live AND the rollback failing, produced a raw stack trace: no
  // list of what failed verification, no statement of what is running, at the one moment an
  // operator needs both.
  //
  // And the summary line said "was rolled back to X" whenever a previous version was
  // RECORDED, which is a different claim from the rollback having worked.
  const src = releaseSource();
  const bad = [];
  // The automatic rollback — the one that runs after a failed verification — must be guarded.
  const auto = between(src, "6 · roll back if verification failed", "7 · tag");
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
  // The changelog exists "for someone deciding whether to upgrade", and an Upgrade notes entry
  // is the one part of it a reader has to ACT on. "Breaking — documents are written as a body,
  // not as a whole file." shipped as a bare heading: its instructions — refuse content opening
  // with `---`, send the body, pass the rest as named arguments — had been absorbed into the
  // NEXT bullet by an edit, so one breaking change named no remedy and another carried
  // somebody else's.
  //
  // Both halves are checked, because the failure has two shapes: a bullet with nothing after
  // its bold lead, and a bullet whose lead says "Breaking" without ever saying what to do.
  const bad: string[] = [];
  for (const rel of ["CHANGELOG.md", "STATE.md", "README.md"]) {
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
  // release.mjs reads the MCP protocol version out of @zz/mcp-client's source rather than
  // importing it, deliberately: "this script must run before a build has necessarily produced
  // any JavaScript, and a release check that needs the build to pass cannot be what tells you
  // the build is wrong". A reader keyed to source is right here and is also a coupling that
  // nothing was checking.
  //
  // Its regex required `export const PROTOCOL`, and the constant is not exported — nothing
  // imports it, Mcp announces it internally. So it never matched, and every path that builds
  // an initialize frame died on it: `--preflight` exited 1 before its first live check, and a
  // real release reached step 5 — the verification that decides whether to roll back — AFTER
  // deploying. The new version stays live, unverified, and the rollback is never reached,
  // which is the single thing that script's ordering exists to prevent.
  //
  // RUN the reader, with its collaborators injected, and require it to return what the client
  // actually declares. A regex over release.mjs would only re-check the spelling that broke.
  const rel = releaseSource();
  const body = functionBody(rel, "mcpProtocol");
  if (!body) return "release.mjs no longer defines mcpProtocol — this check cannot run";
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
  // The changelog says in its own header that it follows Keep a Changelog, whose whole
  // structure is one grouping per kind of change per release. 0.4.0 had THREE `### Fixed`
  // lists, two `### Added` and two `### Changed`, because entries were appended in batches
  // and each batch opened its own heading.
  //
  // A reader "deciding whether to upgrade" — this file's own statement of who it is for —
  // scans for what was fixed, finds a coherent list, and stops. Two more were below,
  // separated by other headings, with nothing to say they existed. That is worse than a
  // long section: a list that looks complete and is not gives the reader no reason to look
  // further, which is the same shape as a listing that quietly omits things.
  const bad: string[] = [];
  for (const rel of ["CHANGELOG.md", "STATE.md", "README.md"]) {
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


