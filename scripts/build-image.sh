#!/usr/bin/env bash
# Build the runtime image from a clean context.
#
# Everything happens inside the build — install from the lockfile, then `tsc -b` — so this
# script exists to name the image consistently, not to prepare anything. Version comes from
# package.json, which is what `npm run set-version` edits, so the image tag and the release
# it claims to be cannot drift apart.
set -euo pipefail
cd "$(dirname "$0")/.."

IMAGE="${ZZ_IMAGE:-ghcr.io/zhixuan312/zz-stack}"
# Read with sed, not node. A deploy host runs containers and has no toolchain installed —
# requiring one just to NAME a tag is how the build script fails on the only machine that
# actually needs to run it.
VERSION="${ZZ_VERSION:-$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' package.json | tail -1)}"
[ -n "$VERSION" ] || { echo "FATAL: no version in package.json and ZZ_VERSION unset" >&2; exit 2; }

# THE SAME PLATFORM THE RELEASE BUILDS, and the same default. Without it docker builds for
# whatever this machine is: on an Apple Silicon laptop that is an arm64 image tagged
# `${IMAGE}:${VERSION}` — the release's exact tag — which cannot run on the amd64 deploy
# host, and nothing here or in docker says so until a container fails to start there.
#
# Two scripts building one tag is a divergence waiting to happen, and this was already it.
# release.ts reads ZZ_PLATFORM with the same default, and the gate holds the two to the
# same value.
PLATFORM="${ZZ_PLATFORM:-linux/amd64}"

# `-f Dockerfile` explicitly, as the release does. There has been a second recipe in this
# repository before — deploy/ts.Dockerfile, which had already drifted on whether the image
# installs git — and naming the file is what stops a stray one being picked up.
echo "==> building ${IMAGE}:${VERSION} for ${PLATFORM}"
docker build --platform "${PLATFORM}" -f Dockerfile -t "${IMAGE}:${VERSION}" .
echo "built ${IMAGE}:${VERSION} (${PLATFORM})"
