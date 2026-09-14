/**
 * What runs on the host between releases: the backups, the scheduled jobs, the monitor.
 *
 * These run unattended, which means their failure mode is silence. The backup that deleted
 * its own three good archives every night did so for weeks behind a cron job that reported
 * success, and no check here existed to disagree.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { firstOf, gateOwnSource, root, sourceFiles, unbuilt } from "../read.ts";
import { check } from "../run.ts";

check("the monitor treats its own silence as a failure", () => {
  const nothingToRun = unbuilt();
  if (nothingToRun) return nothingToRun;
  // NOT ERRORING IS NOT SUCCEEDING, and a monitor is the first place that bites. A collector
  // nobody scheduled does not fail — it produces "nothing wrong today" every day, which is
  // worse than being down, because being down gets noticed.
  //
  // So watch-results returns 2 when it can see no activity at all, and says why: a platform
  // with users does not have two silent windows in a row, so the likely explanation is that
  // it is pointed somewhere wrong. An empty window must never read as an all-clear.
  //
  // Run, not read. This is a claim about what the program DOES, and the version of it that
  // returned 0 on no data would have passed any inspection of its source.
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
  // from — "a backup that was never read is a guess". Both counts used to be taken AFTER the
  // tar, so any write landing in between failed the whole backup with "holds N entries and
  // volume holds M", on an archive that is a correct snapshot.
  //
  // The platform is running while this runs, and a team's store is a git repository this
  // release: one document write now creates several objects and a ref update where it used to
  // create one file. The window is the same and what passes through it is several times
  // larger. A nightly job that cries wolf is one people learn to ignore, which is the opposite
  // of what a backup check is for.
  //
  // Held the way this file already reasons about its own pruning — "a fifth backup added above
  // is pruned by having been added" — so a third volume cannot be archived without being
  // verified, and cannot be verified against a single count.
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
  // Three arguments — the volume, the archive, and the count taken BEFORE the tar — and that
  // third one has to come from a count, not a literal.
  //
  // Read as whole quoted arguments and then unwrapped. Matching `"$name"` directly with a
  // lowercase character class skipped `"$ARTIFACT_VOLUME"`, so the third argument was
  // silently the second and this half of the check never ran.
  // A VOLUME IS CREATED BY BEING MOUNTED, so asking whether it exists has to come first.
  // `docker run -v name:/data` makes a named volume that is not there — empty, silently —
  // and then the count, the archive and the read-back all agree on zero and check_archive
  // says "archived as empty, which is correct on a fresh install". A backup reporting
  // success every night having captured nothing is the worst outcome this file has, and it
  // is the one it was closest to: the script once hard-coded a prefix and "silently backed
  // up nothing on any host whose project differed". Verified against the daemon: a name
  // that did not exist before the mount existed after it.
  //
  // INDIRECTLY TOO, and the first draft of this missed exactly that: the EARLIEST mount of
  // the artifacts volume is `count_volume "$ARTIFACT_VOLUME"`, whose body mounts `$1`. A
  // rule that only saw `-v "$ARTIFACT_VOLUME"` measured against the tar forty lines below
  // and passed a guard moved after the call that would already have created the volume.
  // Found by moving it there. So a helper that mounts a POSITIONAL is a mount, and calling
  // it is mounting.
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
  // COMMENTS STRIPPED, because the paragraph that JUSTIFIES the guard names the command it
  // uses — so removing the command and keeping the prose passed this. Twice in one sitting
  // now: a check that reads the explanation of the code it guards is measuring the wrong
  // text, and the explanation is always there precisely when the code is not.
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
  // `docker compose exec -T postgres psql -U zz -d zz` addresses THIS deployment's database
  // and then types two values the deployment configures. POSTGRES_USER and POSTGRES_DB are
  // settable and .env.example documents them as such, so on any host that sets either, the
  // command fails — and the places it appears are the expensive ones: release.mjs's migration
  // probe is step 5, and step 5 rolls a release back. A good version undone by a name the
  // script guessed.
  //
  // The half-applied version of this fix is what makes it worth a check. The paragraph above
  // that probe had already argued the container must be addressed as a SERVICE rather than by
  // a literal name — citing deploy/backup.sh's four nights of silent loss — and left `-U zz
  // -d zz` in the same command. One assumption named and removed, its twin untouched, two
  // lines apart.
  //
  // `docker compose exec` is the distinguishing mark and it is the true one: it means a
  // deployment whose configuration lives in its own .env. A `docker exec` into a container
  // the caller just started with `-e POSTGRES_USER=…` — release.mjs's throwaway postgres for
  // sql-check — configured that value itself and is right to repeat it.
  const bad = [];
  // THE GATE'S OWN SOURCE IS EXCLUDED, and the paragraphs above are why: they quote the
  // command this looks for, so the check read its own explanation as a finding and named
  // the gate as a deployment script. sql-check carries a SELF constant for exactly this — "a check that
  // reads its own text as evidence reports a defect nobody can fix".
  //
  // Comment lines dropped as well, because the fix for the code is always accompanied by a
  // paragraph quoting the code it replaced. Three checks in this file have now been fooled by
  // prose describing the thing they hunt.
  for (const rel of sourceFiles(["deploy", "testing", "scripts"], [".sh", ".ts"])) {
    if (gateOwnSource(rel)) continue;
    // Kept, so a finding can name the line somebody has to open. Stripping comments and
    // joining string seams moves every offset, and the first version reported the position in
    // the rewritten text — a real file, a real defect, and a line number pointing at neither.
    const original = readFileSync(join(root, rel), "utf8");
    // Comment lines BLANKED rather than dropped, so every offset in here still matches the
    // file. This is what a finding's line number is measured against: `original` alone put
    // the first version's line on a comment quoting `-U zz -d zz` — the right file, and a
    // line naming the paragraph about the defect instead of the defect.
    const masked = original.split("\n")
      .map((l) => (/^\s*(#|\/\/|\*)/.test(l) ? " ".repeat(l.length) : l)).join("\n");
    const src = original.split("\n")
      .filter((l) => !/^\s*(#|\/\/|\*)/.test(l)).join("\n")
      // ADJACENT TEMPLATE LITERALS JOINED FIRST. release.mjs builds its ssh commands as
      // `…` + `…` across several lines, so `docker compose exec` and the `psql` it runs sit
      // on different source lines — and the first version of this check, which required both
      // on one line, could not see the migration probe at all. That probe is the site the
      // check was written for: a mutation putting `-U zz -d zz` back into it passed.
      //
      // Removing the seam is what makes the source read the way the shell will.
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
        // The line in the FILE, not in the rewritten text. Stripping comments and joining
        // string seams moves every offset, so reporting m.index named a real file, a real
        // defect, and a line pointing at neither.
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
  // today's date, in $BACKUP_DIR, sorting NEWEST. backup.sh's own header records four nights
  // in August 2026 of exactly that: 20-byte dumps left behind when the container name was
  // wrong. The failure was loud in a log nobody reads; the DIRECTORY still looked right, and
  // the directory is what somebody reads while the platform is down.
  //
  // ONE LIST, WALKED TWICE. The prune at the end of that file already reasons this way — "a
  // fifth backup added above is pruned by having been added" — and the cleanup needs the same
  // property or a fifth backup is pruned and never cleaned up. So this holds the two walks to
  // the same array rather than to two retyped lists that agree today.
  const src = readFileSync(join(root, "deploy/backup.sh"), "utf8");
  const bad = [];

  // COMMENT LINES BLANKED, OFFSETS KEPT. The first draft of this check reported the trap as
  // armed too late, and it was right about the position and wrong about what was there: the
  // paragraph justifying the trap quotes `cmd > "$db_file"`, and prose about a write is not a
  // write. Its neighbour above carries the same finding — "the explanation is always there
  // precisely when the code is not" — so every index below is measured against code alone.
  // Blanked to spaces rather than deleted, because these indices are compared with each other.
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

  // The trap has to be armed BEFORE the first write, because the first write is the one that
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

  // And the set is only real once it has been validated: `ok` has to be set AFTER the last
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
  // THIS CHECK USED TO HAVE A DIFFERENT PREMISE, and the premise is what changed.
  //
  // It read deploy/sync.sh to learn that the rsync excluded `dist/`, then looked for a host
  // script running compiled output that the sync had not rebuilt — run-smoke-uat.sh ran the
  // engine the host had last compiled rather than the one just synced, and a stale engine
  // still starts, still talks, and still writes a verdict about code that is not there.
  //
  // sync.sh is gone (2026-09-11) and so is every source tree it left. A host now receives the
  // release bundle and nothing else: no repository, no node, no npm, no dist/ at all. So the
  // old question — "was this recompiled?" — cannot arise, and the real one is stricter and
  // simpler: a script that SHIPS must run on a machine that has only docker, a shell, and the
  // bundle. Reaching for `npm run` there does not run stale code; it fails outright.
  //
  // WHICH SCRIPTS SHIP is derived, never listed. deploy/README is the install, so a script it
  // tells an operator to run is part of it — and one that calls `ssh` runs FROM a checkout
  // AGAINST a host, so it stays behind. Same derivation the bundle check uses, for the same
  // reason: a list here would be a list kept in step by hand.
  const readme = readFileSync(join(root, "deploy/README.md"), "utf8");
  const named = [...new Set([...readme.matchAll(/(?:\.\/|deploy\/)([A-Za-z0-9_.-]+\.sh|zz-tool)\b/g)]
    .map((m) => m[1]))];
  if (!named.length) return "deploy/README names no scripts at all — this check is reading nothing";
  const bad = [];
  let shipped = 0;
  for (const name of named) {
    const f = join(root, "deploy", name);
    if (!existsSync(f)) continue;
    // CONTINUATIONS JOINED FIRST, because a shell command is not a line. zz-tool ends with
    //   exec docker compose run --rm --no-deps -T "${pass[@]}" \\
    //     --entrypoint node zz-core "/repo/packages/tools/dist/....js"
    // and judging the second physical line alone reads `node` with no `docker` beside it —
    // which is how this check's first version called the one script that does it RIGHT the
    // one script that does it wrong.
    const code = readFileSync(f, "utf8").split("\n").filter((l) => !/^\s*#/.test(l)).join("\n")
      .replace(/\\\n\s*/g, " ");
    if (/(^|[^a-zA-Z_-])ssh /.test(code)) continue;   // runs against a host, from a checkout
    shipped++;
    // `docker compose run`/`exec` is how a shipped script reaches compiled code legitimately:
    // it executes INSIDE the image, which is the one place on that machine where dist/ exists.
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
