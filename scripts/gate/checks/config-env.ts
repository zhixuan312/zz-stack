/**
 * The configuration surface: every switch an operator can set, that it is documented, that
 * its default is one value wherever it is spelled, and that something actually reads it.
 *
 * A variable nothing reads is a knob that does nothing, and an operator who sets it gets no
 * error — they get the old behaviour and a belief they have changed something.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { envNamesIn, firstOf, gateOwnSource, root, sourceFiles, trackedFiles, unbuilt } from "../read.ts";
import { check } from "../run.ts";

check("the documented defaults are the actual defaults", () => {
  // .env.example calls itself the whole configuration surface, and a check already says it
  // is COMPLETE. Nothing said it was ACCURATE, and it was not: it documented WEB_PORT=8080,
  // which was the previous front end's port — LibreChat listens on 3080, and compose
  // defaults to it — so an operator uncommenting the line would publish the browser
  // somewhere every other document says it is not. And WEB_BIND=0.0.0.0 against a compose
  // default of 127.0.0.1, which is the insecure direction and disagreed with its own three
  // sibling binds, all documented as loopback.
  //
  // A commented line in this file is read as "this is the default, here is where you change
  // it". When it is not the default, it is worse than an undocumented knob: the operator has
  // no reason to check.
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
    // Only where compose actually HAS a default. `${VAR:-}` is compose saying "pass this
    // through, I have no default" — and .env.example is then documenting either the CODE's
    // default (LOG_LEVEL's, say, and saying so is useful) or an
    // example value (PLATFORMS, RULEMILL_PEERS). Neither is a claim about compose, and treating
    // them as one made this check name six things that were all correct, which is how a
    // check gets switched off.
    if (!real || shown === "" || real.has(shown)) continue;
    if ([...real].every((v) => v === "")) continue;
    // A default that is itself an interpolation cannot be compared textually.
    if ([...real].some((v) => v.includes("${"))) continue;
    bad.push(`${name}: .env.example shows ${shown}, compose defaults to ${[...real].join("/")}`);
  }
  return bad.length ? bad.join("; ") : null;
});

check("the configuration surface is documented", () => {
  // deploy/.env.example calls itself "the whole configuration surface". It was not: the
  // three variables that decide what this deployment PUBLISHES — GATEWAY_BIND,
  // INTERNAL_BIND, POSTGRES_BIND — were introduced by the fix for zz-core being reachable
  // beyond loopback, and none of them was ever written down. So did OWU_BASE_MODEL, which
  // chooses the model every agent on the platform runs on.
  //
  // An operator reads this file to find out what they may set. A knob missing from it does
  // not read as undocumented; it reads as nonexistent.
  const envFile = join(root, "deploy/.env.example");
  const composeFile = join(root, "deploy/docker-compose.yml");
  if (!existsSync(envFile) || !existsSync(composeFile)) return "deploy/.env.example or docker-compose.yml is missing";
  const env = readFileSync(envFile, "utf8");
  const wanted = new Set<string>();
  for (const m of readFileSync(composeFile, "utf8").matchAll(/\$\{([A-Z][A-Z_0-9]*)/g)) wanted.add(m[1]);
  // Also what the SERVICES read at runtime, which compose does not always pass explicitly.
  const readsOf = (dirs: string[]): Set<string> => {
    const out = new Set<string>();
    for (const rel of sourceFiles(dirs, [".ts"])) {
      for (const v of envNamesIn(readFileSync(join(root, rel), "utf8"))) out.add(v);
    }
    return out;
  };
  for (const v of readsOf(["services"])) wanted.add(v);
  // AND WHAT THE DEPLOY SCRIPTS READ OUT OF deploy/.env ITSELF, which nothing here saw.
  // `env_get NAME` is a script asking THIS FILE for a value, so by construction the name is
  // deployment configuration and belongs in it — unlike `${BACKUP_DIR:-…}`, which is a knob
  // a person exports for one invocation and is excluded for the same reason packages/tools
  // is excluded below.
  //
  // COMPOSE_PROJECT_NAME is the one that was missing, and it is the expensive one: it
  // decides what every volume on the host is NAMED, backup.sh reads it from here because
  // compose offers volume names no other way, and its absence from this file is the shape
  // of the four nights of silent backup loss in August 2026. Every other name read this way
  // — POSTGRES_USER, POSTGRES_DB, SUPERADMIN_EMAIL — was already documented, which is what
  // made the one exception invisible.
  for (const rel of sourceFiles(["deploy"], [".sh"])) {
    for (const m of readFileSync(join(root, rel), "utf8").matchAll(/env_get ([A-Z][A-Z_0-9]*)/g)) {
      wanted.add(m[1]);
    }
  }
  // packages/tools is deliberately NOT walked. It holds the operator and testing commands,
  // and what they read — ZZ_PAT, LC_PASSWORD, SMOKE_TEAM, twenty more — is what a person
  // exports for one invocation, not what a DEPLOYMENT is configured with. This file's own
  // first line calls itself "the whole configuration surface", and a reader who found the
  // smoke harness's turn limit in it would reasonably conclude it belonged in a running
  // stack's .env. Each of those variables is documented where it is used: in the tool's own
  // usage line, which is what somebody about to run it actually reads.
  for (const d of readdirSync(join(root, "packages"), { withFileTypes: true })) {
    if (!d.isDirectory() || d.name === "tools") continue;
    for (const v of readsOf([`packages/${d.name}`])) wanted.add(v);
  }

  // A THIRD category, and the reason the two directions below are not simply inverses.
  // ZZ_TOKEN and ZZ_URL are read by the ops scripts and by nothing the deployment runs.
  // They do not belong in deploy/.env.example — that file is what compose reads, and an
  // admin token has no business in it — but a document naming them is not naming a dead
  // knob either. So they are excluded from both directions rather than forced into one.
  // Recursive, because scripts/probes/ is where two of them live and a flat readdir has
  // never seen it — so a variable read only by a probe counted as read by nothing, and would
  // have been reported as a phantom the moment somebody documented it.
  //
  // AND packages/tools, which is the other half of the same category and was missing. That
  // directory is excluded from `wanted` twenty lines up, deliberately and for the reason
  // written there — ZZ_PAT, LC_PASSWORD and ZZ_URL are what a person exports for one
  // invocation, not what a deployment is configured with. "Excluded from both directions" is
  // what the paragraph above promises; only one direction did it. So documenting the very
  // command deploy/README.md tells an operator to run first, with its variables named the way
  // this file names every other variable, reported three live knobs as dead ones.
  const opsVars = new Set([...readsOf(["scripts"]), ...readsOf(["packages/tools"])]);
  // OFFERED, not merely mentioned. This asked whether the NAME appears anywhere in the file,
  // so a variable named only in a paragraph explaining something else counted as documented —
  // and this file is full of such paragraphs. `# VAR=` is the form every knob here is offered
  // in, and it is what an operator uncomments; prose about a variable is not an offer of it.
  //
  // The rule used to be spelled twice. A second check, "the configuration surface documents
  // itself completely", asked the same question over compose's variables alone with exactly
  // this stricter test — two checks for one rule, differing on what counts as documented,
  // with the weaker one deciding for every variable the narrower one did not reach. Measured
  // before merging: the two agree on every variable in the tree today, so this changes what
  // is enforced and not what passes.
  const offered = (v: string): boolean => new RegExp(`^#?\\s*${v}=`, "m").test(env);
  const missing = [...wanted].filter((v) => !offered(v)).sort();

  // And the mirror, which is the same failure read from the other end. A knob missing from
  // the docs reads as nonexistent; a knob documented after the code stopped reading it
  // reads as available, and the operator who sets it gets the default with no complaint.
  // deploy/README.md offered `MCP_BIND` for months after the variable became GATEWAY_BIND,
  // so anyone following it left the gateway on loopback — where Caddy cannot reach it, and
  // the failure looks like a hang rather than a misconfiguration.
  //
  // Both sources are closed sets, which is what makes this safe to check: .env.example's
  // own assignments, and the backticked SHOUTING_CASE tokens in the deploy README, every
  // one of which is an environment variable today.
  const named = new Set<string>();
  for (const m of env.matchAll(/^#?\s*([A-Z][A-Z_0-9]{3,})=/gm)) named.add(m[1]);
  // A knob written WITHOUT the `=` was invisible to this mirror, and that is how a phantom
  // survived: `# RULEMILL_URL / RULEMILL_WEB_URL / RULEMILL_INGRESS_BASE / RULEMILL_PEERS` offered four
  // names in a format no other line in the file uses, and RULEMILL_URL was read by nothing,
  // anywhere — not this repo, not zz-blocks, not compose. It existed only on the line
  // offering it to operators. The three beside it were real, which is exactly what made it
  // invisible to a person too.
  //
  // Matched by FORMAT, not by word shape. A knob offered without `=` is offered as a list —
  // `# NAME / NAME / NAME` — or alone on its line, so the name is followed by a slash, a
  // comma, or nothing. Prose that opens with an emphasised word is followed by another
  // word: this file says `# LEAVE IT UNSET unless…` and `# WRITTEN BY THE RELEASE…`, and
  // neither offers a variable called LEAVE or WRITTEN.
  //
  // Anchoring to the start of the line also keeps mid-sentence mentions out. The example
  // that prompted it was a paragraph explaining that compose passed one variable into a
  // container under a different name — a real variable the front end read and we did not,
  // described rather than offered. Both that front end and that variable are gone; the rule
  // stands because prose about a variable is not the same as offering one, whatever the
  // variable happens to be.
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
  // An unset variable passed through compose as ${VAR:-} or exported bare in a shell arrives
  // as the EMPTY STRING, which is not nullish. So `process.env.X ?? "a default"` hands back
  // "" and the default never applies — and nothing errors, because "" is a value.
  //
  // @zz/mcp-http had it over its session TTL: Number("") is 0, so every MCP session would have
  // been reclaimed two minutes into any conversation. (That TTL is gone — the doors are
  // stateless now — but the shape it taught is why this check exists.) Four more sites had it.
  // LC_BASE="" pointed every smoke request at nothing; SMOKE_LANE_DIR="" made
  // join("", "s1.log") into "s1.log", so five lanes wrote their logs into whatever directory
  // the run started in; ZZ_GATEWAY="" and CHAIN_FLOW="" the same way.
  //
  // `?? ""` is fine and common — the default IS the empty string, so nothing is defeated.
  // What this refuses is `??` reaching for a value the empty string will never let it use.
  const bad: string[] = [];
  for (const f of sourceFiles(["services", "packages"], [".ts"])) {
    readFileSync(join(root, f), "utf8").split("\n").forEach((ln, i) => {
      if (/^\s*(\/\/|\*|\/\*)/.test(ln)) return;
      // Two shapes, one rule. An environment variable arrives empty from compose; a FLAG
      // arrives empty from `--since` written with no value, because parseArgs stores "" for a
      // flag it saw without one. `--since` alone became an empty psql interval, `--base`
      // alone made every URL relative. `?? null` and `?? ""` are fine: there the default IS
      // the absent value and nothing is defeated.
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
  // The install is `cp .env.example .env` then `docker compose up -d`, and compose marks
  // four variables `:?` — no default, hard failure, because a default for the front end's
  // session and credential secrets would be a published secret every deployment shared.
  // Right today, and nothing held it there: a fifth `:?` is one line, and the person who
  // finds out is whoever runs the two documented commands on a fresh host and gets
  // "CREDS_X is required" from a file they were told to copy as-is.
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

// AN ENVIRONMENT VARIABLE READ BY A COMPUTED NAME IS A VARIABLE NOTHING CAN FIND.
//
// Two guarantees in this repository are built on being able to see the name in the source:
// zz-tool forwards "the variables the tools read, and ONLY those", and .env.example is
// checked against what the services read. Both find them by looking for `process.env.NAME`.
//
// A helper that took the name as a string and read `process.env[name]` hid three of the
// smoke suite's settings from the first of those. Nothing failed — a run through zz-tool
// would simply have used every default, silently, including the parallelism and the turn
// budget, and the operator who exported them would have had no way to tell.
//
// The value is passed at the call site instead, so the name stays literal. That is a real
// cost of one argument, and it buys a property two checks depend on.
check("nothing reads the environment by a computed name", () => {
  const bad: string[] = [];
  for (const rel of sourceFiles(["services", "packages", "scripts"], [".ts"])) {
    if (gateOwnSource(rel)) continue;     // it has to spell the shape
    // lib/cli.ts IS the accessor: envRequired takes the name so that a missing variable
    // produces one sentence everywhere. The gate reads that shape too, so a name passed to
    // it is as findable as a dotted one.
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
  // zz-tool runs a tool inside the published image with `docker compose run -e NAME`, and
  // it forwards a NAMED LIST — deliberately, so an unset secret arrives unset rather than as
  // an empty string a tool would treat as supplied. The cost of that choice is that the list
  // has to keep up, and nothing was keeping it.
  //
  // chain-check reads CHAIN_FLOW and the list did not carry it, so on a deploy host
  // `CHAIN_FLOW=ops-flow zz-tool chain-check` silently checked a different flow. A wrong
  // answer that looks like a right one is the worst failure a checking tool can have.
  //
  // Computed through the IMPORT GRAPH, because a tool reads variables its helpers read: the
  // variable that went missing belonged to the entry file, but the next one may not.
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
  // `watch-results --health` pointed the stranded-event alert at a different gateway, and was
  // in no usage block, no README and no runbook. So did `--mongo`, `--container`,
  // `--compose-dir`, `--name` and `--require-closed`. Each is a real escape hatch with a
  // working default, which is exactly why nobody noticed: the default keeps the tool running
  // on the host it was written for, and the switch that makes it run anywhere else exists
  // only for a reader of the source.
  //
  // A tool's own doc comment is the whole of its documentation here — `zz-tool --help` prints
  // it — so a flag missing from it is a capability the platform has and cannot offer. Read
  // from the code that consumes the flag rather than from a list, so adding one and not
  // saying so fails here rather than being discovered by whoever needed it.
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

check("a configuration the operator wrote fails with a sentence", () => {
  // @zz/catalog settled this for a manifest, in manifestAt: "an operator who pointed
  // --manifest at the wrong file got a wall of JSON instead of a sentence". The same shape
  // was still open on the two things an operator supplies to the GATEWAY, and both are worse
  // places for it.
  //
  // PLATFORMS is parsed at module load, so a mistyped one took the container down with a
  // SyntaxError or a ZodError — read while the platform is not starting. credentials.json is
  // parsed on every credential operation and on every block call, so a truncated one dumped
  // through an MCP tool answer while nobody's key was being injected.
  //
  // Refusing is right in both cases and stays. What changed is that the refusal says which
  // field, and what to do.
  const bad: string[] = [];
  const sites = [
    ["services/gateway/src/blocks.ts", "PlatformMap", "the block registry"],
    ["services/gateway/src/credentials.ts", "CredentialStore", "the credential store"],
  ];
  for (const [rel, schema, what] of sites) {
    const src = readFileSync(join(root, rel), "utf8");
    const code = src.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
    if (new RegExp(`${schema}\\.parse\\(`).test(code)) {
      bad.push(`${rel} validates ${what} with ${schema}.parse, which throws a ZodError dump — ` +
               "safeParse and name the field, as @zz/catalog's manifestAt does");
    }
    if (!new RegExp(`${schema}\\.safeParse\\(`).test(code)) {
      bad.push(`${rel} no longer validates ${what} against ${schema} at all`);
    }
    // And the JSON parse beside it, which throws its own kind of dump.
    if (/JSON\.parse\([^)]*\)(?!\s*;?\s*\}?\s*catch)/.test(code) && !/catch/.test(code)) {
      bad.push(`${rel} parses JSON with nothing to catch a truncated file`);
    }
  }
  // AND THE SENTENCE ITSELF IS ONE SENTENCE. safeParse only avoids the dump; what an operator
  // reads is the line built from the issues, and that line was written out three times
  // byte-for-byte — the block registry, the credential store, and a flow manifest, in two
  // packages. @zz/catalog's comment is where the reasoning lives: "the schema is strict, so
  // the commonest failure is one mistyped key ... the line says which field, at which path."
  // A copy that stopped naming the path would leave one operator reading `Required` with
  // nothing saying of what, while the other two went on being helpful.
  const HOME = join("packages", "contracts", "src", "index.ts");
  for (const rel of sourceFiles(["services", "packages"], [".ts"])) {
    if (rel === HOME) continue;
    const lines = readFileSync(join(root, rel), "utf8").split("\n");
    lines.forEach((ln, i) => {
      if (/^\s*(\/\/|\*|\/\*)/.test(ln)) return;
      // The issue map, wherever the `.issues` and the `.map` fall across the wrap.
      if (!/\bi\.path\.join\(/.test(ln)) return;
      bad.push(`${rel}:${i + 1} builds the schema sentence by hand — whyNot() in @zz/contracts ` +
               "is that sentence, and it is the whole of what an operator gets back");
    });
  }
  // RUN it, because what is being held is the SHAPE of the sentence: the path, the fallback
  // for an error at the root, and one line however many issues there are.
  const nothingToRun = unbuilt();
  if (nothingToRun) return nothingToRun;
  const probe = `
    import { whyNot } from ${JSON.stringify(join(root, "packages/contracts/dist/index.js"))};
    const bad = [];
    const said = whyNot({ issues: [{ path: ["documents", 0, "name"], message: "Required" }] });
    if (said !== "documents.0.name: Required") bad.push("a nested field must be named by its whole path: " + said);
    const root_ = whyNot({ issues: [{ path: [], message: "Expected object" }] });
    if (root_ !== "(root): Expected object") bad.push("an error with no path must still say where it is: " + root_);
    const two = whyNot({ issues: [{ path: ["a"], message: "x" }, { path: ["b"], message: "y" }] });
    if (two !== "a: x; b: y") bad.push("every issue must appear, on one line: " + two);
    if (whyNot({ issues: [] }) !== "") bad.push("no issues must say nothing, not '(root)'");
    process.stdout.write(bad.join("; "));
  `;
  try {
    const out = execFileSync("node", ["--input-type=module", "-e", probe], { encoding: "utf8" });
    if (out.trim()) bad.push(out.trim());
  } catch (err) {
    const stderr = err && typeof err === "object" ? (err as Record<string, unknown>).stderr : undefined;
    bad.push(`the schema sentence could not be run: ${String(stderr ?? err).slice(-200)}`);
  }
  return bad.length ? bad.join("; ") : null;
});

check("an environment variable's default is one value, wherever it is spelled", () => {
  // Thirteen variables carry a default in more than one file, and the format refuses a single
  // declaration for most of them: compose cannot read release.ts, a bash script cannot import
  // a node constant, and one compose file names the same image on two services. "The platform
  // model is one name, however many places name it" already answers this shape — where one
  // declaration is impossible, the gate enforces one VALUE — and this is that rule applied to
  // every default rather than to the one somebody was bitten by.
  //
  // The sharp one was ZZ_DEPLOY_HOST. sync.sh used to refuse to rsync --delete onto production by
  // comparing HOST against `${ZZ_DEPLOY_HOST:-<host>}`, and its comment claims it "asks that
  // script's question rather than inventing a second answer to it". It is a second answer: the
  // variable is shared and the default is retyped. Change release.ts's and the refusal guards
  // the wrong host — and that script's own header records the accident it exists to prevent,
  // an rsync --delete that removed a host's four secrets, "recoverable only because every
  // container was still running with the values in its own environment".
  //
  // A DERIVATION IS NOT A SECOND SPELLING and must not be reported as one. build-image.sh
  // takes ZZ_VERSION from package.json with a sed, and issue-first-pat.sh reads POSTGRES_USER
  // out of the host's own .env — both are exactly right, and both sit beside a literal in
  // compose. Anything containing a `$` is derived and skipped; what is compared is literal
  // against literal.
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
          if (!value || value.includes("$")) return;         // derived, which is the right thing
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

/* AN ENVIRONMENT VARIABLE zz-tool CARRIES THAT NOTHING READS.
 *
 * `zz-tool` forwards a fixed list of names into the container it runs a tool in. The list
 * costs nothing to be wrong — a name for a tool that no longer exists is simply never set —
 * so thirteen of twenty-five had accumulated: ten SMOKE_* for a testing engine no longer in
 * the tree, three for a front end removed on 2026-09-10, and one for nothing at all.
 *
 * That is the same defect class as `the configuration surface is documented`, one layer out:
 * an operator reading the list cannot tell a live knob from a fossil, and neither can the
 * next person deciding whether it is safe to remove one.
 *
 * Source, not dist, and `process.env.NAME` or `env.NAME` either way — several tools read
 * through a destructured `env`. */
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
