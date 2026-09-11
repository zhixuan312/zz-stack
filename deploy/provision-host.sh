#!/usr/bin/env bash
# Bring a bare Ubuntu host up to the point where it can receive a release bundle.
#
# Everything below was worked out by hand the first time, on 2026-09-10, standing up the
# single environment that replaced the old UAT/production pair. It is a script rather than a
# note because the next host is either a rebuild of this one or its replacement, and a
# half-remembered sequence is how a deployment ends up subtly unlike the one it replaced.
#
# What it does NOT do: secrets, DNS, the Caddyfile, or anything with data in it. Those are
# deploy/.env, deploy/install-caddy.sh and whatever migration you decide on — each is a
# decision, and a provisioning script that quietly makes decisions is worse than one that
# stops.
#
# Usage:  ./deploy/provision-host.sh <ssh-host>
set -euo pipefail
HOST="${1:?usage: provision-host.sh <ssh-host>}"
REMOTE="${ZZ_DEPLOY_PATH:-/root/zz-parent/zz-stack}"

echo "== $HOST: what is already there =="
ssh "$HOST" 'set -e
  . /etc/os-release
  echo "  $PRETTY_NAME, $(nproc) vCPU, $(free -g | awk "/Mem:/{print \$2}")G RAM, $(df -h / | awk "NR==2{print \$4}") free"
  for c in docker caddy jq; do
    printf "  %-8s %s\n" "$c" "$(command -v $c >/dev/null && echo present || echo MISSING)"
  done'

echo "== installing what is missing =="
ssh "$HOST" 'set -e
  export DEBIAN_FRONTEND=noninteractive
  need() { ! command -v "$1" >/dev/null; }

  if need docker; then
    echo "  docker: installing from the official repository"
    # Not `apt install docker.io`: Ubuntu ships an older engine and no compose v2 plugin, and
    # this repo drives `docker compose` (v2, a plugin) everywhere rather than `docker-compose`.
    apt-get update -qq
    apt-get install -y -qq ca-certificates curl gnupg >/dev/null
    install -m 0755 -d /etc/apt/keyrings
    curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
    chmod a+r /etc/apt/keyrings/docker.gpg
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo $VERSION_CODENAME) stable" \
      > /etc/apt/sources.list.d/docker.list
    apt-get update -qq
    apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin >/dev/null
    systemctl enable --now docker
  else echo "  docker: already present"; fi

  if need caddy; then
    echo "  caddy: installing from the official repository"
    apt-get install -y -qq debian-keyring debian-archive-keyring apt-transport-https curl >/dev/null
    curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key \
      | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
    curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt \
      > /etc/apt/sources.list.d/caddy-stable.list
    apt-get update -qq
    apt-get install -y -qq caddy >/dev/null
    systemctl enable --now caddy
  else echo "  caddy: already present"; fi

  # git and rsync went with sync.sh: a host receives a bundle over scp and runs
  # published images, so it needs neither a checkout nor a tree to rsync into.
  for p in jq; do
    command -v "$p" >/dev/null || { echo "  $p: installing"; apt-get install -y -qq "$p" >/dev/null; }
  done'

echo "== the directory the release bundle unpacks into =="
ssh "$HOST" "mkdir -p $REMOTE/deploy && echo '  $REMOTE ready'"

echo "== what it looks like now =="
ssh "$HOST" 'set -e
  echo "  docker  $(docker --version | cut -d, -f1)"
  echo "  compose $(docker compose version --short 2>/dev/null || echo MISSING)"
  echo "  caddy   $(caddy version | head -1)"
  echo "  daemon  $(systemctl is-active docker) / caddy $(systemctl is-active caddy)"'

cat <<EOF

$HOST is provisioned. NOT yet done, each on purpose:
  1. deploy/.env       — every secret and address. Nothing here invents one.
  2. the Caddyfile     — ./deploy/install-caddy.sh $HOST, once .env names the public URL
  3. the stack itself  — unpack a release bundle into $REMOTE/deploy and
                         \`docker compose up -d\`. See deploy/README.
  4. data              — a fresh store, or a migration you decide on
EOF
