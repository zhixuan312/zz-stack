/**
 * Credentials: where they are stored, who may remove them, and what must never carry them.
 *
 * The invariant behind all of it is that a block is told nothing about who is calling and
 * the platform holds no team's key. Each check here is one way that could stop being true.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { COMMENTS, between, firstOf, gateOwnSource, gatewaySource, root, scan, sourceFiles, splitTopLevel, toolsIn, trackedFiles, unbuilt, withoutComments } from "../read.mjs";
import { check } from "../run.mjs";

/* WHAT THIS REPOSITORY DISCLOSES BY BEING PUBLIC.
 *
 * There used to be one unauthenticated HTML page here, `/architecture`, and this was the
 * check that read it — because `server.ts` claimed in a comment that it "is checked for that
 * before it ships" and nothing checked it. The page is gone and so is the route; what the
 * page taught is not gone, and it generalises to every file in a published repository.
 *
 * The rules are the ones that page actually broke, in the order it broke them: an address
 * somebody can write to, an address somebody can reach, and a string shaped like a key.
 * Each is mechanical, and none of them needs a list of things to look for — which is the
 * whole reason this check survives its subject. A marker list only ever finds what its
 * author already knew; a shape finds what nobody thought to write down.
 */
check("nothing in this repository discloses an address, a host or a credential", () => {
  const bad = [];
  for (const rel of trackedFiles() ?? []) {
    if (!/\.(ts|tsx|mjs|js|sql|sh|md|json|yml|yaml|html|example)$/.test(rel)) continue;
    // TRACKED IS NOT PRESENT. A file deleted in the working tree is still tracked until the
    // deletion is staged, and readFileSync on it throws — which reports a check that could
    // not RUN as a check that FAILED, the one confusion this gate is most careful about.
    if (!existsSync(join(root, rel))) continue;
    readFileSync(join(root, rel), "utf8").split("\n").forEach((ln, i) => {
      const at = `${rel}:${i + 1}`;
      // An address that is not a documentation address. RFC 2606 reserves .example and the
      // example.* domains for exactly this, and a SUBDOMAIN of one is still one —
      // `a@x.example.com` is as reserved as `a@example.com`.
      for (const m of ln.matchAll(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[a-z]{2,}/g)) {
        if (!/@(?:[a-z0-9.-]+\.)?(?:example\.(?:com|org|net)|example|invalid|test|localhost)$/i.test(m[0])) {
          bad.push(`${at} carries the address ${m[0]}`);
        }
      }
      // A routable IPv4 address. RFC 5737's TEST-NET blocks and the private ranges are what
      // a document is supposed to use; anything else names a machine that exists.
      for (const m of ln.matchAll(/\b(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\b/g)) {
        const [a, b, c, d] = m.slice(1, 5).map(Number);
        if (a > 255 || b > 255 || c > 255 || d > 255) continue;   // a version, not an address
        const documentation =
          (a === 192 && b === 0) || (a === 198 && (b === 51 || b === 18 || b === 19)) ||
          (a === 203 && b === 0) || a === 10 || a === 127 || a === 0 ||
          (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224;
        if (!documentation) bad.push(`${at} names the host ${m[0]}`);
      }
      // Anything shaped like a key. The lengths are the real ones: a provider key is long,
      // and a short `sk-` literal is a test fixture the redaction engine has to be fed.
      for (const re of [/zzp_[A-Za-z0-9]{16}/, /zze_[A-Za-z0-9]{16}/, /BEGIN [A-Z ]*PRIVATE KEY/,
                        /AKIA[0-9A-Z]{16}/, /sk-[A-Za-z0-9]{32}/]) {
        if (re.test(ln)) bad.push(`${at} carries something shaped like a credential (${re.source})`);
      }
    });
  }
  return bad.length ? bad.slice(0, 12).join("; ") : null;
});

/* AND THE ONE THAT MATTERS MORE THAN ANY SHAPE.
 *
 * The blocks named in this repository are stand-ins. A pseudonym protects nothing the moment
 * prose says it stands for something real — the word "real" put in front of the name, or the
 * name set beside a named environment. Either sentence tells a reader there IS a subject,
 * that this platform ran against it, and roughly what happened when it did, which is the
 * disclosure whatever the name has been changed to.
 *
 * Four audit rounds read these files and none of them caught this class, because every one of
 * the sentences was true and well written. What makes them findings is not falsehood, it is
 * the pairing: a pseudonym plus a claim about a deployment somebody could go and look for.
 *
 * THIS COMMENT DELIBERATELY QUOTES NONE OF THEM. The first draft did, and the check found its
 * own examples — the third time in this gate that a check could not tell a fault from a
 * sentence describing one. Where the shape can be described instead of shown, describe it.
 *
 * Derived from `034_block_title.sql`, which is where a block's id and its display name
 * actually live. A hand-typed list here would stop covering the next block the day it
 * is added, which is the failure this check exists to prevent arriving through the check.
 */
check("no stand-in block is written about as a real deployment", () => {
  const titles = readFileSync(join(root, "services/gateway/migrations/034_block_title.sql"), "utf8");
  const blocks = [...titles.matchAll(/set title = '([^']+)',\s*kind = '[^']*'\s*where name = '([a-z0-9_-]+)'/g)]
    .flatMap((m) => [m[1], m[2]])
    .filter((w) => w !== "platform" && w !== "zz-core");
  if (blocks.length < 4) {
    return "034_block_title.sql no longer names the blocks and their titles — this check reads nothing";
  }
  const names = blocks.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  // Two shapes, both narrow on purpose. `real` next to the name, and the name in the same
  // sentence as an environment. Bare `real` and bare `actually` are NOT signals — "the real
  // predicate" and "a block a person could actually configure" are correct prose, and a
  // check that calls correct prose a defect is a check people switch off.
  const claims = [
    new RegExp(`\\breal\\s+(?:${names})\\b`, "i"),
    new RegExp(`\\b(?:${names})\\b[^.]{0,90}?\\b(?:in|on)\\s+(?:production|staging|UAT)\\b`, "i"),
    new RegExp(`\\b(?:in|on)\\s+(?:production|staging|UAT)\\b[^.]{0,90}?\\b(?:${names})\\b`, "i"),
  ];
  const bad = [];
  for (const rel of trackedFiles() ?? []) {
    if (!/\.(ts|tsx|mjs|sql|sh|md|json|yml|yaml|html)$/.test(rel)) continue;
    if (!existsSync(join(root, rel))) continue;
    readFileSync(join(root, rel), "utf8").split("\n").forEach((ln, i) => {
      if (claims.some((re) => re.test(ln))) {
        bad.push(`${rel}:${i + 1} writes about a stand-in block as a real deployment: ` +
                 `"${ln.trim().slice(0, 90)}"`);
      }
    });
  }
  return bad.length ? bad.slice(0, 12).join("; ") : null;
});

check("the credential store is only mutated through withCredentials", () => {
  // load() -> mutate -> save() rewrites the whole file, so two calls interleaving lose one
  // of them: both read the same store, both write their copy, and the second erases the
  // first user's key with no error. Three call sites did it directly, including the
  // onboarding batch tool — the one most likely to run several at once.
  const src = gatewaySource();
  const bad = [];
  // INSIDE withCredentials, by matching its braces — not "within twelve lines of where it
  // starts". That proximity test exempted anything written just after the function, in a
  // different function entirely: a `save()` placed eleven lines below the definition passed,
  // which is the one thing this check exists to refuse. Found by writing exactly that.
  const at = src.indexOf("function withCredentials");
  if (at < 0) return "withCredentials is gone — the credential store has no single writer";
  let depth = 0, endOfFn = src.length;
  for (let i = src.indexOf("{", at); i < src.length; i++) {
    if (src[i] === "{") depth += 1;
    else if (src[i] === "}") { depth -= 1; if (depth === 0) { endOfFn = i; break; } }
  }
  for (const m of src.matchAll(/^[ \t]*save\(/gm)) {
    if (m.index > at && m.index < endOfFn) continue;      // the one legitimate caller
    bad.push(`server.ts:${src.slice(0, m.index).split("\n").length} calls save() outside withCredentials`);
  }

  // And nothing ELSE may name that file at all. The rule was enforced in TypeScript while a
  // Python script opened /data/credentials.json and rewrote it — a guarantee held in one
  // language and broken in another, which no amount of reading server.ts would have shown.
  // (That script also could not run: it shelled python into a Node container. The dead code
  // is why nobody noticed the live hazard underneath it.)
  // THE OWNER IS THE MODULE NAMED AFTER THE STORE, which is where the store went when
  // server.ts was split. A path that only one file may name has to name that file.
  const OWNER = "services/gateway/src/credentials.ts";
  const scan = (rel) => {
    const abs = join(root, rel);
    if (rel === OWNER || gateOwnSource(rel)) return;
    // Line-wise, skipping comments: a file is allowed to EXPLAIN why it does not touch the
    // store — set-credential carries exactly that explanation, and a whole-file substring
    // match would read the explanation as the offence.
    //
    // The fence-counting that used to sit here skipped a Python triple-quoted docstring,
    // because the explanation lived in one. There is no Python left, and a comment prefix
    // covers every language that remains.
    readFileSync(abs, "utf8").split("\n").forEach((raw, i) => {
      const line = raw.trim();
      if (line.startsWith("#") || line.startsWith("//") || line.startsWith("*") || line.startsWith("/*")) return;
      if (line.includes("/data/credentials.json")) {
        bad.push(`${rel}:${i + 1} names /data/credentials.json — only ${OWNER} may touch it`);
      }
    });
  };
  for (const f of sourceFiles(["services", "packages", "scripts", "deploy", "testing"],
                              [".ts", ".mjs", ".js", ".sh"])) scan(f);
  return bad.length ? bad.join("; ") : null;
});

check("no proxy forwards the caller's credentials upstream", () => {
  // The /core proxy dropped `authorization` by naming it inline; the BLOCK proxy did not,
  // so every third-party platform received the caller's zz PAT alongside its own key —
  // a token that authenticates as that person against this platform. Proven by pointing a
  // block at an echo server. Both proxies now use one NEVER_FORWARD set.
  // Keyed on the COPY, not on a constant it happens to mention.
  //
  // This looked for lines containing HOP_HEADERS and required NEVER_FORWARD beside them,
  // which catches an existing loop being weakened and misses the more likely thing: a NEW
  // proxy written from scratch, mentioning neither. Verified — a header-copy loop naming
  // neither constant passed this check while forwarding the caller's PAT.
  //
  // `Object.entries(req.headers)` is what copying request headers actually looks like here,
  // so that is the trigger, and NEVER_FORWARD has to appear inside the loop it opens.
  // EVERY service source. The comment above says the likely defect is "a NEW proxy written
  // from scratch", and a new proxy is exactly the thing that would be written in a new file —
  // this read one. The front end is being replaced again; whatever proxies for it will not be
  // in server.ts either.
  // A DENYLIST OR AN ALLOWLIST, because both answer the rule and one of them is stricter.
  // Widening this to every source found kb.ts copying headers with no NEVER_FORWARD in
  // sight — and reading it, that loop takes ONLY `x-zz-*`, so the caller's PAT cannot be in
  // what it forwards. Demanding the denylist there would have made it less safe, not more:
  // a denylist forwards everything it has not thought of, and an allowlist forwards nothing
  // it has not.
  //
  // The allowlist is accepted only when its prefix could not select a credential header,
  // which is checked against NEVER_FORWARD itself rather than against a second list here.
  const gw = gatewaySource();
  const never = [...(/const NEVER_FORWARD = new Set\(\[([^\]]*)\]/.exec(gw)?.[1] ?? "")
    .matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  if (never.length === 0) return "NEVER_FORWARD could not be read from the gateway";
  const bad = [];
  for (const rel of sourceFiles(["services", "packages"], [".ts"])) {
    const lines = readFileSync(join(root, rel), "utf8").split("\n");
    lines.forEach((ln, i) => {
      if (!/Object\.entries\(req\.headers\)/.test(ln)) return;
      const body = lines.slice(i, i + 12).join("\n");
      if (/NEVER_FORWARD\.has\(/.test(body)) return;
      const allow = [...body.matchAll(/startsWith\("([a-z-]+)"\)/g)].map((m) => m[1]);
      const safe = allow.length > 0 && allow.every((pfx) => !never.some((h) => h.startsWith(pfx)));
      if (safe) return;
      bad.push(`${rel}:${i + 1} copies request headers with neither NEVER_FORWARD nor an ` +
               "allowlist that excludes a credential — the caller's PAT is in there");
    });
  }
  return bad.length ? bad.join("; ") : null;
});

check("a block is told nothing about who is calling it", () => {
  // The gateway stamps x-zz-* headers on every request so its own services know who is
  // calling. A block is a THIRD PARTY — it is not this platform, whoever wrote it — and it
  // gets exactly one thing, its own key. Who the person is, how they authenticated and which
  // team their token is bound to are none of its business.
  //
  // The block proxy strips them by prefix. Written as a list of names it was already wrong
  // once: x-zz-via, x-zz-pat-scope and x-zz-pat-team were added to the middleware after the
  // list was written, so all three leaked. "no proxy forwards the caller's credentials"
  // covers the PAT and not this — a different leak, of identity rather than authority.
  //
  // So the rule is read off the MIDDLEWARE, not off a list here: whatever it stamps, the
  // block proxy must exclude. Adding a seventh header and forgetting the strip is the whole
  // defect this refuses, and it cannot be refused by a check that carries its own list.
  const idsrc = readFileSync(join(root, "services/gateway/src/identity.ts"), "utf8");
  const stamped = [...new Set([...idsrc.matchAll(/"(x-zz-[a-z-]+)"/g)].map((m) => m[1]))];
  if (stamped.length < 2) return "no x-zz-* headers found in identity.ts — this check reads nothing";

  const src = gatewaySource();
  const start = src.indexOf("async function proxy(");
  if (start < 0) return "the block proxy is gone — this check reads nothing";
  const body = src.slice(start, src.indexOf("\n}\n", start));
  // The loop that copies request headers on their way to the third party.
  const loop = between(body, "Object.entries(req.headers)", "await fetch(");
  if (!loop.text) return `the block proxy's header copy is unreadable: ${loop.why}`;

  // COMMENTS STRIPPED FIRST. The comment explaining this strip names the three headers that
  // leaked, so reading the region whole found every stamped header present and reported no
  // gap — a check defeated by the prose written to justify the code it guards. Caught by
  // putting the old named list back and watching this pass.
  const code = withoutComments(loop.text);
  const byPrefix = /startsWith\("x-zz-"\)/.test(code);
  const missing = stamped.filter((h) => !code.includes(h));
  if (byPrefix || !missing.length) return null;
  return `${firstOf(missing)} reach a third-party block — the middleware stamps them and the ` +
         "proxy names the ones somebody thought of instead of stripping the prefix";
});

check("no team pays for a block call, because no team holds a key", () => {
  // THIS CHECK USED TO ENFORCE A COHERENCE THAT IS NOW UNREACHABLE, and that is the fix.
  //
  // Two facts about one call: the GRANT said the team may reach the block, the CREDENTIAL
  // said whose key got spent — and they had to name the same team. They did not. The proxy
  // asked whether ANY of the caller's teams was granted the block and then resolved the
  // credential against the ACTING team, so somebody in team A (granted casebox) and team B (not
  // granted, holding a shared casebox key) could act for B, pass on A's grant, and spend B's key
  // on a block B was never given.
  //
  // Shared keys are gone, so there is no team-owned key for a grant to disagree with. The
  // rule that replaces it is simpler and cannot rot the same way: the credential resolution
  // takes NO team at all. If a team argument ever comes back, the two-team incoherence comes
  // back with it, so that is what is refused here.
  const src = gatewaySource();
  const start = src.indexOf("async function proxy(");
  if (start < 0) return "the block proxy is gone — this check reads nothing";
  const body = src.slice(start, src.indexOf("\n}\n", start));
  const bad = [];
  if (/resolveCredential\(/.test(body)) {
    bad.push("the proxy calls resolveCredential — the two-level resolver was replaced by personalCredential, which takes no team");
  }
  // Balance the parens rather than matching lazily to the first `)`. The arguments are
  // `load(), email, platform` — a lazy match stops inside `load()` and reports one argument,
  // which is the same trap the check this replaced recorded falling into.
  const at = body.indexOf("personalCredential(");
  if (at < 0) return "the proxy no longer resolves a personal credential in a shape this can read";
  let depth = 0, i = at + "personalCredential".length, argText = "";
  for (; i < body.length; i++) {
    const ch = body[i];
    if (ch === "(") { depth++; if (depth === 1) continue; }
    if (ch === ")") { depth--; if (depth === 0) break; }
    argText += ch;
  }
  const call = [null, argText];
  const args = splitTopLevel(argText);
  if (args.length !== 3) {
    bad.push(`personalCredential is called with ${args.length} arguments (${call[1].trim()}) — it takes the store, the person and the platform, and a fourth is a team creeping back in`);
  }
  if (/team/i.test(call[1])) {
    bad.push(`a team is being passed to the credential resolution: ${call[1].trim()}`);
  }
  // The grant is still checked — removing shared keys must not remove authorisation.
  if (!/\btool_grant\b/.test(body)) {
    bad.push("the proxy no longer checks a grant — a block door with no authorisation");
  }
  return bad.length ? bad.join("; ") : null;
});

check("a key is checked before it is stored, on every path", () => {
  // The two person-facing setters each carried their own `key.length < 8`; the operator's
  // batch path had none — the path most likely to run many at once with a blank field
  // scrolling past. A blank stores as "", and resolveCredential reads "" as absent: the
  // operator is told it worked and the person silently spends the TEAM key instead, with
  // nothing anywhere saying why. A duplicated rule that one caller skipped is exactly the
  // reason the rule is now a function, and this refuses a fourth setter written without it.
  const src = gatewaySource();
  if (!/function implausibleKey\(/.test(src)) return "implausibleKey is gone — the rule has no home";
  const bad = [];
  let stores = 0;
  for (const { name, body } of toolsIn(src)) {
    // Writing a key INTO the store, as opposed to deleting from it or reading it.
    if (!/\(data\[[a-z]+\] \?\?= \{\}\)\[[a-z_]+\] =/.test(body)) continue;
    stores += 1;
    if (!/implausibleKey\(/.test(body)) bad.push(`${name} stores a key it never checked`);
  }
  if (!stores) return "no tool stores a credential — this check reads nothing";
  return bad.length
    ? `${firstOf(bad)} — "" reads as no key at all, so an unchecked one is reported stored and never used`
    : null;
});

check("deleting the last key deletes the person too", () => {
  // credentials.json is the most sensitive file this platform holds — every person's key to
  // somebody else's real platform, in plaintext by design — and its shape invariant is that
  // a subject with no keys is not a subject. Every tool that deletes from it has to uphold
  // that separately, which is the arrangement that guarantees one of them will not.
  //
  // credential_delete was the one that did not. The operator's twin, credential_admin_delete,
  // dropped the emptied subject; the tool a person uses on their own key left their address
  // behind, so the store kept a standing list of everyone who had ever stored one — in the
  // tool you reach for when a key has leaked. The asymmetry is the
  // recurring shape here: this same file already carries two comments about a person-facing
  // tool missing what its operator twin had.
  const src = gatewaySource();
  const bad = [];
  for (const { name, body } of toolsIn(src)) {
    // A delete from the credential store: a subject-keyed delete inside withCredentials.
    if (!/withCredentials\(/.test(body)) continue;
    const drops = [...body.matchAll(/delete (data\[[a-z]+\])\[/g)].map((m) => m[1]);
    if (!drops.length) continue;
    for (const subject of new Set(drops)) {
      const cleanup = new RegExp(
        `Object\\.keys\\(${subject.replace(/[[\]]/g, "\\$&")}\\)\\.length === 0\\s*\\)?\\s*delete ${subject.replace(/[[\]]/g, "\\$&")}`);
      if (!cleanup.test(body)) bad.push(`${name} empties ${subject} and leaves it in the store`);
    }
  }
  if (!bad.length && !/delete data\[/.test(src)) return "no credential delete found — this check reads nothing";
  return bad.length
    ? `${firstOf(bad)} — a subject with no keys is not a subject, and the other deletes drop it`
    : null;
});

check("a block key resolves to the person, and to nobody else", () => {
  const nothingToRun = unbuilt();
  if (nothingToRun) return nothingToRun;
  // ONE LEVEL. There used to be two — the person's own key, else their team's shared one —
  // and the team level is gone rather than merely unused.
  //
  // What it bought was a block call the block could not attribute: the block's audit
  // log recorded the platform, not the person, for anyone who had never signed in. And it
  // made connection state unanswerable from the inside, because somebody holding no
  // credential at all looked connected while a colleague's key carried them. The day-one
  // problem it existed for is solved by the person signing in to the block as themselves.
  //
  // Run against the real resolver rather than a reading of it: a fallback is one `if`, and a
  // reading of an `if` cannot fail, which is exactly the kind of claim that turns out wrong.
  // In a child process against the COMPILED module, which is what the gateway loads.
  const probe = `
    import * as contracts from ${JSON.stringify(join(root, "packages/contracts/dist/index.js"))};
    const { personalCredential } = contracts;
    const bad = [];
    if (contracts.teamSubject) bad.push("teamSubject still exists — the team subject shape is what a shared key was stored under");
    if (contracts.resolveCredential) bad.push("resolveCredential still exists — the two-level resolver is what was removed");
    const store = { "a@x.example.com": { casebox: "PERSONAL" }, "team:acme": { casebox: "SHARED" } };
    const own = personalCredential(store, "a@x.example.com", "casebox");
    if (own?.key !== "PERSONAL") bad.push("a person's own key must resolve: " + JSON.stringify(own));
    if (personalCredential(store, "b@x.example.com", "casebox") !== null) bad.push("somebody with no key of their own must resolve to NOTHING, not to a team's");
    if (personalCredential(store, "team:acme", "casebox")?.key === "SHARED") bad.push("a team subject must not be reachable as if it were a person");
    if (personalCredential(store, "A@X.EXAMPLE.COM", "casebox")?.key !== "PERSONAL") bad.push("an upper-case email must still find its owner's key");
    process.stdout.write(bad.join("; "));
  `;
  try {
    const out = execFileSync("node", ["--input-type=module", "-e", probe], { encoding: "utf8" });
    return out.trim() || null;
  } catch (err) {
    return `the resolver could not be run: ${String(err.stderr ?? err).slice(-300)}`;
  }
});

check("anything that stores a credential can also remove it", () => {
  // Twice now. credential_admin_set shipped without a delete, so an operator could put a key
  // into the store on somebody's behalf and nothing could ever take it out — deactivating
  // the principal stops them authenticating and leaves the platform injecting their key.
  // The team-wide setter that shipped beside it in the same release repeated the mistake, and
  // it mattered more there, for a SHARED key: the reason to remove one is usually that it
  // leaked, and "wait for someone to overwrite it" is not a response to that. That whole tier
  // has since been deleted — "a block key resolves to the person, and to nobody else" below is
  // what replaced it — which is why neither name appears here any more.
  //
  // The shape is simple enough to hold mechanically: a tool that WRITES into the credential
  // store needs a counterpart that removes from it.
  const src = gatewaySource();
  const tools = new Set(toolsIn(src).map((t) => t.name));
  const setters = [...tools].filter((t) => /(^|_)set_/.test(t) && t.includes("credential"));
  const bad = [];
  for (const setter of setters) {
    // credential_set -> credential_delete, credential_admin_set -> credential_admin_delete.
    //
    // BOTH THE SELECTOR ABOVE AND THIS MAPPING ARE WRITTEN FOR VERB-FIRST NAMES — `set_` with
    // something after it — and the noun-first rename left no registered name in that shape, so
    // `setters` is empty and this loop currently runs zero times. Said out loud rather than
    // quietly repaired: changing what a security check ENFORCES is not a prose task, and a
    // comment that implied working coverage would be the same defect this file's rename debris
    // already was. `/(^|_)set$/` on the selector and `.replace(/set$/, "delete")` here are what
    // make it read the surface that exists.
    const deleter = setter.replace(/set_/, "delete_");
    if (!tools.has(deleter)) {
      bad.push(`${setter} stores a key and there is no ${deleter} to remove it`);
    }
  }
  return bad.length ? bad.join("; ") : null;
});

check("no deployment ships with a password we chose", () => {
  // POSTGRES_PASSWORD defaulted to `change-me` in three places, documented as "set on a real
  // deployment" in a section headed "no installer can supply a better value than we already
  // know" — which is true of a service name and false of a credential. Nothing failed, and
  // that is the defect: the documented install completed, the platform came up, and the
  // database holding the team registry and the entire audit record accepted a password
  // published in this repository. POSTGRES_BIND exists so an operator can put that database
  // on a tailnet, at which point the default is reachable by everyone on it.
  //
  // Read from compose rather than from a list of known bad strings: a secret-shaped variable
  // is one whose name says so, and the rule is that it has no default at all.
  const compose = readFileSync(join(root, "deploy/docker-compose.yml"), "utf8");
  const bad = [];
  for (const m of compose.matchAll(/\$\{([A-Z][A-Z0-9_]*)(:-[^}]*)?\}/g)) {
    const [, name, dflt] = m;
    if (!/PASSWORD|SECRET|_KEY$|CREDS_/.test(name)) continue;
    // `:-` with nothing after it is "empty unless set", which is not a shipped secret.
    if (dflt && dflt !== ":-") bad.push(`${name} defaults to ${dflt.slice(2)}`);
  }
  return bad.length ? `a credential with a default we chose — ${bad.join("; ")}` : null;
});

check("a platform token is one shape, whoever writes or reads it", () => {
  const nothingToRun = unbuilt();
  if (nothingToRun) return nothingToRun;
  // Four sites decided independently what a `zzp_` token is. `pat_issue` and `client_setup`
  // each wrote `"zzp_" + randomBytes(24).toString("hex")`; deploy/issue-first-pat.sh writes
  // the same shape in shell, because it mints the first token on a host with no toolchain;
  // and provision-librechat READ one back with `/zzp_[0-9a-f]{48}/` — a length nobody
  // derived, copied out of a minter.
  //
  // The asymmetry is what costs. Raising the entropy is one word at a minter, and the reader
  // goes on looking for 48 hex characters: "could not mint a token for <person>" about a
  // token that was minted correctly, in the tool that provisions everybody. The shape is a
  // contract between whatever writes a token, whatever reads one back, and whatever
  // recognises one in a log — not a minter's to choose alone.
  //
  // RUN, because the property is that a minted token satisfies the pattern every reader
  // uses, and both halves are now derived from one byte count that a reading cannot check.
  const out = execFileSync("node", ["--input-type=module", "-e",
    `import { mintPat, PAT_TOKEN } from ${JSON.stringify(join(root, "packages/contracts/dist/index.js"))};` +
    "const a = mintPat(), b = mintPat();" +
    "process.stdout.write(JSON.stringify({ a, b, ok: PAT_TOKEN.test(a), src: PAT_TOKEN.source }));"],
    { encoding: "utf8" });
  const minted = JSON.parse(out);
  const bad = [];
  if (!minted.ok) bad.push(`mintPat() produces ${minted.a}, which PAT_TOKEN does not match`);
  if (minted.a === minted.b) bad.push("mintPat() returned the same token twice — it is not random");

  // The shell minter, which cannot import and therefore has to be compared. It runs as root
  // on a host with no toolchain and mints the FIRST token, so a shape that disagrees is a
  // platform nobody can log in to on the day it is installed.
  const sh = readFileSync(join(root, "deploy/issue-first-pat.sh"), "utf8");
  const shell = /TOKEN="([a-z_]+)\$\(openssl rand -hex (\d+)\)"/.exec(sh);
  if (!shell) {
    bad.push("deploy/issue-first-pat.sh no longer mints a token in a shape this can read — " +
             "it is the only minter that cannot import the contract");
  } else if (!new RegExp(`^${minted.src}$`).test(shell[1] + "0".repeat(Number(shell[2]) * 2))) {
    bad.push(`issue-first-pat.sh mints ${shell[1]}<${shell[2]} bytes as hex> and @zz/contracts ` +
             `says a token is ${minted.src} — the first token on a fresh host would not be one`);
  }

  // And nobody else may spell it. Both shapes: building one from the prefix, and reading one
  // back with a length written out rather than derived.
  const OWNER = join("packages", "contracts", "src", "index.ts");
  for (const rel of sourceFiles(["services", "packages", "scripts"], [".ts", ".mjs"])) {
    if (rel === OWNER || gateOwnSource(rel)) continue;
    readFileSync(join(root, rel), "utf8").split("\n").forEach((ln, i) => {
      if (/^\s*(\/\/|\*|\/\*)/.test(ln)) return;
      if (/"zzp_"\s*\+/.test(ln)) {
        bad.push(`${rel}:${i + 1} builds a token from the prefix — call mintPat()`);
      }
      if (/zzp_\[[^\]]+\]\{\d+\}/.test(ln)) {
        bad.push(`${rel}:${i + 1} matches a token by a length written out rather than derived ` +
                 "— use PAT_TOKEN, which is built from the byte count the minter uses");
      }
    });
  }
  return bad.length ? bad.join("; ") : null;
});
