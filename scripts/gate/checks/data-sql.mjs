/**
 * SQL: that every statement is one Postgres agreed to run, and that the schema queried is
 * the schema the migrations leave behind.
 *
 * Migrations are append-only history, not the schema. A table created in 002 and dropped in
 * 012 is still in the text, and a query against it typechecks perfectly.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { codeOnly, firstOf, root, sourceFiles, withoutComments, zzCoreSource } from "../read.mjs";
import { check } from "../run.mjs";
import { schemaColumns } from "../facts.mjs";

check("a team whose store is gone loses its index rows", () => {
  // GHOST ROWS. reindexTeam took one early return for two different absences:
  //   teams/ missing        -> the volume is not mounted; touching anything would empty the index
  //   teams/<slug> missing  -> that team's store was removed; its rows must go with it
  // Conflating them meant a retired team kept its zz.doc rows for good. Archiving zz-team left
  // six behind that had to be deleted by hand, and the function's own comment calls a ghost row
  // "the worst failure this store has".
  //
  // And reindexAllTeams walked teams/ alone, so the one team that needed cleaning — the one
  // with no directory — was the one it could never visit.
  const src = zzCoreSource();
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
    if (!/delete from zz\.doc where team_slug=\$1/.test(fn)) {
      bad.push("reindexTeam never deletes a vanished team's zz.doc rows");
    }
    if (!/delete from zz\.decision where team_slug=\$1/.test(fn)) {
      bad.push("reindexTeam deletes a vanished team's documents but not its decisions — the " +
               "two are keyed the same way and only one being cleaned is the bug this file " +
               "already fixed once for a single document");
    }
  }
  if (!all) bad.push("reindexAllTeams is gone — this check reads nothing");
  else if (!/select distinct team_slug from zz\.doc/.test(all)) {
    bad.push("reindexAllTeams iterates the teams/ directories alone, so a team whose store was " +
             "removed is never visited and its rows are never cleaned");
  }
  return bad.length ? bad.join("; ") : null;
});

check("a database read is not silently cut off at one megabyte", () => {
  // execFileSync TRUNCATES past maxBuffer, which defaults to 1MB: the child is killed, the
  // partial output is returned, and the only symptom is that the JSON stops parsing. psqlRows
  // then blamed the command — "anything else means the command is not psql" — which is a
  // confident accusation against the one thing that was working.
  //
  // Three days of one campaign is 1,157,750 bytes. Every tool reading this database broke at
  // exactly the volume the platform exists to produce, and the failure named the wrong thing.
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
  // way. The team reindex deleted only the first, so a deleted or renamed document left its
  // claims behind forever — indexDoc clears them, and indexDoc never runs for a file that is
  // gone. Two tables, one cleanup that knew about one of them.
  //
  // Counting the two statement kinds does NOT work, and the first version of this check did
  // exactly that: zz.decision is deleted from twice (indexDoc clears a document's claims
  // before re-deriving them, and the cleanup below), zz.doc once, so removing the cleanup's
  // one still left two against one and the check passed with the bug reinstated. A check
  // that cannot fail is not a check — so this reads the cleanup loop itself.
  const src = zzCoreSource();
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
  // Five tools each carried their own psql transport. `q<T>` in watch-results and `query<T>`
  // in flow-compare were byte-identical apart from the name; evolve-report's `events()` was
  // the same function with its SQL inlined; collect-turns and tool-report had two more. All
  // five also spelled out the same default command, so the deployment's compose service, user
  // and database were recorded in five places and would have had to be changed in five.
  //
  // That transport is not incidental. It is where the rule lives that a statement goes in on
  // STDIN with psql `-v` bindings and never through `-c` — because psql interpolates :'name'
  // while lexing its input, and deploy/issue-first-pat.sh learned both halves of that the hard
  // way. Five copies is five chances for the next one to interpolate into the SQL instead.
  //
  // Keyed on `-tA`, which is the psql invocation itself rather than on any tool's name.
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
  // AND THE WRAPPER IS THE TRANSPORT'S. psqlRows' own refusal told an operator "every query
  // here selects a single json_agg" as though something guaranteed it; nothing did, and the
  // wrapper was hand-written at seven call sites. A caller who left it off got `-tA`
  // tab-separated text, fell through to that refusal, and was told their `--psql` command was
  // not psql — a message naming the wrong half of a fault that is in the tool's own SQL.
  //
  // THE WRAPPER, not any json_agg. The gateway aggregates a nested column out of `pg` — a
  // person's memberships as one array — and that is an ordinary aggregate with nothing to do
  // with this transport. What is refused is psqlRows' own envelope, written by hand.
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
  // RUN it: what is held is that the transport wraps a bare SELECT, which no reading of a
  // call site can show.
  const stub = join(root, "node_modules", ".zz-psql-echo.sh");
  writeFileSync(stub, "#!/bin/sh\ncat\n", { mode: 0o755 });
  const probe = `
    import { psqlRows } from ${JSON.stringify(join(root, "packages/tools/dist/lib/psql.js"))};
    try { psqlRows(${JSON.stringify(stub)}, "select 1 from zz.doc"); } catch (e) {}
  `;
  let sent = "";
  try {
    // The stub echoes the statement back, so psqlRows dies on it — which is the point: the
    // sentence it dies with carries the statement that was sent.
    execFileSync("node", ["--input-type=module", "-e", probe], { encoding: "utf8" });
  } catch (err) {
    sent = String(err.stdout ?? "") + String(err.stderr ?? "");
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
  // Migration 012 dropped zz.comment when comments became sources. reset-smoke-store.sh went
  // on deleting from it AND counting it in the query that proves the wipe worked — so that
  // select errored, `rows` came back empty, and the script aborted with "store is NOT empty"
  // on a store it had just emptied. That is step 2 of 4 in run-smoke-uat.sh, so the whole
  // smoke suite could not start, and nothing said why.
  //
  // A dropped table is the one schema change no compiler catches: SQL in this repo lives in
  // template literals and shell heredocs. The migrations are the schema's definition and are
  // already replayed here for columns; this asks the same replay the other question.
  const live = new Set(schemaColumns().map((c) => c.split(".")[0]));
  // The migration runner's own bookkeeping table is created by the runner, necessarily before
  // any migration runs. Read from the code that creates it rather than named here, so this
  // does not become a second list to keep in step.
  const boot = readFileSync(join(root, "services/gateway/src/db.ts"), "utf8");
  for (const m of boot.matchAll(/create table (?:if not exists )?zz\.([a-z_]+)/gi)) live.add(m[1]);
  if (live.size < 5) return "the schema replay produced almost nothing — this check reads nothing";

  const bad = [];
  for (const f of sourceFiles(["services", "packages", "scripts", "testing", "deploy"],
                              [".ts", ".mjs", ".sh"])) {
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
  // Half a feature, in either direction, is what this repository has learned to distrust.
  // The dropped `platform_credential` table was one half — a schema implying keys were
  // encrypted at rest when they were not. `pat.expires_at` was the other: resolvePat has
  // always refused a token past its expiry, and nothing could issue one, so every token
  // lived for ever and the check could not fire. Enforcement without issuance reads, to
  // anybody looking at the schema, like a platform that expires its tokens.
  //
  // The shape is checkable: a column named in a WHERE that decides access must also appear
  // in an INSERT or UPDATE somewhere.
  // FROM THE SCHEMA, and across every source. Naming the two columns that were wrong is the
  // list of what somebody found; the schema is the list of what could be. A timestamp column
  // that gates access is exactly the kind a migration adds and nothing ever learns to set —
  // that is how `expires_at` came to make the platform look like it expires its tokens.
  // Replayed, not read flat: `resolved_at` belongs to a `comment` table that a later
  // migration drops, and demanding a writer for a column of a dropped table is asking about
  // history rather than about the platform.
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
  // Postgres 42P10. `select distinct a, b ... order by a, c` is not a slow query or a subtly
  // wrong one — it is rejected at parse time, every time, so the route above it returns 500
  // for every caller. flowsFor ordered by `f.created_at` to make the newest install win and
  // did not select it, which took /pkg out completely: no client package could be installed
  // or refreshed, for anybody, on any of the three clients. Release verification caught it in
  // production. Nothing offline could, because the gate does not run SQL — but it does not
  // need to: the select list and the order list are both right there in the string.
  //
  // `distinct on (...)` is EXEMPT and not an oversight. It carries the opposite rule — its
  // ORDER BY must LEAD with the distinct-on expressions and may then name anything at all —
  // so applying this test to it would report correct queries as broken and push whoever is
  // reading toward the rewrite that reintroduces a real bug flowsFor documents at length.
  const findings = [];
  for (const rel of sourceFiles(["packages", "services", "scripts"], [".ts", ".mjs"])) {
    const src = withoutComments(readFileSync(join(root, rel), "utf8"));
    for (const m of src.matchAll(/\bselect\s+distinct\b/gi)) {
      const head = src.slice(m.index, m.index + 4000);
      if (/^select\s+distinct\s+on\s*\(/i.test(head)) continue;   // the opposite rule
      // The statement ends where its string does — UNLESS it is a CTE, and then it ends at
      // its own closing paren. `with calling as (select distinct ...), loaded as (...)
      // select ... order by s.kind` put the OUTER query's ORDER BY inside the CTE's
      // statement, and this reported four columns as unselected on a query that runs fine.
      // A check that cries wolf on correct SQL is worse than no check: the next person to
      // see it learns to add the exemption rather than read the finding.
      const quote = src.lastIndexOf("`", m.index);
      const close = src.indexOf("`", m.index);
      if (quote === -1 || close === -1) continue;
      // Scan forward for the paren that CLOSES an enclosing one. A `select distinct` at the
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
  // zz-core spelled `pool ??= new pg.Pool({ connectionString: TEAM_DB_URL, max: 4 })` at five
  // call sites, and three more functions read the `pool` variable directly and treated
  // `undefined` as "this deployment has no database". Under LAZY construction those are
  // different questions — is one configured, and has anybody connected yet — and answering
  // the first with the second is a race with whatever the caller happened to do first.
  //
  // It had already cost something twice. reindexAllTeams' boot rebuild returned 0/0/0 for
  // every team because nothing had served a request yet, and the fix was to write the
  // construction out a fifth time. indexDoc and reindexTeam still asked it, so a write
  // arriving before the first database-backed request went to disk and never reached the
  // index — search_knowledge then answers "nothing is known" about a document that is there.
  //
  // The pool SIZE is the quiet half: four connections spelled in five places is four
  // connections until somebody changes one of them, and a pool that disagrees with itself is
  // found under load and nowhere else.
  //
  // TWO SHAPES ARE BOTH FINE, and the difference is what this measures. The gateway builds
  // its pool EAGERLY in initPlatformDb at boot and exposes platformDb()/platformDbReady(),
  // so "does it exist" is a boot fact and `platformDbReady` is its honest name. zz-core
  // builds LAZILY, where existence is a race — so there every read has to go through the
  // accessor. What neither may do is build it twice.
  const bad = [];
  for (const rel of sourceFiles(["services"], [".ts"])) {
    const src = readFileSync(join(root, rel), "utf8");
    // Comments and STRING LITERALS both dropped: `pool` is an ordinary English word, and a
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
