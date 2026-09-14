/**
 * Who the caller is, and which team they act for.
 *
 * The team is a column on the person, read fresh on every call, and everything the platform
 * scopes depends on it being derived one way. A tool that picks a team by taking the first
 * membership row is not wrong for somebody in one team, which is why it survives review.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { between, codeOnly, contractsSource, firstOf, gatewaySource, root, sourceFiles, toolsIn, unbuilt, withoutComments, zzCoreSource } from "../read.ts";
import { check } from "../run.ts";

/** A caught value is never typed as an Error — narrow the shape actually being read rather
 *  than assume it. Here it is an `execFileSync` failure, which carries `stdout`/`stderr`
 *  rather than a plain `message`. */
function execStderr(err: unknown): string {
  const e = err && typeof err === "object" ? err as Record<string, unknown> : {};
  return e.stderr !== undefined ? String(e.stderr) : String(err);
}

check("authority is decided by one function, never by comparing the role", () => {
  // "A superadmin is every team" is a real rule and a correct one. It was also written out
  // by hand in four places — team_list, catalog_list, install_list and the knowledge
  // store's team check — in a form that compares platformRole directly and therefore cannot
  // see anything else about how the caller authenticated. So a token deliberately bound to
  // one team listed every team on the platform, and one of those four even declared a local
  // `const isSuper` that SHADOWED the imported check of that name.
  //
  // isSuper() is where the question is answered: role, plus whether this is a PAT, plus its
  // scope, plus its team binding. A second spelling of it is a spelling that stops agreeing.
  const bad: string[] = [];
  const OWNER = "services/gateway/src/identity.ts";
  for (const rel of sourceFiles(["services", "packages"], [".ts"])) {
    readFileSync(join(root, rel), "utf8").split("\n").forEach((raw, i) => {
      const line = raw.trim();
      if (line.startsWith("//") || line.startsWith("*")) return;
      if (!/platformRole\s*[!=]==\s*"superadmin"/.test(line)) return;
      // identity.ts is allowed: it is where the answer is computed, and where the role is
      // projected into the downstream identity header.
      if (rel === OWNER) return;
      bad.push(`${rel}:${i + 1} decides authority from platformRole — call isSuper(id)`);
    });
  }
  return bad.length ? bad.join("; ") : null;
});

