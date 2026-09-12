/**
 * The edges: which paths are public, what a refusal does to a request, and what a caller's
 * bytes may become downstream.
 *
 * Shell quoting, psql binding, replacement strings read as patterns, a hostile document
 * becoming script in a reader's browser, a path traversal the guards cannot see. A door that
 * refuses and then keeps handling the request is a refusal that refuses nothing.
 */
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { REGEX, between, firstOf, functionBody, gateOwnSource, gatewaySource, root, sourceFiles, unbuilt, withoutComments, zzCoreSource } from "../read.mjs";
import { check } from "../run.mjs";

check("a block dying mid-stream cannot take the gateway with it", () => {
  // `.pipe()` does not forward errors, and Node's default for an unhandled `error` event is
  // `throw` — from a socket callback, where nothing catches it. A block closing its socket
  // mid-response is routine; it exited the whole proxy twice in one afternoon, and each exit
  // dropped every user's session rather than the one request that failed.
  //
  // Reproduced and fixed: the relay now ends the truncated response and stays up. This
  // guards the shape, because the next raw pipe would fail exactly the same way and only
  // under a flaky upstream — the condition least likely to show up in a test.
  // COMMENTS STRIPPED, because this check hunts a shape that its own explanation describes.
  // Reading server.ts alone hid that: tool-telemetry.ts carries a paragraph saying "the
  // proxied ones go through Readable.fromWeb().pipe(res)", which is true, is prose, and was
  // reported as an unguarded pipe the moment this started asking the whole service.
  const src = withoutComments(gatewaySource());
  const bad = [];
  const raw = src.match(/Readable\.fromWeb\([^)]*\)\s*\.pipe\(/g);
  if (raw) bad.push(`${raw.length} unguarded pipe(s) — relay through relayBody instead`);
  if (!/function relayBody\(/.test(src)) bad.push("relayBody is gone");
  else {
    const fn = src.slice(src.indexOf("function relayBody("));
    const body = fn.slice(0, fn.indexOf("\n}\n") + 2);
    if (!/src\.on\("error"/.test(body)) bad.push("relayBody no longer handles a stream error");
    if (!/res\.on\("close"/.test(body)) bad.push("relayBody leaks the upstream when a caller hangs up");
  }
  return bad.length ? bad.join("; ") : null;
});

check("a value crossing into a shell is quoted for a shell", () => {
  // testing/smoke-env.sh built `export LC_PASSWORD=...` from Python's %r and then eval'd it.
  // repr is not a shell quoter and does not claim to be: it switches to DOUBLE quotes as soon
  // as the string contains a single quote, and the shell then interpolates what is inside. A
  // password of a$USER'b was exported as a$USER already expanded — measured, on this machine,
  // as azhangzhixuan'b. The run then fails to log in and nothing says why, because the value
  // that is wrong is the one thing nothing prints.
  //
  // JSON.stringify IS THE SAME BUG, and it is the one that would come back: that file is
  // JavaScript now, and a JSON string is double quoted, so `export X=${JSON.stringify(pw)}`
  // interpolates exactly as repr did. A check written for the language a file used to be in
  // stops covering it the moment the file is rewritten, which is the quietest way for a
  // guard to lapse.
  //
  // The rule with no exceptions: wrap in SINGLE quotes and escape an embedded one.
  const bad = [];
  for (const f of sourceFiles(["."], [".sh"])) {
    const src = readFileSync(join(root, f), "utf8");
    // Only scripts that EVALUATE generated shell. One that prints for a human to read is
    // not creating a word the shell will parse.
    if (!/eval\s+"\$\(/.test(src)) continue;
    for (const [i, line] of src.split("\n").entries()) {
      if (/^\s*(#|\/\/)/.test(line)) continue;
      if (/(%r|!r\})/.test(line) && /export |=/.test(line)) {
        bad.push(`${f}:${i + 1} builds a shell word with repr — single-quote it instead`);
      }
      if (/JSON\.stringify/.test(line) && /export |=\$\{/.test(line)) {
        bad.push(`${f}:${i + 1} builds a shell word with JSON.stringify — a JSON string is ` +
                 "double quoted, and the shell interpolates what is inside one");
      }
    }
  }
  return bad.length ? bad.join("; ") : null;
});

check("the write guards see a path traversal cannot hide from", () => {
  // writeGuard matched every pattern against the path AS THE CALLER WROTE IT, and one of them
  // anchors at the start. So `a/../_knowledge/nodes/0001-x.md` slipped past the journal guard
  // and safePath then resolved it to exactly the file the guard exists to protect: write_file
  // could mint a journal node with no evidence, no index.md row and no line in the
  // append-only log — the things knowledge_add is there to guarantee — and rewrite an OKR sheet
  // that okr_grade averages.
  //
  // The other two patterns survived traversal by accident, matching anywhere in the path or
  // at its end. Normalising once removes the luck, and this refuses a guard written against
  // the raw argument again.
  // THE WHOLE SERVICE, because writeGuard is a guard rather than a line in one file.
  const f = "zz-core";
  const src = zzCoreSource();
  const at = src.indexOf("function writeGuard(");
  if (at < 0) return `${f}: writeGuard is gone — the one place both write paths are guarded`;
  let i = src.indexOf("{", at), depth = 0, end = i;
  for (; i < src.length; i += 1) {
    if (src[i] === "{") depth += 1;
    else if (src[i] === "}") { depth -= 1; if (depth === 0) { end = i + 1; break; } }
  }
  const body = src.slice(at, end);
  // The parameter it takes, and whether it is normalised before anything tests it.
  const param = /function writeGuard\(\s*(\w+)/.exec(body)?.[1];
  if (!param) return `${f}: writeGuard's parameter is unreadable`;
  if (!new RegExp(`resolve\\("/",\\s*${param}\\)`).test(body)) {
    return `${f}: writeGuard tests '${param}' without resolving it — a \`..\` in the path ` +
           "walks around any pattern anchored at the start";
  }
  // And nothing below may go back to the raw argument.
  const afterNormalise = body.slice(body.search(new RegExp(`resolve\\("/",\\s*${param}\\)`)));
  const raw = new RegExp(`\\b${param}\\b`).exec(afterNormalise.replace(/^[^\n]*\n/, ""));
  return raw
    ? `${f}: writeGuard still reads the raw '${param}' after normalising it`
    : null;
});

check("no replacement string can be read as a pattern", () => {
  // String.replace's SECOND argument is not inert text. It reads $$, $&, $` and $' — and
  // this platform's whole job is putting somebody's words into somebody's document.
  //
  // patch_file did `body.replace(find, replace)` with the model's own text as the
  // replacement, and it is described as how a draft is filled in section by section. Verified
  // against that call: "$$50" became "$50"; a shell example containing $' swallowed its line
  // and injected the entire rest of the document after it; "$&" wrote the text being replaced
  // back out. setEnvelopeField and putEnvelopeField did the same with a value that close()
  // takes from the model — a name of "Ms $& Tan" came out as "Ms accepted_by: old Tan" — and
  // three more sites interpolated a title, a stakeholder or a grader's note into a
  // replacement. Nine in total, all silent, none of which any test would have shown.
  //
  // So: a replacement is a FUNCTION, or a literal with nothing interpolated into it. A
  // literal may still say $1 deliberately, which is the only honest use of the syntax.
  const bad = [];
  for (const f of sourceFiles(["services", "packages"], [".ts"])) {
    const raw = readFileSync(join(root, f), "utf8");
    // Comments carry prose about replacements — this gate's own history is written in them —
    // and prose parses as arguments. The strings stay: a replacement literal is the thing
    // being read. This counted quotes on each line to decide whether a `//` was inside one,
    // which cannot see a template literal that opened on an earlier line.
    const src = withoutComments(raw);

    for (const m of src.matchAll(/\.replace(All)?\(/g)) {
      // The arguments split at depth zero, so a nested call or a literal stays one argument.
      let i = m.index + m[0].length, depth = 1, cur = "", parts = [], q = null;
      while (i < src.length && depth > 0) {
        const c = src[i];
        if (q) {
          if (c === "\\") { cur += c + src[i + 1]; i += 2; continue; }
          if (c === q) q = null;
          cur += c; i += 1; continue;
        }
        // A REGEX LITERAL, consumed whole. `/"/g` is the first argument of a real call in
        // this repository, and reading its quote as a string delimiter sent this scanner
        // hundreds of lines down the file and made it report a replacement that was prose.
        // A `/` where an argument begins is a regex; a character class may contain `/`.
        if (c === "/" && cur.trim() === "") {
          cur += c; i += 1;
          let inClass = false;
          while (i < src.length) {
            const d = src[i];
            if (d === "\\") { cur += d + src[i + 1]; i += 2; continue; }
            if (d === "[") inClass = true;
            else if (d === "]") inClass = false;
            else if (d === "/" && !inClass) { cur += d; i += 1; break; }
            cur += d; i += 1;
          }
          while (i < src.length && /[a-z]/.test(src[i])) { cur += src[i]; i += 1; }   // flags
          continue;
        }
        if (c === '"' || c === "'" || c === "`") { q = c; cur += c; i += 1; continue; }
        if ("([{".includes(c)) depth += 1;
        if (")]}".includes(c)) { depth -= 1; if (depth === 0) break; }
        if (c === "," && depth === 1) { parts.push(cur.trim()); cur = ""; i += 1; continue; }
        cur += c; i += 1;
      }
      parts.push(cur.trim());
      if (parts.length < 2) continue;
      const rep = parts[1];
      const isFunction = /^\(/.test(rep) || /^function\b/.test(rep) || rep.includes("=>");
      const isInertLiteral = /^(["'])[\s\S]*\1$/.test(rep) || (/^`/.test(rep) && !rep.includes("${"));
      if (isFunction || isInertLiteral) continue;
      const line = src.slice(0, m.index).split("\n").length;
      bad.push(`${f}:${line} replaces with ${rep.replace(/\s+/g, " ").slice(0, 48)}`);
    }
  }
  return bad.length
    ? `${firstOf(bad)} — $& and $' in that value are read as patterns, so somebody's own words rewrite the document around them`
    : null;
});

check("the gateway is authenticated by default, and the exceptions are the intended ones", () => {
  // The middleware is deny-by-default on purpose: it used to list the PROTECTED prefixes, so
  // a route added later without touching that list was silently public on a gateway
  // reachable from the internet. Named this way round, forgetting costs a 401.
  //
  // Which makes the exception list the thing to guard. /schemas was added this release with
  // a comment calling it unauthenticated and a changelog entry saying so, and it was NOT on
  // the list — so the rulebook a tenant is supposed to read before writing a manifest would
  // have demanded the token they do not have yet, and both the comment and the changelog
  // were wrong. Found by reading the file the route was added to.
  const src = gatewaySource();
  const exact = /const PUBLIC_PATHS = new Set\((\[[^\]]*\])\)/.exec(src)?.[1];
  const prefixes = /const PUBLIC_PREFIXES = (\[[^\]]*\])/.exec(src)?.[1];
  if (!exact || !prefixes) return "the public-path lists are no longer where this can read them";
  const paths = JSON.parse(exact.replace(/'/g, '"'));
  const pre = JSON.parse(prefixes.replace(/'/g, '"'));
  const isPublic = (p) => paths.includes(p) || pre.some((x) => p.startsWith(x));
  const bad = [];
  // What must be reachable with no token, and what must never be.
  for (const [p, want] of [
    ["/", true], ["/health", true],
    ["/schemas/envelope.json", true], ["/schemas/manifest.json", true],
    ["/core/mcp", false], ["/manage/mcp", false],
    ["/pkg/claude-code.tgz", false],
    ["/p/casebox/mcp", false],
  ]) {
    if (isPublic(p) !== want) {
      bad.push(want ? `${p} needs a token and must not` : `${p} IS PUBLIC and must not be`);
    }
  }
  // A prefix wide enough to catch more than it names is the way this list goes wrong.
  for (const x of pre) {
    if (!x.endsWith("/")) bad.push(`public prefix ${x} does not end in / — it matches more paths than it names`);
  }
  return bad.length ? bad.join("; ") : null;
});

check("a psql variable is bound, never interpolated", () => {
  // psql.ts states the rule its whole shape exists for: a statement goes in on STDIN with `-v`
  // bindings, and a value is referenced as `:'name'` — psql interpolates while LEXING, so the
  // quoted form arrives at the server as a string literal and the bare `:name` arrives as raw
  // SQL. deploy/issue-first-pat.sh learned both halves the hard way and reset-smoke-store.sh
  // repeats the warning.
  //
  // "the platform database is reached one way" keeps there being ONE transport. It does not
  // keep the rule that transport exists to enforce: every value in these queries is an
  // operator's own flag — `--since`, `--window`, `--actor`, `--surface` — and a bare
  // `:since` would put it into the statement unquoted, where an apostrophe alone is enough
  // to change what the query means.
  //
  // Only lines that look like SQL, so `import x from ":y"` and a TypeScript annotation are not
  // candidates, and `::interval` is a cast rather than a variable.
  const SQLISH = /\b(select|from|where|insert into|update |delete from|now\(\))\b/i;
  const bad = [];
  for (const rel of sourceFiles(["packages", "services"], [".ts"])) {
    readFileSync(join(root, rel), "utf8").split("\n").forEach((ln, i) => {
      if (/^\s*(\/\/|\*|\/\*)/.test(ln) || !SQLISH.test(ln)) return;
      for (const m of ln.matchAll(/(?<![:\w'])::?([a-zA-Z_][a-zA-Z0-9_]*)/g)) {
        if (m[0].startsWith("::")) continue;                    // a cast
        if (ln.slice(m.index, m.index + 2) === ":'") continue;   // the bound form
        bad.push(`${rel}:${i + 1} references ${m[0]} unquoted`);
      }
    });
  }
  return bad.length
    ? `${bad.join("; ")} — psql substitutes a bare :name as raw SQL; write :'name' so the value ` +
      "arrives as a literal"
    : null;
});

check("nothing under a store root that begins with a dot is reachable", () => {
  // walk() skips dot-entries — it has to, because the store is a git repository and a lister
  // that did not would report `.git/COMMIT_EDITMSG` as the team's first document. safeName
  // refuses a dot-prefixed name and says why in as many words. Neither guards the `path`
  // argument write_file, patch_file and read_file take, so the rule was stated twice and
  // applied nowhere near the tools that needed it.
  //
  // `.git` arrived at the root of every team's store this release. `.git/hooks/pre-commit`
  // is the sharp end: commitStore runs `git commit` after every write, so a file the model
  // chose becomes an executable the service runs. The quiet end is that the repository is
  // what a team keeps when they leave, and it is the one thing here with no other copy.
  //
  // Held on the two surfaces that can reach one: the path rule, RUN rather than read, and
  // every hand-rolled listing of a store root.
  const src = zzCoreSource();
  const bad = [];

  const body = functionBody(src, "pathShapeRefusal");
  if (!body) return "zz-core no longer defines pathShapeRefusal() — this check cannot run";
  let refuse;
  try {
    refuse = new Function("path", body);
  } catch (err) {
    return `pathShapeRefusal could not be evaluated: ${String(err.message ?? err)} — the ` +
           "extraction must fail loudly rather than quietly stop checking";
  }
  const want = [
    [".git/hooks/pre-commit", true], [".git/config", true], ["/.git/config", true],
    ["a/.git/objects/ab/cdef", true], [".zz/i/spec.md", true], ["~/i/spec.md", true],
    ["2026-08-30-enquiries/spec.md", false], ["i/sources/2026-08-30-note.md", false],
    ["_knowledge/nodes/0001-x.md", false], ["i/_versions/spec.v1.md", false],
  ];
  for (const [p, shouldRefuse] of want) {
    const got = !!refuse(p);
    if (got !== shouldRefuse) {
      bad.push(`pathShapeRefusal ${got ? "refuses" : "allows"} ${JSON.stringify(p)} and should ` +
               `${shouldRefuse ? "refuse" : "allow"} it`);
    }
  }
  // Refusing is only half of it: safePath is what every caller path goes through, and a rule
  // it does not consult is a rule about nothing.
  const guard = functionBody(src, "safePath") ?? "";
  if (!/pathShapeRefusal\(path\)/.test(guard)) {
    bad.push("safePath does not call pathShapeRefusal, so the rule is enforced on no path");
  }

  // And every listing that walks a store root by hand. walk() knows; these did not, so the
  // no-argument initiative_status — the call zz-backbone tells every agent to make before
  // continuing any work — answered with `.git` as an open initiative whose next move was to
  // write the flow's first document into it.
  // EVERY LISTING OF A STORE ROOT, in any service or tool — not just zz-core's, because the
  // same gap was open in four places and fixing one at a time is how the fourth stays open.
  // zz-core's initiative_status offered `.git` as an OPEN INITIATIVE with a next move;
  // manifest-audit reported `AUDIT .git: FAIL(no activity telemetry)` on a clean store, in a
  // tool whose exit code is read as an acceptance check; the gateway's landing view listed it
  // beside a team's work and read every `.md` inside it to build a card.
  //
  // What identifies a store listing without naming the four call sites: it filters
  // `startsWith("_")`, which is the STORE's own convention — `_versions`, `_knowledge`,
  // `_ledger.md`, `_activity.jsonl` — and it keeps DIRECTORIES. A listing of files inside one
  // initiative also knows about `_` and cannot contain a repository, so the directory test is
  // what separates them.
  for (const rel of sourceFiles(["packages", "services"], [".ts"])) {
    const text = readFileSync(join(root, rel), "utf8");
    for (const m of text.matchAll(/readdirSync\([^)]*\)([\s\S]{0,400}?);/g)) {
      const tail = m[1];
      if (!/startsWith\("_"\)/.test(tail)) continue;      // not a store listing
      if (!/isDirectory\(\)/.test(tail)) continue;        // files inside one initiative
      if (/startsWith\("\."\)/.test(tail)) continue;      // already excludes them
      bad.push(`${rel}:${text.slice(0, m.index).split("\n").length} lists a store root ` +
               "without excluding dot-entries, and every store root now holds a .git");
    }
  }
  return bad.length ? bad.join("; ") : null;
});

check("both services authenticate their own network the same way", () => {
  const nothingToRun = unbuilt();
  if (nothingToRun) return nothingToRun;
  // The gateway and zz-core each decide "is this caller who it says it is" on the compose
  // network by resolving trusted hostnames and comparing the socket peer against them.
  // zz-core's own comment said "the mechanism is the gateway's own, for the same decision" —
  // and it WAS the gateway's own, and also a second implementation of it, down to the
  // sixty-second cache and the IPv4-mapped fold.
  //
  // The fold is where a second copy hurts. A peer arriving over IPv6 is `::ffff:10.0.0.5`
  // and the same host out of DNS is `10.0.0.5`; fold one side and not the other and the set
  // test is simply never true. It fails CLOSED, which sounds safe and means zz-core 403s
  // every call from its own gateway — a whole deployment down, reading like a network fault.
  // Four spellings, two per service, correct only because both halves happened to agree.
  //
  // The policy stays with each service and differs on purpose: the gateway's trusted front
  // end is off by default, zz-core's defaults to cred-proxy and refuses with 403.
  const bad = [];
  // THE MODULE THAT DEFINES THE MECHANISM, which is identity.ts since the contracts door
  // was split from what is behind it. The rule is "one resolver", so the owner is
  // wherever that resolver lives, not whichever file used to hold everything.
  const OWNER = join("packages", "contracts", "src", "identity.ts");
  for (const rel of sourceFiles(["services", "packages", "scripts"], [".ts", ".mjs"])) {
    if (rel === OWNER || gateOwnSource(rel)) continue;
    readFileSync(join(root, rel), "utf8").split("\n").forEach((ln, i) => {
      if (/^\s*(\/\/|\*|\/\*)/.test(ln)) return;
      if (/::ffff:/.test(ln)) {
        bad.push(`${rel}:${i + 1} folds an IPv4-mapped address itself — peerAddress and ` +
                 "addressResolver both do it, and the two halves have to agree");
      }
      if (/dnsLookup\(|from "node:dns/.test(ln)) {
        bad.push(`${rel}:${i + 1} resolves a hostname itself — addressResolver is that ` +
                 "mechanism, and a second one drifts from it in the cache or the fold");
      }
    });
  }
  // Both doors must still be reading it.
  for (const [rel, what] of [["services/gateway/src/identity.ts", "the trusted front end"],
                             ["services/zz-core/src/server.ts", "its trusted peers"]]) {
    const src = readFileSync(join(root, rel), "utf8");
    if (!/addressResolver\(/.test(src)) bad.push(`${rel} no longer resolves ${what} through the shared mechanism`);
    if (!/peerAddress\(/.test(src)) bad.push(`${rel} no longer reads its socket peer through the shared spelling`);
  }
  // RUN it, because the property is what the two halves DO to an address, and both halves
  // reading correctly is exactly what a source inspection cannot tell you.
  const probe = `
    import { peerAddress, addressResolver } from ${JSON.stringify(join(root, "packages/contracts/dist/index.js"))};
    const bad = [];
    if (peerAddress({ remoteAddress: "::ffff:10.0.0.5" }) !== "10.0.0.5") bad.push("a mapped peer is not folded to the form DNS returns");
    if (peerAddress({ remoteAddress: "10.0.0.5" }) !== "10.0.0.5") bad.push("a plain peer must survive the fold");
    if (peerAddress({}) !== "") bad.push("a socket with no peer must resolve to the empty string, not to undefined");
    if (await addressResolver([])() !== null) bad.push("no hosts to trust must be null, never an empty set that reads as 'nobody matched'");
    if (await addressResolver(["nothing.invalid"])() !== null) bad.push("a hostname that cannot be resolved must be null, not a guess");
    const local = await addressResolver(["localhost"])();
    if (!local || !local.has("127.0.0.1")) bad.push("a resolvable host must come back: " + JSON.stringify(local && [...local]));
    process.stdout.write(bad.join("; "));
  `;
  try {
    const out = execFileSync("node", ["--input-type=module", "-e", probe], { encoding: "utf8" });
    if (out.trim()) bad.push(out.trim());
  } catch (err) {
    bad.push(`the address mechanism could not be run: ${String(err.stderr ?? err).slice(-200)}`);
  }
  return bad.length ? bad.join("; ") : null;
});

check("the paths documented as public are the ones the gateway exempts", () => {
  // "Everything but `/`, `/health` and `/architecture` requires a token" is what STATE.md said, and
  // `/schemas/*` had been public since the release that added it — served deliberately
  // without a token, because a rulebook that answers 401 is one people copy by hand. The
  // list in the document and the list in the code are the same list, and only one of them
  // moved.
  //
  // This is the sharpest kind of documentation drift: it is a claim about what is exposed.
  // A reader auditing the surface counts three and there are four, and the one they did not
  // count is the one nobody told them about.
  const src = withoutComments(gatewaySource());
  const exact = [...(between(src, "const PUBLIC_PATHS", ";").text ?? "").matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  const prefixes = [...(between(src, "const PUBLIC_PREFIXES", ";").text ?? "").matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  if (!exact.length) return "cannot read PUBLIC_PATHS out of the gateway";
  // A prefix is documented as a glob — `/schemas/` is `/schemas/*` in prose — so compare the
  // stem either way rather than demanding one spelling of it.
  const want = [...exact, ...prefixes.map((p) => p.replace(/\/$/, ""))];

  const bad = [];
  for (const rel of ["STATE.md", "deploy/README.md", "README.md"]) {
    const doc = readFileSync(join(root, rel), "utf8");
    // Only where the document actually makes the claim. A file that never lists them is not
    // wrong about them, and inventing a duty to list them would be this check picking a
    // structure for somebody's prose.
    const at = /Everything but|public only by exception|requires a token/.exec(doc);
    if (!at) continue;
    const near = doc.slice(Math.max(0, at.index - 200), at.index + 400);
    const missing = want.filter((p) => !near.includes(`\`${p}\``) && !near.includes(`\`${p}/*\``));
    if (missing.length) {
      bad.push(`${rel} says which paths need no token and does not name ${missing.join(", ")} — ` +
               "the gateway exempts it, so a reader auditing the surface counts one fewer than " +
               "is open");
    }
  }
  return bad.join("\n");
});

check("an MCP door is stateless, and never answers with an HTTP error status", () => {
  // TWO RULES, ONE DISEASE. The MCP client SDK reads the HTTP status as the health of the
  // TRANSPORT and the body as the answer. Conflate them and a refusal we wrote to be READ
  // arrives as a dead socket instead.
  //
  // Rule 1 — no sessions. serveMcp used to mint a session id on initialize and hold the
  // transport in a Map. That map is process memory: emptied by every deploy, every restart,
  // and by an idle sweeper after two hours. The client's id survived all three, so it kept
  // posting one we no longer knew. The spec says answer 404 and says the client MUST then
  // re-initialise — we did the first half; the SDK client does not implement the second.
  // Its `_sessionId` is cleared in exactly one place, `terminateSession()`, and there is no
  // 404 branch anywhere in its transport. So every later POST was another 404, each one
  // `Error POSTing to endpoint: {…}`, and three of those open LibreChat's per-user circuit
  // breaker for good. Reproduced against UAT: POST with an unknown id returned
  // `HTTP 404 {"jsonrpc":"2.0","error":{"code":-32001,…` — the `{` the logs are full of.
  //
  // `sessionIdGenerator: undefined` makes the SDK skip session validation entirely, so there
  // is no state a deploy can drop and no id to go stale. Anything that reintroduces a session
  // map reintroduces the whole class, which is why this is a check and not a comment.
  //
  // Rule 2 — no HTTP error statuses on the doors. Measured on production over seven days:
  // 52 "Error POSTing", 28 "Failed to open SSE stream: Not Found", 12 "Bad Gateway", against
  // TEN credential_required calls in a fortnight. The gateway's 403s were the worst of it:
  // "you are acting for team 'x', which is not granted block 'casebox' — switch_team to it" is an
  // instruction the agent can follow, and it was being delivered as a transport failure, so
  // the agent told the person to reconnect their credentials instead.
  //
  // Two exceptions, both spec-mandated and both explicitly tolerated by the client's own
  // code: 405 (we do not offer the server-to-client stream, and its `terminateSession`
  // special-cases 405 too) and 401 WITH a WWW-Authenticate challenge, which is the auth
  // handshake the client is built to act on. A bare 401 is not exempt — with no authProvider
  // configured it falls through to the same `Error POSTing` throw as everything else.
  const bad = [];
  const src = readFileSync(join(root, "packages/mcp-http/src/index.ts"), "utf8");
  if (!/sessionIdGenerator:\s*undefined/.test(src)) {
    bad.push("serveMcp no longer runs stateless — a session id that outlives our memory of it is unrecoverable for this client, which is the 404 class");
  }
  if (/new Map\b/.test(src) || /transports\./.test(src)) {
    bad.push("serveMcp is holding a session map again; a deploy empties it and every connected client is stranded");
  }
  if (!/req\.method !== "POST"/.test(src) || !/status\(405\)/.test(src)) {
    bad.push("a non-POST on an MCP door does not answer 405 — the client's stream open becomes a transport error and trips its circuit breaker");
  }
  // The gateway's own doors: every refusal on an MCP path goes through mcpRefusal, which
  // answers 200 with a JSON-RPC error. Read the region from the helper to the end of proxy().
  const gw = gatewaySource();
  if (!/function mcpRefusal\(/.test(gw)) {
    bad.push("mcpRefusal is gone from the gateway — the one place that keeps a refusal readable instead of transport-fatal");
  }
  const from = gw.indexOf("function mcpRefusal(");
  // The region is the helper through to the LAST line of proxy() — which is every MCP door
  // handler on this gateway. Anchoring the end on the first `const headers` instead closed the
  // window one line into /core/mcp, so the check passed over code it had never read: a
  // deliberately reintroduced 502 went unnoticed until this was negative-tested.
  const to = gw.indexOf("relayBody(upstream.body, res, `block ${platform}`)", from);
  if (from >= 0 && to > from) {
    gw.slice(from, to).split("\n").forEach((ln) => {
      const code = ln.replace(/\/\/.*$/, "");
      const m = /res\.status\((\d{3})\)/.exec(code);
      if (!m) return;
      const s = Number(m[1]);
      if (s < 400 || s === 405) return;
      if (s === 401 && /WWW-Authenticate/i.test(gw.slice(from, to))) return;
      bad.push(`an MCP door answers HTTP ${s}: the client reads that as a dead transport and the message never reaches the agent — use mcpRefusal`);
    });
  }
  return bad.length ? bad.join("; ") : null;
});

check("a block nobody has connected refuses, rather than answering with a stub", () => {
  // THE GREEN DOT THAT LIED, and the reason this whole piece of work happened.
  //
  // A block door with no credential used to serve a stub MCP session: `initialize` answered
  // 200, `tools/list` offered one tool called `credential_required` carrying the onboarding
  // guidance. For an AGENT that was better than the block silently vanishing. For a PERSON it
  // was a disaster — LibreChat marks a server `connected` when `initialize` returns 200, that
  // being the entire test, so a block nobody had signed in to showed the same green dot as one
  // in daily use. Six green dots and then a block that refuses every call; and the agent,
  // unable to tell "not connected" from "platform broken", reliably chose the second and told
  // people to reconnect credentials that were fine.
  //
  // The door now answers 401 with a WWW-Authenticate challenge, which the client reads as a
  // handshake rather than a failure: the dot stops being green and Connect runs the BLOCK's
  // own OAuth. Three things have to hold together or it half-works in a way nobody notices.
  const bad = [];
  const gw = gatewaySource();
  const at = gw.indexOf("if (conf.header && !key && !delegated)");
  if (at < 0) return "the not-connected branch is gone from the block proxy — this check reads nothing";
  const branch = gw.slice(at, at + 3000);
  if (!/res\.status\(401\)/.test(branch)) {
    bad.push("a block with no credential does not answer 401 — whatever it answers, the front end will call it connected if the status is 2xx");
  }
  if (!/WWW-Authenticate/i.test(branch)) {
    bad.push("the 401 carries no WWW-Authenticate challenge — a bare 401 is a transport error to this client, not a sign-in prompt, and it trips the circuit breaker instead of offering a Connect button");
  }
  // Comments stripped first: this branch EXPLAINS the stub it replaced, at length and on
  // purpose, and a check that cannot tell an explanation from an instruction is a check that
  // gets switched off. What is forbidden is serving one, not describing why we stopped.
  const branchCode = branch.split("\n").map((ln) => ln.replace(/\/\/.*$/, "")).join("\n");
  if (/credential_required/.test(branchCode)) {
    bad.push("the credential_required stub is back in the not-connected branch — that is the 200 that made every dot green");
  }
  // AND NO SKILL MAY STILL TEACH IT AS A LIVE TOOL.
  //
  // A skill may still NAME it — one does, to say plainly that it is gone and to stop the next
  // agent hunting for it, which is worth more than silence. So the rule is not "never mention
  // it": it is that any file mentioning it must also say, in that file, that it no longer
  // exists. A mention without that is a skill teaching a call that now answers `Unknown tool`.
  const GONE = /it is gone|no longer exists|has been removed|used to offer|replaced a stub/i;
  for (const rel of sourceFiles(["skills", "catalog", "blocks"], [".md"])) {
    const text = readFileSync(join(root, rel), "utf8");
    if (!/credential_required/.test(text)) continue;
    if (!GONE.test(text)) {
      bad.push(`${rel} names credential_required without saying it is gone — a disconnected block now offers no tools at all, so an agent following that hunts for a tool nothing serves`);
    }
  }
  return bad.length ? bad.join("; ") : null;
});

check("an MCP door answers MCP, whatever the block's edge did", () => {
  // A block is a third party behind somebody else's CDN, and that edge answers with HTML when
  // it has a bad moment. Relaying it verbatim hands an MCP client `<html>…` where it expects
  // JSON or SSE — which it reports as a TRANSPORT error, not as "the block returned 502". On
  // production 2026-09-09 three of those opened LibreChat's per-user circuit breaker, every
  // later attempt was blocked, each blocked attempt counted as another failure, and the
  // person's agent told them their OAuth sign-in had not landed. It had, four minutes
  // earlier, and was valid for another twelve hours.
  //
  // The cost is not the blip. It is a diagnosis that sends somebody to redo the one thing
  // that was working.
  const src = gatewaySource();
  const at = src.indexOf("relayBody(upstream.body, res, `block ${platform}`)");
  if (at < 0) return "the block proxy no longer relays through relayBody — re-check this rule against whatever replaced it";
  // Read BACKWARD from the relay: the guard has to sit before it, or the HTML is already gone.
  const before = src.slice(Math.max(0, at - 2600), at);
  const bad = [];
  if (!/content-type/i.test(before) || !/event-stream/.test(before)) {
    bad.push("the block proxy relays an upstream body without checking it is JSON or an SSE stream — an HTML error page reaches the MCP client as a transport failure");
  }
  if (!/jsonrpc/.test(before)) {
    bad.push("a non-MCP upstream answer is not turned into a JSON-RPC error, so the caller gets something it cannot parse instead of something it can read");
  }
  return bad.length ? bad.join("; ") : null;
});
