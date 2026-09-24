/**
 * The semantic-assessment role: the bounded questions a flow's checkpoints ask, answered by the
 * typed service and recorded with their provenance.
 *
 * The nine families are `QUESTION_FAMILIES` in @zz/contracts. This file gives each one the
 * instruction the typed service is asked. Every family is a `noul` question — one probability
 * that the answer is yes — and what a checkpoint does with that probability is decided here, by
 * `readingOf`, never by the model.
 *
 * Two callers:
 *   - `source_add`, which asks `changes_commitment` and `repeats_finding` about an audit round the
 *     moment it lands, so `initiative_status` can route the next move on the answer;
 *   - the `assess` tool, which any stage uses to ask one family about one subject.
 *
 * Every answer is written twice, and each copy has one job:
 *   - `zz.assessment`, the provenance record: question, digest, requested and resolved model,
 *     identity assurance, probability, and the reading;
 *   - `<initiative>/_assessments/<source>.json` in the store, for an audit round. The next move
 *     is computed from store files, so it stays computable with no database.
 *
 * Absence is an answer. With no typed-service key the reading is `unavailable`, the reason is
 * recorded, and every caller carries on with its deterministic rule alone.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { QUESTION_FAMILIES } from "@zz/contracts";

import { ask, configured, NOT_CONFIGURED } from "./typed-service.js";
import { db } from "./platform-db.js";
import { Refusal } from "./refusal.js";

/** What the typed service is asked for each family. The state it answers over always carries a
 *  SUBJECT and usually a CONTEXT; the instruction says what "yes" means about the subject. */
export const FAMILY_INSTRUCTIONS: Readonly<Record<string, string>> = Object.freeze({
  evidence_relation:
    "Does the CONTEXT passage support the claim made in the SUBJECT? Yes only if the passage " +
    "actually supports it; contradicting, unclear or unrelated is no.",
  requirement_coverage:
    "Does the SUBJECT fully cover the requirement stated in the CONTEXT? Partial coverage, " +
    "omission or an unclear answer is no.",
  needs_fact:
    "Does resolving the gap named in the SUBJECT need a fact fetched from somewhere, rather than " +
    "analysis, a verification or a decision by a person?",
  needs_verification:
    "Does resolving the gap named in the SUBJECT need something checked or verified, rather than " +
    "a fact fetched, analysis or a decision by a person?",
  needs_analysis:
    "Does resolving the gap named in the SUBJECT need analysis or reasoning over material already " +
    "available, rather than a new fact, a verification or a decision by a person?",
  missing_user_input:
    "Is an input that only the person who owns this work can supply — a preference, a scope call, " +
    "a priority, an authority — still missing from the SUBJECT?",
  changes_commitment:
    "Would acting on the SUBJECT change something the CONTEXT records as already agreed or " +
    "committed to — its scope, a decision, an acceptance criterion or a stated constraint — " +
    "rather than only clarifying, correcting or completing it?",
  repeats_finding:
    "Does the SUBJECT mostly repeat findings already reported in the CONTEXT, rather than raising " +
    "new ones or confirming that earlier findings were fixed?",
  actionability:
    "Is the repair the SUBJECT proposes specific enough to carry out without asking its author " +
    "what they meant?",
});

// A family added to the contracts with no instruction here would be a checkpoint nobody can ask.
for (const f of QUESTION_FAMILIES) {
  if (!FAMILY_INSTRUCTIONS[f]) throw new Error(`semantic family ${f} has no instruction`);
}

/** Bumped whenever an instruction's wording changes; the digest pins the exact bytes too. */
const INSTRUCTION_VERSION = 1;

export function questionDigest(family: string): string {
  return createHash("sha256").update(`${family}\n${FAMILY_INSTRUCTIONS[family] ?? ""}`)
    .digest("hex").slice(0, 16);
}

/** How a probability is read. The platform's own convention, like the 0.5 cut the typed judge
 *  uses for a threshold line: no calibrated mapping exists for these questions, so the middle
 *  band is reported as `unclear` rather than forced to a side. */
export const READING_BANDS = Object.freeze({ no_below: 0.35, yes_above: 0.65 });

export function readingOf(probability: number | null): Assessment["reading"] {
  if (probability === null || !Number.isFinite(probability)) return "unavailable";
  if (probability > READING_BANDS.yes_above) return "yes";
  if (probability < READING_BANDS.no_below) return "no";
  return "unclear";
}

