/**
 * The three things zz-core writes ALONGSIDE a document's index row: the journal's event, the
 * journal's human-readable log, and the envelope a source document is written with.
 *
 * THE INDEXER ITSELF IS NOT HERE ANY MORE. `indexDoc`, `reindexTeam`, `reindexAllTeams` and
 * the store walk moved to `@zz/indexing` at Task I-38, because `knowledge_reindex` moved to
 * `/manage` and the gateway serves that door — a service cannot import another service, and
 * two copies of an indexer agree only until the day one of them is edited. Every caller in
 * this service imports them from the package; there is no second definition to drift from.
 *
 * What stayed is what is zz-core's alone. `knowledgeEvent` writes `zz.event`, which the
 * gateway's console reads and zz-core's knowledge tools are the only writers of;
 * `journalLog` and `sourceDocument` are shapes two of those tools produce. None of it is
 * indexing, and none of it is anything the gateway has a use for.
 */
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { renderEnvelope, tableRow } from "./document-rules.js";
import { db } from "./platform-db.js";

/** The knowledge base's own log, in the platform's event table.
 *
 * `journalLog` beside this writes `_knowledge/log.md` — a real append-only journal, and the
 * right thing for anyone reading a team's store on disk. It is invisible to the console,
 * which reads Postgres and has no way to open a team's files, so "what has this team
 * learned lately, and who wrote it down" had no answer any screen could show.
 *
 * NOT A `tool_call` ROW. Those already exist for these tools and cannot serve: a tool_call
 * deliberately carries NO ACTOR — "no address on a measurement", see tool-telemetry.ts —
 * because it measures a skill, not a person. A journal entry is the opposite kind of record:
 * who recorded what, when. It also cannot be filtered out of tool_call rows honestly, since
 * those include `knowledge_search` reads, which are not log entries at all.
 *
 * team_id AND team_slug, both. The slug alone is what zz.event carried for a week while
 * every console view that joins through `team_id` read empty — see 042_event_team_backfill.
 * The id is resolved in the INSERT so it cannot drift from the slug beside it.
 *
 * THE ACTOR IS FOLDED IN THE STATEMENT. `who.email` arrives canonical from `parseCaller`,
 * but this column is grouped on by tool-report, evolve-report and watch-results, and one
 * person spelled two ways breaks all three — so every writer of it folds, whatever the
 * value's provenance. Cheap insurance on a column with that property.
 *
 * FIRE AND FORGET, catching everything: a journal entry that failed to write must never be
 * the reason a node the person already minted reports failure. */
export function knowledgeEvent(e: {
  actor: string; action: "add" | "supersede"; node: string;
  team: string | null; detail: Record<string, unknown>;
}): void {
  const p = db();
  if (!p) return;
  void p.query(
    `insert into zz.event (actor, team_slug, team_id, kind, subject, detail)
     values (lower($1), $2, (select id from zz.team where slug = $2), $3, $4, $5)`,
    [e.actor, e.team, `knowledge.${e.action}`, e.node, JSON.stringify(e.detail)],
  ).catch(() => undefined);
}
/** Append a row to the journal's human-readable log. It is markdown, so it
 * must be a table: consecutive plain lines render as one run-on paragraph. */
export function journalLog(root: string, action: string, id: string, detail: string): void {
  const log = join(root, "_knowledge", "log.md");
  if (!existsSync(log)) {
    mkdirSync(join(root, "_knowledge"), { recursive: true });
    writeFileSync(log, "| when | action | node | detail |\n|---|---|---|---|\n");
  }
  appendFileSync(log, tableRow(new Date().toISOString(), action, id, detail));
}
/** One row of the knowledge base as retrieval reads it. */
export interface KbRow {
  initiative: string; path: string; flow: string; type: string; status: string;
  outcome: string | null; approved_by: string | null; approved_at: string | null;
  updated_at: string; title: string; tags: string[] | null; evidence: string[] | null;
  superseded_by: string | null; rank: number; snippet: string;
  /** WHICH SHELF the row is on. A knowledge search deliberately spans the caller's team AND
   * the platform's journal, and dropping this made the two indistinguishable in the answer —
   * so a path that came back could not be read back. */
  team_slug: string;
}
/** A source document, which two tools write.
 *
 * source_add attaches material a person brought; document_revise captures the words that
 * caused a version. Same `type: source`, same fields, same readers — and two hand-built
 * envelopes, of which ONE escaped its title. document_revise's interpolated `source_title`
 * raw, so a title carrying a newline did not corrupt the source's envelope, it added fields
 * to it: `supports` decides which approved documents initiative_status flags for refinement,
 * and `type` is what knowledge_search filters on, so a source could be indexed as a spec.
 *
 * Through renderEnvelope, so every value is folded to one line whatever a caller sends and
 * whatever field is added here next. `supports` stays comma-joined because that is how the
 * readers split it, and both callers validate their entries before they arrive. */
export function sourceDocument(
  opts: { title: string; by: string; day: string; supports: string; content: string },
): string {
  return renderEnvelope(
    { type: "source", title: opts.title, contributed_by: opts.by, date: opts.day,
      added_at: new Date().toISOString(), supports: opts.supports },
    ["type", "title", "contributed_by", "date", "added_at", "supports"],
  ) + `\n${opts.content}\n`;
}
