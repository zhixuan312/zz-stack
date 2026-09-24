/**
 * Which flow, and which step of it — decided at the door, stamped on the row.
 *
 * A `skill_read` says which skill the agent is following. Deciding that once, here, at the
 * moment of the call, is what keys attribution on the conversation rather than the person,
 * gives it an expiry, and leaves every reader the same answer instead of re-deriving it.
 *
 * A `skill_read` answer is hashed as it streams, so every call attributed to that step
 * carries the hash of the bytes the model was served — not the file on a laptop, not the
 * version in a manifest.
 *
 * DELIBERATE: this module does not identify people. Identity is used to correlate a skill
 * load with the calls that follow it and is never stored; what lands on the row is a flow, a
 * step and a version.
 */
import { createHash } from "node:crypto";

import { parseEnvelope } from "@zz/contracts";

import { platformDb, platformDbReady } from "./db.js";

/** How long a loaded skill still explains the calls that follow it. */
const FOLLOWS_FOR_MS = 45 * 60 * 1000;

/** A run is a conversation: the id rotates after the same idle window, which is what tells
 * one evaluation round from the next without the client cooperating. */
const RUN_IDLE_MS = FOLLOWS_FOR_MS;

interface Trace {
  /** Absent, never `""`, when this caller has named an initiative without reading a skill.
   * `??` does not coalesce an empty string, so one reaches `zz.event.step` verbatim and is
   * unjoinable to `zz.skill` while the index holds nulls. */
  step?: string;
  /** The initiative this caller is working on, carried forward from the last call that named
   * one — most calls do not take it, and without this a refusal cannot be joined to the
   * document it was made for.
   *
   * Absent, never `""`, for the same reason as `step` above. */
  initiative?: string;
  /** The team the initiative was named under, so it cannot be carried into another one. A
   * slug is unique per `(team_id, slug)`, not globally, and this Map is keyed by caller
   * alone. `initiative_status` on another team's initiative succeeds and teaches the trace
   * that slug, so a team switch is not the only way one arrives.
   *
   * DELIBERATE: withheld on a mismatch, not forgotten — switching away and back is what an
   * evaluation run does, and the initiative is still theirs when they return. */
  team?: string;
  /** Absent where nothing established them: a skill served whole carries its declared version
   *  and the hash of the bytes, a supporting file or a trace with no step carries neither. */
  stepVersion?: string;
  stepSha?: string;
  run: string;
  at: number;
}

/** The version a skill declares, read out of the frontmatter that `skill_read` serves. It is
 * a claim, orderable and citable; the hash recorded beside it is what makes the claim
 * checkable. */
const declaredVersion = (body: string): string =>
  // COUPLED: frontmatter is parsed by @zz/contracts' parseEnvelope, never by a regex here —
  // a second spelling of the fence disagrees with the first. It also takes the last value of
  // a repeated key and ignores a `version:` line in a document's prose.
  (parseEnvelope(body).version ?? "").replace(/^["']|["']$/g, "").trim();

/** Keyed by caller, held in memory, never written down. A restart loses the correlation for
 * conversations in flight, which costs the step on a few rows and nothing else.
 *
 * DELIBERATE: not persisted. A table of it would be a record of who was doing what. */
const traces = new Map<string, Trace>();

function sweep(now: number): void {
  // Bounded without a timer: a sweep on write costs one pass over entries already dead.
  if (traces.size < 512) return;
  for (const [k, t] of traces) if (now - t.at > FOLLOWS_FOR_MS) traces.delete(k);
}

const mint = (seed: string, now: number): string =>
  createHash("sha256").update(`${seed}:${Math.floor(now / RUN_IDLE_MS)}`).digest("hex").slice(0, 10);

/** The correlation key everything in this module is keyed by, spelled once.
 *
 * COUPLED: both readers — the telemetry writer and the proxy's stage check — call this
 * rather than building the key. A second spelling finds an empty trace and lets every call
 * through, which fails silently.
 *
 * DELIBERATE: read from the header, not from req.zzIdentity. identityMiddleware writes the
 * canonical address onto the header after authenticating, so the two agree today. */
export const callerKey = (headers: Record<string, unknown>): string =>
  `${String(headers["x-zz-user-email"] ?? "unknown")}\u0000${String(headers["x-zz-client"] ?? "")}`;

/** A skill was served. Everything this caller does next belongs to it.
 *
 * `whole` says whether the bytes are the skill, or a supporting file beside it —
 * `skill_read(name, file: "references/<file>.md")`. Both are the same step; only the first carries the
 * skill's version.
 *
 * A file inside the step already in progress changes nothing but the clock. A file for some
 * other skill sets the step with no version: nothing served that skill, so nothing told us
 * its version, and a supporting file's own frontmatter declares something else's version. */
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
    // A skill load does not change which initiative is being worked on. Undefined, never "",
    // when nothing has named one — see `Trace.initiative`.
    initiative: prior && now - prior.at <= FOLLOWS_FOR_MS ? prior.initiative : undefined,
    // The team travels with it: carrying the initiative forward without the team it was named
    // under is what lets it cross a team switch.
    team: prior && now - prior.at <= FOLLOWS_FOR_MS ? prior.team : undefined,
    // Only from the skill itself — a supporting file's frontmatter declares its own version.
    stepVersion: whole ? declaredVersion(servedBody) : undefined,
    // The bytes the model was handed, hashed. Twelve hex tells two versions of one skill
    // apart and is short enough to read in a table.
    stepSha: whole ? createHash("sha256").update(servedBody).digest("hex").slice(0, 12) : undefined,
    run,
    at: now,
  });
}

