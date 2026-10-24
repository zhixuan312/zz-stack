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
 * DELIBERATE: the key is the composite marker of the collections the answer READS, at the scope those figures
 * are about (`prefixFor`) — never one global count over every team, and never the route's own name. A global
 * count would strand an answer for another team's write, and a route's name is not a collection any hint is
 * raised for, so an answer keyed on one could never be told to have moved. The marker moves when a write this
 * process's listener heard touched a collection the answer reads, and ONLY then: a write to `zz.event` raises
 * `activity` and `runs`, so it strands Usage, Status and Record and leaves `/api/console/initiatives`
 * — which reads `initiatives` and `document` — reachable, because nothing it reads moved. An answer whose
 * figures are the whole platform's folds every team's changes in, so another team's write strands it; a
 * team-scoped answer folds only the teams its caller hears, so another team's write does not.
 *
 * A table no trigger watches is the one way an answer can outlive its data, which is why the entry also
 * expires: a stale entry is never served for longer than `LIFETIME_MS`, whatever the listener missed. Nothing
 * is cached while nothing listens, because without the counts there is no marker and an unmarked answer cannot
 * be told from a stale one.
 *
 * DELIBERATE: the computation, not the answer, is what is kept. Two tabs that open the console in the same
 * second ask the same question once, which is exactly what a cache is for and what a per-request memo
 * cannot do.
 *
 * COUPLED: `live-revision.ts`, which counts the changes and folds the marker; `read-envelope.ts`, whose table
 * says what each route reads and at what scope; and every route that wraps a read in `cachedWithHit` — each
 * says in its own comment what it means to be a few seconds behind.
 */
import type { Request } from "express";

import type { Identity } from "../identity.js";
import type { ReadMeta } from "./figures.js";
import { heardBy, revisionNamed } from "./live-revision.js";
import { routeFor } from "./read-envelope.js";

/** How long an answer may be served, whatever the listener heard. A backstop, not the policy: the marker
 *  moved by a write is what makes an answer unreachable, and every table the six kept reads touch that a
 *  person can change is watched by a trigger (`003_console_live.sql`, `005_page_view_no_hint.sql`).
 *
 *  DELIBERATE: the minute is for the answer classes whose tables no trigger watches — `zz.release`,
 *  `zz.schema_migration`, `zz.bug`, `zz.model_call` and the `zz.eval_*` family. Nothing raises a hint for
 *  any of them, so no marker can move when one is written and the clock is the only thing that can strand
 *  those answers; the visible cost is a release list or a bug list up to a minute old. A minute, not twenty
 *  seconds, because twenty was shorter than a person spends on a page: a reader who went to another
 *  destination and came back paid the whole read again for an answer nothing had moved — 0.6–1.2 s, where a
 *  kept answer is 0.19 s. */
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
 * The marker `path`'s answer is kept under: the composite of the collections the route's own entry declares,
 * at the scope those figures are about, or null when nothing may be kept.
 *
 * The scope comes from the entry, not from the caller's reach: an entry whose answer is the whole platform's
 * (`invalidates: "platform"`) folds EVERY team's changes in, so a write by a team its reader is not in still
 * makes it unreachable — which is what a public aggregate has to do, or team A's member would keep reading
 * figures team B had already moved. An entry whose answer is the caller's own or their active team's folds
 * only the teams `heardBy` resolves for them.
 *
 * Null — nothing kept, the answer recomputed every time — in three cases, and each is a marker that cannot be
 * told to have moved: nothing is listening, so there are no counts to compose; the path declares no entry, so
 * there are no collections to fold; and the caller's scope is refused, so there are no teams to narrow to.
 */
export function prefixFor(path: string, id: Identity, req: Request): string | null {
  const entry = routeFor(path);
  if (entry === null) return null;
  if (entry.invalidates === "platform") return revisionNamed(entry.collections, null);
  const heard = heardBy(id, req);
  return "teams" in heard ? revisionNamed(entry.collections, heard.teams) : null;
}

/**
 * The caller's half of a platform read's key: whether they are a superadmin, and the team their identity acts
 * as — `platform:<isSuper>:<activeTeam or ->`.
 *
 * Defined once because two routes share it and must never drift, and because the flag is `isSuper(id)` rather
 * than `platformRole`: a team-bound PAT held by a superadmin resolves to a narrower identity, and a platform
 * read answers it differently from the same person's unbound token. Status reads both halves — the flag widens
 * the answer and `activeTeam` fills the reader's own block — so the superadmin switching teams misses, and a
 * superadmin never shares with that team's admin. Usage reads the flag and nothing else of the caller, and
 * carries the team anyway, because both routes keep one shape: the extra term costs Usage one entry per active
 * team rather than one platform-wide entry, which is a recomputation and never a wrong answer.
 */
export function audienceKey({ superadmin, activeTeam }: { superadmin: boolean; activeTeam: string | null }): string {
  return `platform:${superadmin}:${activeTeam ?? "-"}`;
}

/**
 * `read`'s answer under `key`, computed once for every caller that asks under the same marker, with the
 * cache's own statement of whether this caller was served the kept computation.
 *
 * `key` is what makes one answer a different answer from another: the route's own name and whatever of the
 * request changes what it computes — the team it is about, the caller where the computation uses them, the
 * page asked for. `prefix` is `prefixFor`'s marker, and it is what makes one answer unreachable.
 *
 * The promise is shared, so a page opened in several tabs costs one computation; a read that rejects is
 * dropped rather than shared, so a failure is never served to the next caller as though it were an answer.
 *
 * DELIBERATE: with no marker nothing is kept and every answer is a miss. That covers the listener being down
 * (`prefixFor` answers null) and a call site that passed no marker at all — an answer kept under a marker
 * that no write can move would be served until it expired, which is the stale answer this file exists to
 * avoid.
 */
export function cachedWithHit<T>(key: string, read: () => Promise<T>, prefix: string | null): Promise<Served<T>> {
  // `== null` catches a call site that passed no marker as well as a null one: without a marker there is
  // nothing a write could move, so nothing may be kept.
  if (prefix == null) return read().then((value) => ({ value, hit: false }));
  const full = `${prefix}\u0000${key}`;
  const kept = answers.get(full);
  if (kept && kept.expires > Date.now()) {
    return (kept.value as Promise<T>).then((value) => ({ value, hit: true }));
  }
  const value = read();
  if (answers.size >= KEPT) {
    for (const old of answers.keys()) {
      if (answers.size < KEPT / 2) break;
      // An entry under a marker that has moved can never be served again; the rest go oldest first.
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
 * A FRESH object every time, never the one the cache keeps: the kept answer is shared by every caller whose
 * marker is the same one, so writing into it would show one caller's request on another's answer. Nothing else
 * in the `meta` moves, and `asOf` stays the instant the computation ran.
 */
export function served<T extends { meta: ReadMeta }>({ value, hit }: Served<T>): T {
  return { ...value, meta: { ...value.meta, cacheHit: hit } };
}
