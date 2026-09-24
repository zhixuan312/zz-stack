# The image every zz-stack service runs, and the only place that says how it is built.
#
# The build installs and compiles here, from the lockfile, with this directory as the context,
# so .dockerignore applies: a build is reproducible from a clean clone and never picks up a
# working tree's node_modules or dist/.
#
# DELIBERATE: one image, many services. SERVICE picks which entrypoint runs, so zz-core and the
# gateway are the same bytes with a different environment variable and cannot end up on two
# versions of the `packages/` contracts they share.

FROM node:22.23.2-alpine AS build
WORKDIR /repo

# The manifests alone, so editing a source file does not re-run the install.
#
# npm resolves the workspace globs in package.json against every member's package.json, so each
# one is copied, file by file because Docker has no glob for "every package.json two levels
# down". A member left out does not fail: npm installs less.
# COUPLED: the gate holds this list against manifestPaths(), as it does tsconfig.json's
# references and set-version's list.
COPY package.json package-lock.json tsconfig.json tsconfig.base.json ./
COPY packages/catalog/package.json    packages/catalog/
COPY packages/contracts/package.json  packages/contracts/
COPY packages/indexing/package.json   packages/indexing/
COPY packages/mcp-client/package.json packages/mcp-client/
COPY packages/mcp-http/package.json   packages/mcp-http/
COPY packages/tools/package.json      packages/tools/
COPY services/gateway/package.json    services/gateway/
COPY services/zz-core/package.json    services/zz-core/

# `npm ci` and not `npm install`: it builds strictly from the lockfile and fails if the two
# have drifted, which is the difference between shipping the dependencies that were tested
# and shipping whatever resolved on build day.
RUN npm ci

COPY packages packages
COPY services services

RUN npx tsc -b

# DELIBERATE: pruned in the build stage, so the sources never enter the runtime image. A later
# RUN would only hide them: layers are additive and `docker save` gets them back.
RUN find /repo/packages /repo/services \
      \( -name '*.ts' -o -name '*.tsbuildinfo' \) -delete


FROM node:22.23.2-alpine
WORKDIR /repo

# git, because a team's knowledge store is a git repository: every document write is a commit
# authored by the person who made it. node:alpine does not ship it, and without it
# commitDocument does not throw — every write succeeds, logs `git_failed` and records no history.
RUN apk add --no-cache git

# Runtime dependencies only. Copied from the build stage, not the context, so no source comes
# with them; each member's package.json survives the prune, so the workspace globs still resolve.
# Every service starts from services/<name>/dist/server.js.
COPY package.json package-lock.json ./
COPY --from=build /repo/packages ./packages
COPY --from=build /repo/services ./services
RUN npm ci --omit=dev && npm cache clean --force

# Read at runtime, not compiled in: the flow catalog and the skills a client is packaged
# with change on their own cadence, and neither is code.
COPY catalog /catalog
COPY skills /skills

ENV SERVICE=
EXPOSE 8000

# An unset or misspelled SERVICE exits naming the services that exist, rather than dying on a
# missing module that reads like a broken build.
CMD ["sh", "-c", "\
  if [ -z \"$SERVICE\" ]; then \
    echo 'FATAL: SERVICE is unset. Set it to one of:' >&2; \
    ls /repo/services >&2; exit 2; \
  fi; \
  if [ ! -f \"/repo/services/$SERVICE/dist/server.js\" ]; then \
    echo \"FATAL: no such service '$SERVICE'. Available:\" >&2; \
    ls /repo/services >&2; exit 2; \
  fi; \
  exec node \"services/$SERVICE/dist/server.js\""]
