/**
 * SQL: that every statement is one Postgres agreed to run, and that the schema queried is
 * the schema the migrations leave behind.
 *
 * Migrations are history, not the schema: a table one creates a later one may drop, and a query
 * against it typechecks perfectly.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { codeOnly, firstOf, root, sourceFiles, withoutComments } from "../read.ts";
import { check } from "../run.ts";
import { schemaColumns } from "../facts.ts";

/** The indexer, which lives in packages/indexing rather than services/zz-core.
 *
 *  Guarded rather than read bare: both checks below already say "reindexTeam is gone — this
 *  check reads nothing" when the function is absent, and a bare readFileSync would replace that
 *  sentence with an ENOENT stack trace. */
const indexerSource = () => {
  const f = join(root, "packages/indexing/src/index.ts");
  return existsSync(f) ? readFileSync(f, "utf8") : "";
};

check("a team whose store is gone loses its index rows", () => {
  // reindexTeam must distinguish two absences:
  //   teams/ missing        -> the volume is not mounted; touching anything would empty the index
  //   teams/<slug> missing  -> that team's store was removed; its rows must go with it
  // Conflating them leaves a retired team's rows behind, and reindexAllTeams walking teams/
  // alone can never visit the one team that needs cleaning.
  //
  // DELIBERATE: the trailing `"` in the two delete patterns below is load-bearing. Unanchored,
  // `delete from zz.<table> where team_slug=$1` also matches the per-document cleanup at the
  // foot of the same function (`... and initiative=$2 and path=$3`). The closing quote plus the
  // argument list is what tells the two apart.
  const src = indexerSource();
  const fn = /async function reindexTeam\([\s\S]*?\n}/.exec(src)?.[0] ?? "";
  const all = /async function reindexAllTeams\([\s\S]*?\n}/.exec(src)?.[0] ?? "";
  const bad = [];
  if (!fn) bad.push("reindexTeam is gone — this check reads nothing");
  else {
    if (!/existsSync\(join\(ARTIFACTS_DIR,\s*"teams"\)\)/.test(fn)) {
      bad.push("reindexTeam does not distinguish a missing teams/ mount from a missing team " +
               "directory, so either it empties the index on an unmounted volume or it leaves " +
               "ghost rows for a team that no longer has a store");
    }
    if (!/delete from zz\.doc where team_slug=\$1", \[teamSlug\]/.test(fn)) {
      bad.push("reindexTeam never deletes a vanished team's zz.doc rows");
    }
    if (!/delete from zz\.decision where team_slug=\$1", \[teamSlug\]/.test(fn)) {
      bad.push("reindexTeam deletes a vanished team's documents but not its decisions — the " +
               "two are keyed the same way and only one being cleaned is the bug this file " +
               "already fixed once for a single document");
    }
  }
  if (!all) bad.push("reindexAllTeams is gone — this check reads nothing");
  // Both tables: a team's knowledge is its own subject in its own table, and a team can hold
  // nodes and no documents at all. Pinned on the union, so dropping either half fails here.
  else if (!/select team_slug from zz\.doc/.test(all) || !/select team_slug from zz\.knowledge_node/.test(all)) {
    bad.push("reindexAllTeams does not union both index tables, so a team whose store was " +
             "removed — or one holding only knowledge nodes — is never visited and its rows " +
             "are never cleaned");
  }
  return bad.length ? bad.join("; ") : null;
});

check("a database read is not silently cut off at one megabyte", () => {
  // execFileSync truncates past maxBuffer, which defaults to 1MB: the child is killed, the
  // partial output is returned, and the only symptom is that the JSON stops parsing — which
  // psqlRows then reports as "anything else means the command is not psql".
  const src = readFileSync(join(root, "packages/tools/src/lib/psql.ts"), "utf8");
  const calls = src.match(/execFileSync\([\s\S]*?\)\.trim\(\)/g) ?? [];
  const bad = [];
  if (!calls.length) return "psql.ts no longer calls execFileSync — this check reads nothing";
  for (const c of calls) {
    if (!/maxBuffer/.test(c)) {
      bad.push("an execFileSync in psql.ts has no maxBuffer, so any answer over 1MB is " +
               "truncated and reported as malformed JSON");
    }
  }
  return bad.length ? bad.join("; ") : null;
});

