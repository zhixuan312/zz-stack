/**
 * The three things zz-core writes alongside a document's index row: the journal's event, the
 * journal's human-readable log, and the envelope a source document is written with.
 *
 * COUPLED: the indexer itself is `@zz/indexing` — `indexDoc`, `reindexTeam`,
 * `reindexAllTeams` and the store walk — imported rather than defined here, so there is no
 * second definition.
 *
 * What is here is zz-core's alone: `platformEvent` writes `zz.event`, and `journalLog` and
 * `sourceDocument` are shapes its knowledge tools produce.
 */
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { renderEnvelope, tableRow } from "./document-rules.js";
import { db } from "./platform-db.js";

/** The knowledge base's own log, in the platform's event table, which the console reads.
 * `journalLog` beside this writes `_knowledge/log.md`, the on-disk journal, which the console
 * cannot open.
 *
 * DELIBERATE: not a `tool_call` row. A tool_call carries no actor because it measures a
 * skill; a journal entry names who recorded or read what.
 *
 * DELIBERATE: searches are entries too. `knowledge_add` and `knowledge_supersede` each leave
 * three records and a search would otherwise leave none, so "which nodes does anyone read"
 * would have no answer.
 *
 * DELIBERATE: searches are logged only here, never in `journalLog` — a read line per search
 * would bury the entries that record decisions in the file a person reads top to bottom.
 *
 * COUPLED: team_id and team_slug both. Console views join through `team_id`, and the id is
 * resolved inside the INSERT so it cannot drift from the slug beside it.
 *
 * The actor is folded in the statement. tool-report, evolve-report and watch-results all
 * group on this column, and one person spelled two ways breaks all three.
 *
 * Fire and forget, catching everything: a journal entry that failed to write must never make
 * a node the person already minted report failure. */
export function platformEvent(e: {
  actor: string;
  /** The full kind, `<noun>.<verb>`: this writes rows for more than one noun, and prefixing
   *  a fixed noun here would need a second function writing the same table. */
  kind: string;
  /** What the row is about, which is the `subject` column it lands in: the node id for an
   *  add or a supersede, the query itself for a search, the bug id for a resolve. Named for
   *  the column rather than for any one action. */
  subject: string;
  team: string | null; detail: Record<string, unknown>;
}): void {
  const p = db();
  if (!p) return;
  void p.query(
    `insert into zz.event (actor, team_slug, team_id, kind, subject, detail)
     values (lower($1), $2, (select id from zz.team where slug = $2), $3, $4, $5)`,
    [e.actor, e.team, e.kind, e.subject, JSON.stringify(e.detail)],
  // Logged: a row dropped here leaves no trace anywhere, so a database refusing every
  // insert would look identical to one recording them all.
  ).catch((err) => console.error("platform journal insert failed:", err));
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
  /** Which shelf the row is on. A knowledge search deliberately spans the caller's team AND
   * the platform's journal, and dropping this made the two indistinguishable in the answer —
   * so a path that came back could not be read back. */
  team_slug: string;
}
/** A source document, written by source_add and by document_revise — same `type: source`,
 * same fields, same readers, so one builder rather than two hand-built envelopes.
 *
 * Through renderEnvelope, so every value is folded to one line whatever a caller sends. A
 * title carrying a newline otherwise adds fields to the envelope: `supports` decides which
 * approved documents initiative_status flags, and `type` is what knowledge_search filters on.
 *
 * COUPLED: `supports` stays comma-joined because that is how its readers split it. */
export function sourceDocument(
  opts: { title: string; by: string; day: string; supports: string; content: string;
          /** The flow stage this source is the output of — an audit round names its audit stage. */
          stage?: string;
          /** For an audit round: the version of the supported document the round read. */
          audits_version?: string },
): string {
  const env: Record<string, string> = {
    type: "source", title: opts.title, contributed_by: opts.by, date: opts.day,
    added_at: new Date().toISOString(), supports: opts.supports };
  if (opts.stage) env.stage = opts.stage;
  if (opts.audits_version) env.audits_version = opts.audits_version;
  return renderEnvelope(
    env, ["type", "title", "contributed_by", "date", "added_at", "supports", "stage", "audits_version"],
  ) + `\n${opts.content}\n`;
}
