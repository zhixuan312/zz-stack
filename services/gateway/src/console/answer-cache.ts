/**
 * A console answer, kept for as long as nothing has changed that could change it.
 *
 * Several of the console's reads reduce the whole event history — Usage, Record, Home and Status do — and
 * they do it again on every page load: nine statements over tens of thousands of rows each, measured at
 * 0.9–1.2 s a page on a six-week record, and the figure grows with the record rather than with anything a
 * person did.
 * A person moving between the console's destinations asks for the same three answers over and over, and
 * between two of those asks usually nothing has happened at all.
 *
 * DELIBERATE: the key carries `dataVersion()` — every notification this gateway's own listener has heard
 * since its `LISTEN` connection came up. A write that reached the database moves the version, and the
 * answer computed before it becomes a different key: it is not reachable, not merely "probably not
 * current". A table no trigger watches is the one way an answer can outlive its data, which is why the
 * entry also expires: a stale entry is never served for longer than `LIFETIME_MS`, whatever the listener
 * missed. Nothing is cached while nothing listens, because without the counts there is no version and an
 * unversioned answer cannot be told from a stale one.
 *
 * DELIBERATE: the computation, not the answer, is what is kept. Two tabs that open the console in the same
 * second ask the same question once, which is exactly what a cache is for and what a per-request memo
 * cannot do.
 *
 * COUPLED: `live-revision.ts`, which counts the changes, and every route that wraps a read in `cached` —
 * each says in its own comment what it means to be a few seconds behind.
 */
import type { ReadMeta } from "./figures.js";
import { dataVersion } from "./live-revision.js";

/** How long an answer may be served, whatever the listener heard. A backstop, not the policy: the version
 *  moved by a write is what makes an answer unreachable, and every table the six kept reads touch that a
 *  person can change is watched by a trigger (`003_console_live.sql`, `005_page_view_no_hint.sql`).
 *
 *  DELIBERATE: a minute, not twenty seconds. The clock is what stands in for a change no trigger heard, and
 *  the one table it can hide is `zz.release`, which is written without a hint — so the visible cost of the
 *  minute is a release list up to a minute old. Twenty seconds was shorter than a person spends on a page,
 *  so a reader who went to another destination and came back paid the whole read again for an answer nothing
 *  had moved: 0.6–1.2 s, where a kept answer is 0.19 s. */
const LIFETIME_MS = 60_000;

/** How many answers are kept. The console has a handful of these reads and a few callers; past that the
 *  oldest goes, and the only cost is computing it again. */
const KEPT = 64;

type Entry = { expires: number; value: Promise<unknown> };

const answers = new Map<string, Entry>();

/** An answer, and whether this caller was served one that was already computed.
 *
 *  DELIBERATE: the hit is stated by the party that knows. `asOf` is rounded up to a whole second
 *  (`record.ts:403`) and the two instants are sampled at different points on every miss, so comparing
 *  them tells a caller nothing: it is true on almost every miss and false on some hits. */
type Served<T> = { value: T; hit: boolean };

/**
 * `read`'s answer under `key`, computed once for every caller that asks within the same data version,
 * with the cache's own statement of whether this caller was served the kept computation.
 *
 * The promise is shared, so a page opened in several tabs costs one computation; a read that rejects is
 * dropped rather than shared, so a failure is never served to the next caller as though it were an answer.
 * With nothing listening there is no version and nothing is kept, so every answer is a miss.
 */
export function cachedWithHit<T>(key: string, read: () => Promise<T>): Promise<Served<T>> {
  const version = dataVersion();
  if (version === null) return read().then((value) => ({ value, hit: false }));
  const full = `${version}\u0000${key}`;
  const kept = answers.get(full);
  if (kept && kept.expires > Date.now()) {
    return (kept.value as Promise<T>).then((value) => ({ value, hit: true }));
  }
  const value = read();
  if (answers.size >= KEPT) {
    for (const old of answers.keys()) {
      if (answers.size < KEPT / 2) break;
      // An entry from an older version can never be served again; the rest go oldest first.
      if (old !== full) answers.delete(old);
    }
  }
  answers.set(full, { expires: Date.now() + LIFETIME_MS, value });
  void value.catch(() => {
    if (answers.get(full)?.value === value) answers.delete(full);
  });
  return value.then((settled) => ({ value: settled, hit: false }));
}

/**
 * The answer a route sends, with the cache's own statement of whether this caller was served a kept one
 * written into its `meta` — where `read-envelope.ts` finds it and leaves it alone.
 *
 * A FRESH object every time, never the one the cache keeps: the kept answer is shared by every caller inside
 * one data version, so writing into it would show one caller's request on another's answer. Nothing else in
 * the `meta` moves, and `asOf` stays the instant the computation ran.
 */
export function served<T extends { meta: ReadMeta }>({ value, hit }: Served<T>): T {
  return { ...value, meta: { ...value.meta, cacheHit: hit } };
}

/**
 * The same answer, without the hit — the shape every route already awaits.
 *
 * DELIBERATE: kept exactly as it was rather than replaced. Changing what this resolves to would change
 * every call site at once; the routes move to `cachedWithHit` as each one is taught to fill `meta`, and
 * this stays for the ones that have not been yet.
 */
export function cached<T>(key: string, read: () => Promise<T>): Promise<T> {
  return cachedWithHit(key, read).then((kept) => kept.value);
}
