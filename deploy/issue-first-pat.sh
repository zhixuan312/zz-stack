#!/usr/bin/env bash
# Mint the first platform token, for the superadmin, on a fresh deployment.
#
# Every other way to get a token needs one already: `pat_issue` resolves the caller before it
# will mint anything, and a passkey is enrolled by a superadmin. On a fresh install nobody has
# authenticated, so the platform has no first identity — a closed loop with no door into it.
#
# DELIBERATE: this door is the operator's rather than the platform's: it
# runs on the host, against the database directly, by someone who already has root. It
# mints exactly one token, for the superadmin the deployment was configured with, and
# prints it once.
#
#   ./deploy/issue-first-pat.sh                     # uses SUPERADMIN_EMAIL from deploy/.env
#   ./deploy/issue-first-pat.sh someone@example.com
#
# Run it again and the token it wrote last time is revoked and replaced: the label names one
# purpose, so one deployment has one bootstrap token. The notice below says when that happened.
set -euo pipefail
cd "$(dirname "$0")"

# DELIBERATE: read the keys we need; do not source the file. `. ./.env` runs it as shell, so
# any value with a space in it becomes a command — and this runs at the one moment there is no
# other way in.
env_get() {
  [ -f .env ] || return 0
  sed -n "s/^$1=//p" .env | tail -1 | sed -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'\$//"
}
SUPERADMIN_EMAIL="${SUPERADMIN_EMAIL:-$(env_get SUPERADMIN_EMAIL)}"
POSTGRES_USER="${POSTGRES_USER:-$(env_get POSTGRES_USER)}"
POSTGRES_DB="${POSTGRES_DB:-$(env_get POSTGRES_DB)}"

EMAIL="${1:-${SUPERADMIN_EMAIL:-}}"
if [ -z "$EMAIL" ]; then
  echo "no email: pass one as an argument, or set SUPERADMIN_EMAIL in deploy/.env" >&2
  exit 1
fi
EMAIL="$(printf '%s' "$EMAIL" | tr '[:upper:]' '[:lower:]')"

TOKEN="zzp_$(openssl rand -hex 24)"
HASH="$(printf '%s' "$TOKEN" | openssl dgst -sha256 | awk '{print $NF}')"

# The principal must already exist — the gateway seeds it from SUPERADMIN_EMAIL on boot.
# Minting a token for an unknown email reads as success and fails at the first call.
#
# DELIBERATE: `-v`, not interpolation, so an address with a quote cannot break the statement.
# COUPLED: through stdin, not `-c`. psql interpolates `:'email'` while lexing its input, and a
# string given to `-c` reaches the server without that pass.
EXISTS="$(printf '%s\n' "select count(*) from zz.principal where email = :'email' and status = 'active';" \
  | docker compose exec -T postgres psql -U "${POSTGRES_USER:-zz}" -d "${POSTGRES_DB:-zz}" \
      -v email="$EMAIL" -tA)"
if [ "$(printf '%s' "$EXISTS" | tr -d '[:space:]')" != "1" ]; then
  echo "no active principal for $EMAIL." >&2
  echo "set SUPERADMIN_EMAIL in deploy/.env and restart cred-proxy so the gateway seeds it." >&2
  exit 1
fi

# The label names one purpose, so the token a previous run wrote under it is revoked before this
# one is written — revoked, never deleted, because its `last_used_at` is how anyone finds out
# whether production was still using it. The revoke and the insert go in one transaction, so a
# failed insert cannot leave the deployment with no bootstrap token at all.
#
# DELIBERATE: `-tA` without `-q`, because the UPDATE's own command tag is how the notice below
# learns whether anything was revoked. `ON_ERROR_STOP` aborts before the COMMIT.
#
# DELIBERATE: the `awk` reads psql's answer to the end before it prints anything. An `awk` that
# `exit`s on its first match closes the pipe while psql is still writing its command tags, and
# psql then dies of SIGPIPE — which `set -o pipefail` turns into a failed command substitution
# and, under `set -e`, into the script stopping HERE. The transaction has already committed by
# then, so the deployment is left with a fresh token and any earlier bootstrap token revoked, and
# the operator sees neither the token nor a reason. Reproduced locally: the same pipeline
# returned psql=255 on one run in five. `END` is what reads to EOF.
#
# No `scope`: authority is a fact about the person, read from their principal, never the token.
REVOKED="$(printf '%s\n' \
  "begin;
   update zz.pat set revoked_at = now()
     where principal_id = (select id from zz.principal where email = :'email')
       and label = 'bootstrap — issue-first-pat.sh'
       and revoked_at is null;
   insert into zz.pat (principal_id, token_hash, label)
     select id, :'hash', 'bootstrap — issue-first-pat.sh'
     from zz.principal where email = :'email';
   commit;" \
  | docker compose exec -T postgres psql -U "${POSTGRES_USER:-zz}" -d "${POSTGRES_DB:-zz}" \
      -tA -v ON_ERROR_STOP=1 -v email="$EMAIL" -v hash="$HASH" \
  | awk '/^UPDATE [0-9]+$/ { n = $2 } END { print n + 0 }')"

if [ "${REVOKED:-0}" -gt 0 ]; then
  REPLACED_NOTE="
REVOKED ${REVOKED} previous bootstrap token(s) carrying this label. Anything that was still
using one has stopped working."
else
  REPLACED_NOTE=""
fi

cat <<MSG

Platform token for $EMAIL

  $TOKEN
$REPLACED_NOTE

SHOWN ONCE. Store it now — only its hash is kept, so it cannot be printed again.
Use it as: Authorization: Bearer $TOKEN

MSG
