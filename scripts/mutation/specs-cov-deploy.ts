/**
 * Defects planted in what a deployment is made of: the compose files, the proxy in front of
 * them, the release and doctor scripts, the host's unattended jobs, and the one file that
 * tells an operator what they may set.
 *
 * NOTHING HERE IS EXERCISED BEFORE PRODUCTION. A compose file is only ever run on the host,
 * a backup only ever runs at 3am, and a Caddyfile is only ever parsed by the reload that
 * either works or leaves the previous config serving a URL nobody is watching. So the checks
 * these rows aim at are the last reader of these files before a person is, and a row that
 * SURVIVES here is a defect this repository would ship.
 *
 * TWO OF THESE ARE NOT INVENTED. `the Caddyfile puts global options where Caddy accepts
 * them` records a global option written inside a site block on production: Caddy rejected the
 * whole file, the reload failed, the previous config stayed loaded, and the public URL
 * answered 502 while every container read as healthy. That one is planted exactly as it
 * arrived. `an environment variable's default is one value, wherever it is spelled` records
 * ZZ_DEPLOY_HOST retyped between sync.sh and release.ts; sync.sh is gone, so the variable
 * that incident names has only one site left — the same shape is planted on ZZ_DEPLOY_PATH,
 * which is still spelled in two files with the same default.
 *
 * FIVE `replace` PAYLOADS ARE SEAMED, AND NONE OF THE `find` STRINGS IS. This file is a
 * tracked .ts under scripts/, so the gate sweeps it exactly as it sweeps the platform — and
 * it cannot tell a spec QUOTING a defect from the defect. Five payloads here were read as
 * real: a container addressed by a name we built, a dotless hostname, an environment read by
 * a computed name, and two variables that appeared to declare one default in the `find` and a
 * different one in the `replace` — which is precisely the disagreement that check exists to
 * catch, seen on a pair of quotations. So the payload is written as a concatenation and
 * `plant()` puts the string back together at run time.
 *
 * THE SEAM GOES IN `replace` AND NOWHERE ELSE. `replace` is written INTO the subject and
 * never has to match anything, so a seam there cannot cost an experiment. A seam in `find`
 * can: it would stop matching, land zero replacements, and come back indistinguishable from a
 * check that survived a real defect.
 *
 * VERSION LITERALS ARE NOT ANCHORED ON. `deploy/docker-compose.yml` carries this release's
 * version as a literal and the release rewrites it, so a spec that hunted for `0.62.4` would
 * land zero replacements on the next release and read exactly like a check that survived.
 * The anchors here stop at `${ZZ_VERSION:-` and at the service names above the image lines.
 */
import type { MutationSpec } from "./plant.ts";

