# The image every zz-stack service runs, and the only place that says how it is built.
#
# This existed for a while as a heredoc piped into `docker build -f -` from the PARENT
# directory, which had two consequences. The artifact running in production could not be
# rebuilt from a checkout — `docker history` was the only surviving record of the recipe.
# And building from one level up put .dockerignore out of scope, so the image was assembled
# by copying the host's node_modules and dist/ straight in: precisely the failure that file
# exists to prevent, and that it describes in its own comment.
#
# So the build installs and compiles HERE, from the lockfile, exactly as .dockerignore
# assumes. A build is now reproducible from a clean clone and cannot pick up whatever
# compiled output happened to be lying in a working tree.
#
# ONE image, many services. SERVICE picks which entrypoint runs, so zz-core and the gateway
# are the same bytes with a different environment variable — they share every package in
# `packages/`, and building them separately is how two services end up on two versions of a
# contract they are supposed to agree on.

FROM node:22.23.2-alpine AS build
WORKDIR /repo

# THE MANIFESTS ALONE, so editing a source file does not re-run the install.
#
# This copied `packages` and `services` whole, immediately above `npm ci`, while the comment
# here claimed the opposite — "so a change to source does not invalidate the install layer".
# It did invalidate it, on every edit: a release build reinstalled the entire dependency tree
# in order to compile one changed line.
#
# The workspace globs in package.json mean npm needs every member's package.json present
# before it will resolve the tree, which is why each one is copied and not just the root's.
# Listed file by file because Docker has no glob for "every package.json two levels down" —
# and a member left out of this list does NOT fail loudly: npm's glob simply matches fewer
# directories and installs less. The gate holds this list against manifestPaths(), the same
# source tsconfig.json's references and set-version.mjs are held to.
COPY package.json package-lock.json tsconfig.json tsconfig.base.json ./
COPY packages/catalog/package.json    packages/catalog/
COPY packages/contracts/package.json  packages/contracts/
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

# Pruned HERE, in the build stage, so the sources never enter the runtime image at all.
# Deleting them in a later RUN does not do it: layers are additive, the files stay in the
# earlier layer, `docker save` gets them back, and the image gets BIGGER for the extra
# layer. The image is pulled by every deploy host, so the
# difference between hidden and absent is the whole point.
RUN find /repo/packages /repo/services \
      \( -name '*.ts' -o -name '*.tsbuildinfo' \) -delete


FROM node:22.23.2-alpine
WORKDIR /repo

# git, because a team's knowledge store IS a git repository: every document write is a
# commit authored by the person who made it, so a team that walks away with its repository
# walks away with the attribution too, readable by `git log` with nothing of ours installed.
#
# node:alpine does not ship it, and the failure would have been silent — commitDocument
# never throws, so every write would have succeeded, logged `git_failed`, and left a store
# with no history that nobody would notice until they went looking for one.
RUN apk add --no-cache git

# Runtime dependencies only — the build stage's toolchain and dev dependencies stay behind.
#
# From the BUILD stage and not from the context, which is what keeps the sources out. npm
# still gets what it needs: the workspace globs in package.json resolve against each member's
# package.json, and those survive the prune. Nothing at runtime reads a .ts — every service
# starts from services/<name>/dist/server.js, as the CMD below spells out.
COPY package.json package-lock.json ./
COPY --from=build /repo/packages ./packages
COPY --from=build /repo/services ./services
RUN npm ci --omit=dev && npm cache clean --force

# Read at runtime, not compiled in: the flow catalog and the skills a client is packaged
# with change on their own cadence, and neither is code.
COPY catalog /catalog
COPY skills /skills
# Everything written ON TOP of a building block: its usage skill and its tests.
COPY blocks /blocks

ENV SERVICE=
EXPOSE 8000

# An unset or misspelled SERVICE used to start node against a path that did not exist, and
# the container died with a stack trace about a missing module — which reads like a broken
# build rather than a typo in a compose file. Say which names are actually available.
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
