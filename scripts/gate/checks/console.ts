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
  // THE OPPOSITE FAILURE TO THE ONE BELOW, and the one that actually shipped.
  //
  // `?team=` was removed from /initiatives because `($1::text is null or team_slug = $1)`
  // let an absent parameter match every row — the right fix for the wrong half. The console
  // was still sending `/initiatives?team=xuan` from the team page, the parameter was no
  // longer read, and a platform-scoped reader clicking into xuan got all 70 initiatives on
  // the platform, 54 of them another team's. Nothing went red: the check below knows the
  // wildcard SHAPE, and a parameter that is ignored has no shape at all. The count beside
  // the panel was taken from the rows it was handed, so it agreed with itself and disagreed
  // with the Teams table two clicks away — which is how it survived a look.
  //
  // NARROW ON PURPOSE, AND SAYING SO. The general rule — every query key the console sends
  // is read by some route — needs the console's source, which is a different repository
  // this gate cannot read. That rule is the right one and it is not written. This names the
  // one route where it broke, so a future deletion of the parameter goes red here instead of
  // in a screenshot.
  const f = "services/gateway/src/console/initiatives.ts";
  const src = withoutComments(readFileSync(join(root, f), "utf8"));
  const bad: string[] = [];
  if (!/req\.query\.team\b/.test(src)) {
    bad.push(`${f} never reads req.query.team — the team page sends ?team= and would be ` +
             "handed every team's initiatives again");
  }
  // Reading it is not enough: it has to reach a statement. The bug would have passed a test
  // that only asked whether the string appeared.
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
  // THE BUG THIS EXISTS TO CATCH: `/api/console/initiatives` used to read
  // `where ($1::text is null or team_slug = $1)` — with no `?team=`, `$1` was null and the
  // predicate was true for every row, so every team's initiatives came back to a caller who
  // simply forgot the query string. `resolveScope` (scope.ts) exists precisely so that shape
  // has nowhere left to live: a caller is always a team, the platform, or refused, and only
  // `{ kind: "platform" }` may skip a team predicate. This check is the standing evidence
  // that console.ts actually uses it, on every route, everywhere it filters by team.
  const src = consoleSource();
  const bad: string[] = [];
  const lines = src.split("\n");

  // (a) THE WILDCARD SHAPE ITSELF. Comment lines are skipped — several here quote the
  // deleted pattern verbatim to explain what was removed and why, and quoting it in prose
  // is not resurrecting it in SQL.
  lines.forEach((line, i) => {
    const trimmed = line.trim();
    if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) return;
    if (/is null or/.test(line) && /\b(?:team_slug|slug)\s*=\s*\$/.test(line)) {
      bad.push(`line ${i + 1} lets a null parameter stand in for "every team": ${trimmed}`);
    }
  });

  // (b) and (c) read one handler body at a time. `handler("name", async (req, res, scope) =>
  // { ... })` is matched from its opening brace and walked to the matching close by counting
  // braces — this file has no import worth pulling in a real parser for one check.
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
    // (b) EVERY HANDLER TAKES A SCOPE. `handler()` resolves one and hands it to `fn` as a
    // third argument; a callback declaring only two parameters never receives it.
    const params = h.params.split(",").map((p) => p.trim()).filter(Boolean);
    if (params.length < 3) {
      bad.push(`handler("${h.name}", ...) declares only (${h.params}) — it never receives the scope`);
    }
    // (c) A QUERY THAT FILTERS ON team_slug MUST NAME THE SCOPE THAT AUTHORISED IT. Matching
    // the column alone would also flag /overview's `count(distinct (team_slug, initiative))`,
    // which groups by it and predicates nothing — so this looks for team_slug used as an
    // EQUALITY PREDICATE, and only fails when the same handler body never mentions `scope` at
    // all, i.e. it was never consulted.
    if (/\bteam_slug\s*=(?!=)/.test(h.body) && !/\bscope\b/.test(h.body)) {
      bad.push(`handler("${h.name}", ...) filters on team_slug without ever consulting scope`);
    }
  }

  // (d) A TEAMLESS ROUTE MUST STAY TEAMLESS. `teamless()` is the wrapper for routes with no
  // team dimension — the block catalog, the skills library, the run log — and it deliberately
  // resolves NO scope, so that somebody in no team (a first sign-in before the onboarding
  // timer, or anyone removed from every team) is not refused from a page that never had
  // anything to do with teams. The hazard that split introduces is the mirror of (c): a
  // team-scoped query added later to a route that has no scope to authorise it, which would
  // read every team's rows with nothing to catch it. So the same predicate test runs here,
  // and here ANY use of it is wrong rather than merely unaccompanied.
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
  // WHY THIS EXISTS: `check:sql` PREPAREs every query in this repository against a live
  // schema before a release, with no data and no execution — and it is exactly what caught
  // 0.4.0's `select distinct` ordered by a column it did not project, a parse-time error
  // (42P10) that put every `/pkg` request behind a 500 before the query ever ran, and shipped
  // anyway because nothing else in this codebase has a compiler over its SQL. That check needs
  // a live Postgres this gate does not have — but a query text ASSEMBLED AT REQUEST TIME from
  // `scope.kind` (a `${...}` hole, or a bare variable in place of a literal) is invisible to it
  // whether or not a database is running, because there is no longer one complete statement for
  // it to read. Eleven of console.ts's queries went exactly this way when the fail-open
  // `$1::text is null or team_slug = $1` predicate was deleted and replaced with runtime-built
  // text — safe, but unchecked. The fix pairs each branch into two complete literals (see
  // /api/console/initiatives for the pattern this check holds every `.query()` call to).
  //
  // ONE SCANNER, SHARED WITH check:sql — packages/tools/src/lib/sql-scan.ts. This used to be a
  // second copy of that walk, carrying a comment explaining that "a second, differently-written
  // scanner is how the two quietly disagree about what counts". That is the argument for
  // importing one, not for maintaining two.
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
  // THE BUG THIS EXISTS TO CATCH: the functions this console's write routes wrap —
  // `auditAdmin` (identity.ts) and the `my_*` credential tools (server.ts) — log through
  // `logEvent` with domain detail only, across roughly thirteen and nine call sites between
  // them, and NONE of them marks `via`. A console route that simply calls one of those
  // guarded functions inherits its authorisation but not its audit trail, and FR-8's
  // requirement that every console act record the web door fails silently: the row exists,
  // naming the actor and the act, and nothing about it says a browser pressed this rather
  // than an agent turn typing it. `via: "web"` is stated explicitly by the route itself,
  // never inherited from the function being wrapped, and this check is what stops that
  // being a thing anyone has to remember — it reads every write this console has and
  // refuses one that reaches zz-core without an event that says so.
  // console-write.ts's writes reach zz-core through `core.call(...)`. settings.ts (Task
  // I-10) writes a platform table directly instead — a password verifier is not team
  // content and zz-core has no notion of it — so it has no `core.call` to detect a write
  // by. Its own act is unmistakable: it is the only file that ever writes
  // `password_verifier`. Two files, two ways to recognise "this route writes", one rule
  // once a route counts as one: it must logEvent with `via: "web"`.
  //
  // Task I-13 added six more writes to settings.ts — credentials, access tokens, block
  // disconnect — none of which touch `password_verifier`, so `isWrite` gains a second test:
  // a call to one of the shared `my_*` functions server.ts hands this file (see settings.ts's
  // own `SettingsDeps`). And those calls do not run `logEvent` themselves — the shared
  // function does, in server.ts or block-oauth.ts, not in the route body this check reads —
  // so `via: "web"` shows up as an ARGUMENT to `issueMyAccessTokenFor(...)` and its siblings,
  // never inside a literal `logEvent(...)` written in settings.ts. WRITE_CALLS names exactly
  // those functions, and the marker scan below opens either kind of call — `logEvent(` or one
  // of WRITE_CALLS — so a route wrapping a shared function is held to the same rule as one
  // calling `logEvent` directly, without accepting `via: "web"` sitting inside an unrelated
  // call (`res.json({ via: "web" })` would not satisfy this — WRITE_CALLS is a closed list,
  // not "any call").
  const WRITE_CALLS = [
    "issueMyAccessTokenFor", "revokeMyAccessTokenFor",
    // Task I-14: team settings — member_add/member_remove's own guarded bodies (admin.ts),
    // shared with settings.ts's /team/* routes the same way the my_* functions above are.
    "addMember", "removeMember",
    // Task I-15: platform settings — person_add/person_deactivate/team_create/team_archive's
    // own guarded bodies (admin.ts), shared with settings.ts's
    // /platform/* routes the same way the team-tier functions above are. `listPeople` is not
    // here — it is a read, and this check exists for writes that need a door recorded.
    "addPerson", "deactivatePerson", "createTeam", "archiveTeam",
  ];
  const FILES = [
    { path: "services/gateway/src/console-write.ts", isWrite: (body: string) => /\bcore\.call\(/.test(body), markerCalls: [] },
    // THE THREE SCOPE MODULES, not the mount point. settings.ts was 741 lines with
    // twenty-six routes in one mountSettings; the routes are under settings/ by scope now,
    // and this check said "no app.post route was found — this check is reading the wrong
    // file" rather than passing on a file that no longer has any.
    ...["me", "team", "platform"].map((scope) => ({
      path: `services/gateway/src/settings/${scope}.ts`,
      // `active_team_id` joins `password_verifier` as a table this file writes directly with
      // no zz-core call and no shared WRITE_CALLS function to detect it by. Switching the
      // team a person acts for changes what every client of theirs shows — it is exactly the
      // kind of act FR-8 wants a door recorded for, and without this line the route would
      // have been invisible to this check rather than held by it.
      isWrite: (body: string) => /password_verifier|active_team_id/.test(body) ||
        new RegExp(`\\b(${WRITE_CALLS.join("|")})\\(`).test(body),
      markerCalls: WRITE_CALLS,
    })),
    // Task I-19: discussion.ts writes `zz.discussion_message` directly — no `core.call`
    // (there is no zz-core notion of a thread) and no shared `my_*`/`WRITE_CALLS` function
    // (the insert is the route's own body, not a guarded function three files share). Its
    // act is as unmistakable as settings.ts's `password_verifier` one: it is the only file
    // that ever names the table.
    { path: "services/gateway/src/discussion.ts", isWrite: (body: string) => /discussion_message/.test(body), markerCalls: [] },
    // Task I-24: console-ask.ts's one route calls `core.call("knowledge_search", …)` — a
    // READ, scoped by the caller's own identity, that changes nothing zz-core holds — and
    // otherwise only `generate()`, which never touches zz-core at all. Neither has a door
    // to record, so this file is deliberately NOT held to "calls logEvent with via: web"
    // the way console-write.ts's routes are. What it IS held to: a `core.call` to anything
    // OTHER than `knowledge_search` in this file is a write this check has never seen
    // before, and must not pass silently — see the file's own header for the full
    // reasoning. `isWrite` says so explicitly rather than by omission, so the day a write
    // is added here the negative lookahead below flips it to true and this check starts
    // asking the new call for its `via: "web"` the same as every other write route.
    { path: "services/gateway/src/console-ask.ts", isWrite: (body: string) => /\bcore\.call\(\s*"(?!knowledge_search")/.test(body), markerCalls: [] },
  ];
  const bad: string[] = [];

  for (const { path, isWrite, markerCalls } of FILES) {
    const src = readFileSync(join(root, path), "utf8");

    // Each `app.post(`, `app.put(` or `app.delete(` call, taken from its opening `(` to the
    // matching `)` by counting parens — the same brace/paren-walk the check above uses on
    // console.ts, because this file has no import worth pulling in a real parser for one check.
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
      // `logEvent(` plus this file's own write-function names (if any) — a CLOSED list, not
      // "any call", so `via: "web"` still has to sit inside something that actually records
      // the act rather than an arbitrary response object that merely echoes the word.
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

    // A renamed or removed shared function makes `isWrite` quietly return false for its
    // route, and every case above skips a route `isWrite` says is not a write — so a rename
    // that forgot to update WRITE_CALLS would make FR-8 regress with NOTHING in this loop
    // ever failing. Checking the list is still current is what closes that gap: the same
    // shape as "a gate check cited elsewhere is cited by a name that exists".
    // ACROSS EVERY FILE THAT DECLARES THE LIST, not per file. The settings routes are three
    // scope modules now and each calls its own subset — asked file by file, every entry looks
    // stale in two of the three, which says nothing about whether the list is current.
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
  // zz.decision's text columns are `not null default \'\'` — migration 011 — so the DATABASE
  // cannot tell "this row states no verdict" from "this row\'s verdict is the empty string".
  // The API can, and for a while did not: it returned the rows raw, so every one of the 478
  // on the production store arrived carrying `verdict: ""`, which reads as a field that is
  // broken rather than as four readers of which only two produce a verdict at all.
  //
  // THE SAME RULE THIS CONSOLE ALREADY HOLDS FOR NUMBERS. An unmeasured average is reported
  // as null and never as a confident zero (console/skills.ts, and checks/console-nulls.ts,
  // which opens by recording what happened the last time this property was left uncovered:
  // a `git checkout` reverted it and nothing went red). "" is the text-shaped version of the
  // same confident value, and it was the uncovered one.
  //
  // NARROW ON PURPOSE, AND SAYING SO. This names one endpoint and three fields rather than
  // deriving every `not null default \'\'` column the console projects. That broader rule is
  // the right one and it is not written; naming the gap is better than implying it is covered.
  const f = "services/gateway/src/console/initiatives.ts";
  const src = readFileSync(join(root, f), "utf8");
  const bad: string[] = [];
  for (const field of ["verdict", "qualifier", "checker"]) {
    // `row.x || null` is the projection. Asked as "does the file contain the field name",
    // this would pass on the SELECT list alone — which is exactly the state it is guarding
    // against, since the raw rows carried all three names and none of the coercions.
    if (!new RegExp(`${field}:\\s*row\\.${field}\\s*\\|\\|\\s*null`).test(src)) {
      bad.push(`${f} returns ${field} without mapping an empty value to null — a claim that ` +
               "states none is indistinguishable from one whose value is the empty string");
    }
  }
  // EVERY READER OF THE LEDGER, not the one that was fixed first. Two endpoints select these
  // columns — the initiative view and the document view — and a mutation of the first is what
  // revealed the second still returning them raw. Counted rather than named: a third reader
  // added later is covered without anyone remembering this check exists.
  const readers = (src.match(/from zz\.decision\b/g) ?? []).length;
  const mapped = (src.match(/\.map\(claimRow\)/g) ?? []).length;
  if (!readers) {
    bad.push(`${f} no longer queries zz.decision — this check is reading the wrong file`);
  } else if (mapped !== readers) {
    bad.push(`${f} queries zz.decision ${readers} time(s) and maps ${mapped} of them through ` +
             "claimRow — a reader that returns the rows raw states an empty verdict as a value");
  }
  // And the counts, which are what make a blank column legible as a fact about the documents.
  // ANCHORED WITH ITS COLON: written as a bare name this passed on `decisionCountsGone`, which
  // is what renaming the field to break it produced. Measured, not supposed.
  //
  // COUNTED PER READER, for the same reason claimRow is. Asked as "does the file mention it
  // anywhere", one endpoint reporting the counts would cover for the other saying nothing —
  // which is the shape of the defect that made claimRow a helper in the first place.
  const counted = (src.match(/decisionCounts:/g) ?? []).length;
  if (counted !== readers) {
    bad.push(`${f} queries zz.decision ${readers} time(s) and reports decisionCounts on ` +
             `${counted} of them — a reader that returns no counts cannot tell a column of ` +
             "nulls from a derivation that has stopped running");
  }
  return bad.length ? bad.join("; ") : null;
});

