/**
 * Which FLOW, which STEP of it, and which BLOCK — decided at the door, stamped on the row.
 *
 * ── THE PROBLEM THIS SOLVES ──────────────────────────────────────────────────
 *
 * A `tool_call` row carried `actor`, `team_slug`, `subject` and a detail bag. Three questions
 * are worth asking of that record and the row could answer one of them:
 *
 *   which BLOCK misbehaved   — yes: `subject` is `<surface>:<tool>` and for `/p/<block>/mcp`
 *                              the surface IS the block.
 *   which FLOW was running   — no. Recoverable only by looking the initiative up later, and
 *                              only for a call that named one.
 *   which STEP was running   — no. Recoverable only by replaying every row in id order and
 *                              remembering the last `skill_read` PER ACTOR.
 *
 * That last one is why this file exists. Attribution by trace is the right idea — a
 * `skill_read` genuinely does say which skill the agent is following — but re-derived by each
 * reader it has three faults, and all three are silent:
 *
 *   IT KEYS ON THE PERSON. One human running two conversations interleaves, and every call is
 *   attributed to whichever skill either conversation loaded most recently.
 *   IT NEVER EXPIRES. A `skill_read` from last week still "follows" that person, so unrelated
 *   work months later is attributed to a step nobody was reading.
 *   IT IS RECOMPUTED. Every reader re-derives it, so two reports can disagree about the same
 *   row and neither is wrong about anything it can check.
 *
 * Deciding it ONCE, here, at the moment the call happens, fixes all three: the row carries the
 * answer, every reader agrees, and the correlation window is a fact rather than an assumption.
 *
 * ── AND A VERSION, WHICH IS THE WHOLE POINT ──────────────────────────────────
 *
 * Knowing `ops-select` refused eight times is not improvement. Improvement is knowing it
 * refused eight times under ONE version of that skill and once under the next — otherwise a
 * change can be shipped and never proved. So a `skill_read` answer is hashed as it streams and
 * every call attributed to that step carries the hash of the skill text the agent was ACTUALLY
 * SERVED. Not the file on someone's laptop, not the version in a manifest: the bytes that
 * reached the model.
 *
 * ── WHAT IT DELIBERATELY DOES NOT DO ─────────────────────────────────────────
 *
 * It does not identify people. Identity is used to correlate a skill load with the calls that
 * follow it and is not stored by this module; what lands on the row is a flow, a step, a
 * version and a block. An improvement loop needs to know which skill to edit, never who was
 * running it.
 */
import { createHash } from "node:crypto";

import { parseEnvelope } from "@zz/contracts";

import { platformDb, platformDbReady } from "./db.js";

/** How long a loaded skill still explains the calls that follow it.
 *
 * A conversation's turns arrive minutes apart; a different day's work is a different run. The
 * window is what makes "the step is still X" a claim with an expiry rather than a fact that
 * never stops being asserted. */
const FOLLOWS_FOR_MS = 45 * 60 * 1000;

/** A run is a conversation. Rotating the id after the same idle window is what lets one
 * evaluation round be told apart from the next without asking the client to cooperate — and
 * without which "round 7 against round 8" is answerable only by squinting at timestamps. */
const RUN_IDLE_MS = FOLLOWS_FOR_MS;

