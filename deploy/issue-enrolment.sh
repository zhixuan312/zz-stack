#!/usr/bin/env bash
# Mint an enrolment link so somebody can register their FIRST passkey, on a fresh deployment.
#
# The console's only door is a passkey, registering one needs an enrolment link, and minting a
# link from the console needs a superadmin session — which needs a passkey. This breaks that
# loop, as `issue-first-pat.sh` does for tokens.
#
# DELIBERATE: the operator's door, not the platform's. It runs on the host against the database,
# by someone who already has root. Every later link comes from the console.
#
#   ./deploy/issue-enrolment.sh                     # uses SUPERADMIN_EMAIL from deploy/.env
#   ./deploy/issue-enrolment.sh someone@example.com
#
# DELIBERATE: the principal must already exist; nothing here creates one. An authenticator
# asserts possession of a key, never an identity, so registration that could name its own
# account would let anyone with the URL mint one.
#
# DELIBERATE: the token is in the URL's fragment, after the `#`. A query string reaches Caddy's
# access log and browser history; a fragment is never sent to a server. The enrolment page reads
# it with script and posts it.
#
# Single use, and good for seven days. Run it again for another link; an unused one stays
# valid until it expires.
set -euo pipefail
cd "$(dirname "$0")"

# DELIBERATE: read the keys, never source the file. `. ./.env` runs it as shell, and a value
# with a space in it becomes a command.
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

# DELIBERATE: -v and stdin, not -c. psql interpolates variables while lexing its input, and a
# string given to -c reaches the server without that pass.
EXISTS="$(printf '%s\n' "select count(*) from zz.principal where email = :'email' and status = 'active';" \
  | docker compose exec -T postgres psql -U "${POSTGRES_USER:-zz}" -d "${POSTGRES_DB:-zz}" \
      -v email="$EMAIL" -tA)"
if [ "$(printf '%s' "$EXISTS" | tr -d '[:space:]')" != "1" ]; then
  echo "no active principal for $EMAIL." >&2
  echo "add them first — a passkey proves possession of a key, never who somebody is, so" >&2
  echo "enrolment can only ever attach one to an account that already exists." >&2
  exit 1
fi

# issued_by is null: the host's shell authorised this, not a signed-in person. Naming the
# person the link is for would read as self-issued.
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
