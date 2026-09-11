#!/usr/bin/env bash
# Install deploy/Caddyfile onto a host, with the two things that differ per host substituted.
#
# THIS EXISTS BECAUSE COPYING THE FILE VERBATIM TAKES THE HOST DOWN, and the file says so in
# prose that is easy to read after the fact and easy to miss before it. The committed copy
# carries PRODUCTION's addresses. Copied straight onto UAT it leaves Caddy with no site block
# matching anything UAT serves — so every public address answers nothing, the front end goes
# blank, and `caddy validate` says "Valid configuration", because it is: it is a valid config
# for a different machine.
#
# That is exactly what happened on 2026-09-09, to UAT, in the middle of someone using it.
#
# Two substitutions, named in the Caddyfile's own header:
#   · the nip.io address
#   · how Caddy reaches the gateway — production proxies to a Tailscale address because the
#     gateway binds to the tailnet there; UAT reaches it on loopback.
#
# Usage:  ./deploy/install-caddy.sh <host>          # host is an ssh target: zz, sm
set -euo pipefail

HOST="${1:?usage: install-caddy.sh <ssh-host>}"
HERE="$(cd "$(dirname "$0")" && pwd)"

# THE HOST'S OWN ANSWERS, read from the host rather than kept in a table here. A table is a
# third copy of the deployment's addresses and would go stale the first time one moved.
PUBLIC=$(ssh "$HOST" "grep -oE '^GATEWAY_PUBLIC_URL=.*' /root/zz-parent/zz-stack/deploy/.env | cut -d= -f2-")
[ -n "$PUBLIC" ] || { echo "$HOST has no GATEWAY_PUBLIC_URL in deploy/.env — refusing to guess" >&2; exit 1; }
# api.<addr> -> <addr>
ADDR=$(printf '%s' "$PUBLIC" | sed -E 's#^https?://api\.##; s#/+$##')
[ -n "$ADDR" ] || { echo "could not read the nip.io address out of $PUBLIC" >&2; exit 1; }

# How Caddy reaches the gateway there: whatever the running gateway is published on.
UPSTREAM=$(ssh "$HOST" "docker ps --format '{{.Ports}}' --filter name=cred-proxy | grep -oE '[0-9.]+:[0-9]+->8000' | head -1 | cut -d'>' -f1 | sed 's/-\$//'")
[ -n "$UPSTREAM" ] || { echo "could not see where cred-proxy is published on $HOST" >&2; exit 1; }

echo "$HOST: address $ADDR, gateway at $UPSTREAM"

# The committed file's own values, replaced. Deliberately NOT sed-ing the explanatory header:
# the Caddyfile says why, and a substitution that rewrites the explanation leaves a comment
# describing a topology that does not exist.
#
# THE WHOLE HOSTNAME, not the address fragment. Substituting the bare `165-232-169-165`
# against an $ADDR that already ends in .nip.io produces `<addr>.nip.io.nip.io` — site blocks
# for hostnames nothing resolves, which is the same outage as copying the file verbatim
# wearing a different mask. It took a host down a second time, four minutes after the first.
#
# BOTH LITERALS BELOW MUST MATCH WHAT THE Caddyfile ACTUALLY CONTAINS, and one of them
# silently stopped matching. The upstream pattern read `<tailnet-address>:8764` — a tailnet
# address from when this platform had a second deployment — long after the template had been
# repointed at loopback. A sed that matches nothing does not fail: it emits the file
# unchanged, so $UPSTREAM was discarded and every install hardcoded whatever the template
# happened to say. That is what the second guard below now catches.
sed -e "s/165-232-169-165\.nip\.io/$ADDR/g" -e "s#127\\.0\\.0\\.1:8764#$UPSTREAM#g" \
    "$HERE/Caddyfile" > /tmp/caddy-$HOST.new
grep -q "nip\.io\.nip\.io" /tmp/caddy-$HOST.new && { echo "substitution doubled the domain suffix" >&2; exit 1; }

grep -q "$ADDR" /tmp/caddy-$HOST.new || { echo "substitution produced no site block for $ADDR" >&2; exit 1; }
if grep -q "165-232-169-165" /tmp/caddy-$HOST.new && [ "$ADDR" != "165-232-169-165.nip.io" ]; then
  echo "the template's own address survived the substitution — refusing to install" >&2; exit 1
fi
# THE UPSTREAM HALF OF THE SAME CHECK. Without it a stale sed pattern is invisible: the
# install succeeds, Caddy reloads, and the gateway is proxied to whatever address the
# template carried instead of the one this host actually publishes.
if grep -q "127\.0\.0\.1:8764" /tmp/caddy-$HOST.new && [ "$UPSTREAM" != "127.0.0.1:8764" ]; then
  echo "the template's own upstream survived the substitution — refusing to install" >&2; exit 1
fi

# KEEP WHAT IS THERE, BUT ONLY IF IT IS SERVING. A rollback needs a file that worked, and
# running this twice would otherwise overwrite the good backup with the broken install from
# the first run — which is exactly how the second outage lost its own way back.
if ssh "$HOST" "curl -sk -o /dev/null -w '%{http_code}' --resolve 'api.$ADDR:443:127.0.0.1' 'https://api.$ADDR/health' --max-time 8" | grep -q 200; then
  ssh "$HOST" "cp /etc/caddy/Caddyfile /etc/caddy/Caddyfile.prev"
  echo "  kept the current, serving config as /etc/caddy/Caddyfile.prev"
else
  echo "  NOTE: $HOST is not serving right now, so the current config is not kept as a rollback"
fi
scp -q /tmp/caddy-$HOST.new "$HOST:/tmp/Caddyfile.new"
# --adapter caddyfile, EXPLICITLY. Caddy infers the adapter from the FILENAME, so validating
# something called `Caddyfile.new` fails with "config is not valid JSON: invalid character
# '#'" — a parse error about the file being JSON, which it never claimed to be. Run without
# the flag inside an && chain, that failure silently skips the install and leaves whatever was
# there in place; the reload then reports success for a file nobody replaced.
ssh "$HOST" "caddy validate --adapter caddyfile --config /tmp/Caddyfile.new >/dev/null 2>&1 || { echo 'the substituted file is not valid Caddy config' >&2; exit 1; }
             cp /tmp/Caddyfile.new /etc/caddy/Caddyfile && systemctl reload caddy"

# VALID IS NOT SERVING. `caddy validate` passes a config for the wrong machine, which is the
# whole failure this script exists to prevent — so the check is that the host's own addresses
# answer, not that the file parsed.
sleep 2
# THE HOSTS THIS FILE ACTUALLY SERVES, read out of it rather than assumed. There used to be
# three and the list was written here; the bare domain served the browser front end, and when
# that went the check started failing on an address deliberately no longer served. A verifier
# that has to be edited every time the thing it verifies changes is a verifier people switch
# off.
for h in $(grep -oE '^[a-z0-9.-]+\.nip\.io \{' /tmp/caddy-$HOST.new | sed 's/ .*//'); do
  code=$(ssh "$HOST" "curl -sk -o /dev/null -w '%{http_code}' --resolve '$h:443:127.0.0.1' 'https://$h/' --max-time 10")
  printf '  %-38s %s\n' "$h" "$code"
  [ "$code" = "200" ] || { echo "  ^ not serving — previous config is at /etc/caddy/Caddyfile.prev on $HOST" >&2; exit 1; }
done
echo "$HOST: caddy installed and serving"