interface Trace {
  /** ABSENT, NOT EMPTY, when this caller has named an initiative without ever reading a skill.
   *
   * It was `""`, and an empty string is not "no step" to anything downstream: `??` does not
   * coalesce it, so it reached the column verbatim and `zz.event.step` came to hold two
   * spellings of nothing where `event_step` indexes one. Measured on 2026-09-19: 1,713
   * tool_call rows carried `''` against 943 carrying null, every one of them unjoinable to
   * `zz.skill`, and the five-minute reconcile in runs.ts re-scanned the skill tables 1,695
   * times per pass to resolve one of them. `stepVersion` and `stepSha` say unknown by being
   * absent and always have; this is the same answer, spelled the same way. */
  step?: string;
  /** The initiative this caller is working on, carried forward from the last call that named
   * one. It reached 254 of 510 rows on 2026-09-13, because most calls do not take it — and
   * without it a refusal cannot be joined to the document it was made for, which is the entire
   * left-hand side of the reconciliation between prediction and outcome.
   *
   * ABSENT, NOT EMPTY — the same fix as `step` above, which this field did not get. A skill
   * loaded before any initiative is known wrote `initiative: ""` into a fresh trace, and `??`
   * does not coalesce an empty string, so it reached the column verbatim. Measured on
   * 2026-09-23: 381 rows carry `''` where `step` carries none at all, every one of them a
   * `skill_read` at the start of a conversation, and every one unjoinable to `zz.initiative`
   * exactly as the 1,713 step rows were unjoinable to `zz.skill`.
   *
   * The comment above this one describes that failure in full and has sat four lines away
   * from a second instance of it since the day it was written. */
  initiative?: string;
  /** Absent where nothing established them. A skill served WHOLE carries its declared version
   *  and the hash of the bytes; a supporting file, or a trace with no step at all, carries
   *  neither. These have always said unknown by being absent, which is why `??` works on them
   *  and did not on `step`. */
  stepVersion?: string;
  stepSha?: string;
  run: string;
  at: number;
}

/** The version a skill DECLARES, read out of the frontmatter that `skill_read` serves.
 *
 * A declared version is what a person cites — "ops-select v2 fixed it" — and it is the only
 * form of the answer that is orderable and arguable. The hash beside it is what makes the
 * claim checkable, and the two are not redundant: on the day this was written EVERY skill in
 * the repository declared `version: 1.0`, including three that had been edited four times
 * that same day. A version a human types is a claim; a hash of the bytes is a fact. Recording
 * only the claim would have attributed ten rounds of evidence to one version of a skill that
 * had changed five times underneath it. */
