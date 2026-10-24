#!/usr/bin/env bash
# Install deploy/Caddyfile onto a host, with the two things that differ per host substituted.
#
# DELIBERATE: never copy the file verbatim. The committed copy carries one host's addresses;
# on another host Caddy then has no site block matching anything it serves, every public
# address answers nothing, and `caddy validate` still says "Valid configuration" — it is a
# valid config for a different machine.
#
# Three substitutions, named in the Caddyfile's own header:
#   · the console's hostname, from CONSOLE_PUBLIC_URL
#   · the gateway's hostname, from GATEWAY_PUBLIC_URL
#   · how Caddy reaches the gateway — whatever address the running gateway is published on
#
# Usage:  ./deploy/install-caddy.sh <host>          # host is an ssh target
set -euo pipefail

HOST="${1:?usage: install-caddy.sh <ssh-host>}"
HERE="$(cd "$(dirname "$0")" && pwd)"

# The host's own answers, read from the host rather than kept in a table here: a table is a
# third copy of the deployment's addresses.
#
# COUPLED: provision-host.sh's `ZZ_DEPLOY_PATH`, which every other script that names a remote path
# honours. This one hard-coded /root/zz-parent/zz-stack, so a host provisioned anywhere else read
# no .env at all and was told it "has no GATEWAY_PUBLIC_URL in deploy/.env".
REMOTE="${ZZ_DEPLOY_PATH:-/root/zz-parent/zz-stack}"
# https://host[:port][/...] -> host
hostname_of() { printf '%s' "$1" | sed -E 's#^https?://##; s#[:/].*$##'; }
env_of() { ssh "$HOST" "grep -oE '^$1=.*' '$REMOTE/deploy/.env' | cut -d= -f2-"; }
API_URL=$(env_of GATEWAY_PUBLIC_URL)
[ -n "$API_URL" ] || { echo "$HOST has no GATEWAY_PUBLIC_URL in deploy/.env — refusing to guess" >&2; exit 1; }
CONSOLE_URL=$(env_of CONSOLE_PUBLIC_URL)
[ -n "$CONSOLE_URL" ] || { echo "$HOST has no CONSOLE_PUBLIC_URL in deploy/.env — refusing to guess" >&2; exit 1; }
API=$(hostname_of "$API_URL")
CONSOLE=$(hostname_of "$CONSOLE_URL")
[ -n "$API" ] && [ -n "$CONSOLE" ] || { echo "could not read a hostname out of $API_URL or $CONSOLE_URL" >&2; exit 1; }
# Two blocks for one hostname is a config Caddy refuses, and a passkey cookie shared with the API
# host is exactly what the same-origin split exists to prevent.
[ "$API" != "$CONSOLE" ] || { echo "GATEWAY_PUBLIC_URL and CONSOLE_PUBLIC_URL name one host, $API — they must differ" >&2; exit 1; }

# How Caddy reaches the gateway there: whatever the running gateway is published on.
UPSTREAM=$(ssh "$HOST" "docker ps --format '{{.Ports}}' --filter name=cred-proxy | grep -oE '[0-9.]+:[0-9]+->8000' | head -1 | cut -d'>' -f1 | sed 's/-\$//'")
[ -n "$UPSTREAM" ] || { echo "could not see where cred-proxy is published on $HOST" >&2; exit 1; }

echo "$HOST: console $CONSOLE, gateway $API, upstream $UPSTREAM"

# The committed file's own values, replaced. The explanatory header is deliberately not
# rewritten.
#
# DELIBERATE: the api literal first. `api.example.com` contains no `console.`, and the console
# literal is not a suffix of it, so neither substitution can rewrite the other's result.
#
# COUPLED: the three literals below must match what the Caddyfile contains. A sed that matches
# nothing does not fail — it emits the file unchanged — so the guards below refuse an install
# in which any literal survived.
sed -e "s/api\.example\.com/$API/g" -e "s/console\.example\.com/$CONSOLE/g" \
    -e "s#127\\.0\\.0\\.1:8764#$UPSTREAM#g" \
    "$HERE/Caddyfile" > /tmp/caddy-$HOST.new

