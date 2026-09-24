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
# Run it again and you get another token; existing ones keep working until revoked.
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

# No `scope`: authority is a fact about the person, read from their principal, never the token.
printf '%s\n' "insert into zz.pat (principal_id, token_hash, label)
   select id, :'hash', 'bootstrap — issue-first-pat.sh'
   from zz.principal where email = :'email';" \
  | docker compose exec -T postgres psql -U "${POSTGRES_USER:-zz}" -d "${POSTGRES_DB:-zz}" -q \
      -v email="$EMAIL" -v hash="$HASH" >/dev/null

cat <<MSG

Platform token for $EMAIL

  $TOKEN

SHOWN ONCE. Store it now — only its hash is kept, so it cannot be printed again.
Use it as: Authorization: Bearer $TOKEN

MSG
