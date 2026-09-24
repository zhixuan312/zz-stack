/**
 * The console's own surface, checked from the platform side.
 *
 * The console is a separate repository with its own gate; these are the rules that span the
 * two — a query it sends that Postgres must accept, a write route that must record which
 * door it came through, a version that must match the compose literal beside it, and the
 * server-held LLM client that must never reach it.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { consoleSource, root, sourceFiles, unbuilt, withoutComments } from "../read.ts";
import { check, note } from "../run.ts";

check("the initiatives route reads the team filter its caller sends", () => {
  // A parameter that is ignored has no shape, so the wildcard check below cannot see it: a
  // route that stops reading `?team=` hands a platform-scoped reader every team's rows.
  //
  // This names one route. The general rule — every query key the console sends is read by some
  // route — needs the console's source, a different repository this gate cannot read.
  const f = "services/gateway/src/console/initiatives.ts";
  const src = withoutComments(readFileSync(join(root, f), "utf8"));
  const bad: string[] = [];
  if (!/req\.query\.team\b/.test(src)) {
    bad.push(`${f} never reads req.query.team — the team page sends ?team= and would be ` +
             "handed every team's initiatives again");
  }
  // Reading it is not enough: it has to reach a statement.
  if (!/,\s*\[want\]\s*\)/.test(src)) {
    bad.push(`${f} reads a team filter but no query is bound to it — see the note there`);
  }
  // And a team scope must not be able to name another team's slug through it.
  if (!/scope\.kind === "team" && want !== null && want !== scope\.slug/.test(src)) {
    bad.push(`${f} does not refuse a team scope naming another team's slug via ?team=`);
  }
  return bad.length ? bad.join("; ") : undefined;
});

check("a console query cannot fall back to every team", () => {
  // `where ($1::text is null or team_slug = $1)` makes the predicate true for every row when
  // no `?team=` is sent. `resolveScope` (scope.ts) leaves that shape nowhere to live: a caller
  // is a team, the platform, or refused, and only `{ kind: "platform" }` may skip a team
  // predicate. This is the standing evidence console.ts uses it on every route that filters
  // by team.
  const src = consoleSource();
  const bad: string[] = [];
  const lines = src.split("\n");

  // (a) The wildcard shape itself. Comment lines are skipped: several here quote the pattern
  // verbatim, and quoting it in prose is not resurrecting it in SQL.
  lines.forEach((line, i) => {
    const trimmed = line.trim();
    if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) return;
    if (/is null or/.test(line) && /\b(?:team_slug|slug)\s*=\s*\$/.test(line)) {
      bad.push(`line ${i + 1} lets a null parameter stand in for "every team": ${trimmed}`);
    }
  });

  // (b) and (c) read one handler body at a time. `handler("name", async (req, res, scope) =>
  // { ... })` is matched from its opening brace and walked to the matching close by counting
  // braces.
  const bodies = [];
  const open = /handler\("([^"]*)",\s*async\s*\(([^)]*)\)\s*=>\s*\{/g;
  let m;
  while ((m = open.exec(src))) {
    let depth = 1, i = open.lastIndex;
    for (; i < src.length && depth > 0; i++) {
      if (src[i] === "{") depth++;
      else if (src[i] === "}") depth--;
    }
    bodies.push({ name: m[1], params: m[2], body: src.slice(open.lastIndex, i - 1) });
  }
  if (!bodies.length) {
    bad.push("no handler(\"name\", async (req, res, scope) => {...}) bodies were found — this " +
             "check is reading the wrong file or the wrapper's shape changed under it");
  }
  for (const h of bodies) {
    // (b) Every handler takes a scope. `handler()` resolves one and hands it to `fn` as a
    // third argument; a callback declaring only two parameters never receives it.
    const params = h.params.split(",").map((p) => p.trim()).filter(Boolean);
    if (params.length < 3) {
      bad.push(`handler("${h.name}", ...) declares only (${h.params}) — it never receives the scope`);
    }
    // (c) A query filtering on team_slug must name the scope that authorised it. team_slug as
    // an equality predicate only — /overview's `count(distinct (team_slug, initiative))` groups
    // by it and predicates nothing — and only when the handler body never mentions `scope`.
    if (/\bteam_slug\s*=(?!=)/.test(h.body) && !/\bscope\b/.test(h.body)) {
      bad.push(`handler("${h.name}", ...) filters on team_slug without ever consulting scope`);
    }
  }

  // (d) A teamless route must stay teamless. `teamless()` wraps routes with no team dimension
  // — the plugin catalog, the skills library, the run log — and resolves no scope, so somebody
  // in no team is not refused from them. Any team predicate here is wrong rather than merely
  // unaccompanied: nothing authorised it.
  const teamlessBodies = [];
  const openTeamless = /teamless\("([^"]*)",\s*async\s*\(([^)]*)\)\s*=>\s*\{/g;
  let t;
  while ((t = openTeamless.exec(src))) {
    let depth = 1, i = openTeamless.lastIndex;
    for (; i < src.length && depth > 0; i++) {
      if (src[i] === "{") depth++;
      else if (src[i] === "}") depth--;
    }
    teamlessBodies.push({ name: t[1], body: src.slice(openTeamless.lastIndex, i - 1) });
  }
  for (const h of teamlessBodies) {
    if (/\bteam_slug\s*=(?!=)/.test(h.body) || /\bt\.slug\s*=(?!=)/.test(h.body)) {
      bad.push(`teamless("${h.name}", ...) filters by team — it resolves no scope, so nothing ` +
               `authorised that filter; move it to handler() and use the scope`);
    }
  }
  return bad.length ? bad.join("; ") : null;
});

check("a console query is a literal check:sql can PREPARE", () => {
  // `check:sql` PREPAREs every query in this repository against a live schema, which this gate
  // has no Postgres for — and a query text assembled at request time from `scope.kind` (a
  // `${...}` hole, or a bare variable in place of a literal) is invisible to it either way,
  // because there is no longer one complete statement to read. Each branch is paired into two
  // complete literals; /api/console/initiatives carries the pattern every `.query()` call here
  // is held to.
  //
  // COUPLED: the scanner is packages/tools/src/lib/sql-scan.ts, shared with check:sql.
  const nothingToRun = unbuilt();
  if (nothingToRun) return nothingToRun;
  const src = consoleSource();
  const out = execFileSync("node", ["--input-type=module", "-e",
    `import { queriesIn } from ${JSON.stringify(join(root, "packages/tools/dist/lib/sql-scan.js"))};` +
    "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>" +
    "process.stdout.write(JSON.stringify(queriesIn(s))));"],
    { encoding: "utf8", input: src });
  const bad: string[] = [];
  for (const q of JSON.parse(out)) {
    if (q.why) {
      bad.push(`console.ts:${q.line} passes .query() a variable, not a literal — check:sql ` +
               `cannot PREPARE it, whatever it is built from`);
    } else if (/\$\{/.test(q.sql)) {
      bad.push(`console.ts:${q.line} builds its SQL text at runtime (\${...}) — pair the ` +
               `branches into two complete literals instead of interpolating one`);
    }
  }
  return bad.length ? bad.join("; ") : null;
});

check("every console write route records the door it came through", () => {
  // The functions this console's write routes wrap — `auditAdmin` (identity.ts) and the token
  // functions in credentials.ts — log through `logEvent` with domain detail only and mark no
  // `via`. Every console act records the web door, so `via: "web"` is stated by
  // the route itself and never inherited from the function being wrapped. Every write route
  // must logEvent with `via: "web"`.
  //
  // Two ways to recognise "this route writes". console-write.ts reaches zz-core through
  // `core.call(...)`. The settings modules write platform tables directly — `active_team_id`,
  // and the shared token functions server.ts hands them (see settings.ts's `SettingsDeps`).
  //
  // Those shared functions run `logEvent` themselves, in credentials.ts, not in
  // the route body this check reads, so `via: "web"` appears as an argument to
  // `issueMyAccessTokenFor(...)` and its siblings rather than inside a literal `logEvent(...)`.
  // WRITE_CALLS is a closed list, so `via: "web"` inside an unrelated call
  // (`res.json({ via: "web" })`) does not satisfy the scan.
  const WRITE_CALLS = [
    "issueMyAccessTokenFor", "revokeMyAccessTokenFor",
    // member_add/member_remove's guarded bodies (admin.ts), shared with the /team/* routes the
    // same way the token functions above are.
    "addMember", "removeMember",
    // person_add/person_deactivate/team_create/team_archive's guarded bodies (admin.ts),
    // shared with the /platform/* routes. `listPeople` is not here — it is a read.
    "addPerson", "deactivatePerson", "createTeam", "archiveTeam",
  ];
  const FILES = [
    { path: "services/gateway/src/console-write.ts", isWrite: (body: string) => /\bcore\.call\(/.test(body), markerCalls: [] },
    // The three scope modules, not the mount point: the routes live under settings/ by scope.
    ...["me", "team", "platform"].map((scope) => ({
      path: `services/gateway/src/settings/${scope}.ts`,
      // `active_team_id` is a column this file writes directly, with no zz-core call and no
      // WRITE_CALLS function to detect it by. Switching the team a person acts for changes what
      // every client of theirs shows.
      isWrite: (body: string) => /active_team_id/.test(body) ||
        new RegExp(`\\b(${WRITE_CALLS.join("|")})\\(`).test(body),
      markerCalls: WRITE_CALLS,
    })),
    // discussion.ts writes `zz.discussion_message` directly — no `core.call` and no shared
    // WRITE_CALLS function — so naming the table is what identifies the write.
    { path: "services/gateway/src/discussion.ts", isWrite: (body: string) => /discussion_message/.test(body), markerCalls: [] },
    // console-ask.ts calls `core.call("knowledge_search", …)`, a read, and otherwise only
    // `generate()`. DELIBERATE: `isWrite` is a negative lookahead rather than a constant false,
    // so a `core.call` to anything other than knowledge_search added here flips it to true and
    // the new call is asked for its `via: "web"` like every other write route.
    { path: "services/gateway/src/console-ask.ts", isWrite: (body: string) => /\bcore\.call\(\s*"(?!knowledge_search")/.test(body), markerCalls: [] },
  ];
  const bad: string[] = [];

  for (const { path, isWrite, markerCalls } of FILES) {
    const src = readFileSync(join(root, path), "utf8");

    // Each `app.post(`, `app.put(` or `app.delete(` call, taken from its opening `(` to the
    // matching `)` by counting parens.
    const open = /app\.(post|put|delete)\(/g;
    let m;
    const routes = [];
    while ((m = open.exec(src))) {
      let depth = 1, i = open.lastIndex;
      for (; i < src.length && depth > 0; i++) {
        if (src[i] === "(") depth++;
        else if (src[i] === ")") depth--;
      }
      routes.push({ method: m[1], body: src.slice(open.lastIndex, i - 1) });
    }
    if (!routes.length) {
      bad.push(`no app.post/put/delete(...) route was found in ${path} — this check is reading ` +
               "the wrong file or the route's shape changed under it");
    }

    for (const r of routes) {
      // A route that performs no write has no door to record.
      if (!isWrite(r.body)) continue;
      // `logEvent(` plus this file's own write-function names — a closed list, so `via: "web"`
      // has to sit inside something that records the act.
      const callNames = ["logEvent", ...markerCalls];
      const callOpen = new RegExp(`\\b(${callNames.join("|")})\\(`, "g");
      let sawCall = false, sawMarker = false;
      while (callOpen.exec(r.body)) {
        sawCall = true;
        let depth = 1, j = callOpen.lastIndex;
        for (; j < r.body.length && depth > 0; j++) {
          if (r.body[j] === "(") depth++;
          else if (r.body[j] === ")") depth--;
        }
        if (/via\s*:\s*"web"/.test(r.body.slice(callOpen.lastIndex, j - 1))) sawMarker = true;
      }
      if (!sawCall) {
        bad.push(`${path}: app.${r.method}(...) writes but never calls ${callNames.join("/")}() — the act has no audit row at all`);
      } else if (!sawMarker) {
        bad.push(`${path}: app.${r.method}(...) calls ${callNames.join("/")}() without via: "web" in its arguments — the write's audit row does not name the door it came through`);
      }
    }

    // A renamed or removed shared function makes `isWrite` return false for its route, and
    // every case above skips a route `isWrite` says is not a write — so checking the list is
    // still current is what stops a rename dropping `via: "web"` with nothing here failing.
    //
    // Asked across every file that declares the list, not per file: the settings routes are
    // three scope modules and each calls its own subset.
    for (const name of markerCalls) {
      const anywhere = FILES.filter((g) => g.markerCalls === markerCalls)
        .some((g) => existsSync(join(root, g.path))
          && new RegExp(`\\b${name}\\(`).test(readFileSync(join(root, g.path), "utf8")));
      if (!anywhere) {
        bad.push(`WRITE_CALLS names "${name}" and no settings route calls it — the list is stale`);
      }
    }
  }
  return bad.length ? bad.join("; ") : null;
});

check("a claim that states no verdict says so, rather than stating an empty one", () => {
  // zz.decision's text columns are `not null default \'\'`, so the database
  // cannot tell "this row states no verdict" from "this row\'s verdict is the empty string".
  // Returned raw, every row arrives carrying `verdict: ""`.
  //
  // COUPLED: the same rule this console holds for numbers — an unmeasured average is reported
  // as null, never as a confident zero (console/skills.ts, checks/console-nulls.ts).
  //
  // This names one endpoint and three fields rather than deriving every `not null default \'\'`
  // column the console projects. The broader rule is not written.
  const f = "services/gateway/src/console/initiatives.ts";
  const src = readFileSync(join(root, f), "utf8");
  const bad: string[] = [];
  for (const field of ["verdict", "qualifier", "checker"]) {
    // `row.x || null` is the projection. Asked as "does the file contain the field name", this
    // would pass on the SELECT list alone.
    if (!new RegExp(`${field}:\\s*row\\.${field}\\s*\\|\\|\\s*null`).test(src)) {
      bad.push(`${f} returns ${field} without mapping an empty value to null — a claim that ` +
               "states none is indistinguishable from one whose value is the empty string");
    }
  }
  // Every reader of the ledger, counted rather than named: the initiative view and the
  // document view both select these columns, and a third added later is covered without anyone
  // remembering this check exists.
  const readers = (src.match(/from zz\.decision\b/g) ?? []).length;
  const mapped = (src.match(/\.map\(claimRow\)/g) ?? []).length;
  if (!readers) {
    bad.push(`${f} no longer queries zz.decision — this check is reading the wrong file`);
  } else if (mapped !== readers) {
    bad.push(`${f} queries zz.decision ${readers} time(s) and maps ${mapped} of them through ` +
             "claimRow — a reader that returns the rows raw states an empty verdict as a value");
  }
  // And the counts, which make a blank column legible as a fact about the documents.
  // DELIBERATE: `decisionCounts:` is anchored with its colon — a bare name passes on
  // `decisionCountsGone`. Counted per reader, so one endpoint reporting the counts cannot
  // cover for another saying nothing.
  const counted = (src.match(/decisionCounts:/g) ?? []).length;
  if (counted !== readers) {
    bad.push(`${f} queries zz.decision ${readers} time(s) and reports decisionCounts on ` +
             `${counted} of them — a reader that returns no counts cannot tell a column of ` +
             "nulls from a derivation that has stopped running");
  }
  return bad.length ? bad.join("; ") : null;
});

check("the console\'s version and its compose literal move together", () => {
  // The console is a separate repository with its own compose file, and that file goes to the
  // host on its own — a version that moved in package.json and not in the literal ships an
  // image nobody asked for. release.ts bumps both together and refuses when its substitution
  // matches nothing, so only a hand edit can make them disagree.
  const dash = join(root, "..", "zz-stack-dashboard");
  // A checkout without the sibling repository cannot answer this, and does not fail on it.
  if (!existsSync(join(dash, "package.json"))) {
    note("    console compose version: ../zz-stack-dashboard is not checked out beside this "
       + "repository, so the two versions were not compared.");
    return null;
  }
  const pkg = JSON.parse(readFileSync(join(dash, "package.json"), "utf8")).version;
  if (!pkg) return "zz-stack-dashboard/package.json declares no version";
  const composePath = join(dash, "docker-compose.yml");
  if (!existsSync(composePath)) return "zz-stack-dashboard has no docker-compose.yml to name an image";
  const compose = readFileSync(composePath, "utf8");
  const pinned = compose.match(/\$\{ZZ_DASHBOARD_VERSION:-([^}]*)\}/)?.[1];
  if (!pinned) {
    return "the console's compose file has no ZZ_DASHBOARD_VERSION literal — a host receiving "
         + "that file would have to be told what to type, which is what the literal exists to avoid";
  }
  // A `build:` here would let the console reach production as source built on the host. The
  // dev override file is where that belongs.
  if (/^\s*build:/m.test(compose)) {
    return "the console's docker-compose.yml still declares build: — the deployed file names a "
         + "published image; building from a checkout belongs in docker-compose.build.yml";
  }
  return pinned === pkg
    ? null
    : `the console's compose pins ${pinned} but its package.json says ${pkg}`;
});

check("the server-held LLM client stays off the console", () => {
  // generate.ts is the one place this deployment's LLM credential is read, and it is
  // server-side only: nothing the browser loads may import it, name LLM_API_KEY or
  // LLM_BASE_URL, or carry either through a NEXT_PUBLIC_* variable, which Next.js inlines into
  // every bundle it ships. The console is a separate repository (zz-stack-dashboard) checked
  // out beside this one, so this walks its tree directly rather than through sourceFiles(),
  // which answers only for what this repo's git tracks.
  const dash = join(root, "..", "zz-stack-dashboard");
  // Same escape as the compose-version check above: no sibling repository, nothing scanned.
  if (!existsSync(dash)) {
    note("    console secret scan: ../zz-stack-dashboard is not checked out beside this "
       + "repository, so no console file was scanned for an inlined key.");
    return null;
  }

  const SKIP_DIRS = new Set(["node_modules", ".git", ".next", "dist", "build", "coverage", ".turbo", "docs"]);
  const relevant = (name: string): boolean => name.startsWith(".env") || /\.(ts|tsx|js|jsx|mjs|cjs|json|ya?ml)$/.test(name);
  const files: string[] = [];
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        walk(join(d, e.name));
      } else if (relevant(e.name)) {
        files.push(join(d, e.name));
      }
    }
  };
  walk(dash);

  const bad: string[] = [];
  for (const f of files) {
    const rel = f.slice(dash.length + 1);
    // Comments stripped, strings intact — a paragraph explaining this boundary is not a
    // violation of it.
    const src = withoutComments(readFileSync(f, "utf8"));
    for (const m of src.matchAll(/(?:from\s+|require\(|import\(\s*)["']([^"']+)["']/g)) {
      const spec = m[1];
      if (/gateway/.test(spec) && /generate(\.js)?$/.test(spec)) {
        bad.push(`${rel}: imports the gateway's generate module (${spec})`);
      }
    }
    if (/\bLLM_API_KEY\b/.test(src)) bad.push(`${rel}: names LLM_API_KEY`);
    if (/\bLLM_BASE_URL\b/.test(src)) bad.push(`${rel}: names LLM_BASE_URL`);
    for (const m of src.matchAll(/\bNEXT_PUBLIC_[A-Z0-9_]*LLM[A-Z0-9_]*\b/g)) {
      bad.push(`${rel}: ${m[0]} would ship the LLM endpoint into every visitor's bundle`);
    }
  }

  // The other half of the same boundary, run rather than read: a deployment with no LLM_*
  // configured must still boot, and generateConfigured() must say so rather than a route
  // discovering the gap when generate() throws. Spawned with the three variables stripped, so
  // a host that has them set cannot hide the failure.
  const nothingToRun = unbuilt();
  if (nothingToRun) {
    bad.push(nothingToRun);
  } else {
    const probe = `
      import { generate, generateConfigured } from ${JSON.stringify(join(root, "services/gateway/dist/generate.js"))};
      const bad = [];
      if (generateConfigured()) bad.push("generateConfigured() said true with no LLM_* set");
      try {
        await generate({ system: "s", user: "u" });
        bad.push("generate() did not refuse with no LLM_* set");
      } catch (err) {
        if (err?.status !== 503) bad.push("a missing credential did not carry status 503");
        const msg = String(err?.message ?? "");
        for (const name of ["LLM_BASE_URL", "LLM_API_KEY", "PLATFORM_BASE_MODEL"]) {
          if (!msg.includes(name)) bad.push("the refusal did not name " + name + ": " + msg);
        }
      }
      process.stdout.write(bad.join("; "));
    `;
    try {
      const env = { ...process.env };
      delete env.LLM_API_KEY;
      delete env.LLM_BASE_URL;
      delete env.PLATFORM_BASE_MODEL;
      const out = execFileSync("node", ["--input-type=module", "-e", probe], { encoding: "utf8", env });
      if (out.trim()) bad.push(out.trim());
    } catch (err) {
      const stderr = err && typeof err === "object" ? (err as Record<string, unknown>).stderr : undefined;
      bad.push(`generate.ts could not be imported with no credential set: ${String(stderr ?? err).slice(-300)}`);
    }
  }

  return bad.length ? [...new Set(bad)].join("; ") : null;
});

/* A route is live if it is reached from any of four caller sets: the console app (a sibling
 * checkout, which writes the suffix after its own `const BASE = '/api/console'`), the page
 * this gateway serves at /app, the client packages it generates, and this repo's scripts.
 * Leaving any one out reports live routes as dead.
 *
 * Matched on the prefix before the first parameter. A caller writes
 * `/skills/${name}/scores`, which contains "/skills" and never "/skills/scores", so
 * dropping the parameters and rejoining the rest builds a needle that cannot occur.
 *
 * DELIBERATE: /.well-known/ is exempt. Those paths are defined by RFC 8414 and RFC 9728 and are
 * fetched by MCP clients nobody here wrote, so "nothing in this repository names it" is the
 * expected answer rather than a finding. */