export const COV_DEPLOY: readonly MutationSpec[] = [
  /* ── deploy/docker-compose.yml, deploy/Caddyfile and what they describe ──────────── */
  {
    check: "scripts/gate/checks/deploy-compose.ts",
    target: "compose resolves with NO environment at all",
    subject: "deploy/docker-compose.yml",
    find: "${ZZ_VERSION:-",
    replace: "${ZZ_VERSION:?",
    all: true,
    planted: "the image tag stops having a default and becomes a value compose REFUSES to " +
      "start without, so the one thing nobody receiving this file could possibly know is " +
      "also the one thing that stops `docker compose up -d` working",
  },
  {
    check: "scripts/gate/checks/deploy-compose.ts",
    target: "no compose service builds from a sibling repo in the images-only file",
    subject: "deploy/docker-compose.yml",
    find: "  cred-proxy:\n    image:",
    replace: "  cred-proxy:\n    build:\n      context: ..\n      dockerfile: Dockerfile\n    image:",
    planted: "the gateway builds from a checkout in the file that is supposed to need none, " +
      "so the installer who has only the bundle is quietly required to have the repository too",
  },
  {
    check: "scripts/gate/checks/deploy-compose.ts",
    target: "no document tells someone to use a compose profile that does not exist",
    subject: "deploy/README.md",
    find: "docker compose up -d --remove-orphans\n",
    replace: "docker compose --profile scale up -d --remove-orphans\n",
    planted: "the documented install tells a bundle recipient to select a compose profile " +
      "this deployment does not define, so the first command they run reads as a fact about " +
      "the stack and is not one — and the day a service does sit behind a profile, that same " +
      "instruction is how it silently fails to start",
  },
  {
    check: "scripts/gate/checks/deploy-compose.ts",
    target: "Caddy proxies the port the compose file actually publishes",
    subject: "deploy/Caddyfile",
    find: "    reverse_proxy 127.0.0.1:8764 {\n        flush_interval -1\n        transport http {",
    replace: "    reverse_proxy 127.0.0.1:8765 {\n        flush_interval -1\n        transport http {",
    planted: "the public api host proxies a port the compose file does not publish, so every " +
      "terminal client gets a 502 with nothing in it to say which of the two halves moved",
  },
  {
    check: "scripts/gate/checks/deploy-compose.ts",
    target: "only the authenticated door may be published beyond loopback",
    subject: "deploy/docker-compose.yml",
    find: 'ports: ["${INTERNAL_BIND:-127.0.0.1}:${ZZ_CORE_PORT:-8763}:8000"]',
    // SEAMED: unseamed, this line and the `find` above it read as one variable declaring
    // two different defaults, which is exactly what that check hunts. Rebuilt at plant time.
    replace: 'ports: ["${INTERNAL_' + 'BIND:-0.0.0.0}:${ZZ_CORE_PORT:-8763}:8000"]',
    planted: "zz-core is published on every interface by default, and zz-core has no " +
      "authentication of its own — the port answers tools/list to anyone who can reach it, " +
      "and document_read hands another team's approved spec to a caller who supplies only " +
      "an email header",
  },
  {
    check: "scripts/gate/checks/deploy-compose.ts",
    target: "a default install starts every service its defaults point at",
    subject: "deploy/docker-compose.yml",
    find: "  zz-core:\n    image:",
    replace: '  zz-core:\n    profiles: ["scale"]\n    image:',
    planted: "zz-core starts only under a profile while the gateway's default CORE_MCP_URL " +
      "still names it, so the documented `docker compose up -d` brings up a gateway pointing " +
      "at a container it has just declined to start",
  },
  {
    check: "scripts/gate/checks/deploy-compose.ts",
    target: "every build a compose file names points at a Dockerfile that exists",
    subject: "deploy/docker-compose.build.yml",
    find: "      dockerfile: Dockerfile",
    replace: "      dockerfile: deploy/ts.Dockerfile",
    all: true,
    planted: "the development build path names a Dockerfile this repository does not carry, " +
      "so the documented way to build from a checkout fails on its first command",
  },
  {
    check: "scripts/gate/checks/deploy-compose.ts",
    target: "the Caddyfile puts global options where Caddy accepts them",
    subject: "deploy/Caddyfile",
    find: "    request_body {\n        max_size 20MB\n    }",
    replace: "    timeouts {\n        read_body 5m\n    }\n\n    request_body {\n        max_size 20MB\n    }",
    planted: "a global option is written inside the api site block, which Caddy rejects " +
      "outright — the reload fails, the PREVIOUS config stays loaded, and the public URL " +
      "goes on serving whatever it served before while every container reads as healthy",
  },
  {
    check: "scripts/gate/checks/deploy-compose.ts",
    target: "a compose container is addressed as a service, never by a name we built",
    subject: "deploy/backup.sh",
    find: 'docker compose exec -T postgres pg_dump -U "$PG_USER" -d "$PG_DB" --clean --if-exists',
    // SEAMED: the gate sweeps this file for the very command shape this payload carries.
    replace: "docker " + 'exec "${PROJECT}-postgres-1" pg_dump -U "$PG_USER" -d "$PG_DB" --clean --if-exists',
    planted: "the nightly dump addresses the database by a container name this script builds " +
      "itself, and the project prefix in that name is set in deploy/.env — so the name is " +
      "right on at most one host and the backup dies into a log nobody reads on the other",
  },
  {
    check: "scripts/gate/checks/deploy-compose.ts",
    target: "a hostname with no dots is a service this compose file defines",
    subject: "deploy/zz-tool",
    find: "#   --gateway http://cred-proxy:8000",
    // SEAMED: the dotless host here is the defect being planted, not one this file commits.
    replace: "#   --gateway http://gate" + "way:8000",
    // REDACTED, BECAUSE THE REPORT IS A TRACKED FILE THIS REPOSITORY SWEEPS TOO. The payload
    // above is seamed so it never exists whole in this source — but `plant()` writes the
    // RECONSTRUCTED string into testing/mutation-report.json, and that file is swept like any
    // other. Seaming the spec without redacting the row just moves the finding from one
    // tracked file to another, which is what the gate caught. `redact` base64-encodes it in
    // the artifact, so the experiment stays exactly reproducible and the report is not the
    // disclosure.
    redact: true,
    planted: "the header of the script that runs every day-2 command tells an operator to " +
      "pass an address for a service that has never existed, so the first thing deploy/README " +
      "says to run after installing fails with a DNS error",
  },
  {
    check: "scripts/gate/checks/deploy-compose.ts",
    target: "every path the Dockerfile copies is a path that exists",
    subject: "Dockerfile",
    find: "COPY catalog /catalog\nCOPY skills /skills",
    replace: "COPY catalog /catalog\nCOPY skills /skills\nCOPY blocks /blocks",
    planted: "the image copies a directory this repository no longer carries, so the release " +
      "dies in the build step with `failed to compute cache key` — after the gate, after the " +
      "changelog, after the version bump",
  },
  {
    check: "scripts/gate/checks/deploy-compose.ts",
    target: "the postgres image compose runs is the one the lock file pins",
    subject: "deploy/postgres/versions.lock.json",
    find: '"pg_textsearch_tag": "v1.4.0"',
    replace: '"pg_textsearch_tag": "v1.5.0"',
    planted: "the lock pins a search-extension release the compose image does not carry, so " +
      "the release rehearses its migrations and its queries on one database image while the " +
      "Dockerfile is validated against another",
  },

  /* ── the release script, the doctor, and the documents a release writes ──────────── */
  {
    check: "scripts/gate/checks/deploy-release.ts",
    target: "the release verifies through the doctor's probes, not a second list",
    subject: "scripts/release/verify.ts",
    find: 'export const RELEASE_LAYERS = ["host", "doors", "contract", "data"];',
    replace: 'export const RELEASE_LAYERS = ["host", "doors", "contract", "database"];',
    planted: "the release verifies a diagnostic layer that does not exist, so the data probes " +
      "never run — and a layer that was never asked is indistinguishable, in the release's " +
      "own output, from a layer that agreed",
  },
  {
    check: "scripts/gate/checks/deploy-release.ts",
    target: "the doctor changes nothing",
    subject: "scripts/doctor/layers/host.ts",
    find: "docker compose ps --format '{{.Service}} {{.State}}' 2>/dev/null || true",
    replace: "docker compose up -d >/dev/null 2>&1; docker compose ps --format '{{.Service}} {{.State}}' 2>/dev/null || true",
    planted: "the doctor starts the stack before asking whether it is running, so the tool " +
      "somebody reaches for during an outage changes the outage it was called to describe",
  },
  {
    check: "scripts/gate/checks/deploy-release.ts",
    target: "the doctor runs every layer that is written",
    subject: "scripts/doctor.ts",
    find: 'import "./doctor/layers/data.ts";\n',
    replace: "",
    planted: "the data layer is written and never imported, so it does not run — and the " +
      "diagnosis it would have given is absent, which reads exactly like agreement",
  },
  {
    check: "scripts/gate/checks/deploy-release.ts",
    target: "the deploy stops what this release no longer defines",
    subject: "scripts/release.ts",
    find: "docker compose up -d --remove-orphans >/tmp/zz-up.log",
    replace: "docker compose up -d >/tmp/zz-up.log",
    planted: "the deploy leaves behind any container this release no longer defines, so a " +
      "removed service keeps running and keeps taking traffic while verification passes " +
      "against the new one",
  },
  {
    check: "scripts/gate/checks/deploy-release.ts",
    target: "the deploy bundle carries everything the install steps use",
    subject: "scripts/release/build.ts",
    find: "zz-tool backup.sh install-backup-cron.sh",
    replace: "zz-tool install-backup-cron.sh",
    planted: "the bundle stops carrying the backup script deploy/README tells an operator to " +
      "run, so a recipient has no way to back the platform up and nothing saying so",
  },
  {
    check: "scripts/gate/checks/deploy-release.ts",
    target: "a dry run cannot write git history",
    subject: "scripts/release.ts",
    find: "const bundle = buildAndSmoke({ dash, dashVersion });",
    replace: 'run("git", ["commit", "-am", "zz-stack " + version], { cwd: root });\n' +
      "const bundle = buildAndSmoke({ dash, dashVersion });",
    planted: "a rehearsal commits, so --dry-run — documented as \"verify locally, touch " +
      "nothing\" — leaves history behind and the second run starts from different state than " +
      "the first",
  },
  {
    check: "scripts/gate/checks/deploy-release.ts",
    target: "the deployed image can be rebuilt from this repo",
    subject: "Dockerfile",
    find: "COPY package.json package-lock.json ./\nCOPY --from=build /repo/packages ./packages",
    replace: "COPY package.json package-lock.json ./\nCOPY node_modules node_modules\n" +
      "COPY --from=build /repo/packages ./packages",
    planted: "the runtime image copies the host's installed dependencies instead of the ones " +
      "the build stage resolved from the lockfile, so what ships is whatever was lying in " +
      "somebody's working tree — the exact thing .dockerignore exists to prevent",
  },
  {
    check: "scripts/gate/checks/deploy-release.ts",
    target: "a failed rollback is reported, not thrown",
    subject: "scripts/release.ts",
    find: "${rolledBack ? `was rolled back to ${previous}`",
    replace: "${previous ? `was rolled back to ${previous}`",
    planted: "the outcome line claims a rollback whenever a previous version was RECORDED, " +
      "which is a different claim from the rollback having worked — so a release that is " +
      "still live on a bad version reports itself as rolled back",
  },
  {
    check: "scripts/gate/checks/deploy-release.ts",
    target: "a breaking change says what to do about it",
    subject: "CHANGELOG.md",
    find: "- **Two gate checks that enforced the old rule**, replaced by one that enforces the new one.\n" +
      "  The gate is 333 checks, from 334.",
    replace: "- **Breaking — two gate checks that enforced the old rule are gone.**",
    planted: "a breaking change ships as a bare heading with no remedy under it, so the one " +
      "part of the changelog a reader has to ACT on tells them something broke and nothing " +
      "about what to do",
  },
  {
    check: "scripts/gate/checks/deploy-release.ts",
    target: "the release script can read every fact it parses out of source",
    subject: "packages/mcp-client/src/index.ts",
    find: "PROTOCOL",
    replace: "MCP_PROTOCOL",
    all: true,
    planted: "the constant the release parses out of the client is renamed, so the reader " +
      "matches nothing and every path that builds an initialize frame dies on it — including " +
      "the verification in step 5, which is what decides whether to roll back",
  },
  {
    check: "scripts/gate/checks/deploy-release.ts",
    target: "a release groups each kind of change once",
    subject: "CHANGELOG.md",
    find: "### Changed\n\n- **A transient timeout costs latency, not a subject.**",
    replace: "### Added\n\n- **A transient timeout costs latency, not a subject.**",
    planted: "one release opens a second `### Added` below the first, so a reader deciding " +
      "whether to upgrade finds a list that looks complete, stops, and never sees the rest",
  },

  /* ── what runs on the host between releases ──────────────────────────────────────── */
  {
    check: "scripts/gate/checks/deploy-ops.ts",
    target: "every archived volume is verified against a range, not one snapshot",
    subject: "deploy/backup.sh",
    find: 'check_archive "$ARTIFACT_VOLUME" "$art_file" "$art_before"',
    replace: 'check_archive "$ARTIFACT_VOLUME" "$art_file"',
    planted: "the artifacts archive is verified against one snapshot of a volume the platform " +
      "is still writing to, so any document written mid-archive fails the whole backup on an " +
      "archive that is perfectly correct",
  },
  {
    check: "scripts/gate/checks/deploy-ops.ts",
    target: "a deployment's database is asked for its own role and name",
    subject: "scripts/doctor/layers/data.ts",
    find: 'psql -U "$U" -d "$D"',
    replace: "psql -U zz -d zz",
    planted: "the doctor types a role and a database name into a deployment that configures " +
      "both, so on any host that sets POSTGRES_USER or POSTGRES_DB every data probe fails — " +
      "and those probes are what a release reads before deciding whether to roll back",
  },
  {
    check: "scripts/gate/checks/deploy-ops.ts",
    target: "a backup run that fails leaves nothing that reads as a backup",
    subject: "deploy/backup.sh",
    find: 'FILES=("$db_file" "$art_file" "$cred_file" "$conf_file")',
    replace: 'FILES=("$db_file" "$art_file" "$cred_file")',
    planted: "the configuration archive — the one carrying deploy/.env, without which the " +
      "database dump cannot be opened — falls out of the list the cleanup and the prune both " +
      "walk, so a failed run leaves it sitting in the directory as the newest backup and a " +
      "successful one never ages it out",
  },
  {
    check: "scripts/gate/checks/deploy-ops.ts",
    target: "a script the bundle ships needs nothing the host does not have",
    subject: "deploy/install-backup-cron.sh",
    find: '"17 3 * * * $REPO/deploy/backup.sh >> /var/log/zz-backup.log 2>&1 $TAG"',
    replace: '"17 3 * * * cd $REPO && npm run backup >> /var/log/zz-backup.log 2>&1 $TAG"',
    planted: "the nightly job reaches for a toolchain a deploy host does not have — it " +
      "receives the bundle and docker and nothing else — so the backup never runs at all, " +
      "every night, from a cron entry that installed cleanly",
  },

  /* ── the configuration surface ───────────────────────────────────────────────────── */
  {
    check: "scripts/gate/checks/config-env.ts",
    target: "the configuration surface is documented",
    subject: "deploy/.env.example",
    find: "# POSTGRES_BIND=127.0.0.1",
    replace: "#",
    planted: "the knob that decides whether the platform database is reachable beyond " +
      "loopback stops being offered in the file that calls itself the whole configuration " +
      "surface, and an operator reading it takes an absent knob for one that does not exist",
  },
  {
    check: "scripts/gate/checks/config-env.ts",
    target: "an environment default is not defeated by an empty variable",
    subject: "services/zz-core/src/eval/judge-model.ts",
    find: '(process.env.ZZ_JUDGE_THINKING || "on")',
    replace: '(process.env.ZZ_JUDGE_THINKING ?? "on")',
    planted: "a variable set to nothing in .env arrives as the empty string rather than as " +
      "absent, so the default never applies and the judge silently stops deliberating — " +
      "recorded under the same judge name as every round that did",
  },
  {
    check: "scripts/gate/checks/config-env.ts",
    target: "the documented install has every value it refuses to start without",
    subject: "deploy/.env.example",
    find: "\nPOSTGRES_PASSWORD=\n",
    replace: "\n",
    planted: "compose refuses to start without the database password and the file the install " +
      "says to copy no longer mentions it, so the two documented commands on a fresh host end " +
      "in an error about a value nobody was told to supply",
  },
  {
    check: "scripts/gate/checks/config-env.ts",
    target: "nothing reads the environment by a computed name",
    subject: "scripts/deployment.ts",
    find: 'export const PLATFORM = process.env.ZZ_PLATFORM || "linux/amd64";',
    // SEAMED: the computed lookup here is the planted defect, quoted rather than committed.
    replace: "const envOr = (name: string, fallback: string): string => process.env" +
      "[name] || fallback;\n" +
      'export const PLATFORM = envOr("ZZ_PLATFORM", "linux/amd64");',
    planted: "a variable is read through a helper that takes its name as a string, so the " +
      "name no longer appears in the source — and both guarantees built on finding it there, " +
      "zz-tool's passthrough list and .env.example's completeness, go quietly blind to it",
  },
  {
    check: "scripts/gate/checks/config-env.ts",
    target: "zz-tool forwards every variable the tools it runs actually read",
    subject: "deploy/zz-tool",
    find: "ZZ_BLOCK_KEY CHAIN_FLOW \\",
    replace: "ZZ_BLOCK_KEY \\",
    planted: "chain-check's flow selector stops being forwarded into the container, so " +
      "`CHAIN_FLOW=ops-flow zz-tool chain-check` silently checks a different flow — a wrong " +
      "answer that looks exactly like a right one",
  },
  {
    check: "scripts/gate/checks/config-env.ts",
    target: "every switch a tool reads is one an operator can find",
    subject: "packages/tools/src/ops/watch-results.ts",
    find: 'flags.get("health")',
    replace: 'flags.get("health-url")',
    planted: "the monitor reads a flag spelled one way and documents it spelled another, so " +
      "an operator following the usage line points the stranded-event alert at nothing and " +
      "gets the hard-coded default without a word",
  },
  {
    check: "scripts/gate/checks/config-env.ts",
    target: "an environment variable's default is one value, wherever it is spelled",
    subject: "deploy/provision-host.sh",
    find: 'REMOTE="${ZZ_DEPLOY_PATH:-/root/zz-parent/zz-stack}"',
    // SEAMED: same pairing as the bind above. Rebuilt whole at plant time.
    replace: 'REMOTE="${ZZ_DEPLOY_' + 'PATH:-/root/zz-stack}"',
    planted: "one variable gets two answers: provisioning lays the deployment down in one " +
      "directory and every release reaches for another, and nothing in this repository " +
      "chooses between them",
  },
  {
    check: "scripts/gate/checks/config-env.ts",
    target: "every variable zz-tool forwards is read by a tool that exists",
    subject: "deploy/zz-tool",
    find: "JUDGE_MODEL TEAM_DB_URL; do",
    replace: "JUDGE_MODEL TEAM_DB_URL LIBRECHAT_MONGO_URL; do",
    planted: "the passthrough list carries a variable belonging to a front end this platform " +
      "removed, so an operator reading the list cannot tell a live knob from a fossil — and " +
      "neither can the next person deciding whether it is safe to delete one",
  },
];
