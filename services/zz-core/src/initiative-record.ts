/**
 * The record an initiative is opened with, and the two questions asked of it.
 *
 * `chainFor` resolves a flow from a document's envelope, and an initiative is an empty folder
 * until its first document is written. In that window there is no envelope to read, so without
 * this record an initiative opened with a flow reads back as governed by nothing — which is
 * exactly when `initiative_status` is called.
 *
 * DELIBERATE: the record does not say whether the initiative was opened. That is the folder's
 * own existence, and a second source for it would eventually disagree with the filesystem.
 *
 * COUPLED: read by chain.ts resolving a flow, by document_write refusing an unopened name,
 * and by initiative_open itself — hence its own module rather than a corner of the tool.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { documentApplies, OUTCOME_STOPPED } from "@zz/contracts";

import { Refusal } from "./refusal.js";
import { isoToday } from "./write-guards.js";

/** The declaration, beside the documents rather than among them.
 *
 * Exported so `initiative_open` can log its event against this path and land the line in the
 * initiative's own activity log rather than the team-wide one.
 *
 * COUPLED: the leading underscore is what keeps it out of every listing — initiative_status,
 * chainFor's oldest-document walk and document_list all skip `_`-prefixed entries. */
export const OPEN_RECORD = "_open.json";

interface OpenRecord {
  initiative: string;
  /** Set only when an initiative holding no document was abandoned — see recordAbandoned.
   *  Its presence is what `initiative_status` reads to stop offering a next move. */
  abandoned_by?: string;
  abandoned_at?: string;
  /** The flow that governs this initiative, or null, which is a declared freeform rather than
   * an unanswered question. Telling the two apart is why this file is written for a freeform
   * open as well. */
  flow: string | null;
  opened_by: string;
  opened_at: string;
}

/** The name the platform composes: today's date, from the platform's own clock, then the slug.
 *
 * DELIBERATE: there is no argument for the date and no way to pass one. `isoToday()` is the
 * same clock and timezone `envelopeFor` stamps `updated_at` from, so a document's date and
 * its folder's cannot disagree. */
export function initiativeNameFor(slug: string): string {
  return `${isoToday()}-${slug.trim()}`;
}

/** Write the declaration, creating the folder. */
export function recordOpen(root: string, name: string, flow: string | null, who: string): OpenRecord {
  const record: OpenRecord = {
    initiative: name,
    flow: flow?.trim() || null,
    opened_by: who,
    opened_at: isoToday(),
  };
  mkdirSync(join(root, name), { recursive: true });
  writeFileSync(join(root, name, OPEN_RECORD), `${JSON.stringify(record, null, 2)}\n`);
  return record;
}

/** Mark an initiative that holds no document as abandoned, on the record of its own opening.
 *
 * DELIBERATE: an outcome belongs on a document, and this is the one case where there is none
 * and never will be. The alternative is writing a document no stage produced to satisfy a
 * gate, so the open record carries it instead. */
export function recordAbandoned(root: string, name: string, who: string): void {
  const rec = openRecord(root, name);
  if (!rec) return;
  writeFileSync(join(root, name, OPEN_RECORD),
                `${JSON.stringify({ ...rec, abandoned_by: who, abandoned_at: isoToday() }, null, 2)}\n`);
}

/** The record, or null when there is none.
 *
 * DELIBERATE: the whole record is returned rather than a `declaredFlow(root, name)` helper.
 * `flow: null` is a declaration that nothing governs this, and a caller has to tell it apart
 * from no record at all.
 *
 * DELIBERATE: a malformed record is null rather than a throw. `initiative_status` is the call
 * every agent makes before continuing work, and an unparseable byte must not take it down. */
export function openRecord(root: string, name: string): OpenRecord | null {
  const file = join(root, name, OPEN_RECORD);
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as OpenRecord;
    return typeof parsed === "object" && parsed !== null ? parsed : null;
  } catch {
    return null;
  }
}


