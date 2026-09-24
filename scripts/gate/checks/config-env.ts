/**
 * The configuration surface: every switch an operator can set, that it is documented, that
 * its default is one value wherever it is spelled, and that something actually reads it.
 *
 * A variable nothing reads is a knob that does nothing, and an operator who sets it gets no
 * error — they get the old behaviour and a belief they have changed something.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { envNamesIn, firstOf, gateOwnSource, root, sourceFiles, trackedFiles } from "../read.ts";
import { check } from "../run.ts";

check("the documented defaults are the actual defaults", () => {
  // A commented line in .env.example is read as "this is the default, here is where you change
  // it". When it disagrees with compose's own `${VAR:-default}`, the operator has no reason to
  // check.
  const env = readFileSync(join(root, "deploy/.env.example"), "utf8");
  const compose = readFileSync(join(root, "deploy/docker-compose.yml"), "utf8");
  const defaults = new Map();
  for (const m of compose.matchAll(/\$\{([A-Z_0-9]+):-([^}]*)\}/g)) {
    if (!defaults.has(m[1])) defaults.set(m[1], new Set());
    defaults.get(m[1]).add(m[2]);
  }
  const bad: string[] = [];
  for (const line of env.split("\n")) {
    const m = /^#\s*([A-Z_0-9]+)=(\S*)/.exec(line);
    if (!m) continue;
    const [, name, shown] = m;
    const real = defaults.get(name);
  // Only where compose actually has a default. `${VAR:-}` is compose saying "pass this through,
  // I have no default", and .env.example is then documenting either the code's default or an
  // example value — neither is a claim about compose.
    if (!real || shown === "" || real.has(shown)) continue;
    if ([...real].every((v) => v === "")) continue;
    // A default that is itself an interpolation cannot be compared textually.
    if ([...real].some((v) => v.includes("${"))) continue;
    bad.push(`${name}: .env.example shows ${shown}, compose defaults to ${[...real].join("/")}`);
  }
  return bad.length ? bad.join("; ") : null;
});

check("the configuration surface is documented", () => {
  // deploy/.env.example calls itself "the whole configuration surface". A knob missing from it
  // does not read as undocumented to an operator; it reads as nonexistent.
  const envFile = join(root, "deploy/.env.example");
  const composeFile = join(root, "deploy/docker-compose.yml");
  if (!existsSync(envFile) || !existsSync(composeFile)) return "deploy/.env.example or docker-compose.yml is missing";
  const env = readFileSync(envFile, "utf8");
  const wanted = new Set<string>();
  for (const m of readFileSync(composeFile, "utf8").matchAll(/\$\{([A-Z][A-Z_0-9]*)/g)) wanted.add(m[1]);
  // Also what the services read at runtime, which compose does not always pass explicitly.
  const readsOf = (dirs: string[]): Set<string> => {
    const out = new Set<string>();
    for (const rel of sourceFiles(dirs, [".ts"])) {
      for (const v of envNamesIn(readFileSync(join(root, rel), "utf8"))) out.add(v);
    }
    return out;
  };
  for (const v of readsOf(["services"])) wanted.add(v);
  // And what the deploy scripts read out of deploy/.env itself. `env_get NAME` is a script
  // asking this file for a value, so the name is deployment configuration by construction —
  // unlike `${BACKUP_DIR:-…}`, a knob a person exports for one invocation, excluded for the
  // same reason packages/tools is excluded below.
  //
  // COMPOSE_PROJECT_NAME arrives this way and is the expensive one: it decides what every
  // volume on the host is named, and backup.sh reads it from here because compose offers volume
  // names no other way.
  for (const rel of sourceFiles(["deploy"], [".sh"])) {
    for (const m of readFileSync(join(root, rel), "utf8").matchAll(/env_get ([A-Z][A-Z_0-9]*)/g)) {
      wanted.add(m[1]);
    }
  }
  // DELIBERATE: packages/tools is not walked. It holds the operator and testing commands, and
  // what they read — ZZ_PAT, ZZ_URL and the rest — is what a person exports
  // for one invocation, not what a deployment is configured with. Each is documented in its
  // tool's own usage line.
  for (const d of readdirSync(join(root, "packages"), { withFileTypes: true })) {
    if (!d.isDirectory() || d.name === "tools") continue;
    for (const v of readsOf([`packages/${d.name}`])) wanted.add(v);
  }

  // A third category, and the reason the two directions below are not inverses. ZZ_TOKEN and
  // ZZ_URL are read by the ops scripts and by nothing the deployment runs: they do not belong in
  // deploy/.env.example, which is what compose reads, but a document naming them is not naming a
  // dead knob either. So they are excluded from both directions rather than forced into one.
  //
  // Recursive, because scripts/probes/ holds two of them. packages/tools is the other half of
  // the same category, excluded from `wanted` above for the reason written there.
  const opsVars = new Set([...readsOf(["scripts"]), ...readsOf(["packages/tools"])]);
  // Offered, not merely mentioned. `# VAR=` is the form every knob here is offered in and what
  // an operator uncomments; prose about a variable is not an offer of it, and this file is full
  // of prose.
  const offered = (v: string): boolean => new RegExp(`^#?\\s*${v}=`, "m").test(env);
  const missing = [...wanted].filter((v) => !offered(v)).sort();

  // And the mirror: a knob documented after the code stopped reading it reads as available, and
  // the operator who sets it gets the default with no complaint.
  //
  // Both sources are closed sets, which is what makes this safe to check: .env.example's own
  // assignments, and the backticked SHOUTING_CASE tokens in the deploy README, every one of
  // which is an environment variable today.
  const named = new Set<string>();
  for (const m of env.matchAll(/^#?\s*([A-Z][A-Z_0-9]{3,})=/gm)) named.add(m[1]);
  // A knob written without the `=` is offered as a list — `# NAME / NAME / NAME` — or alone on
  // its line, so the name is followed by a slash, a comma, or nothing.
  //
  // Matched by that format rather than by word shape, and anchored to the start of the line.
  // Prose opening with an emphasised word is followed by another word: `# LEAVE IT UNSET
  // unless…` and `# WRITTEN BY THE RELEASE…` offer no variable called LEAVE or WRITTEN. A
  // mid-sentence mention of a variable is not an offer of it either.
  for (const line of env.split("\n")) {
    if (!/^#\s*[A-Z][A-Z_0-9]{3,}\s*(\/|,|$)/.test(line)) continue;
    for (const m of line.matchAll(/\b([A-Z][A-Z_0-9]{3,})\b/g)) named.add(m[1]);
  }
  const readme = join(root, "deploy/README.md");
  if (existsSync(readme)) {
    for (const m of readFileSync(readme, "utf8").matchAll(/`([A-Z][A-Z_0-9]{3,})`/g)) named.add(m[1]);
  }
  // Written by scripts/release.ts onto the host, never by an operator, so it is documented
  // rather than read from compose.
  named.delete("ZZ_PREVIOUS_VERSION");
  for (const v of opsVars) named.delete(v);
  const stale = [...named].filter((v) => !wanted.has(v)).sort();

  const bad: string[] = [];
  if (missing.length) bad.push(`not in deploy/.env.example: ${missing.join(", ")}`);
  if (stale.length) {
    bad.push(`documented but read by nothing: ${stale.join(", ")} — remove it, or make ` +
             "something read it; an operator cannot tell a dead knob from a live one");
  }
  return bad.length ? bad.join("; ") : null;
});

check("an environment default is not defeated by an empty variable", () => {
  // An unset variable passed through compose as ${VAR:-} or exported bare in a shell arrives as
  // the empty string, which is not nullish. So `process.env.X ?? "a default"` hands back "" and
  // the default never applies — and nothing errors, because "" is a value.
  //
  // `?? ""` and `?? null` are fine: there the default is the absent value and nothing is
  // defeated. What this refuses is `??` reaching for a value the empty string will never let it
  // use.
  const bad: string[] = [];
  for (const f of sourceFiles(["services", "packages"], [".ts"])) {
    readFileSync(join(root, f), "utf8").split("\n").forEach((ln, i) => {
      if (/^\s*(\/\/|\*|\/\*)/.test(ln)) return;
      // Two shapes, one rule. An environment variable arrives empty from compose; a flag
      // arrives empty from `--since` written with no value, because parseArgs stores "" for a
      // flag it saw without one.
      const empties: [RegExp, string][] = [
        [/process\.env\.([A-Z_][A-Z0-9_]*)\s*\?\?\s*(.+?)(?:[,;)]|$)/g, "an unset variable arrives as \"\""],
        [/flags\.get\(\s*"([a-z-]+)"\s*\)\s*\?\?\s*(.+?)(?:[,;)]|$)/g, "a flag written with no value arrives as \"\""],
      ];
      for (const [re, why] of empties) {
        for (const m of ln.matchAll(re)) {
          const fallback = m[2].trim();
          if (/^(""|''|null)$/.test(fallback)) continue;
          bad.push(`${f}:${i + 1} ${m[1]} ?? ${fallback.slice(0, 28)} — ${why}, so use ||`);
        }
      }
    });
  }
  return bad.length ? firstOf(bad) : null;
});

check("the documented install has every value it refuses to start without", () => {
  // The install is `cp .env.example .env` then `docker compose up -d`, and compose marks a secret
  // `:?` — no default, hard failure, because a default would be a published secret every
  // deployment shared. The person who finds a `:?` missing from .env.example is whoever runs the
  // two documented commands on a fresh host.
  const compose = readFileSync(join(root, "deploy/docker-compose.yml"), "utf8");
  const required = [...new Set([...compose.matchAll(/\$\{([A-Z_]+):\?/g)].map((m) => m[1]))];
  if (!required.length) return null;   // nothing is mandatory: not a failure, just nothing to check
  const examplePath = join(root, "deploy/.env.example");
  if (!existsSync(examplePath)) {
    return `deploy/.env.example does not exist, and the install says to copy it — ` +
           `compose requires ${required.join(", ")}`;
  }
  const example = readFileSync(examplePath, "utf8");
  // Assigned or commented, because a secret the person must generate is legitimately
  // commented out with the command that makes it. Absent entirely is the failure.
  const missing = required.filter((v) => !new RegExp(`^#?\\s*${v}=`, "m").test(example));
  return missing.length
    ? `${missing.join(", ")} — compose refuses to start without ${missing.length > 1 ? "these" : "this"}, ` +
      `and .env.example, which the install says to copy, does not mention ${missing.length > 1 ? "them" : "it"}`
    : null;
});

// An environment variable read by a computed name is a variable nothing can find.
//
// Two guarantees in this repository are built on seeing the name in the source: zz-tool forwards
// "the variables the tools read, and only those", and .env.example is checked against what the
// services read. Both find them by looking for `process.env.NAME`.
//
// DELIBERATE: the value is passed at the call site instead, so the name stays literal. That is a
// real cost of one argument, and it buys a property two checks depend on.
check("nothing reads the environment by a computed name", () => {
  const bad: string[] = [];
  for (const rel of sourceFiles(["services", "packages", "scripts"], [".ts"])) {
    if (gateOwnSource(rel)) continue;     // it has to spell the shape
    // lib/cli.ts is the accessor: envRequired takes the name so that a missing variable produces
    // one sentence everywhere, and the gate reads that shape too.
    if (rel === join("packages", "tools", "src", "lib", "cli.ts")) continue;
    readFileSync(join(root, rel), "utf8").split("\n").forEach((raw, i) => {
      const line = raw.trim();
      if (line.startsWith("//") || line.startsWith("*")) return;
      // `process.env[x]` — a lookup nothing can resolve by reading. A literal index
      // (`process.env["NAME"]`) is as findable as a dot, so it is allowed.
      if (/process\.env\[\s*[^"'\]]/.test(line)) {
        bad.push(`${rel}:${i + 1} reads the environment by a computed name — zz-tool and ` +
                 ".env.example are both checked by finding the literal name in the source");
      }
    });
  }
  return bad.join("\n");
});

check("zz-tool forwards every variable the tools it runs actually read", () => {
  // zz-tool runs a tool inside the published image with `docker compose run -e NAME`, and it
  // forwards a named list — deliberately, so an unset secret arrives unset rather than as an
  // empty string a tool would treat as supplied. The cost is that the list has to keep up.
  //
  // Computed through the import graph, because a tool reads the variables its helpers read.
  const toolSrc = join(root, "packages/tools/src");
  const wrapper = readFileSync(join(root, "deploy/zz-tool"), "utf8");
  const aliases = [...wrapper.matchAll(/\[[a-z-]+\]=([a-z-]+\/[a-z-]+)/g)].map((m) => m[1]);
  const listed = /for v in ([\s\S]*?); do/.exec(wrapper)?.[1] ?? "";
  const forwarded = new Set(listed.match(/[A-Z][A-Z_0-9]+/g) ?? []);
  const envsOf = (rel: string, seen: Set<string>): Set<string> => {
    const f = join(toolSrc, `${rel}.ts`);
    if (seen.has(rel) || !existsSync(f)) return new Set<string>();
    seen.add(rel);
    const src = readFileSync(f, "utf8");
    const out = new Set(envNamesIn(src));
    for (const m of src.matchAll(/from "(\.[^"]+)\.js"/g)) {
      const dir = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "";
      const parts = `${dir}/${m[1]}`.split("/").filter((p) => p && p !== ".");
      const stack: string[] = [];
      for (const p of parts) { if (p === "..") stack.pop(); else stack.push(p); }
      for (const e of envsOf(stack.join("/"), seen)) out.add(e);
    }
    return out;
  };
  const bad: string[] = [];
  for (const rel of aliases) {
    for (const v of [...envsOf(rel, new Set())].sort()) {
      if (!forwarded.has(v)) bad.push(`${rel} reads ${v}, which zz-tool does not forward`);
    }
  }
  return bad.length ? bad.join("; ") : null;
});

check("every switch a tool reads is one an operator can find", () => {
  // A tool's own doc comment is the whole of its documentation here — `zz-tool --help` prints it
  // — so a flag missing from it is a capability the platform has and cannot offer. Read from the
  // code that consumes the flag rather than from a list, so adding one and not saying so fails
  // here. Every such flag has a working default, which is what keeps it unnoticed.
  const bad: string[] = [];
  for (const rel of sourceFiles(["packages/tools/src"], [".ts"])) {
    const src = readFileSync(join(root, rel), "utf8");
    const doc = /^\s*\/\*\*([\s\S]*?)\*\//.exec(src)?.[1] ?? "";
    const read = [...src.matchAll(/flags\.(?:get|has)\("([^"]+)"\)/g)].map((m) => m[1]);
    const missing = [...new Set(read)].filter((k) => !doc.includes(`--${k}`));
    if (missing.length) bad.push(`${rel}: ${missing.join(", ")}`);
  }
  return bad.length ? `flags no usage block mentions — ${bad.join("; ")}` : null;
});

check("an environment variable's default is one value, wherever it is spelled", () => {
  // Several variables carry a default in more than one file, and the format refuses a single
  // declaration for most of them: compose cannot read release.ts, a bash script cannot import a
  // node constant, and one compose file names the same image on two services. Where one
  // declaration is impossible, the gate enforces one value.
  //
  // DELIBERATE: a derivation is not a second spelling and is not reported as one. build-image.sh
  // takes ZZ_VERSION from package.json with a sed, and issue-first-pat.sh reads POSTGRES_USER out
  // of the host's own .env. Anything containing a `$` is skipped; literal is compared against
  // literal.
  const PATTERNS = [
    /process\.env\.([A-Z][A-Z0-9_]*)\s*\|\|\s*"([^"]*)"/g,   // node
    /\$\{([A-Z][A-Z0-9_]*):-([^}]*)\}/g,                     // compose, and shell's own form
  ];
  const seen = new Map();     // NAME -> value -> [site]
  for (const rel of trackedFiles() ?? []) {
    if (!/\.(ts|mjs|sh|yml|yaml|example)$/.test(rel) && !/(Caddyfile|zz-tool)$/.test(rel)) continue;
    readFileSync(join(root, rel), "utf8").split("\n").forEach((ln, i) => {
      if (/^\s*(#|\/\/|\*|--)/.test(ln)) return;             // prose about a default is not one
      for (const re of PATTERNS) {
        for (const m of ln.matchAll(re)) {
          const [, name, value] = m;
          if (!value || value.includes("$")) return;         // derived, not a second spelling
          if (!seen.has(name)) seen.set(name, new Map());
          const byValue = seen.get(name);
          byValue.set(value, [...(byValue.get(value) ?? []), `${rel}:${i + 1}`]);
        }
      }
    });
  }
  if (seen.size < 5) return "no environment defaults found — the extraction is broken";
  const bad: string[] = [];
  for (const [name, byValue] of seen) {
    if (byValue.size < 2) continue;
    bad.push(`${name} defaults to ` +
      [...byValue].map(([v, at]) => `${JSON.stringify(v)} (${at.join(", ")})`).join(" and to ") +
      " — one variable, two answers, and nothing chooses between them");
  }
  return bad.join("\n");
});

/* An environment variable zz-tool carries that nothing reads.
 *
 * `zz-tool` forwards a fixed list of names into the container it runs a tool in. The list costs
 * nothing to be wrong — a name for a tool that no longer exists is simply never set — so fossils
 * accumulate, and an operator reading the list cannot tell a live knob from a dead one.
 *
 * Source, not dist, and `process.env.NAME` or `env.NAME` either way — several tools read through
 * a destructured `env`. */
check("every variable zz-tool forwards is read by a tool that exists", () => {
  const tool = readFileSync(join(root, "deploy/zz-tool"), "utf8");
  const block = /for v in ([\s\S]*?); do/.exec(tool);
  if (!block) return "deploy/zz-tool no longer has a passthrough list — this check reads nothing";
  const names = block[1].split(/[\s\\]+/).filter((n) => /^[A-Z][A-Z0-9_]*$/.test(n));
  if (!names.length) return "the passthrough list parsed to no names";
  // Relative dir names in, relative paths out — sourceFiles joins `root` itself at both ends.
  const src = sourceFiles(["packages", "services"], [".ts"])
    .filter((f) => f.includes("/src/"))
    .map((f) => readFileSync(join(root, f), "utf8")).join("\n");
  const dead = names.filter((n) => !src.includes(n));
  return dead.length
    ? `${dead.join(", ")} — forwarded by deploy/zz-tool and read by no tool in this repository`
    : null;
});