check("the console\'s version and its compose literal move together", () => {
  // The same claim the check above makes for the blocks, for the third component. The
  // console is a separate repository with its own compose file, and that file goes to the
  // host on its own — so a version that moved in package.json and not in the literal ships
  // an image nobody asked for, under a number that says otherwise.
  //
  // release.ts bumps both together and refuses when its substitution matches nothing, so
  // the only way they can disagree is a hand edit. This is what catches the hand edit
  // BEFORE the release builds anything, which is the whole reason a gate runs first.
  const dash = join(root, "..", "zz-stack-dashboard");
  // A checkout without the sibling repository cannot answer this, and should not fail on it
  // — the same escape the blocks check carries, for the same reason.
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
  // A `build:` here is what let the console reach production as source built on the host,
  // which is how production stopped running published images. The dev override file is
  // where that belongs.
  if (/^\s*build:/m.test(compose)) {
    return "the console's docker-compose.yml still declares build: — the deployed file names a "
         + "published image; building from a checkout belongs in docker-compose.build.yml";
  }
  return pinned === pkg
    ? null
    : `the console's compose pins ${pinned} but its package.json says ${pkg}`;
});

check("the server-held LLM client stays off the console", () => {
  // AC-8 (Task I-22): generate.ts is the one place this deployment's LLM credential is
  // read, and it is SERVER-SIDE ONLY — nothing the browser loads may import it, name
  // LLM_API_KEY or LLM_BASE_URL, or carry either through a NEXT_PUBLIC_* variable, which
  // Next.js inlines into every bundle it ships to every visitor. The console is a separate
  // repository (zz-stack-dashboard) checked out beside this one — the same arrangement the
  // check above reads for the same reason — so this walks its tree directly rather than
  // through sourceFiles(), which only ever answers for what THIS repo's git tracks.
  const dash = join(root, "..", "zz-stack-dashboard");
  // A checkout without the sibling repository cannot answer this, and should not fail on it
  // — the same escape the compose-version check above carries.
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
    // violation of it, the same distinction "nothing is exported that nobody imports" draws.
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

  // The other half of the same boundary, RUN rather than merely read: a deployment with no
  // LLM_* configured must still boot, and generateConfigured() has to say so truthfully
  // rather than a route discovering the gap only when generate() throws. Spawned with the
  // three variables stripped so this is independent of whatever this host happens to have
  // set — the UAT host's own deploy/.env sets all three, which would otherwise hide the
  // exact failure this exists to catch.
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

/* AN HTTP ROUTE NOTHING CALLS.
 *
 * The gateway registers 85 routes. `/api/kb/activity` was one of them and its only occurrence
 * anywhere was its own registration line — not the /app page it was written for, not the
 * console, not a client package, not a script. It was a second activity feed beside
 * /api/console/activity, which the console does call, for a page that never grew the view.
 *
 * FOUR CALLER SETS, because a route reached from any of them is live: the console app (a
 * sibling checkout, which writes the suffix after its own `const BASE = '/api/console'`), the
 * page this gateway itself serves at /app, the client packages it generates, and the repo's
 * own scripts. Leaving any one out reports live routes as dead — the first version of this
 * omitted the served page and condemned five.
 *
 * MATCHED ON THE PREFIX BEFORE THE FIRST PARAMETER. A caller writes
 * `/blocks/${block}/skills/${skill}`, which contains "/blocks" and never "/blocks/skills", so
 * dropping the parameters and rejoining the rest builds a needle that cannot occur.
 *
 * THE ONE EXEMPTION IS /.well-known/, and it is not a convenience. Those paths are defined by
 * RFC 8414 and RFC 9728 and are fetched by MCP clients nobody here wrote, so "nothing in this
 * repository names it" is the expected answer rather than a finding. Every other route has a
 * caller in one of the four sets or it is dead. */
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
      // THE GATE IS NOT A CALLER, and excluding it is load-bearing rather than tidy: the
      // paragraph above names /api/kb/activity as the route that prompted this check, so
      // without the exclusion the check finds its own comment and passes on every route
      // anybody ever explains here. Mutation-testing it is what caught that — restoring the
      // deleted route left it green. The whole gate tree is excluded, not just the entry
      // file: after the split any module's prose could name a route and vouch for it.
      hits(root, p, ["--", ":(glob)services/gateway/app/**", ":(glob)scripts/**",
                     ":(exclude)scripts/gate.ts", ":(exclude,glob)scripts/gate/**",
                     ":(glob)deploy/**", ":(glob)packages/**",
                     ":(glob)services/gateway/src/client-package.ts"]);
    if (!called) bad.push(`${r.file.replace("services/gateway/src/", "")}:${r.line} serves ${r.path} and nothing calls it`);
  }
  // "NOTHING CALLS IT" IS A LIE WHEN THE CALLER'S REPOSITORY IS NOT CHECKED OUT, and it is the
  // expensive kind of lie: the console is the only caller of the /api/console routes, so on a
  // fresh clone this check reported dozens of live routes as dead and invited a reader to
  // delete them. The condition is one `existsSync(dash)` term inside `called` above — every
  // route it guards flips at once — so the honest answer is not a shorter list but a different
  // sentence. Measured: building a copy without the sibling reported forty-three uncalled.
  //
  // It still FAILS rather than passing, because a route with no caller is what this check
  // exists to find and a gate that cannot answer has not answered. What changes is that the
  // failure names the missing repository instead of accusing the routes.
  if (bad.length && !existsSync(dash)) {
    return `../zz-stack-dashboard is not checked out beside this repository, so the console's ` +
           `calls could not be read and ${bad.length} route(s) cannot be shown to have a ` +
           `caller. This is not evidence that they have none. Clone the console beside this ` +
           `repository and run the gate again.`;
  }
  return bad.length ? bad.join("; ") : null;
});
