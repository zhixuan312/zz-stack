# Deploying the ZZ stack on a server

Prereqs: any Linux host with Docker and the compose plugin. **No repository, no toolchain,
no build** — an installer runs published images.

This platform serves **MCP to terminal clients**. It has no browser front end of its own: the
one browser surface is the admin console, which is a separate app with its own compose file,
and `<gateway>/app` for reading a team's knowledge. A previous front end was removed on
2026-09-10 and nothing here provisions accounts into one.

## Standing up a host from scratch

**A new host never receives this repository.** It receives the release bundle, the same
artifact an outside installer gets, and it runs published images — which is what the second
line of this file promises and what a second path here used to quietly break. The sync script
— deleted on 2026-09-11, and named in the changelog rather than here because naming it here is
telling you to go and run it — rsynced the working tree onto a host and built the images
there, leaving 1.8M and 22M of stale source on the one host we have. **There is one way the
platform reaches a server.**

Each step is its own decision, which is why each is its own script rather than one that makes
them all for you:

```bash
./deploy/provision-host.sh <ssh-host>   # docker, caddy, jq — and nothing else
```

Then give it the stack. This is the **Installing a release** section below, run against the new
host — not a different procedure, the same one:

```bash
scp dist/release/zz-stack-deploy-<version>.tgz <ssh-host>:/tmp/
ssh <ssh-host> 'mkdir -p /root/zz-parent/zz-stack/deploy &&
  tar xzf /tmp/zz-stack-deploy-<version>.tgz -C /root/zz-parent/zz-stack/deploy'
```

Fill `deploy/.env` on the host from the `.env.example` the bundle just delivered (see **The
keys** below), then:

```bash
./deploy/install-caddy.sh <ssh-host>    # HTTPS, once .env names the public URL
ssh <ssh-host> 'cd /root/zz-parent/zz-stack/deploy && docker compose up -d --remove-orphans'
```

`provision-host.sh` deliberately does not touch secrets, DNS, the Caddyfile or data. A
provisioning script that quietly makes decisions is worse than one that stops.

**Afterwards, that host is a released deployment like any other.** Point the release at it
with `ZZ_HOST=<ssh-host>` and it will scp each new bundle there itself — `scripts/release.ts`
does exactly the two commands above, at the version it is shipping.

**Never copy `deploy/Caddyfile` onto a host by hand.** It is a template: `install-caddy.sh`
substitutes the hostname and the gateway's real upstream, then refuses the install if either
literal survived the substitution. Copying it verbatim installs site blocks for somebody
else's hostname, which is a certificate that resolves and a platform that does not answer.

## Installing a release

The release bundle carries the compose file, `.env.example`, `zz-tool`, `backup.sh` and
`install-backup-cron.sh`. The compose file names the exact images of that release, so the
bundle is self-describing: reading it tells you which version you are about to run.

```bash
tar xzf zz-stack-deploy-<version>.tgz
cp .env.example .env            # fill in the keys below
docker compose up -d --remove-orphans
```

Then mint the one token that opens the platform:

```bash
./issue-first-pat.sh --email you@example.com
```

**Why a script mints the first token.** Every other way to get one needs one already —
`pat_issue` and `pat_issue` both resolve the caller before they will mint
anything. A fresh install can therefore authenticate nobody, which is a closed loop with no
door into it. `issue-first-pat.sh` is that door, and it is deliberately the operator's: it
runs on the host, against the database, by someone who already has root.

### The keys

Everything else — database URLs, image versions, ports — has a working default. The database
defaults to the Postgres this compose starts, because we run it and no installer can supply a
better value than we already know.

| | |
|---|---|
| `LLM_BASE_URL` + `LLM_API_KEY` | any OpenAI-compatible endpoint and a key for it |
| `GATEWAY_PUBLIC_URL` | this platform's public gateway address. **Every client package generated here embeds it**, so a wrong value hands out unreachable URLs to everyone who installs. It must be reachable from a laptop, not just from inside the network |
| `SUPERADMIN_EMAIL` | the platform superadmin — who can create teams, issue tokens and install flows |
| `BOOTSTRAP_TEAM` | the first team, created on boot with the superadmin as its admin. **Set it.** A deployment with a superadmin and no team looks perfectly healthy and is not: every document lands in a per-user store instead of the team's, and nobody notices until they go looking for it. **It is re-seeded on EVERY boot** — `on conflict do nothing`, so it is a no-op once the team exists, but a team named here cannot be deleted: it returns on the next restart. Point it at a team you actually use, and change it rather than deleting what it names |
| `POSTGRES_PASSWORD` | the platform database's own password |
| `CONSOLE_PUBLIC_URL` | only if you run the console — see below |

### The admin console, if you want it (optional)

A browser app showing every team's work in one place. It is **not in this bundle** and not in
this compose file: it has its own compose file, from the `zz-stack-dashboard` repository, at
its own path on the host. It is still released by `zz-stack/scripts/release.ts` — one
release, two components — so what runs there is a published image
(`ghcr.io/zhixuan312/zz-stack-dashboard`) and the only file the host holds is that compose
file. It binds to loopback, and Caddy splits ONE host on path: `/auth/*` and `/api/console/*`
to this gateway, everything else to the app. Same origin, so the sign-in cookie is
first-party; split them and it becomes a third-party cookie every browser is entitled to drop.

