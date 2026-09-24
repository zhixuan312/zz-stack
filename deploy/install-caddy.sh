#!/usr/bin/env bash
# Install deploy/Caddyfile onto a host, with the two things that differ per host substituted.
#
# DELIBERATE: never copy the file verbatim. The committed copy carries one host's addresses;
# on another host Caddy then has no site block matching anything it serves, every public
# address answers nothing, and `caddy validate` still says "Valid configuration" — it is a
# valid config for a different machine.
#
# Two substitutions, named in the Caddyfile's own header:
#   · the nip.io address
#   · how Caddy reaches the gateway — whatever address the running gateway is published on
#
# Usage:  ./deploy/install-caddy.sh <host>          # host is an ssh target
set -euo pipefail

HOST="${1:?usage: install-caddy.sh <ssh-host>}"
HERE="$(cd "$(dirname "$0")" && pwd)"

# The host's own answers, read from the host rather than kept in a table here: a table is a
# third copy of the deployment's addresses.
PUBLIC=$(ssh "$HOST" "grep -oE '^GATEWAY_PUBLIC_URL=.*' /root/zz-parent/zz-stack/deploy/.env | cut -d= -f2-")
[ -n "$PUBLIC" ] || { echo "$HOST has no GATEWAY_PUBLIC_URL in deploy/.env — refusing to guess" >&2; exit 1; }
# api.<addr> -> <addr>
ADDR=$(printf '%s' "$PUBLIC" | sed -E 's#^https?://api\.##; s#/+$##')
[ -n "$ADDR" ] || { echo "could not read the nip.io address out of $PUBLIC" >&2; exit 1; }

# How Caddy reaches the gateway there: whatever the running gateway is published on.
UPSTREAM=$(ssh "$HOST" "docker ps --format '{{.Ports}}' --filter name=cred-proxy | grep -oE '[0-9.]+:[0-9]+->8000' | head -1 | cut -d'>' -f1 | sed 's/-\$//'")
[ -n "$UPSTREAM" ] || { echo "could not see where cred-proxy is published on $HOST" >&2; exit 1; }

echo "$HOST: address $ADDR, gateway at $UPSTREAM"

# The committed file's own values, replaced. The explanatory header is deliberately not
# rewritten.
#
# DELIBERATE: the whole hostname, not the address fragment. Substituting the bare fragment into
# an $ADDR that already ends in .nip.io produces `<addr>.nip.io.nip.io`, a site block for a
# hostname nothing resolves.
#
# COUPLED: both literals below must match what the Caddyfile contains. A sed that matches
# nothing does not fail — it emits the file unchanged — so the guards below refuse an install
# in which either literal survived.
sed -e "s/203-0-113-11\.nip\.io/$ADDR/g" -e "s#127\\.0\\.0\\.1:8764#$UPSTREAM#g" \
    "$HERE/Caddyfile" > /tmp/caddy-$HOST.new
grep -q "nip\.io\.nip\.io" /tmp/caddy-$HOST.new && { echo "substitution doubled the domain suffix" >&2; exit 1; }

grep -q "$ADDR" /tmp/caddy-$HOST.new || { echo "substitution produced no site block for $ADDR" >&2; exit 1; }
if grep -q "203-0-113-11" /tmp/caddy-$HOST.new && [ "$ADDR" != "203-0-113-11.nip.io" ]; then
  echo "the template's own address survived the substitution — refusing to install" >&2; exit 1
fi
# The upstream half of the same check: without it a stale pattern proxies the gateway to
# whatever address the template carried instead of the one this host publishes.
if grep -q "127\.0\.0\.1:8764" /tmp/caddy-$HOST.new && [ "$UPSTREAM" != "127.0.0.1:8764" ]; then
  echo "the template's own upstream survived the substitution — refusing to install" >&2; exit 1
fi

# Keep what is there, but only if it is serving. A rollback needs a file that worked, and a
# second run must not overwrite the good backup with the first run's broken install.
if ssh "$HOST" "curl -sk -o /dev/null -w '%{http_code}' --resolve 'api.$ADDR:443:127.0.0.1' 'https://api.$ADDR/health' --max-time 8" | grep -q 200; then
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
for h in $(grep -oE '^[a-z0-9.-]+\.nip\.io \{' /tmp/caddy-$HOST.new | sed 's/ .*//'); do
  code=$(ssh "$HOST" "curl -sk -o /dev/null -w '%{http_code}' --resolve '$h:443:127.0.0.1' 'https://$h/' --max-time 10")
  printf '  %-38s %s\n' "$h" "$code"
  [ "$code" = "200" ] || { echo "  ^ not serving — previous config is at /etc/caddy/Caddyfile.prev on $HOST" >&2; exit 1; }
done
echo "$HOST: caddy installed and serving"
