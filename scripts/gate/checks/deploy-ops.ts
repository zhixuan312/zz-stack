/**
 * What runs on the host between releases: the backups, the scheduled jobs, the monitor.
 *
 * These run unattended, so their failure mode is silence.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { firstOf, gateOwnSource, root, sourceFiles, unbuilt } from "../read.ts";
import { check } from "../run.ts";

check("the monitor treats its own silence as a failure", () => {
  const nothingToRun = unbuilt();
  if (nothingToRun) return nothingToRun;
  // Not erroring is not succeeding. A collector nobody scheduled does not fail — it produces
  // "nothing wrong today" every day, which is worse than being down, because being down gets
  // noticed.
  //
  // So watch-results returns 2 when it can see no activity at all, and says why: an empty window
  // must never read as an all-clear.
  //
  // Run, not read. This is a claim about what the program does.
  const tool = join(root, "packages/tools/dist/ops/watch-results.js");
  if (!existsSync(tool)) return "watch-results is not built";
  const stub = join(root, "node_modules/.zz-empty-psql.sh");
  writeFileSync(stub, "#!/bin/sh\nprintf '[]'\n", { mode: 0o755 });
  try {
    execFileSync("node", [tool, "--psql", stub], { encoding: "utf8" });
    return "watch-results exited 0 on an empty window — silence read as an all-clear";
  } catch (err) {
    const code = err && typeof err === "object" ? (err as Record<string, unknown>).status : undefined;
    if (code === 2) return null;
    return `watch-results exited ${code} on an empty window; 2 means "cannot tell"`;
  }
});

check("every archived volume is verified against a range, not one snapshot", () => {
  // backup.sh reads each archive back and matches its entry count against the volume it came
  // from. Both counts taken after the tar fail the whole backup on any write landing in between,
  // on an archive that is a correct snapshot — and the platform is running while this runs.
  //
  // Held the way backup.sh already reasons about its own pruning, so a third volume cannot be
  // archived without being verified, and cannot be verified against a single count.
  const src = readFileSync(join(root, "deploy/backup.sh"), "utf8");
  const bad = [];

  const archived = [...src.matchAll(/tar czf "\/backup\/\$\(basename "\$([a-z_]+)"\)"/g)]
    .map((m) => m[1]);
  const checked = [...src.matchAll(/^check_archive\s+("[^"]*"\s*){2,}/gm)];
  const verified = [...src.matchAll(/^check_archive\s+"[^"]*"\s+"\$([a-z_]+)"/gm)].map((m) => m[1]);

  for (const file of archived) {
    if (!verified.includes(file)) {
      bad.push(`$${file} is archived and never read back — check_archive is what makes the ` +
               "backup a fact rather than a guess");
    }
  }
  if (!checked.length) bad.push("backup.sh no longer calls check_archive — nothing reads an archive back");
  // Three arguments — the volume, the archive, and the count taken before the tar — and that
  // third one has to come from a count, not a literal. Read as whole quoted arguments and then
  // unwrapped: matching `"$name"` with a lowercase character class skips `"$ARTIFACT_VOLUME"`,
  // which silently makes the third argument the second.
  //
  // A volume is created by being mounted, so asking whether it exists has to come first.
  // `docker run -v name:/data` makes a named volume that is not there — empty, silently — and
  // then the count, the archive and the read-back all agree on zero.
  //
  // COUPLED: a helper that mounts a positional is a mount, and calling it is mounting. The
  // earliest mount of the artifacts volume is `count_volume "$ARTIFACT_VOLUME"`, whose body
  // mounts `$1`; a rule that only saw `-v "$ARTIFACT_VOLUME"` would pass a guard placed after the
  // call that already created the volume.
  const viaPositional = [...src.matchAll(/^([a-z_]+)\(\) \{([\s\S]*?)^\}/gm)]
    .filter(([, , body]) => /-v "\$[1-9]":/.test(body))
    .map(([, name]) => name);
  const mountsOf = (v: string) => {
    const at = [...src.matchAll(new RegExp(`-v "\\$${v}":\\/data`, "g"))].map((m) => m.index);
    for (const fn of viaPositional) {
      for (const m of src.matchAll(new RegExp(`\\b${fn}\\s+"\\$${v}"`, "g"))) at.push(m.index);
    }
    return at;
  };
  const mounted = [...src.matchAll(/-v "\$([A-Za-z_][A-Za-z0-9_]*)":\/data/g)].map((m) => m[1]);
  for (const v of new Set(mounted)) {
    const guard = src.indexOf(`require_volume "$${v}"`);
    const firstMount = Math.min(...mountsOf(v));
    if (guard < 0) {
      bad.push(`$${v} is mounted without require_volume — docker CREATES a named volume that ` +
               "is not there, so a wrong name archives nothing and reports success");
    } else if (guard > firstMount) {
      bad.push(`require_volume "$${v}" comes after the mount that would have created it — ` +
               "the question has to be asked before anything mounts the name");
    }
  }
  if (!mounted.length) return "backup.sh mounts no volume — this check needs rewriting";
  // Comments stripped, because the paragraph that justifies the guard names the command it uses —
  // so removing the command and keeping the prose would pass. A check that reads the explanation
  // of the code it guards is measuring the wrong text.
  const code = src.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");
  if (!/docker volume inspect/.test(code)) {
    bad.push("nothing asks the daemon whether a volume exists, so a misnamed one is " +
             "indistinguishable from a fresh install — which is what this file used to claim");
  }
  const befores = [...src.matchAll(/^([a-z_]+)=\$\(count_volume /gm)].map((m) => m[1]);
  for (const call of checked) {
    const args = [...call[0].matchAll(/"([^"]*)"/g)].map((m) => m[1]);
    if (args.length !== 3) {
      bad.push(`a check_archive call passes ${args.length} arguments — it takes the volume, ` +
               "the archive, and the count from before the tar, and comparing against one " +
               "snapshot of a live volume fails on any write that lands mid-archive");
      continue;
    }
    const third = /^\$([A-Za-z_][A-Za-z0-9_]*)$/.exec(args[2])?.[1];
    if (!third || !befores.includes(third)) {
      bad.push(`check_archive is given ${JSON.stringify(args[2])} as the before-count and ` +
               "nothing assigns it from count_volume ahead of the tar");
    }
  }
  return bad.length ? bad.join("; ") : null;
});

check("a deployment's database is asked for its own role and name", () => {
  // `docker compose exec -T postgres psql -U zz -d zz` addresses this deployment's database and
  // then types two values the deployment configures. POSTGRES_USER and POSTGRES_DB are settable
  // and .env.example documents them as such, so on any host that sets either the command fails —
  // and release.ts's migration probe is step 5, which rolls a release back.
  //
  // `docker compose exec` is the distinguishing mark: it means a deployment whose configuration
  // lives in its own .env. A `docker exec` into a container the caller just started with
  // `-e POSTGRES_USER=…` configured that value itself and is right to repeat it.
  const bad = [];
  // DELIBERATE: the gate's own source is excluded and comment lines are dropped. The paragraphs
  // above quote the command this looks for, so the check would otherwise read its own explanation
  // as a finding and name the gate as a deployment script. sql-check carries a SELF constant for
  // the same reason.
  for (const rel of sourceFiles(["deploy", "testing", "scripts"], [".sh", ".ts"])) {
    if (gateOwnSource(rel)) continue;
    // Kept, so a finding can name the line somebody has to open: stripping comments and joining
    // string seams moves every offset.
    const original = readFileSync(join(root, rel), "utf8");
    // Comment lines blanked rather than dropped, so every offset in here still matches the file.
    // This is what a finding's line number is measured against.
    const masked = original.split("\n")
      .map((l) => (/^\s*(#|\/\/|\*)/.test(l) ? " ".repeat(l.length) : l)).join("\n");
    const src = original.split("\n")
      .filter((l) => !/^\s*(#|\/\/|\*)/.test(l)).join("\n")
      // DELIBERATE: adjacent template literals joined first, because a shell command is not a
      // line. release.ts builds its ssh commands as `…` + `…` across several lines, so
      // `docker compose exec` and the `psql` it runs sit on different source lines. Removing the
      // seam makes the source read the way the shell will.
      .replace(/`\s*\+\s*\n?\s*`/g, "");
    for (const m of src.matchAll(/docker compose exec[^\n]*?psql\s+([^\n]*)/g)) {
      const flags = m[1];
      for (const [flag, what] of [["-U", "role"], ["-d", "database"]]) {
        const v = new RegExp(`${flag}\\s+("?)([^\\s"']+)\\1`).exec(flags);
        if (!v) continue;
        const value = v[2];
        // A shell expansion is a read; a bare word is a literal. `postgres` is the
        // maintenance database every server has by name and is not this deployment's own —
        // backup.sh's restore drill connects to it to CREATE the throwaway one.
        if (value.startsWith("$") || value === "postgres" || /^zz_restore/.test(value)) continue;
        // The line in the file, not in the rewritten text: stripping comments and joining string
        // seams moves every offset.
        const needle = `${flag} ${v[1]}${value}`;
        const at = masked.indexOf(needle);
        const line = at < 0 ? 0 : masked.slice(0, at).split("\n").length;
        bad.push(`${rel}:${line || "?"} tells this deployment's postgres its ${what} is "${value}" ` +
                 "instead of reading POSTGRES_" + (flag === "-U" ? "USER" : "DB") +
                 " from the .env beside it");
      }
    }
  }
  return bad.length ? firstOf(bad) : null;
});

check("a backup run that fails leaves nothing that reads as a backup", () => {
  // `cmd > "$db_file"` creates the file before cmd runs, and the two container tars write
  // straight to their final names — so any failure under `set -e` leaves files stamped with
  // today's date, in $BACKUP_DIR, sorting newest. The failure is loud in a log nobody reads; the
  // directory is what somebody reads while the platform is down.
  //
  // COUPLED: one list, walked twice. The prune at the end of backup.sh and the cleanup have to
  // hold to the same array, or a fifth backup is pruned and never cleaned up.
  const src = readFileSync(join(root, "deploy/backup.sh"), "utf8");
  const bad = [];

  // Comment lines blanked, offsets kept. The paragraph justifying the trap quotes
  // `cmd > "$db_file"`, and prose about a write is not a write, so every index below is measured
  // against code alone. Blanked to spaces rather than deleted, because these indices are compared
  // with each other.
  const code = src.split("\n")
    .map((l) => (/^\s*#/.test(l) ? " ".repeat(l.length) : l)).join("\n");

  const written = [...code.matchAll(/^([a-z_]+_file)="\$BACKUP_DIR\//gm)].map((m) => m[1]);
  if (!written.length) return "backup.sh assigns no $BACKUP_DIR file — this check needs rewriting";

  const list = /^FILES=\(([^)]*)\)/m.exec(src);
  if (!list) {
    return "backup.sh has no FILES=(…) naming what this run writes, so the cleanup and the " +
           "prune are two retyped lists that can disagree";
  }
  const members = [...list[1].matchAll(/\$\{?([a-z_]+_file)\}?/g)].map((m) => m[1]);
  for (const f of written) {
    if (!members.includes(f)) {
      bad.push(`$${f} is written into $BACKUP_DIR and is not in FILES — a failed run would ` +
               "leave it looking like the newest backup, and a successful one never prunes it");
    }
  }
  for (const m of members) {
    if (!written.includes(m)) bad.push(`FILES names $${m}, which nothing in backup.sh writes`);
  }

  // The trap has to be armed before the first write, because the first write is the one that
  // creates a file the run may not finish.
  const fn = /^cleanup\(\) \{([\s\S]*?)^\}/m.exec(src);
  if (!fn) bad.push("backup.sh defines no cleanup() — nothing removes a partial set");
  else {
    if (!/\bfor .*"\$\{FILES\[@\]\}"/.test(fn[1])) {
      bad.push("cleanup() does not walk \"${FILES[@]}\" — a retyped list is how the fifth " +
               "backup gets pruned and never cleaned up");
    }
    if (!/\brm\b/.test(fn[1])) bad.push("cleanup() removes nothing");
  }
  const armed = code.search(/^trap cleanup\b/m);
  const firstWrite = Math.min(...written.map((f) => {
    const at = code.search(new RegExp(`>\\s*"\\$${f}"|basename "\\$${f}"`));
    return at < 0 ? Number.MAX_SAFE_INTEGER : at;
  }));
  if (armed < 0) {
    bad.push("nothing arms `trap cleanup` — cleanup() exists and never runs, which is the " +
             "complete-and-unreachable shape this gate has found before");
  } else if (armed > firstWrite) {
    bad.push("`trap cleanup` is armed after the first file is written, so the failure it " +
             "exists for leaves that file behind");
  }

  // And the set is only real once it has been validated: `ok` has to be set after the last
  // check and before the prune. Set it earlier and the trap stops protecting anything.
  const okAt = code.search(/^ok=1$/m);
  const lastCheck = code.lastIndexOf("check_archive \"$");
  const pruneAt = code.search(/^for kept in "\$\{FILES\[@\]\}"/m);
  if (okAt < 0) bad.push("nothing ever sets ok=1, so a COMPLETE backup is deleted by its own cleanup");
  else if (okAt < lastCheck) {
    bad.push("ok=1 is set before the archives are read back — the trap then keeps a set that " +
             "failed verification");
  }
  if (pruneAt < 0) {
    bad.push("the prune no longer walks \"${FILES[@]}\" — it and the cleanup are two lists again");
  } else if (okAt > pruneAt) {
    bad.push("ok=1 comes after the prune, so a prune failure deletes the good backup it just took");
  }
  return bad.length ? bad.join("; ") : null;
});

check("a script the bundle ships needs nothing the host does not have", () => {
  // A script that ships must run on a machine that has only docker, a shell, and the bundle. A
  // host receives the release bundle and nothing else: no repository, no node, no npm, no dist/.
  // Reaching for `npm run` there fails outright.
  //
  // Which scripts ship is derived, never listed. deploy/README is the install, so a script it
  // tells an operator to run is part of it — and one that calls `ssh` runs from a checkout
  // against a host, so it stays behind.
  const readme = readFileSync(join(root, "deploy/README.md"), "utf8");
  const named = [...new Set([...readme.matchAll(/(?:\.\/|deploy\/)([A-Za-z0-9_.-]+\.sh|zz-tool)\b/g)]
    .map((m) => m[1]))];
  if (!named.length) return "deploy/README names no scripts at all — this check is reading nothing";
  const bad = [];
  let shipped = 0;
  for (const name of named) {
    const f = join(root, "deploy", name);
    if (!existsSync(f)) continue;
    // Continuations joined first, because a shell command is not a line. zz-tool ends with
    //   exec docker compose run --rm --no-deps -T "${pass[@]}" \\
    //     --entrypoint node zz-core "/repo/packages/tools/dist/....js"
    // and judging the second physical line alone reads `node` with no `docker` beside it.
    const code = readFileSync(f, "utf8").split("\n").filter((l) => !/^\s*#/.test(l)).join("\n")
      .replace(/\\\n\s*/g, " ");
    if (/(^|[^a-zA-Z_-])ssh /.test(code)) continue;   // runs against a host, from a checkout
    shipped++;
    // `docker compose run`/`exec` is how a shipped script reaches compiled code legitimately:
    // it executes inside the image, which is the one place on that machine where dist/ exists.
    // zz-tool is exactly that and must keep passing.
    const outside = code.split("\n").filter((l) =>
      /\bnpm (run|ci|install)\b|\bnpx \b|\btsc\b|(^|[^-\w])node /.test(l)
      && !/docker\s+(compose\s+)?(run|exec)/.test(l));
    if (outside.length) {
      bad.push(`deploy/${name} ships in the bundle and reaches for a toolchain the host does ` +
               `not have: ${outside[0].trim().slice(0, 100)}`);
    }
  }
  if (!shipped) return "no script in deploy/README ships with the bundle — this check is reading nothing";
  return bad.join("\n");
});
