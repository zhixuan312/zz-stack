# deploy/postgres/Dockerfile — the pinned PostgreSQL 17 + pg_textsearch v1.4.0 image.
# COUPLED: every value that identifies which bytes this builds is cross-checked against
# versions.lock.json by testing/tenant-info/deployment.ts's validateImageInputs, and
# checks/postgres-image-pinned.ts holds the two files together.
#
# DELIBERATE: the Debian (glibc) variant, not Alpine: pg_textsearch's musl compatibility is not
# established.

# Build: compile pg_textsearch against the exact pinned base.
#
# DELIBERATE: the base reference is written out in full in each stage, never interpolated from
# an ARG, because `FROM image@${DIGEST}` can be overridden with `--build-arg` at build time.
FROM postgres:17.11-bookworm@sha256:639ab7ceb90e13123085b741fb31ef493fba25463002f6da665352e7b534b652 AS builder
# DELIBERATE: the defaults are the pin, for the same reason. COUPLED: versions.lock.json records
# the same three, and validateImageInputs refuses a Dockerfile that does not carry the lock's
# commit and hash literally.
ARG PG_TEXTSEARCH_TAG=v1.4.0
ARG PG_TEXTSEARCH_COMMIT=7a932505b537d50ad8d2d068a053cd1dd7b646ea
ARG PG_TEXTSEARCH_SOURCE_SHA256=b05f668806199f747218e43f659a5d3f56e254ff7cf63fab23586e832218ca30

# The build host needs to reach github.com for the pg_textsearch source.
# postgresql-server-dev-17 supplies postgres.h and the rest of the server headers: the official
# image ships the server without them, and PGXS fails on the first translation unit.
RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential git ca-certificates curl postgresql-server-dev-17 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /build
# Fetch the pinned commit of github.com/timescale/pg_textsearch (tag v1.4.0) and verify its
# source hash before building. An all-zero placeholder commit fails closed.
RUN set -eux; \
    test "${PG_TEXTSEARCH_COMMIT}" != "0000000000000000000000000000000000000000" \
      || { echo "PG_TEXTSEARCH_COMMIT is still the unresolved placeholder — resolve it first" >&2; exit 1; }; \
    curl -fsSL -o pg_textsearch.tar.gz \
      "https://github.com/timescale/pg_textsearch/archive/${PG_TEXTSEARCH_COMMIT}.tar.gz"; \
    echo "${PG_TEXTSEARCH_SOURCE_SHA256}  pg_textsearch.tar.gz" | sha256sum -c -; \
    mkdir pg_textsearch && tar xzf pg_textsearch.tar.gz -C pg_textsearch --strip-components=1; \
    cd pg_textsearch && make && make install DESTDIR=/build/out

# Runtime: the same pinned base, plus the compiled extension only.
FROM postgres:17.11-bookworm@sha256:639ab7ceb90e13123085b741fb31ef493fba25463002f6da665352e7b534b652 AS runtime
COPY --from=builder /build/out/ /
COPY deploy/postgres/postgresql.conf /etc/postgresql/postgresql.conf
CMD ["postgres", "-c", "config_file=/etc/postgresql/postgresql.conf"]
