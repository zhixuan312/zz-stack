/**
 * Credentials: what must never carry them, and what must never ship one.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { gateOwnSource, gatewaySource, root, sourceFiles, trackedFiles, unbuilt } from "../read.ts";
import { check } from "../run.ts";

/* What this repository discloses by being public.
 *
 * Three rules, in order: an address somebody can write to, an address somebody can reach, and
 * a string shaped like a key. Each is a shape rather than a list of markers, because a marker
 * list only finds what its author already knew.
 */
check("nothing in this repository discloses an address, a host or a credential", () => {
  const bad: string[] = [];
  for (const rel of trackedFiles() ?? []) {
    if (!/\.(ts|tsx|mjs|js|sql|sh|md|json|yml|yaml|html|example)$/.test(rel)) continue;
    // Tracked is not present: a file deleted in the working tree stays tracked until the
    // deletion is staged, and readFileSync on it throws, reporting a check that could not run
    // as one that failed.
    if (!existsSync(join(root, rel))) continue;
    readFileSync(join(root, rel), "utf8").split("\n").forEach((ln, i) => {
      const at = `${rel}:${i + 1}`;
      // An address that is not a documentation address. RFC 2606 reserves .example and the
      // example.* domains for exactly this, and a subdomain of one is still one —
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
  // A proxy that copies request headers must not forward the caller's zz PAT to a third
  // party. Keyed on the copy rather than on a constant a loop happens to mention:
  // `Object.entries(req.headers)` is what copying headers looks like here, so that is the
  // trigger, and NEVER_FORWARD has to appear inside the loop it opens.
  //
  // Every service source, because a new proxy is written in a new file.
  //
  // A denylist or an allowlist satisfies the rule: a denylist forwards everything it has not
  // thought of, an allowlist forwards nothing it has not. The allowlist is accepted only when
  // its prefix could not select a credential header, checked against NEVER_FORWARD itself.
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

check("no deployment ships with a password we chose", () => {
  // A secret-shaped variable in compose has no default at all: a default completes the
  // documented install with a password published in this repository, and POSTGRES_BIND lets an
  // operator put that database on a tailnet.
  //
  // Read from compose rather than from a list of known bad strings — a secret-shaped variable
  // is one whose name says so.
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
  // COUPLED: a token's shape is a contract between whatever mints one, whatever reads one
  // back, and whatever recognises one in a log. Raising the entropy at a minter while a reader
  // goes on matching the old length reports a correctly minted token as unmintable.
  //
  // Run rather than read, because both halves derive from one byte count that reading cannot
  // check.
  const out = execFileSync("node", ["--input-type=module", "-e",
    `import { mintPat, PAT_TOKEN } from ${JSON.stringify(join(root, "packages/contracts/dist/index.js"))};` +
    "const a = mintPat(), b = mintPat();" +
    "process.stdout.write(JSON.stringify({ a, b, ok: PAT_TOKEN.test(a), src: PAT_TOKEN.source }));"],
    { encoding: "utf8" });
  const minted = JSON.parse(out);
  const bad: string[] = [];
  if (!minted.ok) bad.push(`mintPat() produces ${minted.a}, which PAT_TOKEN does not match`);
  if (minted.a === minted.b) bad.push("mintPat() returned the same token twice — it is not random");

  // The shell minter cannot import, so its shape is compared instead. It mints the first token
  // on a host with no toolchain, so a shape that disagrees is a platform nobody can log in to
  // on the day it is installed.
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
