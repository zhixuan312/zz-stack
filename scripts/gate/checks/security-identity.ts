/**
 * Who the caller is, and which team they act for.
 *
 * The team is a column on the person, read fresh on every call, and everything the platform
 * scopes depends on it being derived one way. A tool that picks a team by taking the first
 * membership row is right for somebody in one team, which is why review does not catch it.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
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
  // isSuper() is where "is this caller platform authority" is answered: role, plus whether
  // this is a PAT, plus its team binding. A line comparing platformRole directly cannot see
  // the binding, so a token bound to one team would list every team on the platform.
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
  // One active team per person, chosen in ZZ Access and read from the database on every call.
  // Neither a client-sent header nor the first membership row may decide it. A bound token is
  // the one exception: automation confined to a team.
  const bad: string[] = [];
  const idsrc = withoutComments(readFileSync(join(root, "services/gateway/src/identity.ts"), "utf8"));
  if (/x-zz-team/.test(idsrc)) {
    bad.push("the gateway still reads a team from the request — the active team is a column");
  }
  const core = withoutComments(zzCoreSource());
  if (!/active_team_id/.test(core)) bad.push("zz-core no longer reads the stored active team");
  // The rule lives in @zz/contracts and both services call actingTeam, so this runs it rather
  // than grepping for the expression that implements it.
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
  // And nothing may quietly pick a different one: `teams[0]` is a membership row in whatever
  // order a query returned it, so it silently answers about a team the person is not acting
  // for. Scanned repo-wide, because any file holding the list can make the mistake.
  for (const f of sourceFiles(["services", "packages"], [".ts"])) {
    const src = readFileSync(join(root, f), "utf8");
    for (const [i, line] of src.split("\n").entries()) {
      if (/^\s*(\/\/|\*|\/\*)/.test(line)) continue;
      // Any local that holds the list, not the name `teams` alone: an alias such as
      // `myTeams[0]` has no word boundary before `teams`, so `\bteams\[0\]` would miss it.
      if (/[Tt]eams\[0\]/.test(line)) {
        bad.push(`${f}:${i + 1} takes the first membership row instead of the acting team`);
      }
    }
  }
  // Switching is a state change on who did what, and this platform records those. The window
  // runs to the next registration rather than to a byte count: the rule is that this handler
  // records the switch, and the handler ends where the next `registerTool` begins.
  const zone = srv.slice(srv.indexOf('"team_switch"'));
  const next = zone.indexOf("registerTool", 1);
  if (!/team\.switch/.test(next > 0 ? zone.slice(0, next) : zone)) {
    bad.push("switching team is not recorded as an event");
  }
  return bad.length ? bad.join("; ") : null;
});

check("a tool picks the caller's team the platform's way", () => {
  // "Which team am I acting for" has one right answer per request, and actingTeam in
  // @zz/contracts decides it: the bound token first, then the team the person chose, then
  // admin-role before alphabetical.
  //
  // A tool that reads memberships and selects one of them is choosing a caller's team, and
  // must choose it that way. Listing them all is not selecting, and neither is acting on a
  // team named in an argument.
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
  // Identity answers one question — which person is calling — through an adapter list, so a
  // new login method is a new entry in that array.
  //
  // The property not visible by reading is the ordering: a door that says no must end the
  // request, not pass the caller to the next one, or a revoked PAT would fall through to the
  // forwarded-header adapter and become an unauthenticated header claim. So this runs the
  // resolver with stub adapters instead of inspecting it.
  const src = withoutComments(readFileSync(join(root, "services/gateway/src/identity.ts"), "utf8"));
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
  // One spelling of a person. Everything stored is lowercase — `principal.email` is citext,
  // every insert lowercases, every predicate says `lower(p.email)` — so `parseCaller` folds
  // the header once, at the boundary, and no call site repeats it. Both halves are asserted
  // here: the fold exists, and nobody does it again.
  const bad: string[] = [];

  const contracts = contractsSource();
  const { text: body, why } = between(contracts, "export function parseCaller", "\n}");
  if (!body) {
    bad.push(`parseCaller cannot be read: ${why}`);
  } else if (!/x-zz-user-email"\]\)[^;]*\.toLowerCase\(\)/.test(body)) {
    bad.push("parseCaller does not lowercase x-zz-user-email, so there is no boundary to " +
             "normalise at and every comparison depends on what the sender happened to send");
  }

  // Lowercasing applied directly to an email field, matched as a suffix rather than by
  // enumerating the receivers — `parseCaller(requestHeaders()).email` is the common spelling
  // and no receiver list catches it.
  //
  // `(email ?? id.email).toLowerCase()` ends the same way and is not this: the lowercase
  // applies to the parenthesised expression, and what it normalises is an address a caller
  // typed as a tool argument.
  const RITUAL = /\.email(?:\.trim\(\))?\.toLowerCase\(\)/;
  for (const rel of sourceFiles(["packages", "services"], [".ts"])) {
    readFileSync(join(root, rel), "utf8").split("\n").forEach((ln, i) => {
      if (RITUAL.test(ln)) bad.push(`${rel}:${i + 1} lowercases the caller's email again`);
    });
  }

  // An actor that did not come from parseCaller. Every statement that writes zz.event.actor
  // folds it; unfolded, one person becomes two rows in the column tool-report and watch-results
  // group on.
  for (const rel of sourceFiles(["packages", "services"], [".ts"])) {
    const text = readFileSync(join(root, rel), "utf8");
    if (!/insert into (?:zz\.)?event\b/.test(text)) continue;
    // Comments stripped first, then the statement located: a window over raw text can match
    // `lower(` in the prose beside the SQL and pass with the fold removed.
    const code = text.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
    // The gateway's statement says `insert into event`, unqualified, so a rule keyed to
    // `zz.event` alone would miss it.
    const at = /insert into (?:zz\.)?event\b/.exec(code)?.index ?? -1;
    if (at < 0) continue;
    const stmt = code.slice(at, at + 400);
    if (!/\bactor\b/.test(stmt)) continue;
    // Folded in the statement, or folded into the value it binds: the gateway lowercases in
    // logEvent, the tool folds in SQL.
    const foldedInSql = /lower\(/.test(stmt);
    const foldedInCode = /const actor = e\.actor\.trim\(\)\.toLowerCase\(\)/.test(code);
    if (!foldedInSql && !foldedInCode) {
      bad.push(`${rel} writes the event actor without folding it — one person then appears as ` +
               "two rows in the column tool-report and watch-results group on");
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
  // serveMcp's own route handler, in @zz/mcp-http. Anywhere else it returns {} silently,
  // because an empty header bag is a legal header bag.
  //
  // The test is having a request in hand, not being outside a tool handler. A helper reached
  // from inside a handler is fine; a function that was handed `req` is not, because express
  // handed it that, which means serveMcp did not. Such a function reads req.zzIdentity.
  //
  // Indirect readers count, repo-wide: any zero-argument function whose answer comes out of
  // that store is a reader, so a wrapper does not open the guard.
  //
  // @zz/mcp-http is excluded: it is the module that enters the store, so a `req` in scope
  // there is the one case where the store is live.
  const files = sourceFiles(["services", "packages"], [".ts"])
    .filter((rel) => !rel.startsWith(join("packages", "mcp-http")))
    .map((rel) => [rel, readFileSync(join(root, rel), "utf8")]);

  /** Spans that are a tool handler, blanked. A function that merely builds a server contains
   * every handler's reads without doing any reading itself. */
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

  // Pass one: every zero-argument function whose answer comes out of that store, by name.
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
  // admin-role then alphabetical. Taking the first row of a differently-ordered list puts one
  // team's documents on screen under another team's name, or spends a key that never
  // authorised the call. Covers .html too, because a wrong label is a wrong answer.
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

