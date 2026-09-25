/**
 * FR-60 derivation itself (Task I-14): turning one closed initiative's own store material into
 * one immutable, chronologically ordered replay case. `replay-cases.ts` is the tool and the door
 * registration; this file is everything FR-60's seven rules actually do, kept separate so neither
 * file crosses the 700-line ceiling and so the registration module stays a thin MCP wrapper the
 * way `subject.ts`/`observe.ts` already are over their own resolvers.
 *
 * One evaluator, `replay.source_kind` (FR-60 rule 1), tells a source apart as `person_statement`
 * or `agent_record` — registered here the same way `discover.ts` registers `discover.owner_kind`:
 * inline, idempotent by content, no separate seeding step. Its qualification is read (or, when
 * none exists yet, established) through `qualify.ts`'s exported `gatherQualification` — the same
 * ladder `evaluator_qualify` runs, never a second copy of it.
 *
 * `deriveCase` builds ONE global, chronologically ordered event timeline per initiative — actor,
 * user_oracle and evaluation_oracle events share one `seq` sequence (migration 002's
 * `unique(case_id, seq)` has no per-visibility partition), which is what lets a candidate actor's
 * seq-0 row and its own later evaluation-oracle material sit in one real order rather than three
 * separate ones nothing ties together.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

import { documentBody, EVAL_STATE_ENUMS, parseEnvelope } from "@zz/contracts";
import type pg from "pg";

import { chainFor } from "../chain.js";
import { openRecord } from "../initiative-record.js";
import { safeName } from "../paths.js";
import { documentVersions } from "../versions.js";
import { canonicalJson } from "./idempotency.js";
import type { EvaluatorDefinition } from "./evaluators.js";
import type { KnownAnswers } from "./qualify-evidence.js";
import { askEvaluatorQuestion, type AskedEvaluatorAnswer } from "../semantic.js";
import {
  gatherQualification, resolveEvaluator as resolveEvaluatorStableKey, type GatheredQualification,
  type ProtocolContext,
} from "./qualify.js";

const sha256Hex = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");

// -------------------------------------------------------------------------------------------
// The evaluator: replay.source_kind (FR-60 rule 1).

const SOURCE_KIND_MEANING = Object.freeze({
  person_statement: "the person's own brief, decision, answer or preference",
  agent_record: "an audit round, an execution or review finding, a correction, or any other " +
    "record an agent produced",
});

/** FR-60 rule 1's own words, read to the evaluator as its `choice` criteria. Registered inline
 *  (see this file's header), idempotent by content the same way `discover.ts`'s OWNER_KIND_EVALUATOR
 *  is — calling `registerEvaluator` on every build costs one upsert-and-read-back, never a second
 *  version of this same question. */
export const SOURCE_KIND_EVALUATOR: EvaluatorDefinition = {
  stable_key: "replay.source_kind",
  kind: "choice",
  question:
    "Below is one piece of material attached to a closed initiative. A PERSON_STATEMENT is the " +
    "person's own brief, decision, answer or preference — something only they could have said. " +
    "An AGENT_RECORD is an audit round, an execution or review finding, a correction, or any " +
    "other record an agent produced about the work, never the person's own words. Which is this?",
  answer_schema: { type: "choice", criteria: SOURCE_KIND_MEANING },
  polarity: {},
  model_policy: {},
};

/** The evaluator's own known answers (qualify-evidence.ts `KnownAnswers`): no protocol measure
 *  defers to it, so no snapshot fact can anchor it, and without these its qualification stopped at
 *  `no_anchors` on every deployment — every case `not_replayable`, and no candidate anywhere ever
 *  had a validation case to replay. Each fault is its anchor's content in the other voice, so a
 *  reader answering from the topic rather than from who is speaking is caught. */
const SOURCE_KIND_KNOWN_ANSWERS: KnownAnswers = {
  anchors: [
    { subject: "TITLE: brief\n\nI want the monthly export to default to CSV. My team opens it in a " +
        "spreadsheet and nobody here reads JSON.", expected: "person_statement" },
    { subject: "TITLE: spec audit round 2\n\nAudit round 2 of spec.md: two blocking findings. FR-3 has no " +
        "acceptance criterion; the rollback section names no owner.", expected: "agent_record" },
  ],
  faults: [
    { subject: "TITLE: review note\n\nThe review recorded that the export was changed to default to CSV " +
        "after the implementation pass; tests were updated to match.", expected: "agent_record" },
    { subject: "TITLE: decision\n\nI have decided FR-3 does not need an acceptance criterion, and I will " +
        "own the rollback myself.", expected: "person_statement" },
  ],
  controls: [
    { subject: "TITLE: execution log\n\nTask 4 executed: build passed, 12 checks green, one retry on the " +
        "migration step.", notExpected: "person_statement" },
    { subject: "TITLE: answer\n\nYes — I'd rather ship it on Friday; my manager signed off on the risk.",
      notExpected: "agent_record" },
  ],
};

