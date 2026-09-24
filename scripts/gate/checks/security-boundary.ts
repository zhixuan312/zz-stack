/**
 * The edges: which paths are public, what a refusal does to a request, and what a caller's
 * bytes may become downstream — shell quoting, psql binding, replacement strings read as
 * patterns, a hostile document becoming script in a reader's browser, a path traversal the
 * guards cannot see, and a door that refuses and then keeps handling the request.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { between, firstOf, functionBody, gateOwnSource, gatewaySource, root, sourceFiles, unbuilt, withoutComments, zzCoreSource } from "../read.ts";
import { check } from "../run.ts";

/** A caught value is never typed as an Error — narrow the shape actually being read rather
 *  than assume it. `unknown?.message` narrows to `{}`, which has no properties at all. */
function errMessage(err: unknown): string {
  if (err && typeof err === "object" && "message" in err) {
    const m = (err as Record<string, unknown>).message;
    if (m !== undefined && m !== null) return String(m);
  }
  return String(err);
}

/** Same idea, for an `execFileSync` failure, which carries `stdout`/`stderr` rather than a
 *  plain `message`. */
function execStderr(err: unknown): string {
  const e = err && typeof err === "object" ? err as Record<string, unknown> : {};
  return e.stderr !== undefined ? String(e.stderr) : String(err);
}

