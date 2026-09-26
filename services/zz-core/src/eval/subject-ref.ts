/**
 * Resolving a `subject_ref` (Task I-20, the defect found ahead of this task: `evaluation_assess`
 * asked a model-backed measure about the templated sentence `Measure "<key>" against subject_ref
 * "<id>"` — a sentence with no content in it at all, the exact defect `replay-score.ts`'s own
 * `producedSubjectText` already closed for a replay run. `resolveSubjectRef` closes the other
 * path, `evaluation_assess`'s own `eval_run`, the same way: what a model-backed measure is
 * actually asked to judge, resolved from the ref alone, never a sentence naming it.
 *
 * Three shapes an `eval_run`'s own `subject_ref` can take:
 *   - `<initiative>/<doc>.md` — a governed document, read off the artifact store the way
 *     `findings-doc.ts` writes one and `bodyOf` below reads one, team-scoped. One under
 *     `_knowledge/` is a knowledge node, and resolves as that kind;
 *   - `bug:<uuid>` — a bug report, rendered from its own `zz.bug` row;
 *   - a bare UUID — a `zz.event.run_id`, rendered from its own `zz.event` rows through
 *     `judge-trace.ts`'s `traceOf`, the platform's one existing "render a run as text" function —
 *     never a second renderer invented here.
 *
 * A `subject_ref` that resolves to neither — no such document on disk, no `zz.event` row for
 * that `run_id` — REFUSES BY NAME (this task's own contract clause): a model asked to judge
 * nothing silently invents the templated sentence instead, which is exactly the defect this file
 * exists to close, so resolving to nothing is never treated as "score it excluded" the way an
 * unqualified evaluator's answer is.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { ARTIFACTS_DIR } from "@zz/indexing";
import type pg from "pg";

import type { SubjectKind } from "./evaluate-measures.js";
import { traceOf } from "./judge-trace.js";
import { sanitize } from "../paths.js";

/** A governed document's body, out of the artifact store. Resolved here and never passed in, which
 *  keeps what a measure is asked to judge out of the conversation: the caller names a ref. */
function bodyOf(team: string, initiative: string, path: string): string | null {
  try {
    const f = join(ARTIFACTS_DIR, "teams", sanitize(team), initiative, path);
    return existsSync(f) ? readFileSync(f, "utf8") : null;
  } catch { return null; }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface ResolvedSubject {
  readonly text: string;
  readonly kind: SubjectKind;
}

/** A malformed or absent `<initiative>/<doc>.md` split reads as "not a document ref" rather than
 *  throwing — `resolveSubjectRef` below is what turns "neither shape resolved" into the one
 *  refusal text, so every dead end funnels through one message rather than several. */
function splitDocumentRef(ref: string): { initiative: string; docPath: string } | null {
  if (!ref.endsWith(".md")) return null;
  const slash = ref.indexOf("/");
  if (slash <= 0 || slash === ref.length - 1) return null;
  return { initiative: ref.slice(0, slash), docPath: ref.slice(slash + 1) };
}

/** One `subject_ref`, resolved to the text a model-backed measure is actually asked to judge, or
 *  the named refusal `evaluation_assess` returns instead of scoring nothing. `team` is the
 *  caller's own team (`teamFor(principal)`, the same resolution `findings-doc.ts` uses) — a
 *  document ref is read from THAT team's artifact store, never a caller-supplied team, so a
 *  measure can never be pointed at another team's documents through subject_ref alone. */
export async function resolveSubjectRef(
  p: pg.Pool, team: string | null, subjectRef: string,
): Promise<ResolvedSubject | { readonly error: string }> {
  if (UUID_RE.test(subjectRef)) {
    const total = Number((await p.query<{ n: string }>(
      "select count(*) as n from zz.event where run_id = $1::uuid", [subjectRef])).rows[0]?.n ?? 0);
    if (total === 0) {
      return {
        error: `ERROR: subject_ref "${subjectRef}" names no zz.event row for run_id — nothing to judge`,
      };
    }
    const trace = await traceOf(p, subjectRef);
    return { text: `RUN ${subjectRef}:\n${trace.text}`, kind: "run" };
  }

  if (subjectRef.startsWith("bug:")) {
    const id = subjectRef.slice("bug:".length);
    const bug = UUID_RE.test(id)
      ? (await p.query<{ title: string; detail: string; impact: string; status: string; surface: string | null }>(
          "select title, detail, impact, status, surface from zz.bug where id = $1::uuid", [id])).rows[0]
      : undefined;
    if (!bug) return { error: `ERROR: subject_ref "${subjectRef}" names no bug report — nothing to judge` };
    return {
      text: `BUG REPORT ${id} (${bug.impact}, ${bug.status}${bug.surface ? `, ${bug.surface}` : ""}):\n` +
        `${bug.title}\n\n${bug.detail}`,
      kind: "bug",
    };
  }

  const doc = splitDocumentRef(subjectRef);
  if (doc) {
    if (!team) {
      return {
        error: `ERROR: subject_ref "${subjectRef}" names a document and this caller resolves to ` +
          "no team — a document ref can only be read from the caller's own artifact store",
      };
    }
    const body = bodyOf(team, doc.initiative, doc.docPath);
    if (body === null) {
      return {
        error: `ERROR: subject_ref "${subjectRef}" names no document at ${doc.initiative}/${doc.docPath} ` +
          `in team "${team}"'s artifact store — nothing to judge`,
      };
    }
    return { text: body, kind: doc.initiative === "_knowledge" ? "knowledge" : "document" };
  }

  return {
    error: `ERROR: subject_ref "${subjectRef}" is neither a known run_id nor an ` +
      "<initiative>/<doc>.md document path — nothing to judge",
  };
}
