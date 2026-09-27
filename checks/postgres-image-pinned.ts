// The database image is pinned, and the pin is the one the lock declares.
//
// The three deploy files are the subject and they all stay: `versions.lock.json` records which
// bytes this repository builds, `Dockerfile` builds them, and `postgresql.conf` says which
// library the server preloads. What the check asserts is that the three agree — the lock's
// version is the tag the Dockerfile's `FROM` names, the digest the lock records is the digest in
// that `FROM`, and the preload list is not empty.
//
// DELIBERATE: the check carries its own reading of the three files rather than importing one.
// The deployment-side validator that used to hold them together lived in the rehearsal's own
// tree and went with it; this check is the pin's only remaining reader, so the reading lives
// beside it. The tampered copies below are what keeps the reading from being vacuous — a
// comparison that accepted anything would pass the three real files too.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

interface ImageInputs {
  readonly postgres_major?: number;
  readonly postgres_version?: string;
  readonly base_image_digest?: string;
  readonly pg_textsearch_tag?: string;
  readonly pg_textsearch_source_sha256?: string;
  readonly shared_preload_libraries?: readonly string[];
}

/** Every reason the three files do not agree, in the order a reader meets them. Empty is pinned. */
function pinnedImageProblems(
  lock: ImageInputs, dockerfile: string, config: string,
): string[] {
  const bad: string[] = [];

  // The version is written out in full in the image reference, never interpolated from an ARG,
  // so it can be read from the FROM line itself.
  const from = /^FROM\s+(\S+):(\S+?)@(sha256:[0-9a-f]{64})/m.exec(dockerfile);
  if (!from) return ['the Dockerfile names no `FROM image:tag@sha256:<digest>` reference'];

  const version = lock.postgres_version;
  if (!version || !/^\d+\.\d+$/.test(version)) {
    bad.push(`the lock's postgres_version is ${JSON.stringify(version)}, not a major.minor pin`);
  } else if (!from[2]!.startsWith(`${version}-`)) {
    bad.push(`the Dockerfile builds ${from[1]}:${from[2]}, which is not the lock's ${version}`);
  }
  if (lock.postgres_major !== undefined && version && !version.startsWith(`${lock.postgres_major}.`)) {
    bad.push(`the lock's postgres_major ${lock.postgres_major} does not name the major of ${version}`);
  }

  const digest = lock.base_image_digest;
  if (!digest || !/^sha256:[0-9a-f]{64}$/.test(digest)) {
    bad.push(`the lock's base_image_digest is ${JSON.stringify(digest)}, not a sha256 digest`);
  } else if (from[3] !== digest) {
    bad.push(`the lock records ${digest} and the Dockerfile builds ${from[3]} — the pin reaches nothing`);
  }

  // An extension built from source is pinned by tag and by hash, and the build verifies both.
  if (lock.pg_textsearch_tag && !dockerfile.includes(lock.pg_textsearch_tag)) {
    bad.push(`the lock pins the extension at ${lock.pg_textsearch_tag} and the Dockerfile never names it`);
  }
  if (lock.pg_textsearch_source_sha256 && !dockerfile.includes(lock.pg_textsearch_source_sha256)) {
    bad.push(`the lock records a source hash the Dockerfile does not verify`);
  }

  // A preload list is what makes the extension's shared memory available at all; an empty one
  // means the image ships a library the server never loads.
  const preload = /^shared_preload_libraries\s*=\s*'([^']*)'/m.exec(config);
  if (!preload || !preload[1]!.trim()) {
    bad.push("postgresql.conf preloads no library, so nothing the image builds is loaded");
  } else if ((lock.shared_preload_libraries ?? []).some((lib) => !preload[1]!.split(',').map((s) => s.trim()).includes(lib))) {
    bad.push(`the lock's preload list names a library ${preload[1]} does not — the two disagree`);
  }
  return bad;
}

const lock = JSON.parse(readFileSync('deploy/postgres/versions.lock.json', 'utf8'));
const dockerfile = readFileSync('deploy/postgres/Dockerfile', 'utf8');
const config = readFileSync('deploy/postgres/postgresql.conf', 'utf8');

const real = pinnedImageProblems(lock, dockerfile, config);
assert.deepEqual(real, [], `the pinned image disagrees with itself: ${real.join('; ')}`);

// The tampered copies. Each one moves exactly one fact, so a reading that stopped comparing
// would report nothing here and be caught.
for (const postgres_version of ['16.15', '18.6', '19.0', '17.bad']) {
  assert.ok(pinnedImageProblems({ ...lock, postgres_version }, dockerfile, config).length > 0,
    `a lock pinned at ${postgres_version} against this Dockerfile must be refused`);
}
const other = `sha256:${lock.base_image_digest.endsWith('a') ? 'b'.repeat(64) : 'a'.repeat(64)}`;
assert.ok(pinnedImageProblems({ ...lock, base_image_digest: other }, dockerfile, config).length > 0,
  'a lock recording a digest the Dockerfile does not build must be refused');
assert.ok(pinnedImageProblems(lock, dockerfile, "shared_preload_libraries = ''\n").length > 0,
  'a cluster that preloads nothing must be refused');
if (lock.pg_textsearch_tag) {
  assert.ok(pinnedImageProblems({ ...lock, pg_textsearch_tag: 'main' }, dockerfile, config).length > 0,
    'an extension pinned to a moving tag must be refused');
}

console.log('postgres-image-pinned: ok');