for h in "$API" "$CONSOLE"; do
  grep -q "^$h {" /tmp/caddy-$HOST.new || { echo "substitution produced no site block for $h" >&2; exit 1; }
done
if grep -q "example\.com" /tmp/caddy-$HOST.new && ! printf '%s %s' "$API" "$CONSOLE" | grep -q "example\.com"; then
  echo "a template hostname survived the substitution — refusing to install" >&2; exit 1
fi
# The upstream half of the same check: without it a stale pattern proxies the gateway to
# whatever address the template carried instead of the one this host publishes.
if grep -q "127\.0\.0\.1:8764" /tmp/caddy-$HOST.new && [ "$UPSTREAM" != "127.0.0.1:8764" ]; then
  echo "the template's own upstream survived the substitution — refusing to install" >&2; exit 1
fi

# Keep what is there, but only if it is serving. A rollback needs a file that worked, and a
# second run must not overwrite the good backup with the first run's broken install.
#
# The api host the CURRENT file serves, which is not the one being installed when the gateway moves.
OLD_API=$(ssh "$HOST" "grep -oE '^api\.[a-z0-9.-]+ \{' /etc/caddy/Caddyfile | head -1 | cut -d' ' -f1" || true)
if [ -n "$OLD_API" ] && ssh "$HOST" "curl -sk -o /dev/null -w '%{http_code}' --resolve '$OLD_API:443:127.0.0.1' 'https://$OLD_API/health' --max-time 8" | grep -q 200; then
  ssh "$HOST" "cp /etc/caddy/Caddyfile /etc/caddy/Caddyfile.prev"
  echo "  kept the current, serving config as /etc/caddy/Caddyfile.prev"
else
  echo "  NOTE: $HOST is not serving right now, so the current config is not kept as a rollback"
fi
scp -q /tmp/caddy-$HOST.new "$HOST:/tmp/Caddyfile.new"
# DELIBERATE: `--adapter caddyfile`, explicitly. Caddy infers the adapter from the filename, so
# `Caddyfile.new` would be parsed as JSON, fail, and inside an && chain silently skip the
# install while the reload reports success.
ssh "$HOST" "caddy validate --adapter caddyfile --config /tmp/Caddyfile.new >/dev/null 2>&1 || { echo 'the substituted file is not valid Caddy config' >&2; exit 1; }
             cp /tmp/Caddyfile.new /etc/caddy/Caddyfile && systemctl reload caddy"

# Valid is not serving: `caddy validate` passes a config for the wrong machine, so the check is
# that the host's own addresses answer.
sleep 2
# The hosts this file serves, read out of it rather than listed here, so the verifier does not
# need editing every time the file changes.
for h in $(grep -oE '^[a-z0-9.-]+ \{' /tmp/caddy-$HOST.new | sed 's/ .*//'); do
  want=200
  # A hostname new to this machine has no certificate until Caddy's first ACME order completes,
  # and until then curl fails the handshake. `|| true`, because under `set -e` that failure ended
  # the script mid-loop with nothing printed; up to 30 seconds, because the order takes a few.
  for _ in 1 2 3 4 5 6; do
    code=$(ssh "$HOST" "curl -sk -o /dev/null -w '%{http_code}' --resolve '$h:443:127.0.0.1' 'https://$h/' --max-time 10" || true)
    [ "$code" = "$want" ] && break
    sleep 5
  done
  printf '  %-38s %s\n' "$h" "$code"
  [ "$code" = "$want" ] || { echo "  ^ answered $code, not $want — previous config is at /etc/caddy/Caddyfile.prev on $HOST" >&2; exit 1; }
done
echo "$HOST: caddy installed and serving"