check("a value crossing into a shell is quoted for a shell", () => {
  // A shell value is wrapped in single quotes with any embedded one escaped. Neither Python's
  // %r nor JSON.stringify is a shell quoter: both switch to double quotes as soon as the string
  // contains a single quote, and the shell then interpolates what is inside — a password of
  // a$USER'b exports with $USER already expanded.
  const bad = [];
  for (const f of sourceFiles(["."], [".sh"])) {
    const src = readFileSync(join(root, f), "utf8");
    // Only scripts that evaluate generated shell. One that prints for a human to read is
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
  // writeGuard's patterns are matched against the normalised path, not the path as the caller
  // wrote it: one of them anchors at the start, so `a/../_knowledge/nodes/0001-x.md` slips past
  // the journal guard while safePath resolves it to the file the guard protects.
  // Checked over the whole service, because writeGuard is a guard rather than a line in a file.
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
  // String.replace's second argument is not inert text: it reads $$, $&, $` and $'. With a
  // model's own words as the replacement, "$$50" becomes "$50", a $' swallows its line and
  // injects the rest of the document after it, and "$&" writes the text being replaced back out.
  //
  // So a replacement is a function, or a literal with nothing interpolated into it. A literal
  // may still say $1 deliberately.
  const bad = [];
  for (const f of sourceFiles(["services", "packages"], [".ts"])) {
    const raw = readFileSync(join(root, f), "utf8");
    // Comments carry prose about replacements, and prose parses as arguments. The strings stay:
    // a replacement literal is the thing being read. Counting quotes per line to decide whether
    // a `//` is inside one cannot see a template literal opened on an earlier line.
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
        // DELIBERATE: a regex literal is consumed whole. `/"/g` is a real first argument here,
        // and reading its quote as a string delimiter sends the scanner hundreds of lines down
        // the file. A `/` where an argument begins is a regex; a character class may contain `/`.
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
  // The middleware is deny-by-default: it names the public prefixes, not the protected ones, so
  // a route added later without touching the list costs a 401 rather than being silently public
  // on a gateway reachable from the internet. That makes the exception list the thing to guard —
  // a route documented as unauthenticated and missing from it answers 401 to everyone.
  const src = gatewaySource();
  const exact = /const PUBLIC_PATHS = new Set\((\[[^\]]*\])\)/.exec(src)?.[1];
  const prefixes = /const PUBLIC_PREFIXES = (\[[^\]]*\])/.exec(src)?.[1];
  if (!exact || !prefixes) return "the public-path lists are no longer where this can read them";
  const paths = JSON.parse(exact.replace(/'/g, '"'));
  const pre = JSON.parse(prefixes.replace(/'/g, '"'));
  const isPublic = (p: string): boolean => paths.includes(p) || pre.some((x: string) => p.startsWith(x));
  const bad: string[] = [];
  // What must be reachable with no token, and what must never be.
  for (const [p, want] of [
    ["/", true], ["/health", true],
    ["/schemas/envelope.json", true], ["/schemas/manifest.json", true],
    ["/core/mcp", false], ["/manage/mcp", false], ["/eval/mcp", false],
  ] as [string, boolean][]) {
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
  // A statement goes in on stdin with `-v` bindings and a value is referenced as `:'name'`.
  // psql interpolates while lexing, so the quoted form arrives at the server as a string literal
  // and a bare `:name` arrives as raw SQL, where an apostrophe alone changes what the query
  // means. Every value in these queries is an operator's own flag (`--since`, `--actor`).
  //
  // Only lines that look like SQL, so `import x from ":y"` and a TypeScript annotation are not
  // candidates, and `::interval` is a cast rather than a variable.
  const SQLISH = /\b(select|from|where|insert into|update |delete from|now\(\))\b/i;
  const bad: string[] = [];
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
  // walk() skips dot-entries, because the store is a git repository and a lister that did not
  // would report `.git/COMMIT_EDITMSG` as a team's first document. safeName refuses a
  // dot-prefixed name. Neither guards the `path` argument document_write, document_patch and
  // document_read take: commitStore runs `git commit` after every write, so a `.git/hooks/` file
  // the model chose becomes an executable the service runs.
  //
  // Held on the two surfaces that can reach a store root: the path rule, run rather than read,
  // and every hand-rolled listing.
  const src = zzCoreSource();
  const bad = [];

  const body = functionBody(src, "pathShapeRefusal");
  if (!body) return "zz-core no longer defines pathShapeRefusal() — this check cannot run";
  let refuse;
  try {
    refuse = new Function("path", body);
  } catch (err) {
    return `pathShapeRefusal could not be evaluated: ${errMessage(err)} — the ` +
           "extraction must fail loudly rather than quietly stop checking";
  }
  const want = [
    [".git/hooks/pre-commit", true], [".git/config", true], ["/.git/config", true],
    ["a/.git/objects/ab/cdef", true], [".zz/i/spec.md", true], ["~/i/spec.md", true],
    ["2026-08-30-sample-intake/spec.md", false], ["i/sources/2026-08-30-note.md", false],
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

  // And every listing that walks a store root by hand, in any service or tool — the same gap was
  // open in four places at once, and `.git` came back as an open initiative with a next move, as
  // an audit row, and as a card on the gateway's landing view.
  //
  // What identifies a store listing without naming the call sites: it filters `startsWith("_")`,
  // the store's own convention (`_versions`, `_knowledge`, `_ledger.md`, `_activity.jsonl`), and
  // it keeps directories. A listing of files inside one initiative also knows about `_` and
  // cannot contain a repository, so the directory test separates them.
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
  // network by resolving trusted hostnames and comparing the socket peer against them. One
  // resolver, because a second copy of the IPv4-mapped fold fails closed: a peer arriving over
  // IPv6 is `::ffff:10.0.0.5` and the same host out of DNS is `10.0.0.5`, so folding one side
  // and not the other 403s every call from a service's own gateway.
  //
  // The policy stays with each service and differs on purpose: the gateway's trusted front end
  // is off by default, zz-core's defaults to cred-proxy and refuses with 403.
  const bad = [];
  // The module that defines the mechanism is identity.ts. The rule is "one resolver", so the
  // owner is wherever that resolver lives.
  const OWNER = join("packages", "contracts", "src", "identity.ts");
  for (const rel of sourceFiles(["services", "packages", "scripts"], [".ts"])) {
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
  // Run it, because the property is what the two halves do to an address, and both halves
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
    bad.push(`the address mechanism could not be run: ${execStderr(err).slice(-200)}`);
  }
  return bad.length ? bad.join("; ") : null;
});

check("the paths documented as public are the ones the gateway exempts", () => {
  // A claim about what is exposed. The list in the READMEs and the list in the code are the same
  // list, and a reader auditing the surface counts whatever the document says — so a public path
  // added to the code and not to the document is one nobody told them about.
  const src = withoutComments(gatewaySource());
  const exact = [...(between(src, "const PUBLIC_PATHS", ";").text ?? "").matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  const prefixes = [...(between(src, "const PUBLIC_PREFIXES", ";").text ?? "").matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  if (!exact.length) return "cannot read PUBLIC_PATHS out of the gateway";
  // A prefix is documented as a glob — `/schemas/` is `/schemas/*` in prose — so compare the
  // stem either way rather than demanding one spelling of it.
  const want = [...exact, ...prefixes.map((p) => p.replace(/\/$/, ""))];

  const bad = [];
  // The two documents somebody actually reads before opening a port.
  for (const rel of ["deploy/README.md", "README.md"]) {
    const doc = readFileSync(join(root, rel), "utf8");
    // Only where the document actually makes the claim. A file that never lists them is not
    // wrong about them, and inventing a duty to list them would pick a structure for the prose.
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
  // The MCP client SDK reads the HTTP status as the health of the transport and the body as the
  // answer. Conflate them and a refusal written to be read arrives as a dead socket.
  //
  // Rule 1 — no sessions. `sessionIdGenerator: undefined` makes the SDK skip session validation,
  // so there is no state a deploy can drop and no id to go stale. A session map is process
  // memory, emptied by every deploy, restart and idle sweep, while the client's id survives all
  // three; the spec's answer is 404 and a client-side re-initialise, and the SDK client clears
  // `_sessionId` only in `terminateSession()` and has no 404 branch, so every later POST is
  // another 404.
  //
  // Rule 2 — no HTTP error statuses on the doors. A refusal reading "you are acting for team
  // 'x' — team_switch to it" is an instruction the agent can follow, and delivered as a
  // transport failure it becomes "reconnect your credentials".
  //
  // Two exceptions, both spec-mandated and tolerated by the client's own code: 405 (no
  // server-to-client stream, and its `terminateSession` special-cases 405) and 401 with a
  // WWW-Authenticate challenge. A bare 401 is not exempt — with no authProvider configured it
  // falls through to the same `Error POSTing` throw.
  const bad = [];
  const src = withoutComments(readFileSync(join(root, "packages/mcp-http/src/index.ts"), "utf8"));
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
  // answers 200 with a JSON-RPC error. Read the region from the helper to the end of
  // passThrough(), which serves both proxied doors.
  const gw = gatewaySource();
  if (!/function mcpRefusal\(/.test(gw)) {
    bad.push("mcpRefusal is gone from the gateway — the one place that keeps a refusal readable instead of transport-fatal");
  }
  const from = gw.indexOf("function mcpRefusal(");
  const to = gw.indexOf("relayBody(upstream.body, res, what)", from);
  // A region that cannot be located is a failure, not a pass: the scan below would read nothing.
  if (from < 0 || to <= from) {
    bad.push("the door region from mcpRefusal to passThrough's relayBody call cannot be located, " +
             "so no door handler was scanned for an HTTP error status");
  } else {
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
