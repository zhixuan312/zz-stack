#!/usr/bin/env node
/**
 * checks/read-meta-keys.ts — the read envelope declares the marker, the observed instant and the hit
 * flag beside the six fields it carried; the cache reports its own hit under a marker the caller hands it
 * and keeps nothing without one; and `cached()`, the wrapper every route used to await, is gone.
 *
 *   node checks/read-meta-keys.ts   # needs `npm run build`
 *
 * The type is erased at runtime, so the declared fields are read from the source the build copies.
 * The cache behaviours are exercised for real: the marker is what makes a second read a hit.
 *
 * Exit 0 every case held; exit 1 one failed; exit 2 the tree is not built.
 */
import { existsSync, readFileSync } from "node:fs";

const NAME = "read-meta-keys";
const CACHE = new URL("../services/gateway/dist/console/answer-cache.js", import.meta.url);
const LIVE = new URL("../services/gateway/dist/console/live-revision.js", import.meta.url);
const FIGURES = new URL("../services/gateway/src/console/figures.ts", import.meta.url);

if (!existsSync(CACHE) || !existsSync(LIVE) || !existsSync(FIGURES)) {
  console.error(`${NAME}: the tree is not built — run npm run build`);
  process.exit(2);
}

const fail: string[] = [];
const ok = (line: string) => console.log(`✓ ${line}`);

type CacheModule = {
  cached?: <T>(key: string, read: () => Promise<T>) => Promise<T>;
  cachedWithHit?: <T>(key: string, read: () => Promise<T>, prefix: string | null) => Promise<{ value: T; hit: boolean }>;
};
type LiveModule = { listening: () => void };

const cache = (await import(CACHE.href)) as CacheModule;
const live = (await import(LIVE.href)) as LiveModule;

// 1. Every field the envelope must carry is declared, the six it had and the five it gains.
// The type ends at a `};` at the start of a line — not at the `};` closing an inline object such as
// `period: { from: string; to: string };`, which is what a plain indexOf would cut at.
const src = readFileSync(FIGURES, "utf8");
const from = src.indexOf("export type ReadMeta");
const body = from < 0 ? "" : src.slice(from, src.indexOf("\n};", from));
for (const field of ["asOf", "timezone", "period", "scope", "population", "coverageFrom",
  "observedAt", "revision", "builtAt", "sourceRevision", "cacheHit"]) {
  if (!new RegExp("\\b" + field + "\\??\\s*:").test(body)) fail.push(`ReadMeta does not declare ${field}`);
}
if (!fail.length) ok("ReadMeta declares the six fields it carried and the five it gains");

// 2. cached() is gone: one way to read a kept answer, and no wrapper nothing calls.
live.listening();
if (typeof cache.cached === "function") {
  fail.push("answer-cache.js still exports cached(), the wrapper that resolved to the bare value");
} else ok("cached() is gone, so cachedWithHit is the one way to read a kept answer");

// 3. The companion says whether it hit, and flips: one computation, then a hit under the same marker.
const kept = cache.cachedWithHit;
if (typeof kept !== "function") {
  fail.push("answer-cache.js does not export cachedWithHit()");
} else {
  let computed = 0;
  const read = async () => ({ n: ++computed });
  const marker = "read-meta-keys|marker";
  const first = await kept("read-meta-keys|hit", read, marker);
  const second = await kept("read-meta-keys|hit", read, marker);
  if (first?.hit !== false || second?.hit !== true || computed !== 1) {
    fail.push(`cachedWithHit reported hit=${first?.hit} then ${second?.hit} over ${computed} computation(s), not false then true over 1`);
  } else if (second.value?.n !== first.value?.n) {
    fail.push(`cachedWithHit served ${JSON.stringify(second.value)} where it had computed ${JSON.stringify(first.value)}`);
  } else {
    ok("cachedWithHit reports its own hit: false on the computation, true on the answer it kept");
  }

  // 4. No marker, nothing kept: an answer nothing can tell has moved must never be served.
  let unmarked = 0;
  const readUnmarked = async () => ({ n: ++unmarked });
  const a = await kept("read-meta-keys|unmarked", readUnmarked, null);
  const b = await kept("read-meta-keys|unmarked", readUnmarked, null);
  if (a?.hit !== false || b?.hit !== false || unmarked !== 2) {
    fail.push(`with no marker the cache reported hit=${a?.hit} then ${b?.hit} over ${unmarked} computation(s), not two misses over 2`);
  } else ok("with no marker nothing is kept: both reads are computations");
}

if (fail.length) {
  for (const line of fail) console.error(`✗ ${line}`);
  process.exit(1);
}
console.log(`${NAME}: the envelope declares the marker, the observed instant and the hit; the cache reports the hit itself under a marker and keeps nothing without one; and cached() is gone (passed)`);