type SourceKind = "person_statement" | "agent_record";

// The literal state/status/visibility words this file writes, checked once against migration
// 002's own vocabulary (`EVAL_STATE_ENUMS`) — the same guard `discover.ts` runs over its own
// `CANDIDATE_STATUS` — so an enum edited without this file catches it here, at import, rather
// than as a constraint violation the first time a case is actually written.
const REPLAY_CASE_STATUSES = EVAL_STATE_ENUMS.replayCaseStatus as readonly string[];
const REPLAY_EVENT_VISIBILITIES = EVAL_STATE_ENUMS.replayEventVisibility as readonly string[];
for (const w of ["replayable", "not_replayable"]) {
  if (!REPLAY_CASE_STATUSES.includes(w)) throw new Error(`"${w}" is not in EVAL_STATE_ENUMS.replayCaseStatus`);
}
for (const w of ["actor", "user_oracle", "evaluation_oracle"]) {
  if (!REPLAY_EVENT_VISIBILITIES.includes(w)) throw new Error(`"${w}" is not in EVAL_STATE_ENUMS.replayEventVisibility`);
}

/** FR-60 rule 1: below `operationally_qualified`, no ask happens at all — "nothing enters
 *  user_oracle" is enforced by never asking, not by discarding an answer after the fact. Qualified,
 *  a tie (or an unavailable/off-vocabulary answer) resolves to `agent_record` — "an agent_record
 *  verdict wins ties" — the conservative side, since an agent_record source never becomes
 *  actor/user_oracle material a simulated person could be asked to repeat.
 *
 *  Asks and does not record: the answer is written by `deriveCase`, inside the caller's
 *  transaction, so a rolled-back build leaves no orphaned `zz.assessment` row behind. */
async function askSourceKind(
  evaluatorVersionId: string, qualified: boolean, subjectText: string, contextText: string, principal: string,
): Promise<{ kind: SourceKind; asked: AskedEvaluatorAnswer | null }> {
  if (!qualified) return { kind: "agent_record", asked: null };
  const asked = await askEvaluatorQuestion({
    evaluator_version_id: evaluatorVersionId, subject_text: subjectText, context: contextText, askedBy: principal,
  });
  const entries = Object.entries(asked.result.distribution ?? {});
  if (!entries.length) return { kind: "agent_record", asked };
  const [top] = entries.sort((a, b) =>
    b[1] - a[1] || (a[0] === "agent_record" ? -1 : b[0] === "agent_record" ? 1 : 0));
  return { kind: top[0] === "person_statement" ? "person_statement" : "agent_record", asked };
}

// -------------------------------------------------------------------------------------------
// Reading one initiative's own material off the store — the same files source_add/document_write/
// initiative_close already produced, read the way protocol.ts/versions.ts already read them.

interface SourceRow {
  readonly rel: string;
  readonly title: string;
  readonly contributedBy: string;
  readonly addedAt: string;
  readonly supports: readonly string[];
  readonly stage: string;
  readonly body: string;
}

function readSources(root: string, initiative: string): SourceRow[] {
  const dir = join(root, initiative, "sources");
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return [];
  return readdirSync(dir).filter((f) => f.endsWith(".md")).map((f): SourceRow => {
    const raw = readFileSync(join(dir, f), "utf8");
    const env = parseEnvelope(raw);
    return {
      rel: `${initiative}/sources/${f}`, title: env.title || f, contributedBy: env.contributed_by || "",
      addedAt: env.added_at || "", stage: env.stage || "", body: documentBody(raw),
      supports: (env.supports || "").split(",").map((s) => s.trim()).filter(Boolean),
    };
  }).sort((a, b) => a.addedAt.localeCompare(b.addedAt));
}

interface GatedDocEvent {
  readonly docName: string;
  readonly version: number;
  readonly approvedBy: string;
  readonly approvedAt: string;
  readonly body: string;
}