Set `CONSOLE_PUBLIC_URL` and the door opens; leave it unset and `/auth/*` answers 503 and says
why, rather than guessing a relying party from the Host header.

| | |
|---|---|
| `CONSOLE_PUBLIC_URL` | where a BROWSER reaches the console — and, from it, the whole relying party: its hostname is the RP ID and its origin the expected origin. Never derived from the Host header, because the one value worth forging is exactly the one that must not come from the request. **A registered passkey is bound to the hostname in here**; change it and everybody re-enrols |

Nobody registers themselves. Create the principal, then mint a one-time enrolment link — the
first one from the host, because before anyone has a passkey there is no superadmin session
to mint it with:

```bash
./issue-enrolment.sh someone@example.com      # from deploy/, where the bundle unpacks
```

Later ones come from the console, or from `enrolment_issue` on `/manage/mcp`.

## The doors

| Path | Who |
|---|---|
| `/core/mcp` | everyone — the platform's own tools |
| `/manage/mcp` | everyone; **the tool list is your role**, so a tool you cannot execute is a tool you are not offered |

There is no package route. A person's client package is the public shelf in this
repository, which their client clones from GitHub; `/pkg/<client>.tgz` went with Codex and
Hermes on 2026-09-12 and answers 404.

## Developing against a checkout

Nothing below is needed to install a release.

Released images are on ghcr and an installer pulls them; during development you want your own
edits live instead. That is what the build override is for:

```bash
docker compose -f docker-compose.yml -f docker-compose.build.yml up -d --build
```

It builds both images from source and mounts `../catalog` and `../skills` over the copies
inside them, so editing a skill takes effect on the next call. An installer needs no checkout
at all, which is the point of the split.

## Notes

- **One service is published beyond loopback and it is the gateway.** zz-core and Postgres
  bind to 127.0.0.1 (`INTERNAL_BIND` / `POSTGRES_BIND`); reach them through an SSH tunnel. The
  gateway takes `GATEWAY_BIND`, and it is the one service that may widen, because Caddy has to
  reach it and it authenticates every request itself. These were ONE variable, so widening the
  gateway's reach silently published zz-core beside it — and zz-core has no authentication of
  its own: that port answered `tools/list` to anyone, and `document_read` returned another team's
  approved spec to a caller who supplied nothing but an email header.
- The catalog and the platform skills ship INSIDE the image, so a released version describes
  the method as well as the code. They are live-editable only under the build override above.
- **Air-gapped install:** `docker save ghcr.io/zhixuan312/zz-stack:<version> | gzip >
  zz-images.tgz`, ship it, `docker load` on the server, then use the bundle as above.

## Day-2 operations

Every command below runs from `deploy/`, which is what the release bundle unpacks to and where
`docker compose` finds its file. `zz-tool` runs the platform's own tools inside the image
already on the host — no toolchain to install, and no docker socket mounted.

**Credentials** — people store their own key by asking the **ZZ Access** agent. For onboarding
several at once:

```bash
export ZZ_TOKEN=<an admin-scope platform token>
export ZZ_URL=$GATEWAY_PUBLIC_URL      # this deployment's gateway; there is no default
./zz-tool set-credential --csv keys.csv                    # Email,Platform,Key
./zz-tool set-credential --csv keys.csv --platform casebox      # Email,Key rows
./zz-tool set-credential --email alice@x --platform casebox --delete
```

A member-scope token is refused: acting on another person's behalf is exactly what a terminal
token is scoped down to prevent. There is no default block, for the reason there is no default
gateway: a key stored against the wrong one authenticates as nobody and still prints OK.
Three-column rows carry their own; anything else needs `--platform`.

## Installing a flow for a team

Flows are installed per team over MCP, not from this directory:

```bash
./zz-tool call /manage/mcp flow_install '{"team":"<slug>","flow":"sdlc-flow"}'
```

There is one door. `/manage/mcp` serves everybody and registers the tools the caller's role can
execute, so `flow_install` is there if your token administers a team and absent if it does not
— `whoami` on the same door says which. `catalog_list` says what is available to install. What
a person then gets is a client package.

## Interfaces

**Claude Code** installs from the public shelf in this repository. No token is needed to read
it — every tool behind these plugins is a door at the gateway, and the door still asks:

```bash
claude plugin marketplace add zhixuan312/zz-stack
claude plugin install zz-core@zz-stack # the baseline; then take what you want
```

Then the token, which is what the tools actually authenticate with:

```bash
(umask 077; mkdir -p ~/.zz) && chmod 700 ~/.zz
(umask 077; printf '%s' "$ZZ_TOKEN" > ~/.zz/token) && chmod 600 ~/.zz/token
```

