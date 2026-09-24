/**
 * The compose files and the proxy in front of them: that they resolve, that they name images
 * this release builds, that every address in them is one this deployment defines, and that
 * the Dockerfile copies only paths this repository carries.
 *
 * A compose file is only exercised on the host. Every mistake here is found in production or
 * here, and there is nothing in between.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { asRecord, between, gateOwnSource, readJson, root, sourceFiles, trackedFiles, withoutComments } from "../read.ts";
import { check } from "../run.ts";
import { postgresService } from "../../release/postgres-service.ts";
import { ourDocs } from "../facts.ts";

check("compose resolves with NO environment at all", () => {
  // This is the install experience: a person has the file and nothing else. The versions are
  // literals, and an empty environment must produce exactly the images this release publishes.
  const bare = { ...process.env };
  for (const k of ["ZZ_VERSION", "ZZ_IMAGE"]) delete bare[k];
  // Secrets are the one thing compose refuses to default, because a default would be a published
  // secret every deployment shared. Placeholders keep this check asking its own question: that
  // nobody has to know a version to start the stack.
  //
  // Read off the file, not listed here — a new `:?` added to compose would otherwise fail this
  // check with a docker error pointing at the gate.
  const composeText = readFileSync(join(root, "deploy/docker-compose.yml"), "utf8");
  for (const m of composeText.matchAll(/\$\{([A-Z_]+):\?/g)) bare[m[1]] ||= "gate-placeholder";
  const out = execFileSync("docker", ["compose", "-f", "docker-compose.yml", "config"], {
    cwd: join(root, "deploy"), env: bare, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  });
  const want = String(asRecord(readJson("package.json"), "package.json").version);
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
  // The compose literal and the manifests are one release. A bundle can look correct while
  // every image tag in it points at the previous version, and the first sign is a host running
  // old code.
  const want = String(asRecord(readJson("package.json"), "package.json").version);
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
  // A document telling someone to start the stack with a profile that compose does not define
  // sends them to a command that silently starts nothing.
  //
  // Comment lines are stripped first: the compose file's own prose names a profile it no longer
  // defines, and reading that sentence as a definition would certify exactly that profile.
  const compose = readFileSync(join(root, "deploy/docker-compose.yml"), "utf8")
    .split("\n").filter((l) => !l.trim().startsWith("#")).join("\n");
  const defined = new Set([...compose.matchAll(/profiles:\s*\[([^\]]*)\]/g)]
    .flatMap((m) => m[1].split(",").map((x) => x.trim().replace(/["']/g, "")))
    .filter(Boolean));
  const bad: string[] = [];
  for (const rel of ourDocs()) {
    const txt = readFileSync(join(root, rel), "utf8");
    txt.split("\n").forEach((line, i) => {
      // DELIBERATE: `--profile` is not compose's word alone. `npm run tenant-info -- verify
      // --suite X --profile integration` selects a verification profile (scripts/tenant-info/
      // cli.ts: "integration" or "acceptance"), which cannot be defined in docker-compose.yml.
      // Narrow on purpose: it excuses that one CLI and nothing about compose, so a bare "start
      // it with --profile scale" is still caught.
      if (/\btenant-info\b/.test(line)) return;
      for (const m of line.matchAll(/--profile\s+([a-z0-9-]+)/g)) {
        // A line that says the profile is gone is the fix, not the defect.
        if (/\bnow\b|used to|no longer|unconditional|removed/i.test(line)) continue;
        if (!defined.has(m[1])) bad.push(`${rel}:${i + 1} tells the reader to use --profile ${m[1]}`);
      }
    });
  }
  return bad.length ? bad.join("; ") : null;
});

check("Caddy proxies the port the compose file actually publishes", () => {
  // Two files have to agree about one number. The Caddyfile names the gateway's upstream
  // host:port; the compose file publishes it from CRED_PROXY_PORT. A change to either alone
  // produces a 502 with nothing in it to say which half moved.
  const caddy = readFileSync(join(root, "deploy/Caddyfile"), "utf8");
  const compose = readFileSync(join(root, "deploy/docker-compose.yml"), "utf8");
  const want = /CRED_PROXY_PORT:-(\d+)/.exec(compose)?.[1];
  if (!want) return "compose declares no CRED_PROXY_PORT default";
  // The api host's block, not the first mention of "api." — which is in the comment header, and
  // slicing from there finds the browser host's proxy instead.
  const block = /^api\.[^\s{]*\s*\{([\s\S]*?)^\}/m.exec(caddy)?.[1];
  if (!block) return "deploy/Caddyfile has no api host block";
  // The fallthrough proxy, not the first one in the block: a `handle` directive carries its own
  // reverse_proxy, so stripping the handle blocks leaves the unconditional proxy the compose
  // port has to match.
  const fallthrough = block.replace(/handle[^\n]*\{[\s\S]*?\n\s*\}/g, "");
  const got = /reverse_proxy\s+\S*?:(\d+)/.exec(fallthrough)?.[1];
  if (!got) return "the api host in deploy/Caddyfile has no unconditional reverse_proxy upstream";
  return got === want ? null
    : `Caddy proxies :${got} but compose publishes the gateway on :${want}`;
});

check("only the authenticated door may be published beyond loopback", () => {
  // zz-core has no authentication of its own; the gateway is the door and /core/mcp is the way
  // in. Publishing zz-core on the same host address makes that premise false — the port answers
  // tools/list to anyone, and document_read returns another team's approved spec to a caller who
  // supplied nothing but an email header.
  const compose = readFileSync(join(root, "deploy/docker-compose.yml"), "utf8");
  // What Caddy fronts, asked of the Caddyfile rather than from a list of container names: a
  // service is a door if Caddy reverse-proxies the port it publishes. That is the property the
  // rule is about — everything else is reachable only from the compose network — and it survives
  // the container being renamed or the front end being swapped.
  const fronted = new Set([...readFileSync(join(root, "deploy/Caddyfile"), "utf8")
    .matchAll(/reverse_proxy\s+\S*?:(\d+)/g)].map((m) => m[1]));
  if (fronted.size === 0) return "deploy/Caddyfile proxies nothing — no door can be identified";
  const bad: string[] = [];
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
  // `docker compose up -d` is the documented install and the release bundle's whole premise, so
  // a service behind `profiles:` must not be named in another service's default URL: the stack
  // starts with a database URL pointing at a container it declined to start.
  //
  // "compose resolves with no environment" cannot see this — `{}` and an unreachable hostname
  // both resolve perfectly.
  const compose = readFileSync(join(root, "deploy/docker-compose.yml"), "utf8");
  const services = [];
  const profiled = new Set();
  let current = null;
  for (const line of compose.split("\n")) {
    const svc = /^ {2}([a-z0-9][a-z0-9_-]*):\s*$/.exec(line);
    if (svc) { current = svc[1]; services.push(current); continue; }
    if (current && /^\s+profiles:/.test(line)) profiled.add(current);
  }
  const bad: string[] = [];
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
  // A build that names a missing Dockerfile is a broken instruction that reads as working: the
  // development build path the README documents fails on its first command.
  const bad: string[] = [];
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
  // `timeouts` is a global option — it belongs in the `{ servers { … } }` block at the top, not
  // inside a site. Inside one, Caddy rejects the whole file ("unrecognized directive: timeouts"),
  // the reload fails and the previous config stays loaded, so the public URL answers 502 while
  // every container is healthy.
  const f = join(root, "deploy/Caddyfile");
  // Tracked, so its absence is a defect: deploy/Caddyfile is committed, and passing silently
  // when the file is gone is the one answer this check must not give.
  if (!existsSync(f)) return "deploy/Caddyfile does not exist — the reverse proxy a release "
                           + "reloads has no configuration in this repository";
  const lines = readFileSync(f, "utf8").split("\n");
  const bad: string[] = [];
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
  // Compose names a container `<project>-<service>-<n>`, and the project comes from
  // COMPOSE_PROJECT_NAME — which lives in deploy/.env, a file compose reads and a shell does
  // not, and is set per host — so any name built here is right on at most one host.
  //
  // `docker compose exec <service>` from the compose directory asks compose to resolve its own
  // project. A `docker run` against an ad-hoc image names no compose container and stays
  // allowed.
  const bad: string[] = [];
  for (const rel of [...sourceFiles(["deploy", "testing", "scripts"], [".sh", ".ts"]),
                     ...sourceFiles(["packages", "services"], [".ts"])]) {
    if (gateOwnSource(rel)) continue;   // it has to spell the shape
    const src = readFileSync(join(root, rel), "utf8");
    // Names this file created itself, with `docker run --name <x>`. A name the file did not
    // create is still a name it guessed.
    const created = new Set(
      [...src.matchAll(/--name["'\s,]+([A-Za-z_$][\w$]*)/g)].map((m) => m[1])
        .filter((n) => n !== "true" && n !== "false"));
    src.split("\n").forEach((ln, i) => {
      if (/^\s*(#|\/\/|\*|\/\*)/.test(ln)) return;       // prose about the mistake is the record
      // Both spellings: `docker exec …` in a shell and `run("docker", ["exec", …])` in argv
      // form, which is what every .mjs here uses.
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
  // A dotless host with a port is the whole rule, and it is exactly the shape a compose service
  // reference takes: on the compose network `zz-core`, `cred-proxy` and `postgres` resolve and
  // nothing else does. A real address has a dot in it, and `localhost` and the loopback literals
  // are named below. An address like `http://gateway:8000` names no service and resolves to
  // nothing, and the failure arrives as a DNS error.
  const compose = readFileSync(join(root, "deploy/docker-compose.yml"), "utf8");
  const services = new Set(
    [...between(compose, "\nservices:", "\nvolumes:").text?.matchAll(/^  ([a-z][a-z0-9_-]*):$/gm) ?? []]
      .map((m) => m[1]));
  if (services.size < 3) return "cannot read the service list out of deploy/docker-compose.yml";
  const KNOWN = new Set([...services, "localhost", "host.docker.internal"]);
  const bad: string[] = [];
  for (const rel of trackedFiles() ?? []) {
    // The lockfile is npm's, full of registry URLs, and not ours to hold to this.
    if (rel === "package-lock.json") continue;
    // And the changelog, whose entries are the record of what was wrong — the entry for this
    // defect has to be able to name the bad address. Nothing in it is an instruction anybody
    // follows.
    if (rel === "CHANGELOG.md") continue;
    let text;
    try { text = readFileSync(join(root, rel), "utf8"); } catch { continue; }
    // JS comments stripped, and only those. A rule's own prose quotes the address it refuses, so
    // a check reading its own file whole fails on itself. Prose in a shell header or a README is
    // an instruction somebody follows, not a note about the code, so it is not stripped.
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

check("every path the Dockerfile copies is a path that exists", () => {
  // The gate does not build, so a path in a COPY is a claim about the tree that nothing else
  // checks: `COPY assets /assets` against a tree with no assets/ passes tsc and every other
  // check, and fails in step 2 of the release with `failed to compute cache key`.
  //
  // DELIBERATE: build-stage copies are skipped. `--from=build` names a path inside a previous
  // stage's filesystem rather than in this checkout.
  const df = readFileSync(join(root, "Dockerfile"), "utf8");
  const bad: string[] = [];
  let copies = 0;
  for (const line of df.split("\n")) {
    const m = /^COPY\s+(?!--from=)(.+)$/.exec(line.trim());
    if (!m) continue;
    // The last word is the destination; everything before it is a source.
    const parts = m[1].split(/\s+/).filter(Boolean);
    for (const src of parts.slice(0, -1)) {
      if (src.startsWith("--")) continue;
      copies++;
      // A glob is a claim about a shape rather than about one path; it is matched by the builder
      // and cannot be resolved with existsSync.
      if (/[*?\[]/.test(src)) continue;
      if (!existsSync(join(root, src))) {
        bad.push(`Dockerfile copies ${src}, which this repository does not carry — the image ` +
                 `build fails on it, and the gate is where that should have been said`);
      }
    }
  }
  if (!copies) return "the Dockerfile has no COPY this check could read — it is measuring nothing";
  return bad.length ? bad.join("; ") : null;
});

check("the postgres image compose runs is the one the lock file pins", () => {
  // One source for the database image, because two release steps start it from here.
  // `scripts/release/postgres-service.ts` reads the `postgres` service out of compose so the
  // release rehearses against the image the deployment runs: the SQL check migrates an empty one
  // and PREPAREs every query in the tree against the schema it leaves behind, and the tool-chain
  // walk stands the whole platform on it. A hardcoded `postgres:16-alpine` cannot carry
  // pg_textsearch, which defers the schema on every release.
  //
  // COUPLED: compose and `deploy/postgres/versions.lock.json` are both descriptions of that
  // image, and the lock is what `checks/postgres-image-pinned.ts` validates the Dockerfile
  // against. Nothing else in this repository compares them.
  //
  // The tag is asserted to contain both versions rather than to equal a reconstructed string: a
  // registry path and a naming convention are not this check's business.
  const { image } = postgresService(root);
  const rel = "deploy/postgres/versions.lock.json";
  const lock = asRecord(readJson(rel), rel);
  const pg = String(lock.postgres_version ?? "");
  const pgts = String(lock.pg_textsearch_tag ?? "").replace(/^v/, "");
  if (!pg || !pgts) return `${rel} names no postgres_version or pg_textsearch_tag`;
  const tag = image.slice(image.lastIndexOf(":") + 1);
  if (tag === image) {
    return `compose runs \`${image}\`, which carries no tag — the release would rehearse against whatever :latest is that day`;
  }
  const wrong: string[] = [];
  if (!tag.includes(pg)) wrong.push(`the lock pins PostgreSQL ${pg}`);
  if (!tag.includes(pgts)) wrong.push(`the lock pins pg_textsearch v${pgts}`);
  if (wrong.length) {
    return `compose runs \`${image}\` but ${wrong.join(" and ")} — the release rehearses on one image `
      + "and the Dockerfile is validated against the other";
  }
});