check("an OAuth code is exchanged once, even by two requests at the same instant", () => {
  // Reading `used` and then setting it is two statements, and two exchanges of one code that
  // interleave both read false: both mint a token, and the second's one-token-per-door delete
  // removes the first's, so a client holds a token that stopped working the moment it arrived.
  // The code is consumed by the update that tests it, and the exchange goes on only when that
  // update changed the row.
  const REL = "services/gateway/src/mcp-oauth.ts";
  if (!existsSync(join(root, REL))) return `${REL} is gone, so the code exchange is unchecked`;
  const code = withoutComments(readFileSync(join(root, REL), "utf8"));
  const sets = [...code.matchAll(/update zz\.mcp_oauth_authz set used = true([^`"]*)/g)];
  if (sets.length !== 1) return `${REL} marks a code used in ${sets.length} places; the exchange consumes it in exactly one`;
  const where = sets[0]![1]!;
  if (!/used = false/.test(where)) {
    return `${REL} marks a code used without testing that it was unused (\`${where.trim()}\`) — two concurrent exchanges both succeed`;
  }
  if (!/created_at > now\(\) - interval '10 minutes'/.test(where)) {
    return `${REL} consumes a code without testing it has not expired — a code that expired after it was read would still mint a token`;
  }
  const after = code.slice(sets[0]!.index!);
  if (!/if \(consumed\.rowCount !== 1\)/.test(after.slice(0, 400))) {
    return `${REL} consumes the code but does not refuse when the update changed no row — the losing exchange would still mint a token`;
  }
  return null;
});