check("every route this gateway serves has a caller", () => {
  const dash = join(root, "..", "zz-stack-dashboard");
  const files = sourceFiles(["services/gateway/src"], [".ts"]);
  const found = [];
  for (const f of files) {
    const src = readFileSync(join(root, f), "utf8");
    for (const m of src.matchAll(/\bapp\.(get|post|put|delete|patch)\s*\(\s*("[^"]*"|'[^']*')/g)) {
      const path = m[2].slice(1, -1);
      if (!path.startsWith("/")) continue;
      found.push({ file: f, line: src.slice(0, m.index).split("\n").length, path });
    }
  }
  if (found.length < 20) return `only ${found.length} routes parsed — the walk is pointed wrong`;

  const prefix = (p: string): string => {
    const out: string[] = [];
    for (const seg of p.split("/")) {
      if (!seg) continue;
      if (seg.startsWith(":") || seg === "*") break;
      out.push(seg);
    }
    return "/" + out.join("/");
  };
  const hits = (cwd: string, needle: string, spec: string[]): boolean => {
    try {
      execFileSync("git", ["grep", "-q", "--fixed-strings", needle, ...spec],
        { cwd, stdio: "ignore" });
      return true;
    } catch { return false; }
  };

  const bad: string[] = [];
  for (const r of found) {
    if (r.path.startsWith("/.well-known/")) continue;
    const p = prefix(r.path);
    if (p === "/" || p === "") continue;
    const suffix = p.startsWith("/api/console") ? (p.slice("/api/console".length) || "/") : p;
    const called =
      (existsSync(dash) && hits(dash, suffix, [])) ||
      // DELIBERATE: the whole gate tree is excluded as a caller, not just the entry file. A
      // gate module's prose naming a route would otherwise vouch for it.
      hits(root, p, ["--", ":(glob)services/gateway/app/**", ":(glob)scripts/**",
                     ":(exclude)scripts/gate.ts", ":(exclude,glob)scripts/gate/**",
                     ":(glob)deploy/**", ":(glob)packages/**",
                     ":(glob)services/gateway/src/client-package.ts"]);
    if (!called) bad.push(`${r.file.replace("services/gateway/src/", "")}:${r.line} serves ${r.path} and nothing calls it`);
  }
  // The console is the only caller of the /api/console routes, so without the sibling checkout
  // this would report live routes as dead. It still fails rather than passing — a gate that
  // cannot answer has not answered — but the failure names the missing repository instead of
  // accusing the routes.
  if (bad.length && !existsSync(dash)) {
    return `../zz-stack-dashboard is not checked out beside this repository, so the console's ` +
           `calls could not be read and ${bad.length} route(s) cannot be shown to have a ` +
           `caller. This is not evidence that they have none. Clone the console beside this ` +
           `repository and run the gate again.`;
  }
  return bad.length ? bad.join("; ") : null;
});