/** A call named an initiative, so the calls that follow it are about that one too. Most calls
 * do not take one as an argument, and without this a refusal cannot be joined to the document
 * it was made for. */
export function initiativeSeen(caller: string, initiative: string, team?: string): void {
  const now = Date.now();
  const t = traces.get(caller);
  if (t && now - t.at <= FOLLOWS_FOR_MS) { t.initiative = initiative; t.team = team; t.at = now; return; }
  sweep(now);
  // No step, rather than an empty one — see the note on `Trace.step`. This caller named an
  // initiative and has read no skill.
  traces.set(caller, { initiative, team, run: mint(caller, now), at: now });
}

/** The step this caller is following, or nothing if none is or the last one has expired. */
export function currentStep(caller: string, team?: string):
  { step?: string; step_version?: string; step_sha?: string; initiative?: string; run: string } | undefined {
  const t = traces.get(caller);
  if (!t) return undefined;
  const now = Date.now();
  if (now - t.at > FOLLOWS_FOR_MS) { traces.delete(caller); return undefined; }
  // Touched on read, so a step that takes longer than the window does not expire mid-run.
  t.at = now;
  // DELIBERATE: the step crosses a team switch and the initiative does not. Which skill
  // someone is following is a fact about them; a slug means something different, or nothing,
  // in the next team.
  return { step: t.step, step_version: t.stepVersion, step_sha: t.stepSha,
           initiative: t.team === team ? t.initiative : undefined, run: t.run };
}

/** The flow the call's initiative runs, cached briefly — the initiative's own `flow`, as
 * `initiative_open` recorded it.
 *
 * DELIBERATE: context only, not attribution. `plugin` / `plugin_version` on `zz.event` answer
 * which plugin owns a call, resolved from the loaded skill; nothing may treat `flow` as the
 * plugin. */
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
    // DELIBERATE: only a positive answer is cached, and the asymmetry is the point. A flow is
    // decided at `initiative_open` and there is no way to adopt one afterwards, so a hit
    // cannot go stale. A miss is the answer for an initiative that does not exist yet, and
    // the next thing that happens is somebody creating it — sdlc-flow's opening sequence is a
    // status call on an unopened slug, then the open, then the first write, all inside one
    // TTL. It fails quietly: `stepName` falls back to the traced skill, so the row survives
    // and only the stage is lost.
    if (flow) flowCache.set(key, { flow, at: now });
    return flow ? { flow } : undefined;
  } catch {
    // DELIBERATE: a lookup failure returns undefined rather than throwing. An event that
    // vanishes because a side lookup failed is a hole in the record.
    return undefined;
  }
}


/* A door's own version, from its own handshake. */

/** Every MCP server states its name and version at `initialize`, so a version costs no new
 * contract and no new tool.
 *
 * Keyed by the door, and remembered rather than read per call, because the handshake arrives
 * on a different request from the calls it describes. */
const doorVersions = new Map<string, string>();

export function doorHandshake(door: string, servedBody: string): void {
  const m = /"serverInfo"\s*:\s*\{[^}]*?"version"\s*:\s*"([^"]{1,80})"/.exec(servedBody);
  if (m) doorVersions.set(door, m[1]);
}

export const doorVersion = (door: string): string | undefined => doorVersions.get(door);