/** Every approved version of every document this initiative's own flow gates (FR-60 rule 4) —
 *  `chainFor` resolves the flow the same way `source_add`'s `governing` does, off `_open.json`
 *  when no document exists yet to declare one; a freeform initiative gates nothing, so this
 *  returns empty rather than guessing. */
function gatedDocumentEvents(root: string, initiative: string): { names: string[]; events: GatedDocEvent[] } {
  const chain = chainFor(root, `${initiative}/x.md`);
  const names = chain.documents.filter((d) => d.gate).map((d) => d.name);
  const events: GatedDocEvent[] = [];
  for (const name of names) {
    for (const v of documentVersions(root, `${initiative}/${name}`)) {
      const abs = join(root, v.rel);
      const body = existsSync(abs) ? documentBody(readFileSync(abs, "utf8")) : "";
      events.push({ docName: name, version: v.version, approvedBy: v.approved_by, approvedAt: v.approved_at, body });
    }
  }
  return { names, events };
}

interface ClosingInfo { readonly doc: string; readonly outcome: string; readonly closedAt: string; readonly closedBy: string }

/** The initiative's own closing document, found the way `initiative_close` leaves it: exactly one
 *  top-level `.md` file whose envelope carries `outcome` — never `sources/`, `_versions/` or
 *  `_open.json`, none of which `initiative_close` ever writes it to. */
function closingInfo(root: string, initiative: string): ClosingInfo | null {
  const dir = join(root, initiative);
  if (!existsSync(dir)) return null;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".md")) continue;
    const abs = join(dir, f);
    if (!statSync(abs).isFile()) continue;
    const env = parseEnvelope(readFileSync(abs, "utf8"));
    if (env.outcome) return { doc: f, outcome: env.outcome, closedAt: env.updated_at || "", closedBy: env.closed_by || "" };
  }
  return null;
}

interface InitiativeMaterial {
  readonly initiative: string;
  readonly sources: readonly SourceRow[];
  readonly gatedDocNames: readonly string[];
  readonly gatedDocEvents: readonly GatedDocEvent[];
  readonly closing: ClosingInfo | null;
}

export function buildMaterial(root: string, initiative: string): InitiativeMaterial {
  const gated = gatedDocumentEvents(root, initiative);
  return {
    initiative, sources: readSources(root, initiative), gatedDocNames: gated.names,
    gatedDocEvents: gated.events, closing: closingInfo(root, initiative),
  };
}

/** sha256 over the raw material every derived case is built from — sources, gated-document
 *  versions, the outcome, the protocol's own scoring content, which protocol version supplied
 *  it, and `replay.source_kind`'s own qualification state at build time. Two builds with the
 *  same digest for the same plugin describe the exact same case-set version (see
 *  `replay-cases.ts`'s reuse path).
 *
 *  The qualification state is IN the digest, deliberately, even though nothing about a source's
 *  own bytes moved: `qualified` decides whether classification runs at all (rule 1), so the same
 *  initiatives derive a materially different case before and after `replay.source_kind` crosses
 *  `operationally_qualified` — a build the moment it does must not silently keep serving the
 *  stale unqualified version forever, waiting for someone to also edit a source. An evaluator's
 *  own per-call answer (possibly non-deterministic) still never enters this digest — only the
 *  qualification STATE does — which is what keeps "rebuild over unchanged material reuses the
 *  version" and "rebuild over changed material creates a new one" both true and both testable
 *  live. */
export function materialDigest(
  materials: readonly InitiativeMaterial[], protocolVersionId: string, scoringPolicy: unknown,
  qualificationState: string,
): string {
  const perInitiative = [...materials].map((m) => ({
    initiative: m.initiative,
    sources: [...m.sources].map((s) => ({ rel: s.rel, digest: sha256Hex(`${s.addedAt}\n${s.contributedBy}\n${s.body}`) }))
      .sort((a, b) => a.rel.localeCompare(b.rel)),
    docs: [...m.gatedDocEvents].map((g) => ({
      doc: g.docName, version: g.version, digest: sha256Hex(`${g.approvedAt}\n${g.approvedBy}\n${g.body}`),
    })).sort((a, b) => a.doc === b.doc ? a.version - b.version : a.doc.localeCompare(b.doc)),
    outcome: m.closing ? sha256Hex(`${m.closing.outcome}\n${m.closing.closedAt}\n${m.closing.closedBy}`) : null,
  })).sort((a, b) => a.initiative.localeCompare(b.initiative));
  return sha256Hex(canonicalJson({
    protocolVersionId, scoring: canonicalJson(scoringPolicy ?? null), qualificationState, perInitiative,
  }));
}

