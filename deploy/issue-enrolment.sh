#!/usr/bin/env bash
# Mint an enrolment link so somebody can register their FIRST passkey, on a fresh deployment.
#
# Why this exists: the console's only door is a passkey, and a passkey has to be registered
# before it opens anything. Registering one needs an enrolment link, and minting a link from
# the console needs a superadmin session — which needs a passkey. That is a closed loop with
# no door into it, exactly like the one `issue-first-pat.sh` exists to open.
#
# So this is that door, and it is deliberately the operator's rather than the platform's: it
# runs on the host, against the database directly, by someone who already has root. Every
# LATER link comes from the console, where a superadmin mints it for somebody.
#
#   ./deploy/issue-enrolment.sh                     # uses SUPERADMIN_EMAIL from deploy/.env
#   ./deploy/issue-enrolment.sh someone@example.com
#
# The principal must already exist. Nothing here creates one — that is the whole point of the
# design: an authenticator asserts possession of a key, never an identity, so if registration
# could name its own account then anyone with the URL could mint themselves one.
#
# THE TOKEN IS IN THE FRAGMENT of the printed URL, after the `#`. A query string is written to
# Caddy's access log and to the browser's history; a fragment reaches neither, because it is
# never sent to a server. The enrolment page reads it with script and posts it.
#
# Single use, and good for seven days. Run it again for another link; an unused one stays
# valid until it expires.
set -euo pipefail
cd "$(dirname "$0")"

# READ the keys we need; do not SOURCE the file. `. ./.env` runs it as shell, so any value
# with a space in it becomes a command — see issue-first-pat.sh's own note on the run that
# died with "Stack: command not found" while minting the first token on a fresh host.
env_get() {
  [ -f .env ] || return 0
  sed -n "s/^$1=//p" .env | tail -1 | sed -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'\$//"
}
SUPERADMIN_EMAIL="${SUPERADMIN_EMAIL:-$(env_get SUPERADMIN_EMAIL)}"
POSTGRES_USER="${POSTGRES_USER:-$(env_get POSTGRES_USER)}"
POSTGRES_DB="${POSTGRES_DB:-$(env_get POSTGRES_DB)}"
CONSOLE_PUBLIC_URL="${CONSOLE_PUBLIC_URL:-$(env_get CONSOLE_PUBLIC_URL)}"

EMAIL="${1:-${SUPERADMIN_EMAIL:-}}"
if [ -z "$EMAIL" ]; then
  echo "no email: pass one as an argument, or set SUPERADMIN_EMAIL in deploy/.env" >&2
  exit 1
fi
EMAIL="$(printf '%s' "$EMAIL" | tr '[:upper:]' '[:lower:]')"

if [ -z "$CONSOLE_PUBLIC_URL" ]; then
  echo "no CONSOLE_PUBLIC_URL in deploy/.env — the gateway needs it to be a relying party," >&2
  echo "and this script needs it to print a link anyone can open." >&2
  exit 1
fi
CONSOLE_PUBLIC_URL="${CONSOLE_PUBLIC_URL%/}"

# base64url, because that is what the gateway mints and what `zze_` prefixes there.
TOKEN="zze_$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=')"
HASH="$(printf '%s' "$TOKEN" | openssl dgst -sha256 | awk '{print $NF}')"

# -v and stdin, not -c and interpolation. psql performs variable interpolation while lexing
# its input, and a string given to -c is handed to the server without that pass — see
# issue-first-pat.sh, where that combination died with «syntax error at or near ":"».
EXISTS="$(printf '%s\n' "select count(*) from zz.principal where email = :'email' and status = 'active';" \
  | docker compose exec -T postgres psql -U "${POSTGRES_USER:-zz}" -d "${POSTGRES_DB:-zz}" \
      -v email="$EMAIL" -tA)"
if [ "$(printf '%s' "$EXISTS" | tr -d '[:space:]')" != "1" ]; then
  echo "no active principal for $EMAIL." >&2
  echo "add them first — a passkey proves possession of a key, never who somebody is, so" >&2
  echo "enrolment can only ever attach one to an account that already exists." >&2
  exit 1
fi

# issued_by is null: nobody signed in authorised this, the host's shell did. The column says
# so rather than naming the person the link is for, which would read as self-issued.
printf '%s\n' "insert into zz.passkey_enrolment (token_hash, principal_id, issued_by, expires_at)
   select :'hash', id, null, now() + interval '7 days'
   from zz.principal where email = :'email';" \
  | docker compose exec -T postgres psql -U "${POSTGRES_USER:-zz}" -d "${POSTGRES_DB:-zz}" -q \
      -v email="$EMAIL" -v hash="$HASH" >/dev/null

cat <<MSG

Enrolment link for $EMAIL

  ${CONSOLE_PUBLIC_URL}/enrol#t=${TOKEN}

Open it on the device whose passkey you want to use. Single use, good for seven days.
SHOWN ONCE — only its hash is kept, so it cannot be printed again.

MSG