/** Where a flow's durable branch facts live (FR-58, Task I-26): `protocol_action`,
 *  `improvement_mode`, `release_mode`. Written by `writeFacts` below and read by every caller
 *  that resolves a conditional document's `when` — the same division `_open.json` above draws
 *  between the tool that opens an initiative and the one that reads it back, except that here
 *  BOTH halves live in this module: `writeBranchFacts` (services/zz-core/src/eval/protocol.ts,
 *  Task I-27) owns the refuse-on-change decision and calls `writeFacts` for the mechanical part,
 *  the same split `recordAbandoned` below keeps from `closeInitiative`. Underscore-prefixed, so
 *  no listing treats it as a document.
 *
 *  DELIBERATE: not exported. `factsOrDamaged`/`writeFacts` below are the only two touching the
 *  filename; a second module reaching for it directly would be reading or writing `_facts.json`
 *  a second way. */
const FACTS_FILE = "_facts.json";

/** An initiative's durable branch facts, or `{}` when none are recorded yet.
 *
 * No `_facts.json` is not an error — it is every named fact reading `undetermined`
 * (`documentApplies`, ./flow-when.js) rather than this call throwing.
 *
 * DELIBERATE: a malformed or non-object file IS an error, thrown as a `Refusal` naming the file.
 * `writeFacts` below replaces the file atomically, so no reader ever sees a partial write, and a
 * file that does not parse is damage. Reading it as `{}` would turn every fact back into
 * `undetermined` — and a fact that was set once is exactly what the refuse-on-change rule
 * protects, so `{}` would let the next write record the opposite branch over it. */
export function factsFor(root: string, initiative: string): Record<string, string> {
  const facts = factsOrDamaged(root, initiative);
  if (facts) return facts;
  throw new Refusal(
    `ERROR: ${initiative}/${FACTS_FILE} is not a JSON object, so this initiative's branch facts ` +
    "cannot be read. The platform writes that file whole and atomically, so this is damage, not " +
    "a write in progress, and nothing reads or writes this initiative's branch until it is " +
    `repaired. Two ways out. To stop the work: initiative_close("${initiative}", ` +
    `"${OUTCOME_STOPPED}") — an abandon does not read this file. To continue it: an operator ` +
    `rewrites ${initiative}/${FACTS_FILE} in the team's store on the platform host as a JSON ` +
    "object of fact → value, from the platform database's mirror of it " +
    `(select fact, value from zz.initiative_fact where team = '<team>' and initiative = ` +
    `'${initiative}'), or deletes it when the mirror holds no row — each stage that decides a ` +
    "fact records it again when it next runs.");
}

/** `factsFor`'s read without the throw: the facts, or null when the file is damaged.
 *
 * For the one act that must proceed over damage — an abandoned close, which asks no branch to
 * have been decided (guards.ts `closeCheck`, initiative-close.ts). Without it a damaged file
 * would leave the initiative unable to advance AND unable to stop, and nothing on the platform
 * repairs it on its own.
 *
 * A non-string value under a fact name is dropped rather than coerced: `documentApplies` compares
 * strings, and a caller-written number or object is not one. */
function factsOrDamaged(root: string, initiative: string): Record<string, string> | null {
  const file = join(root, initiative, FACTS_FILE);
  if (!existsSync(file)) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}

/** The facts a write is judged against: `factsFor`'s, except that a write recording an abandon
 *  (`stopping`, an `outcome:` of OUTCOME_STOPPED) gets null for a damaged file rather than a
 *  throw — a stop asks no branch to have been decided, so each caller discharges what the facts
 *  would have answered. One function so guards.ts's three fact readers and initiative-close.ts
 *  agree on when damage is survivable. */
export function factsForWrite(root: string, initiative: string, stopping: boolean): Record<string, string> | null {
  return stopping ? factsOrDamaged(root, initiative) : factsFor(root, initiative);
}

const factsLockHeld = new AsyncLocalStorage<ReadonlySet<string>>();
const inProcessFactsLocks = new Map<string, Promise<unknown>>();

