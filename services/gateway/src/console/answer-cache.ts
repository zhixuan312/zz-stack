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

/**
 * `read`'s answer under `key`, computed once for every caller that asks within the same data version.
 *
 * The promise is shared, so a page opened in several tabs costs one computation; a read that rejects is
 * dropped rather than shared, so a failure is never served to the next caller as though it were an answer.
 */
export function cached<T>(key: string, read: () => Promise<T>): Promise<T> {
  const version = dataVersion();
  if (version === null) return read();
  const full = `${version}\u0000${key}`;
  const hit = answers.get(full);
  if (hit && hit.expires > Date.now()) return hit.value as Promise<T>;
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
  return value;
}
