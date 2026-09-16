/**
 * Credentials: where they are stored, who may remove them, and what must never carry them.
 *
 * The invariant behind all of it is that a block is told nothing about who is calling and
 * the platform holds no team's key. Each check here is one way that could stop being true.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { gateOwnSource, gatewaySource, root, sourceFiles, toolsIn, trackedFiles, unbuilt } from "../read.ts";
import { check } from "../run.ts";

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
  const bad: string[] = [];
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
  const bad: string[] = [];
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
  const bad: string[] = [];
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
  const bad: string[] = [];
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
  const bad: string[] = [];
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
  for (const rel of sourceFiles(["services", "packages", "scripts"], [".ts"])) {
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