check("a document's two derived tables are cleaned together", () => {
  // zz.doc holds the document; zz.decision holds the claims derived from it, keyed the same
  // way. A deleted or renamed document must lose both — indexDoc clears claims, and it never
  // runs for a file that is gone.
  //
  // DELIBERATE: this reads the cleanup loop itself rather than counting statement kinds.
  // zz.decision is deleted from twice and zz.doc once, so a count passes with the cleanup gone.
  const src = indexerSource();
  const from = src.indexOf("const gone = rows.rows.filter");
  if (from === -1) return "cannot find the reindex cleanup loop — this check needs rewriting";
  const loop = src.slice(from, src.indexOf("return { scanned", from));
  const missing = ["delete from zz.doc", "delete from zz.decision"]
    .filter((stmt) => !loop.includes(stmt));
  return missing.length === 0 ? null
    : `the reindex cleanup drops a document without ${missing.join(" or ")} — its claims stay ` +
      "behind, joined to a path nothing will ever produce again";
});

check("the platform database is reached one way", () => {
  // One psql transport, in packages/tools/src/lib/psql.ts. It is where the rule lives that a
  // statement goes in on stdin with psql `-v` bindings and never through `-c`, because psql
  // interpolates :'name' while lexing its input. It also holds the deployment's compose
  // service, user and database, recorded once.
  //
  // Keyed on `-tA`, the psql invocation itself, rather than on any tool's name.
  const home = "packages/tools/src/lib/psql.ts";
  if (!existsSync(join(root, home))) return `${home} is gone — the one psql transport with it`;
  const bad = [];
  for (const f of sourceFiles(["services", "packages"], [".ts"])) {
    if (f === home) continue;
    readFileSync(join(root, f), "utf8").split("\n").forEach((ln, i) => {
      if (/^\s*(\/\/|\*|\/\*)/.test(ln)) return;
      if (/"-tA"|'-tA'/.test(ln)) bad.push(`${f}:${i + 1} invokes psql itself`);
      if (/docker compose exec -T postgres psql/.test(ln)) bad.push(`${f}:${i + 1} spells out the psql command`);
    });
  }
  // The json_agg wrapper belongs to the transport. A caller that writes its own gets `-tA`
  // tab-separated text back and falls through to psqlRows' refusal, which names the operator's
  // command rather than the tool's own SQL. What is refused is psqlRows' envelope written by
  // hand — an ordinary aggregate elsewhere, such as the gateway aggregating a person's
  // memberships out of `pg`, has nothing to do with this transport.
  for (const f of sourceFiles(["packages/tools/src"], [".ts"])) {
    if (f === home) continue;
    readFileSync(join(root, f), "utf8").split("\n").forEach((ln, i) => {
      if (/^\s*(\/\/|\*|\/\*)/.test(ln)) return;
      if (/coalesce\(json_agg\(row_to_json\(/.test(ln)) {
        bad.push(`${f}:${i + 1} wraps its own json_agg — psqlRows composes it, and a select ` +
                 "written without one is refused with a message about the operator's command");
      }
    });
  }
  // Run it: what is held is that the transport wraps a bare SELECT, which no reading of a call
  // site can show.
  const stub = join(root, "node_modules", ".zz-psql-echo.sh");
  writeFileSync(stub, "#!/bin/sh\ncat\n", { mode: 0o755 });
  const probe = `
    import { psqlRows } from ${JSON.stringify(join(root, "packages/tools/dist/lib/psql.js"))};
    try { psqlRows(${JSON.stringify(stub)}, "select 1 from zz.doc"); } catch (e) {}
  `;
  let sent = "";
  try {
    // The stub echoes the statement back, so psqlRows dies on it, and the sentence it dies
    // with carries the statement that was sent.
    execFileSync("node", ["--input-type=module", "-e", probe], { encoding: "utf8" });
  } catch (err) {
    const e = err && typeof err === "object" ? err as Record<string, unknown> : {};
    sent = String(e.stdout ?? "") + String(e.stderr ?? "");
  }
  if (!/coalesce\(json_agg\(row_to_json\(t\)\), '\[\]'\)/.test(sent) || !/select 1 from zz\.doc/.test(sent)) {
    bad.push("psqlRows no longer wraps a bare select in the json_agg its own refusal promises: " +
             sent.replace(/\s+/g, " ").slice(0, 200));
  }
  return bad.length
    ? `${firstOf(bad)} — ${home} is where that lives, and where "on stdin, never -c" is kept true`
    : null;
});

check("nothing queries a table the migrations dropped", () => {
  // A dropped table is the one schema change no compiler catches: SQL in this repo lives in
  // template literals and shell heredocs, so a query against a table dropped by a later
  // migration typechecks and errors at run time, taking whatever reads its result with it. The
  // migrations are the schema's definition and are already replayed here for columns; this asks
  // the same replay the other question.
  const live = new Set(schemaColumns().map((c) => c.split(".")[0]));
  // The migration runner's own bookkeeping table is created by the runner, necessarily before
  // any migration runs. Read from the code that creates it rather than named here, so this does
  // not become a second list to keep in step.
  const boot = readFileSync(join(root, "services/gateway/src/db.ts"), "utf8");
  for (const m of boot.matchAll(/create table (?:if not exists )?zz\.([a-z_]+)/gi)) live.add(m[1]);
  if (live.size < 5) return "the schema replay produced almost nothing — this check reads nothing";

  const bad = [];
  for (const f of sourceFiles(["services", "packages", "scripts", "testing", "deploy"],
                              [".ts", ".sh"])) {
    if (f.includes("/migrations/")) continue;
    const src = readFileSync(join(root, f), "utf8");
    for (const m of src.matchAll(/\b(?:from|join|into|update|delete from)\s+zz\.([a-z_]+)/gi)) {
      if (!live.has(m[1])) bad.push(`${f} queries zz.${m[1]}, which no migration leaves behind`);
    }
  }
  return bad.length
    ? `${firstOf(bad)} — the statement errors at run time and takes whatever reads its result with it`
    : null;
});

check("a column the platform enforces is a column something can write", () => {
  // A column named in a WHERE that decides access must also appear in an INSERT or UPDATE
  // somewhere, or the access check it feeds can never fire.
  //
  // Taken from the schema rather than a named list, and replayed rather than read flat — a
  // column of a table a later migration drops is history, not the platform.
  const columns = new Set(schemaColumns()
    .filter((c) => /_at$/.test(c.split(".")[1]))
    .map((c) => c.split(".")[1]));
  const src = sourceFiles(["services", "packages"], [".ts"])
    .map((f) => readFileSync(join(root, f), "utf8")).join("\n");
  const bad = [];
  for (const col of [...columns].sort()) {
    const guarded = new RegExp(`\\b${col}\\b[^;]{0,120}(is null|>|<)`, "i").test(src);
    const written = new RegExp(`(insert into[^;]{0,400}\\b${col}\\b|set[^;]{0,80}\\b${col}\\s*=)`, "is").test(src);
    if (guarded && !written) {
      bad.push(`${col} is queried as though it decides something and nothing ever sets it`);
    }
  }
  return bad.length ? bad.join("; ") : null;
});

check("a SELECT DISTINCT is ordered only by columns it selects", () => {
  // Postgres rejects `select distinct a, b ... order by a, c` at parse time (42P10), so the
  // route above it returns 500 for every caller. The gate runs no SQL and does not need to.
  //
  // DELIBERATE: `distinct on (...)` is exempt. It carries the opposite rule — its ORDER BY must
  // lead with the distinct-on expressions and may then name anything — so testing it here
  // reports correct queries as broken.
  const findings = [];
  for (const rel of sourceFiles(["packages", "services", "scripts"], [".ts"])) {
    const src = withoutComments(readFileSync(join(root, rel), "utf8"));
    for (const m of src.matchAll(/\bselect\s+distinct\b/gi)) {
      const head = src.slice(m.index, m.index + 4000);
      if (/^select\s+distinct\s+on\s*\(/i.test(head)) continue;   // the opposite rule
      // The statement ends where its string does — unless it is a CTE, and then at its own
      // closing paren. Otherwise `with calling as (select distinct ...), loaded as (...) select
      // ... order by s.kind` puts the outer query's ORDER BY inside the CTE's statement and
      // reports unselected columns on a query that runs fine.
      const quote = src.lastIndexOf("`", m.index);
      const close = src.indexOf("`", m.index);
      if (quote === -1 || close === -1) continue;
      // Scan forward for the paren that closes an enclosing one. A `select distinct` at the
      // top level never meets it and keeps the whole literal; one inside `as ( … )` stops
      // exactly where the CTE does.
      let end = close, d = 0;
      for (const t of src.slice(m.index, close).matchAll(/\(|\)/g)) {
        if (t[0] === "(") d++;
        else if (d === 0) { end = m.index + t.index; break; }
        else d--;
      }
      const stmt = src.slice(m.index, end);
      // The select list runs to the first FROM outside parentheses; a subquery's own FROM
      // must not end it.
      let depth = 0, from = -1;
      for (const t of stmt.matchAll(/\(|\)|\bfrom\b/gi)) {
        if (t[0] === "(") depth++;
        else if (t[0] === ")") depth--;
        else if (depth === 0) { from = t.index; break; }
      }
      if (from === -1) continue;
      const selected = stmt.slice(m[0].length, from);
      const order = /\border\s+by\b([\s\S]*)$/i.exec(stmt)?.[1];
      if (!order) continue;
      if (/\*/.test(selected)) continue;                            // select distinct *
      const line = src.slice(0, m.index).split("\n").length;
      for (const raw of order.split(",")) {
        const expr = raw.replace(/\b(asc|desc)\b/gi, "")
                        .replace(/\bnulls\s+(first|last)\b/gi, "")
                        .replace(/[;)]+\s*$/, "").trim();
        if (!expr || /^\$?\d+$/.test(expr)) continue;                // ordinal, always legal
        const bare = expr.replace(/^[a-z_][a-z0-9_]*\./i, "");
        const has = new RegExp(`(^|[\\s,])(\\w+\\.)?${bare.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\s|,|$)`, "i");
        if (!has.test(selected)) {
          findings.push(`${rel}:${line} orders by \`${expr}\` and does not select it`);
        }
      }
    }
  }
  return firstOf(findings) &&
    `${firstOf(findings)} — Postgres refuses this at parse time (42P10), so the query never ` +
    "runs at all; add the column to the select list";
});

check("a service reaches its database through one accessor", () => {
  // A service builds its pool once, in one accessor. Spelled at several call sites, the
  // connection string and the pool size are recorded that many times.
  //
  // Under lazy construction "is a database configured" and "has anybody connected yet" are
  // different questions, and reading the `pool` variable directly answers the first with the
  // second. A write arriving before the first database-backed request then goes to disk and
  // never reaches the index.
  //
  // Two shapes are both fine. The gateway builds eagerly in initPlatformDb at boot and exposes
  // platformDb()/platformDbReady(), so existence is a boot fact. zz-core builds lazily, so
  // there every read goes through the accessor. What neither may do is build it twice.
  const bad = [];
  for (const rel of sourceFiles(["services"], [".ts"])) {
    const src = readFileSync(join(root, rel), "utf8");
    // Comments and string literals both dropped: `pool` is an ordinary English word, and a
    // tool description reading "narrow the pool" is prose about search results, not a read.
    const code = codeOnly(src);
    const lines = code.split("\n");
    const built = [...code.matchAll(/new pg\.Pool\(/g)].length;
    if (built > 1) {
      bad.push(`${rel} constructs pg.Pool ${built} times — the connection string and the pool ` +
               "size are then spelled that many times, and one of them is wrong the first " +
               "time anybody edits it. Build it in one accessor and call that");
    }
    if (!built || !/\?\?=\s*new pg\.Pool\(/.test(code)) continue;
    // Lazy: existence is whoever ran first, so nothing outside the accessor may consult it.
    const accessor = /(?:\?\?=\s*new pg\.Pool\(|^\s*return pool;|^\s*(?:let|const|var) pool\b)/;
    for (const [i, ln] of lines.entries()) {
      if (accessor.test(ln)) continue;
      if (!/(?<![\w.])pool(?![\w])/.test(ln)) continue;
      bad.push(`${rel}:${i + 1} consults \`pool\` outside the accessor that builds it lazily — ` +
               `\`${ln.trim().slice(0, 72)}\`. An unset pool means nobody has connected yet, ` +
               "not that there is no database, and which one it means depends on who ran first");
    }
  }
  return bad.join("\n");
});

check("a run is attributed to a version by time, not by a column nothing stamps", () => {
  // A run is keyed on time, not on `step_version`. That column is written only when a skill is
  // served whole through skill_read; an installed skill read off disk stamps nothing, so the
  // join it feeds resolves almost never.
  //
  // A LEFT join over a dead column compounds it: an unresolvable event still produces a row
  // carrying skill_version_id NULL, and a NULL cannot match the insert's conflict target,
  // because Postgres treats NULLs as distinct — so `do update` never fires and the timer
  // appends a duplicate every pass.
  //
  // Both halves are required: binding by a dead column loses every row, and an inner join over
  // a dead column writes nothing at all.
  //
  // Only event-resolved joins are held to it. A join on `sv.id = run.skill_version_id` reads a
  // version the insert already decided; what must be time-bound is the step where an event
  // becomes a version, recognisable by resolving against the event row itself.
  const rel = "services/gateway/src/runs.ts";
  const f = join(root, rel);
  if (!existsSync(f)) return `${rel} is gone -- this check reads nothing`;
  const code = withoutComments(readFileSync(f, "utf8"));

  const bad = [];
  if (/\bstep_version\b/.test(code)) {
    bad.push(`${rel} still keys on step_version. It is stamped on under 8% of events and has ` +
             "not moved in a month; resolve the version from the event's timestamp against " +
             "zz.skill_version.released_at instead");
  }
  // Every place a version is resolved from an event -- recognised by the skill being matched
  // on the event's own step -- must carry released_at. Counted, so that deleting the
  // derivation to satisfy the rule above cannot pass as a green tick.
  const resolutions = [...code.matchAll(/zz\.skill_version[\s\S]{0,200}/g)]
    .map((m) => m[0])
    .filter((w) => /\be\.(?:step|ts)\b/.test(w));
  if (!resolutions.length) {
    return `${rel} resolves a skill version from an event nowhere -- either the run derivation ` +
           "is gone or this extraction is broken, and both need a person rather than a tick";
  }
  for (const w of resolutions) {
    if (!/released_at/.test(w)) {
      bad.push(`${rel} resolves a version from an event without released_at: ` +
               `${w.replace(/\s+/g, " ").slice(0, 90)}`);
    }
  }
  return bad.length ? firstOf(bad) : null;
});

check("the run reconcile rewrites only the runs that changed", () => {
  // `reconcileRuns` runs every five minutes over every run, and an unconditional `do update`
  // rewrote each row on every pass whether or not anything moved — 805,942 updates on 723 rows
  // in production, all of them dead tuples. Each upsert skips a row its update would leave as
  // it is, compared against the values the update writes.
  const rel = "services/gateway/src/runs.ts";
  const f = join(root, rel);
  if (!existsSync(f)) return `${rel} is gone -- this check reads nothing`;
  const code = withoutComments(readFileSync(f, "utf8"));
  const updates = [...code.matchAll(/do update\s+set([\s\S]*?)`\)/g)].map((m) => m[1]!);
  if (updates.length !== 2) return `${rel} has ${updates.length} run upserts; this check expects the two reconcileRuns writes`;
  const bad = updates.filter((u) => !/\n\s*where \$\{CHANGED\}$/.test(u));
  if (bad.length) return `${rel}: ${bad.length} run upsert(s) rewrite the row on every pass — end the do update with \`where \${CHANGED}\``;
  const changed = /const CHANGED = `([\s\S]*?)`;/.exec(code)?.[1] ?? "";
  for (const col of ["calls", "refusals", "bytes_total", "started_at", "ended_at"]) {
    if (!changed.includes(`zz.run.${col}`)) return `${rel}: CHANGED does not compare ${col}, so a change to it alone is never written`;
  }
  if (!/is distinct from/.test(changed)) return `${rel}: CHANGED must compare with is distinct from, or a null total never counts as a change`;
  return null;
});