check("the team a person acts for is stored, not asserted", () => {
  const nothingToRun = unbuilt();
  if (nothingToRun) return nothingToRun;
  // ONE active team per person, chosen in ZZ Access and read from the database on every
  // call. The whole value is that there is a single answer to "which team" — so the ways it
  // used to be decided must stay gone, not linger beside it:
  //
  //   · a header a client sends (any client could then claim any team, and the middleware
  //     had to police it)
  //   · `every[0]` — an active team decided by role and the alphabet, which nobody chose
  //     and nobody could see
  //
  // A bound token is the ONE exception and stays: automation confined to a team.
  const bad: string[] = [];
  const idsrc = readFileSync(join(root, "services/gateway/src/identity.ts"), "utf8");
  if (/x-zz-team/.test(idsrc)) {
    bad.push("the gateway still reads a team from the request — the active team is a column");
  }
  const core = zzCoreSource();
  if (!/active_team_id/.test(core)) bad.push("zz-core no longer reads the stored active team");
  // The RULE now lives in @zz/contracts, because the gateway needs the same answer for
  // credential resolution and was taking the first row of a differently ordered query — so
  // a person in two teams could have documents land in one team's store while the block
  // call spent another team's quota. Both services call actingTeam.
  //
  // Which means this can RUN it rather than grep for the expression that used to implement
  // it. The earlier version tested for the literal `every.includes(stored)` and failed the
  // moment the rule moved, while the property it names still held perfectly.
  if (!/actingTeam\(/.test(core)) bad.push("zz-core no longer uses the shared acting-team rule");
  const probe = `
    import { actingTeam } from ${JSON.stringify(join(root, "packages/contracts/dist/index.js"))};
    const m = [{ slug: "zebra", role: "admin" }, { slug: "alpha", role: "member" }];
    const bad = [];
    if (actingTeam(m, "gone", null) !== "zebra") bad.push("a stored team that is no longer a membership must be ignored, not obeyed");
    if (actingTeam(m, "alpha", null) !== "alpha") bad.push("the team a person chose must win over the fallback");
    if (actingTeam(m, null, null) !== "zebra") bad.push("the fallback must be deterministic: admin role, then alphabetical");
    if (actingTeam(m, "alpha", "zebra") !== "zebra") bad.push("a bound token must outrank the person's chosen team");
    if (actingTeam(m, "alpha", "other") !== null) bad.push("a token bound to a team they are not in must get NO team, not another of theirs");
    if (actingTeam([], "alpha", null) !== null) bad.push("belonging to no team must resolve to no team");
    process.stdout.write(bad.join("; "));
  `;
  try {
    const out = execFileSync("node", ["--input-type=module", "-e", probe], { encoding: "utf8" });
    if (out.trim()) bad.push(out.trim());
  } catch (err) {
    bad.push(`the acting-team rule could not be run: ${execStderr(err).slice(-200)}`);
  }
  const srv = gatewaySource();
  if (!/"team_switch"/.test(srv)) bad.push("there is no way for a person to switch team");
  // And nothing may quietly pick a different one. `teams[0]` is a membership row in whatever
  // order a query returned it, and it was standing in for the acting team in three places:
  // credential resolution (so a block call could spend one team's quota while documents
  // landed in another's), the web knowledge base (so the browser showed one team and the
  // agent wrote to the other), and catalog_list (so "what does my team run" answered about
  // a team they were not working in). None of them failed; they were just about a different
  // team than the person was.
  // The three files it was found in are the three it was named for. It is a mistake anyone
  // reaching for a person's team can make, in any file that has the list.
  for (const f of sourceFiles(["services", "packages"], [".ts"])) {
    const src = readFileSync(join(root, f), "utf8");
    for (const [i, line] of src.split("\n").entries()) {
      if (/^\s*(\/\/|\*|\/\*)/.test(line)) continue;
      // Any local that holds the list, not the name `teams` alone. catalog_list aliased it
      // to `myTeams` and then took `myTeams[0]`, one line below a comment refusing exactly
      // that — and `\bteams\[0\]` cannot match it, because `y` and `t` are both word
      // characters so there is no boundary to anchor on.
      if (/[Tt]eams\[0\]/.test(line)) {
        bad.push(`${f}:${i + 1} takes the first membership row instead of the acting team`);
      }
    }
  }
  // Switching is a state change on who did what, and this platform records those.
  const zone = srv.slice(srv.indexOf('"team_switch"'));
  if (!/team\.switch/.test(zone.slice(0, 3000))) {
    bad.push("switching team is not recorded as an event");
  }
  return bad.length ? bad.join("; ") : null;
});

check("a tool picks the caller's team the platform's way", () => {
  // "Which team am I acting for" has exactly one right answer per request, and actingTeam in
  // @zz/contracts is where it is decided — the bound token first, then the team the person
  // chose, then admin-role before alphabetical. Its own docstring records that the gateway
  // once took the first row of a differently ordered query and put documents in one team's
  // store while the block call spent another's.
  //
  // team_mine was still doing it, in the one tool whose entire job is to answer the question:
  // `order by t.slug`, then `rows.find(r => r.active) ?? rows[0]`. A person who is a member
  // of 'alpha' and an admin of 'beta' and has never switched was told alpha while every call
  // acted for beta, and no other check saw it because both answers are a team the person is
  // really in. Fixing that instance is not the point — the query is easy to write again.
  //
  // So: a tool that reads memberships and SELECTS one of them is choosing a caller's team,
  // and must choose it the one way. Listing them all (team_switch's "yours:" line) is not
  // selecting, and neither is acting on a team named in an argument.
  const bad: string[] = [];
  for (const f of sourceFiles(["services"], [".ts"])) {
    const src = readFileSync(join(root, f), "utf8");
    for (const { name, body } of toolsIn(src)) {
      if (!/\bzz\.membership\b|\bfrom membership\b/i.test(body)) continue;
      // Picking one out of the set: an index, or a search for the active one.
      const picks = /\brows\s*\[\s*\d|\.rows\s*\[\s*\d|\brows\.find\(|\.rows\.find\(/.exec(body);
      if (!picks) continue;
      if (/\bactingTeam\(|\.activeTeam\b/.test(body)) continue;
      bad.push(`${f}: ${name} picks a team out of the caller's memberships itself (${picks[0].trim()})`);
    }
  }
  return bad.length
    ? `${firstOf(bad)} — actingTeam decides that, so two places deciding it means one is wrong`
    : null;
});

check("identity is a port, and a door that says no ends the request", () => {
  const nothingToRun = unbuilt();
  if (nothingToRun) return nothingToRun;
  // Identity answers ONE question — which person is calling — and it answers it through
  // adapters. The shape has to be right before it is needed: "we have our own auth, SSO
  // later" is the road that welds itself shut, because once a PAT is the foundation rather
  // than one adapter, every new way of logging in means surgery on identity resolution.
  // Adding Keycloak or another OIDC provider should be adding an entry to an array.
  //
  // The property that is not visible by reading is the ORDERING. A door that says NO must
  // end the request, not pass the caller to the next door — a revoked PAT falling through to
  // the forwarded-header adapter would turn a revoked token into an unauthenticated header
  // claim, which is the exact opposite of revoking it. So this RUNS the resolver with stub
  // adapters instead of inspecting it.
  const src = readFileSync(join(root, "services/gateway/src/identity.ts"), "utf8");
  const bad: string[] = [];
  if (!/const ADAPTERS: IdentityAdapter\[\] = \[/.test(src)) {
    bad.push("identity resolution is not an adapter list — a new login method would mean surgery on the core");
  }
  for (const door of ['name: "pat"', 'name: "forwarded"']) {
    if (!src.includes(door)) bad.push(`the ${door} adapter is gone`);
  }
  const probe = `
    import { resolveThrough } from ${JSON.stringify(join(root, "services/gateway/dist/identity.js"))};
    const said = [];
    const door = (name, answer) => ({ name, resolve: async () => { said.push(name); return answer; } });
    const bad = [];
    const refusing = await resolveThrough([door("a", { refuse: "no" }), door("b", { email: "x@y" })], {});
    if (!refusing || !("refuse" in refusing)) bad.push("a refusing door did not end the request");
    if (said.includes("b")) bad.push("a refusing door fell through to the next one - a revoked token would become a header claim");
    said.length = 0;
    const skipped = await resolveThrough([door("a", null), door("b", { email: "x@y" })], {});
    if (skipped?.email !== "x@y") bad.push("a door that does not apply must yield to the next");
    said.length = 0;
    await resolveThrough([door("a", { email: "x@y" }), door("b", { email: "z@z" })], {});
    if (said.includes("b")) bad.push("the first door that answered did not win");
    process.stdout.write(bad.join("; "));
  `;
  try {
    const out = execFileSync("node", ["--input-type=module", "-e", probe], { encoding: "utf8" });
    if (out.trim()) bad.push(out.trim());
  } catch (err) {
    bad.push(`the resolver could not be run: ${execStderr(err).slice(-200)}`);
  }
  return bad.length ? bad.join("; ") : null;
});

check("a caller's email is normalised at the boundary, never at the call site", () => {
  // ONE SPELLING OF A PERSON. Every reader of `Caller.email` either compares it — to the
  // `user` stored in activity.jsonl, to a row the database returned, to an address somebody
  // typed as a tool argument — or writes it into a record something later compares. The
  // platform had already settled on lowercase everywhere that spelling is STORED:
  // `principal.email` is citext, every insert lowercases, every predicate says
  // `lower(p.email)`. What it lacked was a place where the header became that, so the
  // normalisation was a ritual repeated at twenty-odd call sites — and a ritual is exactly
  // the kind of thing three of them forgot.
  //
  // Each of those three then compared a lowercased value against a raw one, which is never
  // equal for an address with a capital in it: initiativeNameTaken read a person's own draft
  // as somebody else's and told them to open a second initiative, and pat_issue and
  // client_setup refused a person their own token. All three were invisible because the
  // database happens to hold lowercase — the bug waited on the one identity that does not
  // come from it, the forwarded caller a gateway with no platform database passes straight
  // through, which is local development.
  //
  // Both halves are held here. Without the first the ritual is load-bearing again; without
  // the second it grows back, and the next call site to forget is invisible for the same
  // reason as the last three were.
  const bad: string[] = [];

  const contracts = contractsSource();
  const { text: body, why } = between(contracts, "export function parseCaller", "\n}");
  if (!body) {
    bad.push(`parseCaller cannot be read: ${why}`);
  } else if (!/x-zz-user-email"\]\)[^;]*\.toLowerCase\(\)/.test(body)) {
    bad.push("parseCaller does not lowercase x-zz-user-email, so there is no boundary to " +
             "normalise at and every comparison depends on what the sender happened to send");
  }

  // Lowercasing applied DIRECTLY to an email field. Written as a SUFFIX rather than as a list
  // of receivers: the first attempt enumerated them — `parseCaller(...)`, `caller()`, `who`,
  // `id` — and `parseCaller\([^)]*\)` stops at the first `)`, so it never matched the one form
  // that actually appears, `parseCaller(requestHeaders()).email`. A pattern that misses the
  // commonest spelling of the thing it forbids is worse than none, because it reads as cover.
  //
  // Two things end in `.toLowerCase()` near an email and are NOT this:
  //   `(email ?? id.email).toLowerCase()` — the lowercase applies to the parenthesised
  //       expression, not to `.email`, and what it normalises is an address a caller TYPED as
  //       a tool argument. A value arriving from outside has to be brought to the one
  //       spelling; that is the boundary doing its job, in the other direction.
  //   `lane.email` — a smoke fixture read from a credentials file, not a Caller at all. It is
  //       compared against a `closed_by` the platform wrote, so it too is an outside value
  //       being normalised inwards.
  const RITUAL = /(?<!\blane)\.email(?:\.trim\(\))?\.toLowerCase\(\)/;
  for (const rel of sourceFiles(["packages", "services"], [".ts"])) {
    readFileSync(join(root, rel), "utf8").split("\n").forEach((ln, i) => {
      if (RITUAL.test(ln)) bad.push(`${rel}:${i + 1} lowercases the caller's email again`);
    });
  }

  // AN ACTOR THAT DID NOT COME FROM parseCaller. zz.event.actor is written from the canonical
  // header by the gateway — one spelling, folded at the boundary above — and once from
  // somewhere else entirely: collect-turns reads LibreChat's own store, where the address is
  // whatever the account was registered with. An operator who typed `Alice@Example.com` when
  // provisioning made one person two actors in one table, and `tool-report --actor`,
  // evolve-report and watch-results all group on it.
  //
  // The GUARD had to widen too. Written `insert into zz.event`, it skipped the gateway's own
  // writer entirely — that statement says `insert into event`, unqualified — so the rule
  // covered exactly one of the two, and the one it covered was the one that happened to need
  // it. A check that passes because of what it cannot see is the shape this file refuses.
  for (const rel of sourceFiles(["packages", "services"], [".ts"])) {
    const text = readFileSync(join(root, rel), "utf8");
    if (!/insert into (?:zz\.)?event\b/.test(text)) continue;
    // COMMENTS STRIPPED FIRST, THEN the statement located. The paragraph explaining why the
    // fold is there sits between the two halves of the SQL and contains the word `lower(`, so
    // a window taken over the raw text matched the check's own prose and passed with the fold
    // removed — and a window taken after stripping, but measured before, no longer reached the
    // code at all. A comment cannot be evidence that the code does what it says.
    const code = text.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
    // BOTH writers of the column. The gateway's says `insert into event`, unqualified, and a
    // rule keyed to `zz.event` covered only the tool — which was luck rather than design: the
    // one it happened to cover was the one that needed it.
    const at = /insert into (?:zz\.)?event\b/.exec(code)?.index ?? -1;
    if (at < 0) continue;
    const stmt = code.slice(at, at + 400);
    if (!/\bactor\b/.test(stmt)) continue;
    // Folded in the STATEMENT, or folded into the value the statement binds. The gateway's
    // insert binds `actor`, which logEvent lowercases on the way in because it is the one
    // place every gateway event passes through; the tool folds in SQL because its actor comes
    // from LibreChat's store rather than from the platform's identity.
    const foldedInSql = /lower\(/.test(stmt);
    const foldedInCode = /const actor = e\.actor\.trim\(\)\.toLowerCase\(\)/.test(code);
    if (!foldedInSql && !foldedInCode) {
      bad.push(`${rel} writes the event actor without folding it — one person then appears as ` +
               "two rows in the column tool-report, evolve-report and watch-results group on");
    }
  }

  return bad.length
    ? `${bad.join("; ")} — parseCaller is where the address becomes canonical; a call site ` +
      "that has to remember is a call site that can forget, and the one that forgets compares " +
      "its lowercased copy against somebody else's raw one"
    : null;
});

check("the request-scoped header store is only read where it exists", () => {
  // requestHeaders() reads an AsyncLocalStorage store, and exactly one place enters it:
  // serveMcp's own route handler, in @zz/mcp-http. Anywhere else it returns {} — silently,
  // because an empty header bag is a legal header bag.
  //
  // The gateway's block proxy is a plain `app.all("/p/:platform/mcp")`, and it opened with
  // `const email = caller().email` — caller() being parseCaller(requestHeaders()). So the
  // address was always "", resolveCredential looked the personal key up under the empty
  // string, found nothing, and EVERY block call fell through to the team's shared key. A
  // person who had stored their own key spent the team's quota under the team's permissions,
  // and the audit recorded level "team" for everybody. "A personal key always wins" is what
  // the tool description, the door index and the missing-credential guidance all promise.
  //
  // THE TEST IS HAVING A REQUEST IN HAND, not being outside a tool handler. Plenty of helpers
  // sit outside one and are reached from inside it, where the store is live; that is the
  // normal shape and nothing is wrong with it. What cannot be right is a function that was
  // handed `req` — because express handed it that, which means serveMcp did not, which means
  // the store is empty. Such a function already has the answer: req.zzIdentity.
  //
  // INDIRECT READERS COUNT, repo-wide. `caller()` was one line of sugar over requestHeaders,
  // and `callerIdentity()` in identity.ts is another — a zero-argument function whose answer
  // comes entirely from that store. Naming only the accessor would leave the guard open
  // through whichever wrapper the next author reached for, which is how this class of defect
  // arrives in the first place.
  // @zz/mcp-http is the module that ENTERS the store — serveMcp's own handler runs inside
  // als.run, so a `req` in scope there is the one case where the store is live. It is the
  // implementation of the rule, not a place the rule applies.
  const files = sourceFiles(["services", "packages"], [".ts"])
    .filter((rel) => !rel.startsWith(join("packages", "mcp-http")))
    .map((rel) => [rel, readFileSync(join(root, rel), "utf8")]);

  /** Spans that are a TOOL HANDLER, blanked. A function that merely builds a server contains
   * every handler's reads without doing any reading itself: `buildServer` in zz-core wraps
   * fifty registerTool calls, and counting it as a reader made every caller of it a suspect. */
  const withoutTools = (span: string): string => {
    let out = span;
    for (const m of [...span.matchAll(/registerTool\(/g)].reverse()) {
      let depth = 0, i = m.index + m[0].length - 1;
      for (; i < span.length; i++) {
        if (span[i] === "(") depth++;
        else if (span[i] === ")" && --depth === 0) break;
      }
      out = out.slice(0, m.index) + " ".repeat(i - m.index) + out.slice(i);
    }
    return out;
  };

  /** The body of the function opening at `from`, by brace matching. */
  const bodyAt = (code: string, from: number) => {
    const brace = code.indexOf("{", from);
    if (brace < 0) return null;
    let depth = 0, end = brace;
    for (; end < code.length; end++) {
      if (code[end] === "{") depth++;
      else if (code[end] === "}" && --depth === 0) break;
    }
    return { start: brace, end };
  };

  const stripped = files.map(([rel, src]) => [rel, codeOnly(src)]);

  // Pass one: every ZERO-ARGUMENT function whose answer comes out of that store, by name.
  const alsReaders = new Set(["requestHeaders"]);
  for (let round = 0; round < 3; round++) {          // a wrapper of a wrapper still reads it
    const uses = new RegExp(`\\b(?:${[...alsReaders].join("|")})\\(`);
    for (const [, code] of stripped) {
      for (const m of code.matchAll(/(?:const|function)\s+(\w+)(?:\s*=\s*(?:async\s*)?)?\s*\(\s*\)/g)) {
        if (alsReaders.has(m[1])) continue;
        const body = bodyAt(code, m.index + m[0].length);
        // An expression-bodied arrow has no block: read to the end of its statement instead.
        const span = body && body.start < code.indexOf(";", m.index + m[0].length)
          ? code.slice(body.start, body.end)
          : code.slice(m.index, code.indexOf(";", m.index + m[0].length) + 1 || undefined);
        if (uses.test(withoutTools(span))) alsReaders.add(m[1]);
      }
    }
  }
  const reads = new RegExp(`\\b(?:${[...alsReaders].join("|")})\\(\\)`, "g");

  // Pass two: any of those, inside a function express handed a request to.
  const bad = [], seen = new Set();
  for (const [rel, code] of stripped) {
    if (!reads.test(code)) { reads.lastIndex = 0; continue; }
    reads.lastIndex = 0;
    for (const open of code.matchAll(/\(\s*(?:_?req)\s*[,:)]/g)) {
      const body = bodyAt(code, open.index);
      if (!body) continue;
      for (const r of code.slice(body.start, body.end).matchAll(reads)) {
        const line = code.slice(0, body.start + r.index).split("\n").length;
        // Once per site. A handler nested inside another matches both spans, and reporting
        // the same defect twice reads as two.
        if (seen.has(`${rel}:${line}`)) continue;
        seen.add(`${rel}:${line}`);
        bad.push(`${rel}:${line} calls ${r[0]} inside a function that was handed \`req\`. ` +
                 "Only serveMcp enters that store, so a function express called reads {} and " +
                 "gets an empty identity with no error — read req.zzIdentity instead");
      }
    }
  }
  return bad.join("\n");
});

check("nothing picks a team by taking the first membership row", () => {
  // Which team a person acts as is `actingTeam` in @zz/contracts and nothing else: a bound
  // token wins or resolves to nothing, else the team they chose while it is still live, else
  // admin-role then alphabetical. Three places took the first row of a differently-ordered
  // list instead — the gateway, `catalog_list`, and the knowledge web app — and the failure
  // is always the same shape: one team's documents on screen, another team's name beside
  // them, or a block call spending a team's key that never authorised it.
  //
  // The web app was the last one, and the quietest: it fetched an identity that already
  // carried `activeTeam` and used `teams[0].slug` for the header. The DATA was right, because
  // the server scopes every route by activeTeam; only the label was wrong, which is worse in
  // one specific way — the page tells the reader which team they are looking at, and that is
  // the sentence they would use to notice a mistake.
  const bad: string[] = [];
  for (const rel of sourceFiles(["services", "packages"], [".ts", ".html"])) {
    const src = readFileSync(join(root, rel), "utf8");
    // Comments narrate the defect; the code is what does it.
    const code = /\.html$/.test(rel)
      ? src.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*|<!--)/.test(l)).join("\n")
      : withoutComments(src);
    for (const m of code.matchAll(/\bteams\s*\[\s*0\s*\]/g)) {
      const line = code.slice(0, m.index).split("\n").length;
      bad.push(`${rel}:${line} takes the first membership row as the team — that is a second ` +
               "answer to a question actingTeam already answers, and the two disagree for " +
               "anybody in more than one team");
    }
  }
  return bad.join("\n");
});