/** Run `fn` holding this process's lock on an initiative's branch facts — the in-process half of
 *  a `_facts.json` read-check-write (`writeBranchFacts`, eval/protocol.ts, and release_prepare /
 *  proposal_prepare, eval/release-prepare.ts), which two concurrent callers would otherwise both
 *  pass on the same old read and then both write. With a database, the cross-process half is
 *  `lockInitiativeFacts` below, taken by `fn` on the one transaction it writes through.
 *
 *  DELIBERATE: the queue comes first even with a database. Without it every waiter in this
 *  process would hold a pooled connection while blocked on the advisory lock — the pool is four.
 *  With it, one connection per initiative per process waits, at most.
 *
 *  DELIBERATE: reentrant within one async call chain (AsyncLocalStorage), so a caller holding the
 *  lock may call `writeBranchFacts`, which takes it too. Without that the inner call would queue
 *  behind the outer one, forever.
 *
 *  Keyed on the initiative name alone, not the team: two teams' same-named initiatives share a
 *  lock, which costs a wait and never a wrong answer. */
export async function withInitiativeFactsLock<T>(initiative: string, fn: () => Promise<T>): Promise<T> {
  const held = factsLockHeld.getStore();
  if (held?.has(initiative)) return fn();
  const inner = () => factsLockHeld.run(new Set([...(held ?? []), initiative]), fn);
  const before = inProcessFactsLocks.get(initiative) ?? Promise.resolve();
  const run = before.then(inner);
  const tail = run.catch(() => undefined);
  inProcessFactsLocks.set(initiative, tail);
  try {
    return await run;
  } finally {
    if (inProcessFactsLocks.get(initiative) === tail) inProcessFactsLocks.delete(initiative);
  }
}

/** The cross-process half of the facts lock: a transaction-level pg advisory lock on `client`,
 *  which must be inside an open transaction — every zz-core process sharing the database is
 *  serialized on it, and it releases at that transaction's COMMIT or ROLLBACK.
 *
 *  DELIBERATE: transaction-level, on the caller's own client, never a session lock on a second
 *  pooled connection. release_prepare writes its ledger row and its branch fact in one
 *  transaction; a lock held on another connection for the length of that transaction is two
 *  connections per call, and four such calls starve the pool. Re-taking it inside the same
 *  transaction (`writeBranchFacts` under release_prepare) is a no-op, as pg advisory locks are
 *  reentrant per session. */
export async function lockInitiativeFacts(
  client: { query(text: string, values?: unknown[]): Promise<unknown> }, initiative: string,
): Promise<void> {
  await client.query("select pg_advisory_xact_lock(hashtext($1))", [`initiative_facts:${initiative}`]);
}

/** Write the durable branch facts, replacing whatever `factsFor` would have read back.
 *
 * DELIBERATE: no merge and no refusal here — `writeBranchFacts` (eval/protocol.ts) reads the
 * current facts with `factsFor` above, decides whether a requested change is a refusal, and
 * passes the whole merged object down. This call is the mechanical write, append-only only
 * because its one caller never asks it to drop a fact that was already set. */
