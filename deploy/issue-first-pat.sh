#!/usr/bin/env bash
# Mint the FIRST platform token, for the superadmin, on a fresh deployment.
#
# Why this exists: every other way to get a token needs one already. `pat_issue` and
# `pat_issue` both resolve the caller before they will mint anything, and the
# identity a browser carries is forwarded by the front end for somebody it has already
# authenticated. On a fresh install nobody has been, so there is no first identity and the
# platform could authenticate nobody — a closed loop with no door into it.
#
# That has held across two front ends. It was written when Open WebUI forwarded the headers
# and reads the same with LibreChat, which keeps each person's platform token encrypted in
# its own store: the token has to exist before the front end can hold one.
#
# This is that door, and it is deliberately the operator's rather than the platform's: it
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

# READ the keys we need; do not SOURCE the file.
#
# `. ./.env` runs it as shell, so any value with a space in it becomes a command. Production
# had `WEBUI_NAME=ZZ Stack` — a perfectly ordinary line in a perfectly ordinary env file —
# and this script died with "Stack: command not found" while minting the first token on a
# fresh host, which is the one moment there is no other way in.
#
# A .env is configuration, not a program, and nothing here needs it to be one.
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
# Minting a token for an unknown email would hand out access to nobody, which reads as
# success and fails at the first call.
# -v, not interpolation. This runs as root on the host and the threat model is thin, but an
# address with a quote in it would still break the statement in a way that is tedious to
# diagnose and unnecessary to allow.
# Through STDIN, not -c. psql performs variable interpolation while lexing its input, and a
# string given to -c is handed to the server without that pass — so `:'email'` arrived at the
# server literally and every run died with «syntax error at or near ":"». The -v was added by
# an audit, correctly, to keep an address with a quote in it out of the statement; feeding the
# SQL on stdin is what makes -v actually work.
EXISTS="$(printf '%s\n' "select count(*) from zz.principal where email = :'email' and status = 'active';" \
  | docker compose exec -T postgres psql -U "${POSTGRES_USER:-zz}" -d "${POSTGRES_DB:-zz}" \
      -v email="$EMAIL" -tA)"
if [ "$(printf '%s' "$EXISTS" | tr -d '[:space:]')" != "1" ]; then
  echo "no active principal for $EMAIL." >&2
  echo "set SUPERADMIN_EMAIL in deploy/.env and restart cred-proxy so the gateway seeds it." >&2
  exit 1
fi

# NO `scope`. A PAT carried `member` or `admin` until the platform stopped asking the TOKEN
# what its holder may do — authority is a fact about the person, read from their principal — and
# the column went with it. This still named it, so the one script a fresh install cannot do
# without died on "column scope of relation pat does not exist" at the moment there is no other
# way in. Found by the release's own tool-chain walk, which mints its token exactly this way.
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
