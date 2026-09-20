# deploy/postgres/Dockerfile — the pinned PostgreSQL 17 + pg_textsearch v1.4.0 image this
# initiative's dependency proof runs against. Every value that identifies WHICH bytes this
# builds is pinned here and cross-checked against versions.lock.json by
# testing/tenant-info/deployment.ts's validateImageInputs — checks/postgres-image-pinned.ts
# is the frozen proof that the two files cannot drift apart.
#
# GLIBC, NOT MUSL. The official postgres image ships both a Debian ("bookworm") and an
# Alpine variant. pg_textsearch's musl compatibility has not been established from this
# checkout — untested musl/glibc mixtures are exactly what the contract forbids — so this
# pins the Debian variant, and the running platform database's own postgres:16-alpine tag
# is NOT what this file builds toward; the migration to Debian is deliberate, not an
# oversight, and is recorded here for whoever reviews this pin.
#
# EVERY DIGEST/COMMIT/HASH BELOW MARKED UNVERIFIED IS A PLACEHOLDER, not a fabricated real
# value. Writing this file involved no docker, no registry and no network — the same
# constraint that forbids it from building or running the image it describes. Each one is
# named again, individually, in versions.lock.json's own "unverified_fields", and resolving
# them is the operator's job, on a build host that can reach a registry, before this image
# may be accepted. A placeholder that merely LOOKS like a real digest is not release evidence
# — see versions.lock.json's own header comment for why the values below repeat digits
# rather than trying to look plausible.

ARG PG_TEXTSEARCH_TAG=v1.4.0
ARG PG_TEXTSEARCH_COMMIT=0000000000000000000000000000000000000000
ARG PG_TEXTSEARCH_SOURCE_SHA256=4444444444444444444444444444444444444444444444444444444444444444

# ── build: compile pg_textsearch against the exact pinned base ─────────────────────────────
#
# The base image reference below is written out in full, twice (once per stage), rather than
# built from an ARG interpolated into FROM. An interpolated `FROM image@${DIGEST}` can be
# silently overridden with `--build-arg DIGEST=...` at build time, which defeats the entire
# point of a pin recorded in a lock file the gate reads back from this file's own bytes.
FROM postgres:17.999-bookworm@sha256:0000000000000000000000000000000000000000000000000000000000000000 AS builder
ARG PG_TEXTSEARCH_TAG
ARG PG_TEXTSEARCH_COMMIT
ARG PG_TEXTSEARCH_SOURCE_SHA256

# Outbound network access here is the operator's build environment, not this task's — this
# task neither ran nor could run this RUN step. "Build/test on isolated resources with
# outbound integrations disabled" (the contract's own words) means the platform's OWN
# external integrations stay off during that isolated build/test, not that pg_textsearch's
# own resolved source cannot be fetched at all; an operator building this image still needs
# reachability to wherever PG_TEXTSEARCH_COMMIT actually resolves to, once that is known.
RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential git ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /build
# Resolve the exact tag to the exact commit, verify the exact source hash, and refuse to
# proceed if any of the three does not match — "no main/master/latest substitution" enforced
# again here at build time, not only in the lock file an offline check can read.
#
# UPSTREAM-SOURCE-URL-UNRESOLVED: this task did not reach GitHub or any registry to confirm
# where pg_textsearch v1.4.0 actually lives. An operator resolving the placeholders above
# fills in the real download URL here before this RUN step can do anything but fail closed.
RUN set -eux; \
    test "${PG_TEXTSEARCH_COMMIT}" != "0000000000000000000000000000000000000000" \
      || { echo "PG_TEXTSEARCH_COMMIT is still the unresolved placeholder — resolve it first" >&2; exit 1; }; \
    curl -fsSL -o pg_textsearch.tar.gz \
      "https://UPSTREAM-SOURCE-URL-UNRESOLVED/pg_textsearch/archive/${PG_TEXTSEARCH_COMMIT}.tar.gz"; \
    echo "${PG_TEXTSEARCH_SOURCE_SHA256}  pg_textsearch.tar.gz" | sha256sum -c -; \
    mkdir pg_textsearch && tar xzf pg_textsearch.tar.gz -C pg_textsearch --strip-components=1; \
    cd pg_textsearch && make && make install DESTDIR=/build/out

# ── runtime: the same pinned base, plus the compiled extension only ────────────────────────
FROM postgres:17.999-bookworm@sha256:0000000000000000000000000000000000000000000000000000000000000000 AS runtime
COPY --from=builder /build/out/ /
COPY deploy/postgres/postgresql.conf /etc/postgresql/postgresql.conf
CMD ["postgres", "-c", "config_file=/etc/postgresql/postgresql.conf"]
