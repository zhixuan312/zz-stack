#!/usr/bin/env bash
# Supplies the ZZ platform bearer token to the client as MCP connection
# headers. Read at connect time and never stored in the package, so the
# token never lands in a file that gets committed.
#
# Resolution order:
#   1. $ZZ_TOKEN        (env override)
#   2. $ZZ_TOKEN_FILE   (explicit path)
#   3. ~/.zz/token      (written by the install step, mode 600)
set -uo pipefail

if [ -n "${ZZ_TOKEN:-}" ]; then
  token="$ZZ_TOKEN"
else
  token_file="${ZZ_TOKEN_FILE:-$HOME/.zz/token}"
  if [ -r "$token_file" ]; then
    token="$(tr -d '\r\n' < "$token_file")"
  else
    # No token: emit no credential rather than failing the connection, so the
    # person sees an auth error they can act on instead of a silent no-op.
    printf '{"X-ZZ-Client":"zz-plugin"}\n'
    exit 0
  fi
fi

escaped=$(printf '%s' "$token" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g')
printf '{"Authorization":"Bearer %s","X-ZZ-Client":"zz-plugin"}\n' "$escaped"
