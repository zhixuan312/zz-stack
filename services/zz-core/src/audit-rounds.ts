/**
 * Audit rounds: which sources are rounds, what each round read, and what the next move is once
 * a round has landed.
 *
 * A flow declares an audit as a stage that produces a source supporting the document it audits
 * (sdlc-flow: `sdlc-spec-audit` supports spec.md, `sdlc-plan-audit` supports plan.md). A source is
 * a round of that stage only when it names the stage — `source_add(..., stage)` — and supports
 * that document. Everything else supporting the document is material: a stakeholder's answers,
 * a decision taken elsewhere.
 *
 * How many rounds is a question of evidence, not of a count. `ROUND_BUDGET` is a resource limit
 * and never a pass criterion:
 *   - no round yet                         -> the first round is owed
 *   - the latest round read an older version -> the revision it caused is checked by another round
 *   - the latest round reopens an agreement  -> the stakeholder decides, before anything proceeds
 *   - the budget is spent and the latest revision is unaudited -> the stakeholder decides
 *   - the latest round read the current version and reopened nothing -> the audit is settled
 * A stakeholder's decision is recorded as material supporting the document after the round,
 * which is what settles the two waiting states.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { ENVELOPE_BLOCK, parseEnvelope } from "@zz/contracts";

import { assessFamily, readRoundAssessments, writeRoundAssessments } from "./semantic.js";
import type { Chain } from "./write-guards.js";

const stripEnvelope = (s: string): string => s.replace(ENVELOPE_BLOCK, "");

/** Rounds an audit may use before the stakeholder decides. The approved control-loop design:
 *  "up to three independent auditor dispatches as a provisional resource limit, never as a
 *  pass criterion". */
export const ROUND_BUDGET = 3;

/** The audit stage and audited document this source is a round of, or null when it is not a
 *  round: no stage named, or a stage that is not one producing a source supporting a listed
 *  document. */
export function auditRoundOf(chain: Chain, stage: string | undefined,
                             supports: string[]): { stage: string; document: string } | null {
  if (!stage) return null;
  const st = chain.stages.find((s) => s.name === stage && s.produces === "source");
  const doc = st && "supports" in st ? st.supports : undefined;
  return doc && supports.includes(doc) ? { stage, document: doc } : null;
}

interface Round { file: string; version: number; added_at: string }

const supportsOf = (env: Record<string, string>) =>
  (env.supports || "").split(",").map((x) => x.trim()).filter(Boolean);

/** The rounds of one audit stage on one document, oldest first. */
function roundsOf(dir: string, stage: string, document: string): Round[] {
  const src = join(dir, "sources");
  if (!existsSync(src)) return [];
  const out: Round[] = [];
  for (const f of readdirSync(src).filter((x) => x.endsWith(".md"))) {
    const env = parseEnvelope(readFileSync(join(src, f), "utf8"));
    if (env.stage !== stage || !supportsOf(env).includes(document)) continue;
    out.push({ file: f, version: Number(env.audits_version) || 1, added_at: env.added_at || "" });
  }
  return out.sort((a, b) => a.added_at.localeCompare(b.added_at) || a.file.localeCompare(b.file));
}

/** Material supporting the document that landed after a given moment and is not itself a round:
 *  where a stakeholder's decision on a round is recorded. */
function decidedSince(dir: string, document: string, since: string): boolean {
  const src = join(dir, "sources");
  if (!existsSync(src)) return false;
  return readdirSync(src).filter((x) => x.endsWith(".md")).some((f) => {
    const env = parseEnvelope(readFileSync(join(src, f), "utf8"));
    return !env.stage && supportsOf(env).includes(document) && (env.added_at || "") > since;
  });
}

/**
 * Ask the one question an audit round's routing depends on — does it reopen something already
 * agreed — record it, and say what came back. Runs inside `source_add`; an unavailable service is
 * recorded as such and the deterministic rule routes alone.
 *
 * DELIBERATE: `repeats_finding` is not asked. No move depends on it: a round on the current
 * version that reopens nothing already settles, and a revision after the last round owes a round
 * whether or not that round repeated the one before — its findings are what the revision answered.
 */
export async function assessRound(root: string, initiative: string, rel: string, document: string,
                                  content: string, by: string): Promise<string> {
  const dir = join(root, initiative);
  const file = rel.split("/").pop() ?? rel;
  const agreed = existsSync(join(dir, document)) ? stripEnvelope(readFileSync(join(dir, document), "utf8")) : "";
  const answer = await assessFamily({ family: "changes_commitment", subject: content, context: agreed,
                                      initiative, about: `sources/${file}`, askedBy: by });
  writeRoundAssessments(root, initiative, file, [answer]);
  return `assessed: ${answer.family} = ${answer.reading}` +
    (answer.probability !== null ? ` (p=${answer.probability.toFixed(2)})` : "") +
    (answer.reason ? ` — ${answer.reason}` : "");
}

interface AuditMove { action: string; document: string; waiting_on: string; why: string }

/**
 * The next move an audited document owes, or null when its audit is settled.
 * `version` is the document as it stands; the caller has already routed a document awaiting
 * approval, so this is asked only of an approved one.
 */
export function auditMove(root: string, initiative: string, stage: string, document: string,
                          version: number): AuditMove | null {
  const dir = join(root, initiative);
  const rounds = roundsOf(dir, stage, document);
  const call = `source_add(initiative: "${initiative}", title, content, supports: ["${document}"], stage: "${stage}")`;
  if (!rounds.length) {
    // NOT A TOOL: `add_source` is next_move's own vocabulary; the call is source_add, named in `why`.
    return { action: "add_source", document, waiting_on: "agent",
             why: `${stage} is the next stage this flow declares and no round of it exists yet. ` +
                  `Dispatch round 1 on ${document} v${version}, then record it with ${call}. ` +
                  "Only a source naming its stage counts as a round." };
  }
  const last = rounds[rounds.length - 1];
  const n = rounds.length;
  const a = readRoundAssessments(root, initiative, last.file);
  const reopens = a.changes_commitment?.reading === "yes";
  const decided = decidedSince(dir, document, last.added_at);
  if (reopens && last.version === version && !decided) {
    return { action: "decide", document, waiting_on: "stakeholder",
             why: `round ${n} (${last.file}) reopens something ${document} records as agreed ` +
                  `(changes_commitment p=${a.changes_commitment.probability?.toFixed(2)}). That is the ` +
                  `stakeholder's to decide, not the audit's: if they change the agreement, ` +
                  `document_revise ${document} citing sources/${last.file}; if they keep it, record ` +
                  `their decision with source_add(supports: ["${document}"]) and the audit continues.` };
  }
  if (last.version < version) {
    if (n < ROUND_BUDGET) {
      // NOT A TOOL: `add_source` is next_move's own vocabulary; the call is source_add, named in `why`.
      return { action: "add_source", document, waiting_on: "agent",
               why: `${document} is v${version}; round ${n} read v${last.version}. ` +
                    `Round ${n + 1} checks the revision — dispatch it, then ${call}.` };
    }
    if (!decided) {
      return { action: "decide", document, waiting_on: "stakeholder",
               why: `${ROUND_BUDGET} rounds of ${stage} are spent and ${document} v${version} — the ` +
                    `revision after round ${n} — has not been audited. The budget is a resource ` +
                    "limit, not a pass: the stakeholder decides whether v" + version + " proceeds " +
                    `unaudited or ${document} goes back to its stage. Record the decision with ` +
                    `source_add(supports: ["${document}"]).` };
    }
  }
  return null;
}
