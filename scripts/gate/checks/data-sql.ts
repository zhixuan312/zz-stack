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
import { SCHEMA_TARGET } from "../../../schema-target.ts";

/** The indexer, which lives in packages/indexing rather than services/zz-core.
 *
 *  Guarded rather than read bare: the check below already says "reindexTeam is gone — this check
 *  reads nothing" when the function is absent, and a bare readFileSync would replace that sentence
 *  with an ENOENT stack trace. */
const indexerSource = () => {
  const f = join(root, "packages/indexing/src/index.ts");
  return existsSync(f) ? readFileSync(f, "utf8") : "";
};

check("a team's rebuild touches that team's rows and no others", () => {
  // The store a rebuild used to read was a directory per team, so "which team" was answered by
  // the path. The rows are the record now, and a document reaches its team through the
  // initiative it is filed under while a knowledge node carries `team_id` itself — two
  // different joins, one per table. A rebuild that scoped either of them wrongly would rewrite
  // another team's `body_tsv`, which is silent: the vector is derived, so the wrong one still
  // answers, just to the wrong words.
  //
  // DELIBERATE: the two corpora are asserted TOGETHER and by their scope, not by their table
  // name alone. `zz.knowledge_node` appears once in the file, inside the corpus list, and a
  // second statement naming it later would be a second writer of the same column.
  // COUPLED: the two corpora are declared in ONE list, and that list is the whole of "which rows
  // a rebuild touches" — the table, the scope that reaches it, and the statement that moves the
  // derived columns. Read from the list rather than from `reindexTeam`'s own body, because a
  // check that sliced the body would see a loop over `corpus.table` and never the table's name:
  // the scopes are what it is about, and they live where they are declared.
  const src = indexerSource();
  const corpora = /const CORPORA = \[[\s\S]*?\] as const;/.exec(src)?.[0] ?? "";
  const fn = /async function reindexTeam\([\s\S]*?\n}/.exec(src)?.[0] ?? "";
  const all = /async function reindexAllTeams\([\s\S]*?\n}/.exec(src)?.[0] ?? "";
  const bad = [];
  if (!corpora) {
    bad.push("the corpus list is gone — this check reads nothing");
  } else {
    // `zz.doc` reaches its team through the initiative a document is filed under — `zz.doc` has
    // no team column at all, so a scope that named one would not prepare.
    if (!/table: "zz\.doc"/.test(corpora)
        || !/initiative_id in \(select id from zz\.initiative where team_id = \$1::uuid\)/.test(corpora)) {
      bad.push("the zz.doc corpus does not reach the team through the initiative a document is " +
               "filed under, so either it rebuilds another team's documents or it rebuilds none");
    }
    if (!/table: "zz\.knowledge_node"/.test(corpora) || !/team_id = \$1::uuid/.test(corpora)) {
      bad.push("the zz.knowledge_node corpus is not scoped by team_id, so a team's rebuild " +
               "rewrites another shelf's node vectors");
    }
    // `update`, not `insert into`: a re-derivation moves the columns of a row that is already
    // there, and both corpora must name both of them.
    for (const [what, table] of [["zz.doc", "zz\.doc"], ["zz.knowledge_node", "zz\.knowledge_node"]] as const) {
      const stmt = new RegExp(`update ${table} set analyzer_version[\\s\\S]*?body_tsv`).test(corpora);
      if (!stmt) {
        bad.push(`the ${what} corpus moves neither derived column, so a rebuild that changed the ` +
                 "derivation leaves every row as it was");
      }
    }
  }
  if (!fn) bad.push("reindexTeam is gone — this check reads nothing");
  else if (!/\$\{corpus\.table\}/.test(fn) || !/\$\{corpus\.scope\}/.test(fn)) {
    bad.push("reindexTeam does not run the declared corpora — a list nothing iterates is a list " +
             "that scopes nothing");
  }
  if (!all) bad.push("reindexAllTeams is gone — this check reads nothing");
  // The team list is the roster, not the rows: a team that holds nothing yet is on it, and a
  // team whose rows are stale is on it either way.
  else if (!/select\s+slug\s+from\s+zz\.team\b/.test(all)) {
    bad.push("reindexAllTeams does not walk the roster, so a team holding no row is never " +
             "visited and one whose derivation moved is never rebuilt");
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
    //
    // DELIBERATE: stdio spelled out. `execFileSync` relays the child's stderr to this process
    // unless stdio is given, and this child is *meant* to die — the log line psqlRows writes
    // before it throws would print under a passing gate run and read as a failure. Piped, it is
    // captured below and nowhere else.
    execFileSync("node", ["--input-type=module", "-e", probe],
                 { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
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
  // of ITS OWN TABLE, or the access check it feeds can never fire.
  //
  // Per table, not per name: `used_at` is on two tables, and a writer of `mcp_oauth_authz.used_at`
  // kept this green when the mutation suite's first full run stopped `passkey_enrolment.used_at`
  // being set — a one-time enrolment link that never counts as used. A column with a default is
  // set by the database on insert and needs no writer here. Taken from SCHEMA_TARGET rather than
  // a named list, so a column added tomorrow is covered the day it is added.
  const src = sourceFiles(["services", "packages"], [".ts"])
    .map((f) => readFileSync(join(root, f), "utf8")).join("\n");
  const bad = [];
  for (const [table, t] of Object.entries(SCHEMA_TARGET.tables).sort(([a], [b]) => a.localeCompare(b))) {
    for (const [col, , , defaultExpr] of t.columns) {
      if (!/_at$/.test(col) || defaultExpr) continue;
      const guarded = new RegExp(`\\b${col}\\b[^;]{0,120}(is null|>|<)`, "i").test(src);
      if (!guarded) continue;
      const on = `(?:zz\\.)?${table}\\b`;
      const written = new RegExp(`(insert into\\s+${on}[^;]{0,600}\\b${col}\\b|` +
        `update\\s+${on}[^;]{0,300}\\bset\\b[^;]{0,300}\\b${col}\\s*=)`, "is").test(src);
      if (!written) bad.push(`${table}.${col} is queried as though it decides something and nothing ever sets it`);
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
  // join it feeds resolves almost never. It is not even in the schema now, and the resolution is
  // one function — runs.ts' `versionAtEvent` — which the door calls on the statement that writes
  // the row.
  //
  // A version resolved from an event must be bound by `released_at <=`: without the bound the
  // join resolves every version ever released and files the call under the newest, and resolved
  // by anything but time it resolves nothing for an installed skill, which stamps no version of
  // its own. Either way every call leaves the per-version report it exists for.
  //
  // Only time-resolved joins are held to it. A join on `sv.id = run.skill_version_id` reads a
  // version the insert already decided; what must be time-bound is the step where an instant
  // becomes a version, recognisable by its shape — the latest version released at or before it.
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
  // Recognised by the shape of the resolution rather than by the event column it reads: the
  // column that named the skill is gone, and what has to hold is that the answer is the latest
  // version released at or before the instant asked about. Counted, so that deleting the
  // resolution to satisfy the rule above cannot pass as a green tick.
  const resolutions = [...code.matchAll(/zz\.skill_version[\s\S]{0,240}/g)]
    .map((m) => m[0])
    .filter((w) => /order by\s+v\.released_at desc limit 1/.test(w));
  if (!resolutions.length) {
    return `${rel} resolves a skill version by time nowhere -- either the resolution is gone or ` +
           "this extraction is broken, and both need a person rather than a tick";
  }
  for (const w of resolutions) {
    if (!/released_at\s*<=/.test(w)) {
      bad.push(`${rel} resolves a version without bounding it to the versions released at or ` +
               `before the event: ${w.replace(/\s+/g, " ").slice(0, 90)}`);
    }
  }
  // The door resolves the version on the row it writes, through that same function: a second
  // copy of the join spelled in events.ts is one the per-version report has to keep in step by
  // hand, which is the drift this whole check exists to catch.
  const doorRel = "services/gateway/src/events.ts";
  const door = join(root, doorRel);
  if (!existsSync(door)) return `${doorRel} is gone -- this check reads nothing`;
  const doorCode = withoutComments(readFileSync(door, "utf8"));
  if (!/\bversionAtEvent\(/.test(doorCode)) {
    bad.push(`${doorRel} does not resolve a skill version through versionAtEvent, so the row ` +
             "that stamps a version and the row a per-version report reads can disagree");
  }
  if (/zz\.skill_version/.test(doorCode)) {
    bad.push(`${doorRel} spells a version resolution of its own — runs.ts' versionAtEvent is the ` +
             "one place that join is written");
  }
  return bad.length ? firstOf(bad) : null;
});

check("the run reconcile rewrites only the runs that changed", () => {
  // `reconcileRuns` runs every five minutes over every run, and an unconditional `do update`
  // rewrote each row on every pass whether or not anything moved — 805,942 updates on 723 rows
  // in production, all of them dead tuples. Every write skips a row it would leave as it is,
  // compared against the values it would write: the door's upsert against `excluded`, the repair
  // against the aggregate it recomputed. One comparison, in both, because "nothing moved" has to
  // mean the same thing at the door and on the timer.
  //
  // One conflict target, too. The run's identity is the tuple `skill_run_identity` declares, and
  // it is `nulls not distinct`, so a run with no initiative is a row on that index rather than a
  // case needing a second, partial-target statement to keep in step.
  const rel = "services/gateway/src/runs.ts";
  const f = join(root, rel);
  if (!existsSync(f)) return `${rel} is gone -- this check reads nothing`;
  const code = withoutComments(readFileSync(f, "utf8"));
  const targets = [...code.matchAll(/on conflict \(([^)]*)\)/g)].map((m) => m[1]!);
  const identity = "team_id, initiative_id, skill_version_id, session";
  if (targets.length !== 1 || targets[0]!.replace(/\s+/g, " ").trim() !== identity) {
    return `${rel} spells ${targets.length} conflict target(s); the run is keyed on one — ` +
           `(${identity}) — and a second target is a second idea of what a run is`;
  }
  const updates = [...code.matchAll(/do update\s+set([\s\S]*?)`/g)].map((m) => m[1]!);
  if (updates.length !== 1) {
    return `${rel} has ${updates.length} do update clauses; this check expects the one run upsert`;
  }
  if (!/\n\s*where \$\{CHANGED\(/.test(updates[0]!)) {
    return `${rel}: the run upsert rewrites the row on every pass — end the do update with ` +
           "`where ${CHANGED(` and the values it would write";
  }
  if (!/\$\{CHANGED\("r", "c"\)\}/.test(code)) {
    return `${rel}: the repair rewrites every run its aggregate finds, moved or not — it must ` +
           "skip them with the same comparison the upsert uses";
  }
  // And the door must compose its run from that one upsert, or the guard and the conflict target
  // are this file's idea of a run alone while the row actually written on every call is another.
  const doorRel = "services/gateway/src/events.ts";
  const door = join(root, doorRel);
  if (!existsSync(door)) return `${doorRel} is gone -- this check reads nothing`;
  if (!/\$\{RUN_CONFLICT\}/.test(withoutComments(readFileSync(door, "utf8")))) {
    return `${doorRel} does not compose its run from ${rel}'s RUN_CONFLICT, so the guard and ` +
           "the conflict target the door writes under are copies nothing keeps in step";
  }
  if (/update zz\.event\b/.test(code)) {
    return `${rel}: the timer writes zz.event again — the door stamps the identity on the row it ` +
           "writes, and the timer's only job is to recount what is already attributed";
  }
  const changed = /const CHANGED = \(stored: string, incoming: string\): string =>\s*`([\s\S]*?)`;/
    .exec(code)?.[1] ?? "";
  if (!changed) {
    return `${rel}: CHANGED is not a function of the stored row and the incoming one, so the two ` +
           "writers can come to mean different things by \"nothing moved\"";
  }
  if (!/is distinct from/.test(changed)) {
    return `${rel}: CHANGED must compare with is distinct from, or a null total never counts as a change`;
  }
  // The stored side has to name each column, and the incoming side has to fold started_at down
  // and ended_at up: without the least/greatest a late event makes the two sides disagree, and
  // the write is skipped as though nothing had moved.
  const [stored, incoming] = changed.split(/is distinct from/);
  for (const col of ["calls", "refusals", "bytes_total", "started_at", "ended_at"]) {
    if (!(stored ?? "").includes(`\${stored}.${col}`)) {
      return `${rel}: CHANGED's stored side does not name ${col}, so a change to it alone is never written`;
    }
  }
  if (!/\bleast\(/.test(incoming ?? "") || !/\bgreatest\(/.test(incoming ?? "")) {
    return `${rel}: CHANGED's incoming side does not fold started_at down and ended_at up`;
  }
  return null;
});

check("a date the platform states is cut in the deployment's zone, not the database's", () => {
  // A `timestamptz` read by `to_char` alone answers in the DATABASE's zone. These images run
  // PostgreSQL at UTC, and every date this platform writes belongs to the deployment: an
  // initiative's name comes from `isoToday()`, a document's `date` from the same clock. So a bare
  // `to_char(opened_at, 'YYYY-MM-DD')` reported an initiative opened at 00:30 in Asia/Singapore —
  // the default zone — as `2026-10-04` beside its own name `2026-10-05-…`: one row answering one
  // question twice, disagreeing for the eight hours a day the two calendars do.
  //
  // `… at time zone <zone>` is how every INSTANT is sent, deliberately — the console's own idiom —
  // so this refuses the bare form only, whatever name the expression ends in.
  const stamps = new Set<string>();
  for (const t of Object.values(SCHEMA_TARGET.tables)) {
    for (const c of t.columns ?? []) if (c[1] === "timestamp with time zone") stamps.add(c[0]);
  }
  if (!stamps.size) return "no timestamptz column is declared in the schema target — this check is reading nothing";
  const bad: string[] = [];
  let seen = 0;
  for (const f of sourceFiles(["services", "packages"], [".ts"])) {
    const src = withoutComments(readFileSync(join(root, f), "utf8"));
    for (const m of src.matchAll(/to_char\(\s*([^,()]*?)\s*,/g)) {
      seen++;
      const expr = m[1].trim();
      if (/at time zone/i.test(expr)) continue;
      const col = [...stamps].find((c) => new RegExp(`(?:^|[.\\s])${c}$`, "i").test(expr));
      if (col) {
        bad.push(`${f}: to_char(${expr}, …) renders ${col} in the database's zone — it answers in ` +
                 "UTC here, and every date this platform states is the deployment's. Say `at time " +
                 "zone` with `ZZ_TZ`.");
      }
    }
  }
  if (!seen) return "no to_char call is read in services/ or packages/ — this check is reading nothing";
  return bad.length ? bad.join("\n") : null;
});
