/**
 * An initiative's documents and sources, as its state reads them: the envelope facts a row carries,
 * the sources filed under `sources/`, the ones that landed after the document they support was
 * approved, and the few bodies a move actually reads as text.
 *
 * Split from `tools/initiative-status.ts`, which computes the state itself: that file was at the
 * line a second subject is what it holds, and the body rule below is the second subject. What stays
 * there is the chain, the gates and the next move; what is here is what a document IS.
 *
 * DELIBERATE: the bodies are a rule, not a convenience. A state read decides from metadata — a
 * status, a path, an envelope field, a support link — and only three kinds of text are ever read:
 * the plan the flow declares (a phase is planned, built or not, read off the text), a document whose
 * stage owes an act (`owedActs` looks for the record's affirmed digest IN the document), and the
 * sources a move consults — a round, which is a source carrying a stage, and a stakeholder's
 * material bearing on the document under review. An initiative holds megabytes of source prose no
 * move looks at: reading all of it per status call was most of a console page's latency.
 */
import type pg from "pg";

import { docBodies, type DocRow } from "./indexing.js";

/** A document's envelope facts, or `{}` when this initiative holds no such document.
 *
 * COUPLED: an unresolved chain's `closingDoc` is the empty string, and the file version returned
 * `{}` for it (`readFileSync` of the directory threw EISDIR). A map lookup of a name nothing
 * holds answers `{}` for exactly the same reason. */
export function docFacts(rows: Map<string, DocRow>, name: string): Record<string, string> {
  const d = rows.get(name);
  if (!d) return {};
  const env: Record<string, string> = {};
  if (d.status) env.status = d.status;
  if (d.outcome) env.outcome = d.outcome;
  if (d.closed_by) env.closed_by = d.closed_by;
  if (d.approved_by) env.approved_by = d.approved_by;
  if (d.approved_at) env.approved_at = d.approved_at;
  if (d.current_version !== null) env.version = String(d.current_version);
  if (d.flow) env.flow = d.flow;
  for (const [k, v] of Object.entries(d.fields ?? {})) env[k] = v;
  return env;
}

/** The documents an initiative holds under `sources/`, by their name inside it — the material
 *  `source_add` recorded, which is what an audit round and a review round are read out of. */
export function sourceRows(rows: Map<string, DocRow>): DocRow[] {
  return [...rows.values()]
    .filter((d) => d.path.startsWith("sources/") && d.path.endsWith(".md"))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** The initiative's registered sources, and which of them landed after the document they
 *  support was approved. Reached from both returns of `initiativeState`.
 *
 * Compares two instants the platform wrote: a source's `updated_at`, stamped when it filed the
 * row, and the seal's `approved_at`, the instant `document_approve` was given (`approvalStamp`).
 * A row sealed before 0.97.0 holds the UTC midnight of its approval day and is kept as it was, so
 * on such a document a source filed earlier that day still lists. */
export function sourceReport(rows: Map<string, DocRow>): {
  sourceFiles: string[];
  needsRefinement: Array<{ document: string; source: string; title: string }>;
} {
  const sources = sourceRows(rows);
  const sourceFiles = sources.map((d) => d.path.slice("sources/".length));
  // When the source was last written and when the document it bears on was approved — the
  // database's clock and zz-core's, one host's. Comparing them as instants rather than as text is
  // what keeps two offsets from deciding.
  const at = (ts: string | null): number => (ts ? Date.parse(ts) : 0);
  const needsRefinement: Array<{ document: string; source: string; title: string }> = [];
  for (const src of sources) {
    if (!src.path.endsWith(".md")) continue;
    // An audit round lands on an approved document by design; the next move routes it.
    if (src.fields?.stage) continue;
    const sourceTime = at(src.updated_at);
    const supports = src.supports;
    for (const d of supports) {
      const target = rows.get(d);
      if (!target || target.status !== "approved") continue;
      if (sourceTime > at(target.approved_at)) {
        needsRefinement.push({ document: d, source: src.path,
                               title: src.title || src.path.slice("sources/".length) });
      }
    }
  }
  return { sourceFiles, needsRefinement };
}

/** Fill the bodies `initiativeState` reads into `rows`, in one statement.
 *
 *  `plan` is the document the flow declares with `role: "plan"`; `owing` the documents whose stage
 *  record owes an act, whose text `owedActs` searches for the record's affirmed digest; `verified`
 *  the documents some flow document verifies, whose sources a review consults. Everything else is
 *  decided from metadata and is left without its text. */
export async function fillStateBodies(
  p: pg.Pool, team: string, name: string, rows: Map<string, DocRow>, rowList: readonly DocRow[],
  plan: string | null, owing: ReadonlySet<string>, verified: ReadonlySet<string>,
): Promise<void> {
  const wanted: string[] = [];
  for (const d of rowList) {
    if (!d.path.startsWith("sources/")) {
      if (d.path === plan || owing.has(d.path)) wanted.push(d.path);
      // A source no link names is still a round when its envelope carries a stage: review round 1
      // is filed before the document it reviews exists (bug c92d1bb1).
    } else if (d.fields?.stage || d.supports.some((s) => verified.has(s))) wanted.push(d.path);
  }
  for (const [path, body] of await docBodies(p, team, name, wanted)) {
    const row = rows.get(path);
    if (row) row.body = body;
  }
}