export interface Assessment {
  family: string;
  instruction_version: number;
  question_digest: string;
  reading: "yes" | "no" | "unclear" | "unavailable";
  probability: number | null;
  requested_model: string | null;
  resolved_model: string | null;
  identity_assurance: string | null;
  /** Why there is no reading, when there is none. */
  reason: string | null;
  initiative: string | null;
  /** What the assessment is about: a document, a source, a finding. */
  about: string | null;
  asked_by: string;
  asked_at: string;
}

/** Enough of each part to be read and no more: the typed service answers over one state string,
 *  and a whole document plus its history is not a bounded question. */
const MAX_PART = 24_000;
const clip = (s: string) => (s.length > MAX_PART ? `${s.slice(0, MAX_PART)}\n[… truncated]` : s);

/** Ask one family about one subject. An unavailable service is an answer, recorded with its
 *  reason; the only refusal is a family that does not exist. */
export async function assessFamily(opts: {
  family: string; subject: string; context?: string;
  initiative?: string | null; about?: string | null; askedBy: string;
}): Promise<Assessment> {
  const { family } = opts;
  if (!FAMILY_INSTRUCTIONS[family]) {
    throw new Refusal(`ERROR: "${family}" is not a registered question family — one of ${QUESTION_FAMILIES.join(", ")}`);
  }
  const base = {
    family, instruction_version: INSTRUCTION_VERSION, question_digest: questionDigest(family),
    requested_model: configured() ? `typesafe/${(process.env.TYPESAFE_MODEL || "jev-latest").trim()}` : null,
    initiative: opts.initiative ?? null, about: opts.about ?? null,
    asked_by: opts.askedBy, asked_at: new Date().toISOString(),
  };
  let out: Assessment;
  if (!configured()) {
    out = { ...base, reading: "unavailable", probability: null, resolved_model: null,
            identity_assurance: null, reason: NOT_CONFIGURED };
  } else {
    const state = (opts.context ? `CONTEXT:\n${clip(opts.context)}\n\n` : "") + `SUBJECT:\n${clip(opts.subject)}`;
    try {
      const answers = await ask(state, { [family]: { type: "noul", instructions: FAMILY_INSTRUCTIONS[family] } });
      const a = answers[family];
      const p = a?.readings.probability ?? null;
      out = { ...base, reading: readingOf(p), probability: p,
              resolved_model: a?.resolved_identity ?? null,
              identity_assurance: a?.identity_assurance ?? null, reason: null };
    } catch (err) {
      out = { ...base, reading: "unavailable", probability: null, resolved_model: null,
              identity_assurance: null,
              reason: err instanceof Error ? err.message.replace(/^ERROR:\s*/, "").slice(0, 300) : String(err) };
    }
  }
  await persistAssessment(out);
  return out;
}

/** The provenance row. Never throws: an answer in hand is not lost to a database hiccup. */
async function persistAssessment(a: Assessment): Promise<void> {
  try {
    const p = db();
    if (!p) return;
    await p.query(`
      insert into zz.assessment
        (family, instruction_version, question_digest, reading, probability, requested_model,
         resolved_model, identity_assurance, reason, initiative, about, asked_by, asked_at)
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [a.family, a.instruction_version, a.question_digest, a.reading, a.probability,
       a.requested_model, a.resolved_model, a.identity_assurance, a.reason, a.initiative,
       a.about, a.asked_by, a.asked_at]);
  } catch { /* the store copy is the one the next move reads */ }
}

/** Where an audit round's assessments live in the store. Underscore-prefixed, so no listing,
 *  index or document count treats it as a document. */
function assessmentFile(root: string, initiative: string, sourceFile: string): string {
  return join(root, initiative, "_assessments", sourceFile.replace(/\.md$/, ".json"));
}

export function writeRoundAssessments(root: string, initiative: string, sourceFile: string,
                                      assessments: Assessment[]): void {
  mkdirSync(join(root, initiative, "_assessments"), { recursive: true });
  writeFileSync(assessmentFile(root, initiative, sourceFile),
                JSON.stringify({ source: `sources/${sourceFile}`, assessments }, null, 2) + "\n");
}

/** One audit round's recorded assessments, keyed by family. Empty when none were taken. */
export function readRoundAssessments(root: string, initiative: string,
                                     sourceFile: string): Record<string, Assessment> {
  const file = assessmentFile(root, initiative, sourceFile);
  if (!existsSync(file)) return {};
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { assessments?: Assessment[] };
    return Object.fromEntries((parsed.assessments ?? []).map((a) => [a.family, a]));
  } catch { return {}; }
}