// -------------------------------------------------------------------------------------------
// source_scope resolution (FR-60's own request shape).

export type SourceScope =
  | { readonly initiatives: readonly string[] }
  | { readonly flow: string; readonly closed_between: readonly [string, string] };

type ScopeResolution = { readonly initiatives: readonly string[] } | { readonly error: string };

export function resolveInitiatives(root: string, scope: SourceScope): ScopeResolution {
  if ("initiatives" in scope) {
    const out: string[] = [];
    for (const name of scope.initiatives) {
      const badName = safeName(name, "initiative");
      if (badName) return { error: badName };
      if (!existsSync(join(root, name))) return { error: `ERROR: no initiative named "${name}"` };
      if (!closingInfo(root, name)) {
        return { error: `ERROR: "${name}" is not closed — FR-60 derives a case from one closed initiative only` };
      }
      out.push(name);
    }
    return { initiatives: out };
  }
  const [from, to] = scope.closed_between;
  const out: string[] = [];
  for (const entry of existsSync(root) ? readdirSync(root, { withFileTypes: true }) : []) {
    if (!entry.isDirectory() || entry.name.startsWith(".") || entry.name.startsWith("_")) continue;
    const rec = openRecord(root, entry.name);
    if (!rec?.flow || rec.flow.split("@")[0].trim() !== scope.flow) continue;
    const closing = closingInfo(root, entry.name);
    if (!closing || closing.closedAt < from || closing.closedAt > to) continue;
    out.push(entry.name);
  }
  return { initiatives: out.sort() };
}

// -------------------------------------------------------------------------------------------
// Qualification: read the current state, or establish it once (FR-60 rule 1's own carve-out).

/** `EVAL_STATE_ENUMS.qualificationState`'s own order (`qualify-ladder.ts`'s ladder climbs it
 *  bottom-up in exactly this order) — derived from the enum itself, not restated. */
const QUALIFICATION_RANK: Readonly<Record<string, number>> = Object.freeze(
  Object.fromEntries(EVAL_STATE_ENUMS.qualificationState.map((s, i) => [s, i])),
);

export function meetsOperational(state: string): boolean {
  return (QUALIFICATION_RANK[state] ?? -1) >= QUALIFICATION_RANK.operationally_qualified;
}

/** The newest recorded state, or null when there is none — or when the newest one is the
 *  `no_anchors` row every build recorded before this evaluator had known answers of its own. That
 *  row measured nothing, and read as-is it would keep a protocol's cases unreplayable forever. */
async function currentQualificationState(
  p: pg.Pool, protocolVersionId: string, evaluatorVersionId: string,
): Promise<string | null> {
  const row = (await p.query<{ state: string; reason: string | null }>(`
    select state, evidence->>'reason' as reason from zz.eval_evaluator_qualification
     where evaluator_version_id = $1::uuid and protocol_version_id = $2::uuid
     order by qualified_at desc limit 1`, [evaluatorVersionId, protocolVersionId])).rows[0];
  if (!row || row.reason === "no_anchors") return null;
  return row.state;
}

/** FR-60 rule 1, in full: read the evaluator's current qualification against this protocol
 *  version; if none has ever been recorded, run the qualification ladder once (through
 *  `qualify.ts`'s own `gatherQualification` — never a second copy of it) so a fresh protocol is
 *  not permanently stuck reporting a state nobody ever computed. An EXISTING qualification, of
 *  whatever state, is read as-is and never re-run here — re-qualifying on every build would make
 *  `replay_case_set_build` a second, uninvited caller of `evaluator_qualify`'s own job.
 *
 *  Asks and does not record, the same split as `classifyMaterial`: a fresh run comes back as
 *  `pending`, and the caller writes it with `recordQualification` inside its own ledger
 *  transaction. `establish: false` (a replayed build) never asks at all — it reads what exists
 *  and answers the ladder's bottom rung when nothing does. */
export async function resolveQualification(
  p: pg.Pool, protocolVersionId: string, evaluatorVersionId: string, protocol: ProtocolContext,
  principal: string, establish: boolean,
): Promise<{ state: string; pending: GatheredQualification | null }> {
  const existing = await currentQualificationState(p, protocolVersionId, evaluatorVersionId);
  if (existing !== null) return { state: existing, pending: null };
  if (!establish) return { state: EVAL_STATE_ENUMS.qualificationState[0], pending: null };
  const stableKey = await resolveEvaluatorStableKey(p, evaluatorVersionId) ?? SOURCE_KIND_EVALUATOR.stable_key;
  // No measure: the source-kind evaluator is the platform's own, never one a protocol measure
  // defers to, so it is qualified against its own known answers rather than snapshot facts.
  const pending = await gatherQualification(
    p, protocolVersionId, evaluatorVersionId, null, protocol, stableKey, principal, SOURCE_KIND_KNOWN_ANSWERS);
  return { state: pending.state, pending };
}

