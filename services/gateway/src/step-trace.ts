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
 *   which FLOW was running   — no. Recoverable only through the team's CURRENT install, so a
 *                              team that reinstalls rewrites its own history.
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
  step: string;
  /** The initiative this caller is working on, carried forward from the last call that named
   * one. It reached 254 of 510 rows on 2026-09-13, because most calls do not take it — and
   * without it a refusal cannot be joined to the document it was made for, which is the entire
   * left-hand side of the reconciliation between prediction and outcome. */
  initiative: string;
  stepVersion: string;
  stepSha: string;
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
    initiative: prior && now - prior.at <= FOLLOWS_FOR_MS ? prior.initiative : "",
    // ONLY FROM THE SKILL ITSELF. A supporting file's frontmatter is its own, not the
    // skill's — see the note above for what reading it out of one cost.
    stepVersion: whole ? declaredVersion(servedBody) : "",
    // The bytes the model was handed, hashed. Twelve hex is plenty to tell two versions of one
    // skill apart and short enough to read in a table.
    stepSha: whole ? createHash("sha256").update(servedBody).digest("hex").slice(0, 12) : "",
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
  traces.set(caller, { step: "", stepVersion: "", stepSha: "", initiative, run: mint(caller, now), at: now });
}

/** The step this caller is following, or nothing if none is or the last one has expired. */
export function currentStep(caller: string):
  { step: string; step_version: string; step_sha: string; initiative: string; run: string } | undefined {
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

/** The flow a team is running, cached briefly. Recorded per call so a later reinstall cannot
 * rewrite what an earlier call was doing — the failure the team-lookup-at-read-time has.
 *
 * TEAM CONTEXT ONLY — NOT ATTRIBUTION. This used to be the closest thing a row had to an
 * answer for "which plugin owns this call", and it was the wrong answer: `flow_install` names
 * the team's most recently installed flow, so a team running two flows has every row read as
 * whichever was installed last, and a call made while working a block usage skill (no flow
 * open at all) got nothing. `plugin` / `plugin_version` on `zz.event` (Task I-4) answer that
 * question properly, resolved from the loaded skill through `zz.plugin_version_skill` rather
 * than from this lookup. `flow` keeps its column and keeps being written — it is still real
 * team context, and `migrations-next/022_drop_denormalized.sql` is the migration that will
 * eventually remove it, once every reader has moved off it — but nothing may treat it as the
 * plugin, here or anywhere added after this comment. */
const flowCache = new Map<string, { flow: string; version: string; at: number }>();
const FLOW_TTL_MS = 60_000;

export async function flowFor(teamSlug: string | null): Promise<{ flow: string; flow_version: string } | undefined> {
  if (!teamSlug || !platformDbReady()) return undefined;
  const now = Date.now();
  const hit = flowCache.get(teamSlug);
  if (hit && now - hit.at < FLOW_TTL_MS) {
    return hit.flow ? { flow: hit.flow, flow_version: hit.version } : undefined;
  }
  try {
    const { rows } = await platformDb().query<{ flow: string; version: string }>(
      `select fi.flow, fi.version from zz.flow_install fi
         join zz.team t on t.id = fi.team_id
        where t.slug = $1 order by fi.created_at desc limit 1`, [teamSlug]);
    const flow = rows[0]?.flow ?? "";
    const version = rows[0]?.version ?? "";
    flowCache.set(teamSlug, { flow, version, at: now });
    return flow ? { flow, flow_version: version } : undefined;
  } catch {
    // A lookup failure must not cost the row. An event that vanishes because a side lookup
    // failed is a hole in the record, and the record is the thing being defended here.
    return undefined;
  }
}

/** WHICH PLUGIN OWNS THE SKILL A CALLER IS FOLLOWING — the attribution key itself (AC-1.5,
 * AC-1.6), and deliberately not derived from `flowFor` above or from `zz.flow_install`.
 *
 * The join is the one `plugin-profile.ts` already prefers for exactly this question —
 * `zz.plugin_version_skill` joined to `zz.plugin_version` and `zz.plugin` — except that join
 * starts from a `zz.run` row, and a run is reconciled from the event log on a timer
 * (`runs.ts`), not written at the moment a call happens. There is no run yet for the call this
 * function is being asked about, so the entry point here is the skill itself: the caller's
 * current step, resolved to a skill name, resolved to the version of it that was RELEASED at
 * the time of the call — same rule `runs.ts`'s `VERSION_AT_EVENT` uses, and for the same
 * reason: `skill_version` on a served skill is stamped only when the whole skill text was
 * served, so it is sparse, and a time-based lookup is right both for a declared version and
 * for the far more common case of none.
 *
 * Takes the ALREADY ALIAS-RESOLVED step name — `resolveStep` is the caller's job, once, on the
 * value it already has, not this function's, so a single step-name resolution rule keeps
 * living in one place (Task I-2's resolver).
 *
 * `plugin` IS DETERMINISTIC — a skill belongs to one plugin — `plugin_version` IS NOT, AND
 * THAT IS A GAP IN THE SCHEMA, NOT SOMETHING GUESSED AT HERE. `zz.plugin_version_skill` is
 * many-to-many: an untouched skill can ship unchanged in several plugin releases, so more than
 * one `plugin_version` row can match the one `skill_version_id` this resolves to, and
 * `zz.plugin_version` carries no timestamp to order candidates by the way `zz.skill_version`
 * does — `released_at` lives one table over. Ordered by `version` text as the best available
 * tiebreak, which is right for the common `x.y.z` shape and not a real ordering in general;
 * fixing it needs a column this migration does not add. */
const pluginCache = new Map<string, { plugin: string; version: string; at: number } | { at: number }>();
const PLUGIN_TTL_MS = 60_000;

export async function pluginFor(step: string | undefined): Promise<{ plugin: string; plugin_version: string } | undefined> {
  if (!step || !platformDbReady()) return undefined;
  const now = Date.now();
  const hit = pluginCache.get(step);
  if (hit && now - hit.at < PLUGIN_TTL_MS) {
    return "plugin" in hit ? { plugin: hit.plugin, plugin_version: hit.version } : undefined;
  }
  try {
    const { rows } = await platformDb().query<{ plugin: string; version: string }>(
      `select p.name as plugin, pv.version as version
         from zz.skill s
         join lateral (
                select v.id from zz.skill_version v
                 where v.skill_id = s.id and v.released_at <= now()
                 order by v.released_at desc limit 1
              ) sv on true
         join zz.plugin_version_skill pvs on pvs.skill_version_id = sv.id
         join zz.plugin_version pv on pv.id = pvs.plugin_version_id
         join zz.plugin p on p.id = pv.plugin_id
        where s.name = $1
        order by pv.version desc
        limit 1`, [step]);
    const row = rows[0];
    if (!row) { pluginCache.set(step, { at: now }); return undefined; }
    pluginCache.set(step, { plugin: row.plugin, version: row.version, at: now });
    return { plugin: row.plugin, plugin_version: row.version };
  } catch {
    // Unresolvable is a null on the row, never a guess — see the check's own comment on this.
    // A lookup failure must not cost the row either, for the same reason flowFor's does not.
    return undefined;
  }
}

/** The surfaces that are the platform's own. Anything else is a building block, and the
 * surface name IS the block — that is how `/p/<block>/mcp` is routed. */
// `eval` IS OURS. Every door this platform serves itself belongs in here, and the cost of
// forgetting one is not a mislabelled row: `blockOf` below answers "this call went to a
// building block called eval", so the evaluation door's own traffic would be recorded as a
// third party's, against a block nobody granted and no registry has ever heard of.
const PLATFORM_SURFACES = new Set(["core", "eval", "manage", "admin"]);

export const blockOf = (surface: string): string | undefined =>
  surface && !PLATFORM_SURFACES.has(surface) ? surface : undefined;


/* ── the block's own version, from its own handshake ────────────────────────── */

/** Every MCP server states its name and version at `initialize`. That is the block's own
 * account of what it is, given in a protocol field it already has to send — so a block
 * version costs no new contract, no new tool and nothing for a block team to adopt.
 *
 * Observed on the handshake and remembered per block, then stamped on every call to it, since
 * the handshake and the calls are separate requests. What the three connected blocks answer
 * today: rulemill `3.4.7`, bookit `3.4.7`, casebox `<a build timestamp>` — the last one a
 * build timestamp rather than a version, which is a real answer and a poor one, and now
 * visible as such rather than absent.
 */
const blockVersions = new Map<string, string>();

export function blockHandshake(block: string, servedBody: string): void {
  const m = /"serverInfo"\s*:\s*\{[^}]*?"version"\s*:\s*"([^"]{1,80})"/.exec(servedBody);
  if (m) blockVersions.set(block, m[1]);
}

export const blockVersion = (block: string): string | undefined => blockVersions.get(block);