The shelf is build output, rendered by `npm run build:marketplace` from the catalog and
committed here; the gate fails a release that forgot to rebuild it. It lists the platform
baseline, the access tools and one plugin per flow — everything the catalog holds, rather
than a set chosen per person, because what a person may actually *use* is decided by their
role and their team's installs at the door, not by what their shelf lists.

`client_setup` on `/manage/mcp` prints these steps with the person's own values.

Claude Code is the only client. Codex and Hermes were served until 2026-09-12 — nobody ran
either, and `/pkg/<client>.tgz` went with them.

People authenticate with a PAT (`pat_issue`), and get the same identity, the same
team knowledge store and the same gates — enforced in zz-core, so no client can bypass them.

The team's knowledge is readable in a browser at `<gateway>/app` (PAT login): documents,
search, and the sources behind each one. Writing on a document there attaches a SOURCE to the
initiative, through zz-core like every other write — there is no separate comment record,
because a comment and a source were the same thing wearing two names and only one of them was
part of the document's history.

## Sizing

Inference is on the provider `LLM_BASE_URL` names — the server never runs a model.

| Concurrent pipeline users | Droplet |
|---|---|
| 1–5 | Basic 4GB / 2vCPU (~$24/mo) |
| ~20 | Basic 8GB / 4vCPU (~$48/mo) |
| 40+ | 16GB / 8vCPU (~$96/mo), headroom for concurrent long agent turns |

OS: Ubuntu 24.04 LTS or the DO "Docker" marketplace image. Postgres always runs — the platform
keeps its own data there — and is an ordinary service in this compose, started by
`docker compose up -d` like everything else.

The one caveat the server cannot fix: **the model provider's rate limits.** Concurrent
reasoning streams share the one `LLM_API_KEY`; raise the plan or rotate several keys.

## Per-user platform credentials (cred-proxy)

Every user brings their OWN API key per building-block platform. The `cred-proxy` service is a
credential gateway: the caller's own token carries the caller's identity on every MCP call; the
gateway injects THAT user's stored key and streams the call through to the real endpoint.
Solves both problems at once: no shared key, and each person works in their own platform app.

- Users self-serve **in chat with the ZZ Access agent**: "store my CaseBox key: ..." →
  `credential_set` (per-user, masked, never echoed back). That agent carries the access
  tools and no other does, so a delivery agent asked for a key sends them there rather than
  collecting one it cannot store.
- Operators batch-import or revoke with `./zz-tool set-credential`, as above.
- No key stored → the block's call returns a guidance error naming ZZ Access.
- Keys live in the `cred-data` volume only, written through one serialised, atomic path in the
  gateway. Nothing else may open that file.

## HTTPS

Caddy + nip.io — no domain purchase needed. `deploy/Caddyfile` is a template and
`install-caddy.sh` is the only thing that should apply it; see **Standing up a host** above. It
serves two hostnames on one machine: the bare host for the console, and `api.<host>` for the
gateway, which is how Claude Code reaches this platform from a laptop.

Caddy fetches and renews Let's Encrypt automatically and proxies WebSockets. Swap the nip.io
host for a real domain in the Caddyfile whenever one exists.

## Connecting to the DB from your laptop

Postgres is published on the SERVER's loopback only (127.0.0.1:5432, `POSTGRES_BIND`) — reach
it through an SSH tunnel; nothing is exposed to the internet:

```bash
ssh -f -N -L 5433:127.0.0.1:5432 zz-stack   # background tunnel
psql "postgresql://zz:<POSTGRES_PASSWORD from deploy/.env>@localhost:5433/zz"
pkill -f '5433:127.0.0.1:5432'              # close the tunnel
```

GUI clients (TablePlus/DBeaver/DataGrip): use their built-in SSH-tunnel tab — SSH host
`zz-stack`, then DB host 127.0.0.1:5432, user `zz`, db `zz`.

## Backups

`deploy/backup.sh` writes **three** things into `$BACKUP_DIR` (default `/root/zz-backups`),
because losing any one of them loses something no restart brings back:

| | |
|---|---|
| the `zz` schema | identity truth — principals, teams, PATs, flow installs, grants, events |
| the artifacts volume | every team's documents and knowledge |
| the credential volume | each person's own building-block API keys |

The third is the one nobody can reconstruct: the platform can be reinstalled and documents
re-indexed, but a person's key to another platform exists only in that volume and in whatever
they wrote it down on.

It checks the dump actually contains the identity tables, reads every archive back and matches
it against the volume it came from, and prunes past `$KEEP_DAYS` (14). A run that fails deletes
what it had written, so a partial set never sits in the directory looking like the newest
backup. `--verify` also restores into a throwaway database and counts principals.

`deploy/install-backup-cron.sh` installs a nightly run and a weekly verify. It replaces its own
tagged lines and touches nothing else, so re-running it is how you pick up a change — including
removing a job that no longer exists.

**The default directory is on the same host as the data — copy it off-host.**
`zz-credentials-*.tar.gz` holds those API keys in plaintext, exactly as the volume does; treat
a copy of it as you would the keys themselves.