// -------------------------------------------------------------------------------------------
// One case's chronological timeline (FR-60 rules 2-7) and its digest.

interface TimelineEntry {
  readonly timestamp: string;
  readonly priority: number; // tie-break at equal timestamp: actor(0) < user_oracle(1) < evaluation_oracle(2, or 3 for content with no natural date)
  readonly actor: string;
  readonly visibility: "actor" | "user_oracle" | "evaluation_oracle";
  readonly kind: string;
  readonly payload: Record<string, unknown>;
  readonly digestBasis: string;
}

interface DerivedEvent {
  readonly seq: number;
  readonly actor: string;
  readonly visibility: "actor" | "user_oracle" | "evaluation_oracle";
  readonly kind: string;
  readonly payload: Record<string, unknown>;
  readonly payloadDigest: string;
}

export interface DerivedCase {
  readonly initiative: string;
  readonly caseDigest: string;
  readonly status: "replayable" | "not_replayable";
  readonly notReplayableReason: "source_kind_unqualified" | "no_person_statement" | null;
  readonly userOracleCoverage: number;
  readonly decisionsOnlyInDocuments: boolean;
  readonly events: readonly DerivedEvent[];
}

const byTimestampThenPriority = (a: TimelineEntry, b: TimelineEntry): number =>
  a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : a.priority - b.priority;

/** Rule 1 for one initiative: every source's kind, asked of the evaluator when qualified.
 *  Every model call a build makes happens here, BEFORE the caller opens its transaction — each
 *  ask can take ~100s, and a transaction held across them pins one of the pool's few
 *  connections. Nothing is written; `deriveCase` records the answers inside the transaction. */
export interface ClassifiedMaterial {
  readonly material: InitiativeMaterial;
  readonly sources: readonly { readonly kind: SourceKind; readonly asked: AskedEvaluatorAnswer | null }[];
}

export async function classifyMaterial(
  material: InitiativeMaterial, evaluatorVersionId: string, qualified: boolean, principal: string,
): Promise<ClassifiedMaterial> {
  const sources: { kind: SourceKind; asked: AskedEvaluatorAnswer | null }[] = [];
  for (const s of material.sources) {
    sources.push(await askSourceKind(
      evaluatorVersionId, qualified, `${s.title}\n\n${s.body}`,
      `Material attached to closed initiative "${material.initiative}".`, principal));
  }
  return { material, sources };
}

/** One initiative's material, turned into one case (FR-60 rules 2-7). Classification (rule 1) is
 *  already decided — `classifyMaterial` asked before the transaction — so the only I/O here is
 *  `record`, which writes each answer through the caller's transaction and returns its id.
 *
 * `payload` carries provenance (`assessment_id`, the classification's own reason) that a rebuild
 * over UNCHANGED material can legitimately answer differently — a fresh model call is not
 * guaranteed byte-identical the second time. `digestBasis` never includes it: `case_digest` is
 * built only from the material itself, so `assignSplits`'s ordering (keyed on `case_digest`) does
 * not drift with the evaluator's own call-to-call variance. */