const declaredVersion = (body: string): string =>
  // Through parseEnvelope, not a regex of this file's own. Frontmatter is spelled once in
  // @zz/contracts, and a second spelling here disagreed about the fence on its first outing —
  // which is precisely how two readers of one document come to disagree about what it says.
  // It also gets the right answer for free on the cases a hand-rolled version gets wrong: a
  // repeated key takes the last value, and a `version:` line further down the document is
  // prose in somebody's example rather than the skill's own version.
  (parseEnvelope(body).version ?? "").replace(/^["']|["']$/g, "").trim();

/** Keyed by caller, held in memory, never written down. A restart loses the correlation for
 * conversations in flight, which costs the step on a few rows and nothing else — the
 * alternative is a table holding who was doing what, which is the thing this must not build. */
const traces = new Map<string, Trace>();

function sweep(now: number): void {
  // Bounded without a timer: a Map that only ever grows is a leak in a long-lived process,
  // and a sweep on write costs one pass over entries that are already dead.
  if (traces.size < 512) return;
  for (const [k, t] of traces) if (now - t.at > FOLLOWS_FOR_MS) traces.delete(k);
}

const mint = (seed: string, now: number): string =>
  createHash("sha256").update(`${seed}:${Math.floor(now / RUN_IDLE_MS)}`).digest("hex").slice(0, 10);

/** THE CORRELATION KEY, spelled once.
 *
 * Everything in this module is keyed by it, and it is now read from two places: the telemetry
 * writer, which records what a step did, and the proxy's stage check, which decides whether a
 * step may. Two spellings of it would not fail loudly — the second reader would simply find an
 * empty trace and let every call through, which is the shape of failure that looks exactly
 * like success. So neither caller spells it.
 *
 * From the HEADER, not from req.zzIdentity. identityMiddleware writes the canonical address
 * onto the header after authenticating, so the two agree — but the header is what the
 * telemetry path has always used, and the point of this function is that there is one answer,
 * not two that currently match. */
export const callerKey = (headers: Record<string, unknown>): string =>
  `${String(headers["x-zz-user-email"] ?? "unknown")}\u0000${String(headers["x-zz-client"] ?? "")}`;

/** A skill was served. Everything this caller does next belongs to it.
 *
 * `whole` says whether the bytes ARE the skill, or a supporting file beside it —
 * `skill_read(name, file: "references/blocks-capabilities.md")`, which ops-select's own
 * instructions tell the agent to read. Both are the same step; only the first carries the
 * skill's version.
 *
 * IT USED TO READ THE VERSION OUT OF WHATEVER WAS SERVED, and a reference file is not the
 * skill. Measured on one round of ops-flow: the agent loaded `using-casebox` (1.0), read
 * a file inside it, and the SEVEN casebox calls that followed were written with an empty
 * step_version — which `runs.ts` joins against `zz.skill_version`, so they matched no version
 * and vanished from every per-version report. Worse where the file has frontmatter of its own:
 * a document template declares a document's `version`, so `ops-select` was recorded at 1.0 and
 * then 1.1 — numbers that are real, belong to something else, and are indistinguishable from
 * the skill's own.
 *
 * A file inside the step already in progress therefore changes nothing but the clock. A file
 * for some OTHER skill sets the step with no version, which is the honest answer: nothing
 * served us that skill, so nothing told us its version. */
export function stepLoaded(caller: string, skill: string, servedBody: string, whole: boolean): void {
  const now = Date.now();
  sweep(now);
  const prior = traces.get(caller);
  const run = prior && now - prior.at <= RUN_IDLE_MS ? prior.run : mint(caller, now);
  // Reading a supporting file of the step you are already following is not a load. Refresh the
  // clock and keep the version and the hash that the load itself established.
  if (!whole && prior && prior.step === skill && now - prior.at <= FOLLOWS_FOR_MS) {
    prior.at = now;
    return;
  }
  traces.set(caller, {
    step: skill,
    // A skill load does not change which initiative is being worked on.
    // UNDEFINED, NOT "", when nothing has named one — see `Trace.initiative`.
    initiative: prior && now - prior.at <= FOLLOWS_FOR_MS ? prior.initiative : undefined,
    // ONLY FROM THE SKILL ITSELF. A supporting file's frontmatter is its own, not the
    // skill's — see the note above for what reading it out of one cost.
    stepVersion: whole ? declaredVersion(servedBody) : undefined,
    // The bytes the model was handed, hashed. Twelve hex is plenty to tell two versions of one
    // skill apart and short enough to read in a table.
    stepSha: whole ? createHash("sha256").update(servedBody).digest("hex").slice(0, 12) : undefined,
    run,
    at: now,
  });
}

/** A call named an initiative, so the calls that follow it are about that one too.
 *
 * Most calls do not take an initiative as an argument — 254 of 510 rows on 2026-09-13 — and
 * without it a refusal cannot be joined to the document it was made for, which is the entire
 * left-hand side of the reconciliation between what a step predicted and what happened. */
export function initiativeSeen(caller: string, initiative: string): void {
  const now = Date.now();
  const t = traces.get(caller);
  if (t && now - t.at <= FOLLOWS_FOR_MS) { t.initiative = initiative; t.at = now; return; }
  sweep(now);
  // NO STEP, rather than an empty one — see the note on `Trace.step`. This caller named an
  // initiative and has read no skill, so there is nothing to say about which step it is
  // following, and saying it with "" made 1,713 rows unjoinable to `zz.skill`.
  traces.set(caller, { initiative, run: mint(caller, now), at: now });
}

/** The step this caller is following, or nothing if none is or the last one has expired. */
export function currentStep(caller: string):
  { step?: string; step_version?: string; step_sha?: string; initiative?: string; run: string } | undefined {
  const t = traces.get(caller);
  if (!t) return undefined;
  const now = Date.now();
  if (now - t.at > FOLLOWS_FOR_MS) { traces.delete(caller); return undefined; }
  // Touched on read: a conversation that is still making calls is still that conversation, and
  // an unrefreshed window would expire mid-run on any step that takes longer than the window.
  t.at = now;
  return { step: t.step, step_version: t.stepVersion, step_sha: t.stepSha,
           initiative: t.initiative, run: t.run };
}

/** The flow the call's initiative runs, cached briefly — the initiative's own `flow`, as
 * `initiative_open` recorded it.
 *
 * It was the TEAM's most recently installed flow, read from an install registry the platform
 * no longer keeps: a team running two flows had every row read as whichever was installed
 * last, and a call outside any initiative still got one. The initiative is what actually says
 * which flow is running.
 *
 * CONTEXT ONLY — NOT ATTRIBUTION. `plugin` / `plugin_version` on `zz.event` answer "which plugin
 * owns this call", resolved from the loaded skill; nothing may treat `flow` as the plugin. */
const flowCache = new Map<string, { flow: string; at: number }>();
const FLOW_TTL_MS = 60_000;

export async function flowFor(teamSlug: string | null, initiative: string | undefined): Promise<{ flow: string } | undefined> {
  if (!teamSlug || !initiative || !platformDbReady()) return undefined;
  const key = `${teamSlug}/${initiative}`;
  const now = Date.now();
  const hit = flowCache.get(key);
  if (hit && now - hit.at < FLOW_TTL_MS) return hit.flow ? { flow: hit.flow } : undefined;
  try {
    const { rows } = await platformDb().query<{ flow: string }>(
      `select i.flow from zz.initiative i join zz.team t on t.id = i.team_id
        where t.slug = $1 and i.slug = $2`, [teamSlug, initiative]);
    const flow = rows[0]?.flow ?? "";
    // ONLY A POSITIVE ANSWER IS CACHED, and the asymmetry is the whole point.
    //
    // An initiative's flow is decided at `initiative_open` and only there — the platform says
    // so in as many words and offers no way to adopt one afterwards — so a flow this lookup
    // HAS found cannot change under the cache, and sixty seconds of it costs nothing.
    //
    // An ABSENCE is the opposite: it is the answer for an initiative that does not exist YET,
    // and the next thing that happens is somebody creating it. Cached, it outlives the thing
    // it described and every call in the following minute is attributed as if the initiative
    // had no flow.
    //
    // THE FLOW'S OWN FIRST INSTRUCTION GUARANTEES THE MISS. sdlc-flow opens with "ask the
    // platform where the initiative stands before anything else", so the opening sequence is
    // `initiative_status` on a slug that does not exist, then `initiative_open`, then the
    // first `document_write` — and the whole sequence fits inside one TTL. Measured on this
    // deployment, driving that exact sequence: status at 0s poisoned the key, explore.md was
    // written at 29s and its event carries no step, and spec.md at 116s — past the TTL —
    // carries `sdlc-spec`. Same caller, same initiative, same document rule; the only
    // difference was the clock.
    //
    // `stepName` falls back to the traced skill when the manifest cannot answer, so this does
    // not lose the row — it loses the STAGE, silently, on exactly the calls that open a piece
    // of work.
    if (flow) flowCache.set(key, { flow, at: now });
    return flow ? { flow } : undefined;
  } catch {
    // A lookup failure must not cost the row. An event that vanishes because a side lookup
    // failed is a hole in the record, and the record is the thing being defended here.
    return undefined;
  }
}


/* ── a door's own version, from its own handshake ───────────────────────────── */

/** Every MCP server states its name and version at `initialize` — a protocol field it already
 * has to send, so a version costs no new contract and no new tool.
 *
 * KEYED BY THE DOOR, which is the change. This used to be keyed by BLOCK, and a "block" was
 * defined as any surface that was NOT one of ours — so the one case it could never record was
 * the platform's own. `/p/<block>/mcp` has since been deleted and there are no other surfaces,
 * which left the whole mechanism recording nothing at all while our own doors, which announce
 * their version on every handshake, went unrecorded.
 *
 * Observed on the handshake and remembered per door, then stamped on the calls, because the
 * handshake arrives on a different request from the calls it describes. */
const doorVersions = new Map<string, string>();

export function doorHandshake(door: string, servedBody: string): void {
  const m = /"serverInfo"\s*:\s*\{[^}]*?"version"\s*:\s*"([^"]{1,80})"/.exec(servedBody);
  if (m) doorVersions.set(door, m[1]);
}

export const doorVersion = (door: string): string | undefined => doorVersions.get(door);
