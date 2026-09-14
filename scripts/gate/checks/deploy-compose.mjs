/**
 * The compose files and the proxy in front of them: that they resolve, that they name images
 * this release builds, and that every address in them is one this deployment defines.
 *
 * A compose file is only exercised on the host. Every mistake here is found in production or
 * here, and there is nothing in between.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { between, gateOwnSource, readJson, root, sourceFiles, trackedFiles, withoutComments } from "../read.mjs";
import { check } from "../run.mjs";
import { ourDocs } from "../facts.mjs";

check("compose resolves with NO environment at all", () => {
  // This is the install experience: a person has the file and nothing else. It used to
  // REQUIRE ZZ_VERSION, which meant the one value nobody receiving the file could know
  // was also the one that stopped it starting. Now the versions are literals and an empty
  // environment must produce exactly the images this release publishes.
  const bare = { ...process.env };
  for (const k of ["ZZ_VERSION", "ZZ_BLOCKS_VERSION", "ZZ_IMAGE", "ZZ_BLOCKS_IMAGE"]) delete bare[k];
  // The front end's own secrets are the one thing this file REFUSES to default, because a
  // default here would be a published secret every deployment shared. They are supplied as
  // placeholders so this check still asks what it is about: that nobody has to know a
  // VERSION to start the stack. The install steps generate the real ones.
  //
  // READ OFF THE FILE, not listed here. Four were named, and a fifth `:?` added to compose
  // would have failed this check with a docker error about a variable — pointing at the gate
  // rather than at the variable, for a defect that is not in either.
  const composeText = readFileSync(join(root, "deploy/docker-compose.yml"), "utf8");
  for (const m of composeText.matchAll(/\$\{([A-Z_]+):\?/g)) bare[m[1]] ||= "gate-placeholder";
  const out = execFileSync("docker", ["compose", "-f", "docker-compose.yml", "config"], {
    cwd: join(root, "deploy"), env: bare, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  });
  const want = readJson("package.json").version;
  const images = [...out.matchAll(/image:\s*(\S*zz-stack:\S+)/g)].map((m) => m[1]);
  if (images.length === 0) return "no zz-stack image resolved";
  const wrong = [...new Set(images.filter((i) => !i.endsWith(`:${want}`)))];
  if (wrong.length) return `resolved to ${wrong.join(", ")} with no env, expected :${want}`;
  // The build override must still layer cleanly on top.
  execFileSync("docker", ["compose", "-f", "docker-compose.yml", "-f", "docker-compose.build.yml", "config"], {
    cwd: join(root, "deploy"), env: bare, stdio: ["ignore", "pipe", "pipe"],
  });
  return null;
});

check("the compose file names this release's images", () => {
  // The compose literal and the manifests are one release. They drifted apart silently
  // before this check existed: a bundle can look correct while every image tag in it
  // points at the previous version, and the first sign is a host running old code.
  const want = readJson("package.json").version;
  const txt = readFileSync(join(root, "deploy/docker-compose.yml"), "utf8");
  const tags = [...txt.matchAll(/ZZ_VERSION:-([^}]*)\}/g)].map((m) => m[1]);
  if (tags.length === 0) return "no ZZ_VERSION literal found";
  const wrong = [...new Set(tags.filter((t) => t !== want))];
  return wrong.length ? `compose names ${wrong.join(", ")}, package.json is ${want}` : null;
});

check("no compose service builds from a sibling repo in the images-only file", () => {
  // The whole point of the split: an installer needs no checkout of anything. A `build:`
  // surviving in the base file quietly reintroduces that requirement.
  const txt = readFileSync(join(root, "deploy/docker-compose.yml"), "utf8");
  return /^\s+build:/m.test(txt)
    ? "docker-compose.yml still contains a build: — it belongs in docker-compose.build.yml"
    : null;
});

check("no document tells someone to use a compose profile that does not exist", () => {
  // deploy/README named `--profile scale` in four places — the sizing table, the migration
  // note, and the cold-start record — after the profile was removed and Postgres and Redis
  // became ordinary services. An instruction naming a profile compose does not define runs
  // and silently starts nothing, which is the same failure the profile itself used to cause.
  // Comment lines stripped first: the compose file EXPLAINS that postgres used to sit
  // behind `profiles: [scale]`, and reading that sentence as a definition made this check
  // certify the very profile whose removal the sentence describes.
  const compose = readFileSync(join(root, "deploy/docker-compose.yml"), "utf8")
    .split("\n").filter((l) => !l.trim().startsWith("#")).join("\n");
  const defined = new Set([...compose.matchAll(/profiles:\s*\[([^\]]*)\]/g)]
    .flatMap((m) => m[1].split(",").map((x) => x.trim().replace(/["']/g, "")))
    .filter(Boolean));
  const bad = [];
  for (const rel of ourDocs()) {
    const txt = readFileSync(join(root, rel), "utf8");
    txt.split("\n").forEach((line, i) => {
      for (const m of line.matchAll(/--profile\s+([a-z0-9-]+)/g)) {
        // A line that says the profile is GONE is the fix, not the defect.
        if (/\bnow\b|used to|no longer|unconditional|removed/i.test(line)) continue;
        if (!defined.has(m[1])) bad.push(`${rel}:${i + 1} tells the reader to use --profile ${m[1]}`);
      }
    });
  }
  return bad.length ? bad.join("; ") : null;
});

check("Caddy proxies the port the compose file actually publishes", () => {
  // Two files have to agree about one number and nothing made them. The Caddyfile names the
  // gateway's upstream host:port; the compose file publishes it from CRED_PROXY_PORT. A
  // change to either alone produces a 502 with nothing in it to say which half moved.
  const caddy = readFileSync(join(root, "deploy/Caddyfile"), "utf8");
  const compose = readFileSync(join(root, "deploy/docker-compose.yml"), "utf8");
  const want = /CRED_PROXY_PORT:-(\d+)/.exec(compose)?.[1];
  if (!want) return "compose declares no CRED_PROXY_PORT default";
  // The api host's BLOCK, not the first mention of "api." — which is in the comment header,
  // and slicing from there found the browser host's proxy instead. This check reported the
  // browser port as a mismatch on its first run, which is the sort of thing that trains
  // people to ignore a gate.
  const block = /^api\.[^\s{]*\s*\{([\s\S]*?)^\}/m.exec(caddy)?.[1];
  if (!block) return "deploy/Caddyfile has no api host block";
  // THE FALLTHROUGH PROXY, not the first one in the block. The api host also carries ten
  // `handle /blocks/…` directives, each with a reverse_proxy of its own to a mock block on
  // :8761 or :8762, and they are written ABOVE the gateway because `handle` is terminal and
  // matching more specifically first is how the file reads. Taking the first match therefore
  // compared the gateway's declared port against bookit's and reported a mismatch that
  // was not one.
  //
  // This check passed for months only because deploy/Caddyfile was missing those handles
  // entirely while both live hosts ran them — so it was reading a file that did not describe
  // the deployment, and agreeing with it. Stripping the handle blocks leaves exactly the
  // unconditional proxy the compose port has to match.
  const fallthrough = block.replace(/handle[^\n]*\{[\s\S]*?\n\s*\}/g, "");
  const got = /reverse_proxy\s+\S*?:(\d+)/.exec(fallthrough)?.[1];
  if (!got) return "the api host in deploy/Caddyfile has no unconditional reverse_proxy upstream";
  return got === want ? null
    : `Caddy proxies :${got} but compose publishes the gateway on :${want}`;
});

check("only the authenticated door may be published beyond loopback", () => {
  // zz-core has no authentication of its own; the gateway is the door and /core/mcp is the
  // way in. Publishing zz-core on the same host address made that premise false — the port
  // answered tools/list to anyone, and document_read returned another team's approved spec to a
  // caller who supplied nothing but an email header. It happened because ONE variable,
  // MCP_BIND, governed both the gateway (which must be reachable) and the internal services
  // (which must not be), so widening one widened the other.
  const compose = readFileSync(join(root, "deploy/docker-compose.yml"), "utf8");
  // WHAT CADDY FRONTS, asked of the Caddyfile. The exemption named `cred-proxy` and
  // `librechat`, and its own comment claims to name roles — but `librechat` is a product, and
  // this exemption has already been stranded once by a front-end swap: it named the previous
  // product, so after the replacement it covered nothing, and a configuration the front end
  // is allowed would have been refused. The next swap does the same thing again.
  //
  // A service is a DOOR if Caddy reverse-proxies the port it publishes. That is the property
  // the rule is actually about — everything else is reachable only from the compose network
  // and has no business binding wider — and it survives the container being renamed.
  const fronted = new Set([...readFileSync(join(root, "deploy/Caddyfile"), "utf8")
    .matchAll(/reverse_proxy\s+\S*?:(\d+)/g)].map((m) => m[1]));
  if (fronted.size === 0) return "deploy/Caddyfile proxies nothing — no door can be identified";
  const bad = [];
  let svc = null;
  for (const raw of compose.split("\n")) {
    const m = /^ {2}([a-z0-9][a-z0-9_-]*):\s*$/.exec(raw);
    if (m) { svc = m[1]; continue; }
    if (!/^\s+ports:/.test(raw) && !/^\s+- "\$\{/.test(raw)) continue;
    const bind = /\$\{([A-Z_]+)(?::-|\})/.exec(raw)?.[1];
    if (!bind) continue;
    const published = /:\$\{[A-Z_]+:-(\d+)\}:/.exec(raw)?.[1];
    if (published && fronted.has(published)) continue;
    if (!/:-127\.0\.0\.1/.test(raw)) {
      bad.push(`${svc} publishes with ${bind} and no loopback default`);
    }
  }
  return bad.length ? bad.join("; ") : null;
});

check("a default install starts every service its defaults point at", () => {
  // `docker compose up -d` is the documented install and the release bundle's whole
  // premise. postgres and redis sat behind `profiles: [scale]`, so it started three
  // services whose default database URLs named a container it had just declined to start —
  // while the comment beside those URLs said "falls back to the postgres this compose
  // starts". The live host never noticed because it runs --profile scale and overrides
  // every URL in .env, so the tested path and the shipped path were different paths.
  //
  // "compose resolves with no environment" could not see this: `{}` and an unreachable
  // hostname both resolve perfectly. Resolving is not the same as working.
  const compose = readFileSync(join(root, "deploy/docker-compose.yml"), "utf8");
  const services = [];
  const profiled = new Set();
  let current = null;
  for (const line of compose.split("\n")) {
    const svc = /^ {2}([a-z0-9][a-z0-9_-]*):\s*$/.exec(line);
    if (svc) { current = svc[1]; services.push(current); continue; }
    if (current && /^\s+profiles:/.test(line)) profiled.add(current);
  }
  const bad = [];
  for (const m of compose.matchAll(/(?:@|:\/\/)([a-z0-9][a-z0-9_-]*):\d+/g)) {
    const host = m[1];
    if (!services.includes(host)) continue;      // an external host is not ours to start
    if (profiled.has(host)) {
      bad.push(`a default URL names '${host}', which only starts under a profile`);
    }
  }
  return bad.length ? [...new Set(bad)].join("; ") : null;
});

check("every build a compose file names points at a Dockerfile that exists", () => {
  // docker-compose.build.yml named `deploy/ts.Dockerfile`, which was not in the repo — so
  // the development build path the README documents failed on the first command, and had
  // for as long as the Dockerfile lived only in someone's shell history. A build that names
  // a missing file is not a stale comment; it is a broken instruction that reads as working.
  const bad = [];
  for (const name of ["deploy/docker-compose.yml", "deploy/docker-compose.build.yml"]) {
    const f = join(root, name);
    if (!existsSync(f)) continue;
    const text = readFileSync(f, "utf8");
    // context defaults to the compose file's directory; dockerfile is relative to context.
    const blocks = text.matchAll(/context:\s*(\S+)[\s\S]{0,120}?dockerfile:\s*(\S+)/g);
    for (const [, ctx, df] of blocks) {
      const base = join(root, "deploy", ctx);
      if (!existsSync(base)) continue;          // a sibling checkout, not ours to assert
      if (!existsSync(join(base, df))) bad.push(`${name} builds from ${ctx}/${df}, which does not exist`);
    }
  }
  return bad.length ? [...new Set(bad)].join("; ") : null;
});

check("the Caddyfile puts global options where Caddy accepts them", () => {
  // `timeouts` is a GLOBAL option — it belongs in the `{ servers { … } }` block at the top,
  // not inside a site. Inside one, Caddy rejects the whole file: "unrecognized directive:
  // timeouts". The reload then FAILS and the previous config stays loaded, which is the part
  // that hurts — on a host being migrated the old config still proxies to the front end the
  // release has just removed, so the public URL answers 502 while every container is healthy
  // and the deployment looks fine. That happened on production during this release.
  const f = join(root, "deploy/Caddyfile");
  if (!existsSync(f)) return null;
  const lines = readFileSync(f, "utf8").split("\n");
  const bad = [];
  let depth = 0, inSite = false;
  for (const [i, raw] of lines.entries()) {
    const line = raw.replace(/#.*$/, "");
    // A site block opens at column 0 with a name; the global options block opens with a bare
    // "{", which is how the two are told apart without parsing Caddy's grammar.
    if (depth === 0 && /^\S.*\{\s*$/.test(line) && !/^\{\s*$/.test(line)) inSite = true;
    if (inSite && depth >= 1 && /^\s*timeouts\s*\{/.test(line)) {
      bad.push(`timeouts at line ${i + 1} is inside a site block — it is a global option`);
    }
    depth += (line.match(/\{/g) || []).length - (line.match(/\}/g) || []).length;
    if (depth === 0) inSite = false;
  }
  return bad.length ? bad.join("; ") : null;
});

check("a compose container is addressed as a service, never by a name we built", () => {
  // Compose names a container `<project>-<service>-<n>`, and the PROJECT comes from
  // COMPOSE_PROJECT_NAME — which lives in deploy/.env, a file COMPOSE reads and a shell does
  // not. Production sets it to `zz` and UAT does not, so the same stack runs as `zz-*` on one
  // host and `deploy-*` on the other, and any name built here is right on at most one of them.
  //
  // It has now cost something on both sides of that. deploy/backup.sh derived the project
  // from its own directory, got `deploy` on production, and from 2026-08-26 ran `docker exec
  // deploy-postgres-1` into "No such container": four nights of 20-byte database dumps, no
  // artifacts archive and no credential archive, into a log nobody reads, while the script
  // exited non-zero to cron. release.mjs had the same literal pointing the other way,
  // `zz-postgres-1` under `|| true`, so its migration probe could only ever work against the
  // one host a release touches. reset-smoke-store.sh had `deploy-zz-core-1`, correct on UAT
  // and wrong on production, in a script whose whole job is deleting things.
  //
  // `docker compose exec <service>` from the compose directory asks compose to resolve its
  // own project, and then nothing here has to know the convention. A `docker run` against an
  // ad-hoc image is not this — it names no compose container — and stays allowed.
  const bad = [];
  for (const rel of [...sourceFiles(["deploy", "testing", "scripts"], [".sh", ".mjs"]),
                     ...sourceFiles(["packages", "services"], [".ts"])]) {
    if (gateOwnSource(rel)) continue;   // it has to spell the shape
    const src = readFileSync(join(root, rel), "utf8");
    // Names THIS FILE created itself, with `docker run --name <x>`. The paragraph above
    // already draws this line — an ad-hoc `docker run` names no compose container — and the
    // implementation did not, so a script that starts a throwaway postgres and then execs
    // into it under the name it just chose was told to ask compose about a service compose
    // has never heard of. A name the file did not create is still a name it guessed.
    const created = new Set(
      [...src.matchAll(/--name["'\s,]+([A-Za-z_$][\w$]*)/g)].map((m) => m[1])
        .filter((n) => n !== "true" && n !== "false"));
    src.split("\n").forEach((ln, i) => {
      if (/^\s*(#|\/\/|\*|\/\*)/.test(ln)) return;       // prose about the mistake is the record
      // BOTH SPELLINGS. This read only the shell form, so `run("docker", ["exec", "zz-postgres-1"
      // …])` — the argv form every .mjs here uses — walked straight past a rule written for
      // exactly that container name. A check that catches a mistake in one syntax and not the
      // other is worse than none, because the syntax it misses is the one people write.
      if (!/\bdocker exec\b/.test(ln) &&
          !/["'`]docker["'`]\s*,\s*\[\s*["'`]exec["'`]/.test(ln)) return;
      if ([...created].some((n) => new RegExp(`(\\$\\{\\s*${n}\\s*\\}|\\b${n}\\b)`).test(ln))) return;
      bad.push(`${rel}:${i + 1} runs \`docker exec\`, which needs a container NAME — the ` +
               "project prefix in one is set in deploy/.env, so a name built here is right on " +
               "at most one host. Use `docker compose exec -T <service>` from the compose directory");
    });
  }
  // And the one place a project name still has to be built — the volume names, which compose
  // offers no other way — must read it the way compose does rather than guess the directory.
  const backup = readFileSync(join(root, "deploy/backup.sh"), "utf8");
  const code = backup.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");
  if (!/PROJECT=.*COMPOSE_PROJECT_NAME/.test(code)) {
    bad.push("deploy/backup.sh no longer resolves COMPOSE_PROJECT_NAME — the volume names it " +
             "builds would be the directory's guess, which is what broke it");
  }
  if (!/env_get COMPOSE_PROJECT_NAME/.test(code)) {
    bad.push("deploy/backup.sh reads COMPOSE_PROJECT_NAME from the shell alone — cron does not " +
             "source deploy/.env, which is the only place production sets it");
  }
  return bad.join("\n");
});

check("a hostname with no dots is a service this compose file defines", () => {
  // `deploy/zz-tool` told an operator to pass `--gateway http://gateway:8000`. There has
  // never been a service called `gateway` — it is `cred-proxy` — so the address in the
  // header of the script that runs every day-2 command resolved to nothing, and the failure
  // arrives as a DNS error from a command deploy/README documents as the first thing to run
  // after installing.
  //
  // A DOTLESS HOST WITH A PORT is the whole rule, and it is exactly the shape a compose
  // service reference takes: on the compose network `librechat`, `cred-proxy` and `postgres`
  // resolve and nothing else does. A real address has a dot in it, and `localhost` and the
  // loopback literals are named below. Surveyed across every tracked file before this was
  // added: one occurrence, and it was the defect.
  const compose = readFileSync(join(root, "deploy/docker-compose.yml"), "utf8");
  const services = new Set(
    [...between(compose, "\nservices:", "\nvolumes:").text?.matchAll(/^  ([a-z][a-z0-9_-]*):$/gm) ?? []]
      .map((m) => m[1]));
  if (services.size < 3) return "cannot read the service list out of deploy/docker-compose.yml";
  const KNOWN = new Set([...services, "localhost", "host.docker.internal"]);
  const bad = [];
  for (const rel of trackedFiles() ?? []) {
    // The lockfile is npm's, full of registry URLs, and not ours to hold to this.
    if (rel === "package-lock.json") continue;
    // And the changelog, whose entries are the RECORD of what was wrong — the entry for this
    // very defect has to be able to say `http://gateway:8000`, or it cannot say what was
    // fixed. Migration 003 makes the same distinction about naming a retired front end:
    // history rather than description. Nothing in it is an instruction anybody follows.
    if (rel === "CHANGELOG.md") continue;
    let text;
    try { text = readFileSync(join(root, rel), "utf8"); } catch { continue; }
    // JS comments stripped, and ONLY those. A rule's own prose quotes the address it
    // refuses — this one names `http://gateway:8000` three lines up — so a check reading its
    // own file whole fails on itself. Nothing else is stripped, because the defect this was
    // written for lived in a `#` comment at the top of deploy/zz-tool: prose in a shell
    // header or a README is an instruction somebody follows, not a note about the code.
    if (/\.(ts|mjs|js)$/.test(rel)) text = withoutComments(text);
    for (const m of text.matchAll(/https?:\/\/([A-Za-z0-9][A-Za-z0-9._-]*):(\d+)/g)) {
      const host = m[1];
      if (host.includes(".") || KNOWN.has(host)) continue;
      const line = text.slice(0, m.index).split("\n").length;
      bad.push(`${rel}:${line} names ${m[0]} — \`${host}\` has no dots, so it can only be a ` +
               `compose service, and this file defines ${[...services].sort().join(", ")}`);
    }
  }
  return bad.join("\n");
});
