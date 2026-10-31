/**
 * Resolving a `subject_ref` for `evaluation_assess`'s own `eval_run`: what a model-backed measure
 * is actually asked to judge, resolved from the ref alone, never a templated sentence naming it
 * (`Measure "<key>" against subject_ref "<id>"` has no content in it at all).
 *
 * Three shapes an `eval_run`'s own `subject_ref` can take:
 *   - `<initiative>/<doc>.md` — a governed document, read from `zz.doc`/`zz.doc_revision` the
 *     way `findings-doc.ts` writes one, team-scoped. One under `_knowledge/` is a knowledge
 *     node, and resolves as that kind from `zz.knowledge_node`;
 *   - `bug:<uuid>` — a bug report, rendered from its own `zz.bug` row;
 *   - a bare UUID — a `zz.event.run_id`, rendered from its own `zz.event` rows through
 *     `judge-trace.ts`'s `traceOf`, the platform's one existing "render a run as text" function —
 *     never a second renderer invented here.
 *
 * A `subject_ref` that resolves to neither — no such document row, no `zz.event` row for
 * that `run_id` — REFUSES BY NAME: a model asked to judge nothing silently judges the templated
 * sentence instead, which is exactly what this file exists to prevent, so resolving to nothing is never treated as "score it excluded" the way an
 * unqualified evaluator's answer is.
 */
import type pg from "pg";

import { ZZ_TZ } from "../write-guards.js";

import { KNOWLEDGE_TEAM } from "../paths.js";
import { loadDocument } from "../versions.js";

import type { SubjectKind } from "./evaluate-measures.js";
import { UUID_RE } from "./idempotency.js";
import { traceOf } from "./judge-trace.js";

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

/** The node a `_knowledge/nodes/<ordinal>-<slug>.md` ref names, or null. `knowledge_search`
 *  answers both shelves under that one spelling, and each shelf numbers its nodes from one, so the
 *  slug is matched as well as the ordinal and the caller's own shelf is read before the platform's.
 *
 *  COUPLED: `evaluate-run.ts` pins the assessment to this row's id, so the text judged and the row
 *  recorded are one node. */
export async function knowledgeNodeAt(
  p: pg.Pool, team: string, ref: string,
): Promise<{ id: string; title: string; body: string } | null> {
  const named = /^_knowledge\/nodes\/(\d+)-(.+)\.md$/.exec(ref);
  if (!named) return null;
  return (await p.query<{ id: string; title: string; body: string }>(
    `select k.id::text as id, k.title, k.body from zz.knowledge_node k
       join zz.team t on t.id = k.team_id
      where t.slug in ($1, $2) and k.node_ordinal = $3 and k.slug = $4
      order by t.slug = $1 desc limit 1`,
    [team, KNOWLEDGE_TEAM, named[1], named[2]])).rows[0] ?? null;
}

/** One `subject_ref`, resolved to the text a model-backed measure is actually asked to judge, or
 *  the named refusal `evaluation_assess` returns instead of scoring nothing. `team` is the
 *  caller's own team (`teamFor(principal)`, the same resolution `findings-doc.ts` uses) — a
 *  document ref is read from THAT team's own store, never a caller-supplied team, so a
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

  // One door call, for a call that belongs to no run — an admin act on /manage, an evaluation on
  // /eval — whose refusal a judge is asked about: the tool, what it acted on, and what it answered.
  const event = /^event:(\d+)$/.exec(subjectRef);
  if (event) {
    const row = (await p.query<{ at: string; tool: string; target: string; ok: boolean | null; refusal: string | null; shapes: string | null }>(`
      select to_char(e.ts at time zone $2, 'YYYY-MM-DD HH24:MI:SS') as at, coalesce(e.tool_key, e.subject) as tool,
             coalesce((select string_agg(v.key || '=' || left(v.value, 120), ' ' order by v.key)
                         from jsonb_each_text(case when jsonb_typeof(e.detail->'ids') = 'object'
                                                   then e.detail->'ids' else '{}'::jsonb end) v), '') as target,
             e.ok, e.refusal, (e.detail->'shapes')::text as shapes
        from zz.event e where e.id = $1::bigint and e.kind = 'tool_call'`, [event[1], ZZ_TZ])).rows[0];
    if (!row) return { error: `ERROR: subject_ref "${subjectRef}" names no tool call — nothing to judge` };
    return {
      text: `CALL ${event[1]} at ${row.at}:\n${row.tool}${row.target ? `  ${row.target}` : ""}  ` +
        `${row.ok === false ? `REFUSED  ${row.refusal ?? ""}` : "ok"}` +
        (row.shapes ? `\nargument shapes: ${row.shapes}` : ""),
      kind: "event",
    };
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
          "no team — a document ref can only be read from the caller's own store",
      };
    }
    // A journal node is not a document: it is a `zz.knowledge_node` row, on this team's shelf or
    // the platform's.
    if (doc.initiative === "_knowledge") {
      const row = await knowledgeNodeAt(p, team, subjectRef);
      if (!row) {
        return {
          error: `ERROR: subject_ref "${subjectRef}" names no journal node — nothing to judge`,
        };
      }
      return { text: `${row.title ?? ""}\n\n${row.body ?? ""}`, kind: "knowledge" };
    }
    const loaded = await loadDocument(team, `${doc.initiative}/${doc.docPath}`);
    if (!loaded.ok) {
      return {
        error: `ERROR: subject_ref "${subjectRef}" names no document at ${doc.initiative}/${doc.docPath} ` +
          `in team "${team}" — nothing to judge`,
      };
    }
    return { text: loaded.text, kind: "document" };
  }

  return {
    error: `ERROR: subject_ref "${subjectRef}" is neither a known run_id nor an ` +
      "<initiative>/<doc>.md document path — nothing to judge",
  };
}
