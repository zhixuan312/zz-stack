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
# DELIBERATE: read with sed, not node. A deploy host has no toolchain installed.
VERSION="${ZZ_VERSION:-$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' package.json | tail -1)}"
[ -n "$VERSION" ] || { echo "FATAL: no version in package.json and ZZ_VERSION unset" >&2; exit 2; }

# The platform the release builds. Without it docker builds for this machine, and an Apple
# Silicon laptop would produce an arm64 image under the release's exact tag that the amd64
# deploy host cannot run.
# COUPLED: release.ts reads ZZ_PLATFORM with the same default, and the gate holds the two equal.
PLATFORM="${ZZ_PLATFORM:-linux/amd64}"

# `-f Dockerfile` explicitly, as the release does, so no other recipe is ever picked up.
echo "==> building ${IMAGE}:${VERSION} for ${PLATFORM}"
docker build --platform "${PLATFORM}" -f Dockerfile -t "${IMAGE}:${VERSION}" .
echo "built ${IMAGE}:${VERSION} (${PLATFORM})"