export async function deriveCase(
  input: ClassifiedMaterial, record: (asked: AskedEvaluatorAnswer) => Promise<number>, qualified: boolean,
  scoringPolicy: unknown, protocolVersionId: string,
): Promise<DerivedCase> {
  const { material } = input;
  const classified: (SourceRow & { kind: SourceKind; assessmentId: number | null })[] = [];
  for (const [i, s] of material.sources.entries()) {
    const { kind, asked } = input.sources[i];
    classified.push({ ...s, kind, assessmentId: asked ? await record(asked) : null });
  }
  const personSources = classified.filter((s) => s.kind === "person_statement")
    .sort((a, b) => a.addedAt.localeCompare(b.addedAt));
  const agentSources = classified.filter((s) => s.kind === "agent_record");

  const timeline: TimelineEntry[] = [];

  // Rule 2: the earliest person_statement source, and ONLY it, is actor-visible at seq 0.
  if (qualified && personSources.length) {
    const earliest = personSources[0];
    timeline.push({
      timestamp: earliest.addedAt, priority: 0, actor: earliest.contributedBy || "unknown", visibility: "actor",
      kind: "person_statement",
      payload: { source: earliest.rel, title: earliest.title, body: earliest.body, added_at: earliest.addedAt },
      digestBasis: `actor\n${earliest.rel}\n${earliest.body}`,
    });
  }

  // Rule 3: EVERY person_statement source, including the earliest, also becomes a user_oracle
  // row carrying its original timestamp in payload.original_at.
  if (qualified) {
    for (const s of personSources) {
      timeline.push({
        timestamp: s.addedAt, priority: 1, actor: s.contributedBy || "unknown", visibility: "user_oracle",
        kind: "person_statement",
        payload: { source: s.rel, title: s.title, body: s.body, original_at: s.addedAt },
        digestBasis: `user_oracle\n${s.rel}\n${s.body}`,
      });
    }
  }

  // Rule 4: gated documents at their approved versions, the outcome, every agent_record source
  // and the protocol's scoring annotations — all evaluation_oracle, in original chronological
  // order. Rule 5 (a gated document's body never enters user_oracle) holds by construction: this
  // is the only place a document's body is ever read into an event, and it is always tagged
  // evaluation_oracle.
  for (const g of material.gatedDocEvents) {
    timeline.push({
      timestamp: g.approvedAt || "0", priority: 2, actor: g.approvedBy || "unknown", visibility: "evaluation_oracle",
      kind: "approved_document",
      payload: { document: g.docName, version: g.version, approved_by: g.approvedBy, approved_at: g.approvedAt, body: g.body },
      digestBasis: `approved_document\n${g.docName}\n${g.version}\n${g.body}`,
    });
  }
  for (const s of agentSources) {
    timeline.push({
      timestamp: s.addedAt, priority: 2, actor: s.contributedBy || "unknown", visibility: "evaluation_oracle",
      kind: "agent_record",
      payload: { source: s.rel, title: s.title, stage: s.stage, body: s.body, added_at: s.addedAt, assessment_id: s.assessmentId },
      digestBasis: `agent_record\n${s.rel}\n${s.body}`,
    });
  }
  if (material.closing) {
    timeline.push({
      timestamp: material.closing.closedAt || "9", priority: 2, actor: material.closing.closedBy || "unknown",
      visibility: "evaluation_oracle", kind: "outcome",
      payload: { document: material.closing.doc, outcome: material.closing.outcome },
      digestBasis: `outcome\n${material.closing.outcome}`,
    });
  }
  if (scoringPolicy !== null && scoringPolicy !== undefined) {
    // No natural date of its own — a protocol's content, not a moment in the initiative's
    // history — so it is placed last (priority 3, beyond every other evaluation_oracle row at
    // the same timestamp) rather than guessed into the middle of the timeline.
    const lastTimestamp = timeline.length ? [...timeline].sort(byTimestampThenPriority).at(-1)!.timestamp : "9";
    timeline.push({
      timestamp: lastTimestamp, priority: 3, actor: "protocol", visibility: "evaluation_oracle",
      kind: "scoring_annotations", payload: { protocol_version_id: protocolVersionId, scoring_policy: scoringPolicy },
      digestBasis: `scoring_annotations\n${protocolVersionId}\n${canonicalJson(scoringPolicy)}`,
    });
  }

  timeline.sort(byTimestampThenPriority);
  const events: DerivedEvent[] = timeline.map((e, seq) => ({
    seq, actor: e.actor, visibility: e.visibility, kind: e.kind, payload: e.payload,
    payloadDigest: sha256Hex(e.digestBasis),
  }));
  const caseDigest = sha256Hex(events.map((e) => e.payloadDigest).join("\n"));

  const userOracleCoverage = personSources.length;
  // Rule 6: no gated document of the initiative CITES (via `supports`) a person_statement source.
  const decisionsOnlyInDocuments = !personSources.some((s) => s.supports.some((d) => material.gatedDocNames.includes(d)));

  let status: DerivedCase["status"] = "replayable";
  let notReplayableReason: DerivedCase["notReplayableReason"] = null;
  if (!qualified) { status = "not_replayable"; notReplayableReason = "source_kind_unqualified"; }
  else if (userOracleCoverage === 0) { status = "not_replayable"; notReplayableReason = "no_person_statement"; }

  return { initiative: material.initiative, caseDigest, status, notReplayableReason, userOracleCoverage, decisionsOnlyInDocuments, events };
}