export function writeFacts(root: string, initiative: string, facts: Record<string, string>): void {
  // Temp file, then rename: a rename within one directory is atomic, so a concurrent `factsFor`
  // reads the old facts or the new ones and never a truncated file between the two.
  const file = join(root, initiative, FACTS_FILE);
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(facts, null, 2)}\n`);
  renameSync(tmp, file);
}

/** Is the flow's DECLARED closing document (`chain.closingDoc`) ruled out for this initiative
 *  (FR-58, Task I-28)? `zz-plugin-eval` is the first flow whose closing document is itself
 *  `when`-conditional — `improvement.md`, promotable only — so a branch that never reaches
 *  `promotable` has to close on something else, and `chain.closingDoc` (chain.ts) is a static,
 *  per-flow answer that cannot see this initiative's own branch facts.
 *
 *  Read by BOTH `initiative_close` (initiative-close.ts, to fall back to the furthest document
 *  this branch actually wrote — the same fallback it already used for a stop that never reached
 *  its closing document, now also triggered by a branch that ruled it out) and `closeCheck`
 *  (guards.ts, to recognise a write reaching that fallback document as still the closing write) —
 *  one function, so the two never disagree about which document a close lands on.
 *
 *  A document with no `when` is never ruled out — this returns `false` unconditionally, which is
 *  every flow that predates FR-58 (sdlc-flow, zz-access): asking never changes their answer. */
export function closingDocRuledOut(
  declared: { name: string; when?: Record<string, string | string[]> } | undefined,
  facts: Record<string, string>,
): boolean {
  if (!declared?.when) return false;
  return documentApplies(declared, facts) === "not_applicable";
}

/** An initiative this slug would collide with, or null.
 *
 * DELIBERATE: the slug is what is taken, not the dated name. Testing `<today>-<slug>` alone
 * lets the same work be opened again tomorrow under a second folder.
 *
 * Anchored, so a slug that is a prefix of an existing one is free: `payment` is not taken by
 * `payment-retries`. */
export function takenRefusal(root: string, slug: string): string | null {
  const v = slug.trim();
  const escaped = v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const existing = (existsSync(root) ? readdirSync(root) : [])
    .filter((n) => new RegExp(`^\\d{4}-\\d{2}-\\d{2}-${escaped}$`).test(n))
    .sort();
  if (!existing.length) return null;
  return (
    `ERROR: "${v}" is already taken by ${existing.join(", ")}. Continue that one — ` +
    `initiative_status("${existing[0]}") says where it stands — or open this under a slug that ` +
    "says how it differs. Two initiatives with the same slug and different dates diverge, and " +
    "nothing downstream can say which one a person meant."
  );
}

/** The refusal for a path whose initiative nobody opened, or null. A single existence test:
 * the name shape, the taken check and the flow declaration are `initiative_open`'s, asked
 * once, before there is a folder.
 *
 * A path that is not an initiative document — a bare file at the root of the store — is not
 * this function's business and passes. */
export function unopenedRefusal(root: string, relPath: string): string | null {
  const parts = relPath.replace(/^\/+/, "").split("/");
  if (parts.length < 2 || !parts[0]) return null;
  if (existsSync(join(root, parts[0]))) return null;
  return (
    `ERROR: there is no initiative named "${parts[0]}" — writing into one no longer creates ` +
    "it. Open it first with `initiative_open(\"<slug>\")`: send the SLUG alone and use the " +
    "name it hands back, because the platform composes that name from its own clock. Pass " +
    "`flow` there if a flow governs this work; leaving it out is a choice the platform " +
    "supports, and documents, gates, approvals and closing all still work without one."
  );
}

/** What each `produces: "record"` stage of an initiative minted — the ids a later stage needs
 *  and, being in no document, could otherwise only find in the conversation that ran it. A stage
 *  that starts in a new conversation reads them back through `initiative_status` (`records`),
 *  and `next_move` names the first record stage that has none yet.
 *
 *  Keyed by stage, then by id name. Latest wins, per id: a stage run again (a second profile,
 *  a re-score) supersedes what it recorded before, which is what "resume from the initiative"
 *  must mean. Nothing here decides a branch — branch facts are `_facts.json`, append-only.
 *
 *  DELIBERATE: not exported. `recordsFor`/`writeStageRecord` are the only two touching it. */
const RECORDS_FILE = "_records.json";

export function recordsFor(root: string, initiative: string): Record<string, Record<string, string>> {
  const file = join(root, initiative, RECORDS_FILE);
  if (!existsSync(file)) return {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, Record<string, string>> = {};
    for (const [stage, ids] of Object.entries(parsed as Record<string, unknown>)) {
      if (!ids || typeof ids !== "object" || Array.isArray(ids)) continue;
      out[stage] = Object.fromEntries(Object.entries(ids as Record<string, unknown>)
        .filter((e): e is [string, string] => typeof e[1] === "string"));
    }
    return out;
  } catch {
    // Unreadable is "nothing recorded": every id in it can be minted again by the stage that
    // owns it, unlike a branch fact, whose loss would let the opposite branch be recorded.
    return {};
  }
}

/** Merge `ids` into `stage`'s record. Temp file then rename, as `writeFacts` does. */
export function writeStageRecord(root: string, initiative: string, stage: string, ids: Record<string, string>): void {
  const records = recordsFor(root, initiative);
  records[stage] = { ...(records[stage] ?? {}), ...ids };
  const file = join(root, initiative, RECORDS_FILE);
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(records, null, 2)}\n`);
  renameSync(tmp, file);
}
