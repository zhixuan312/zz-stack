/**
 * `knowledge_reconcile` — what a stage committed to, for one initiative.
 *
 * Its own module rather than a third tool in initiative-status.ts, because it is a different
 * subject: `initiative_status` says where an initiative STANDS — its chain, its gates, its next
 * move — and this says what a stage PREDICTED: the fit ledger keyed by acceptance criterion, as
 * the stage recorded it in the text a reader sees. The two share a door and nothing else, and the
 * repository's 700-line ceiling is where a second subject always turns out to have been hiding.
 *
 * COUPLED: the claims are not stored anywhere. `decisionRows` parses them back out of the
 * documents' own bodies on every read, so nothing can drift from the text the console shows
 * beside it.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { parseCaller } from "@zz/contracts";
import { decisionRows, type DecisionRow } from "@zz/indexing";
import { requestHeaders, text } from "@zz/mcp-http";
import { z } from "zod";

import { safeName } from "../paths.js";
import { db, teamFor } from "../platform-db.js";

export function registerKnowledgeReconcileTool(server: McpServer): void {
  server.registerTool(
    "knowledge_reconcile",
    {
      description:
        "What a stage committed to, for one initiative: the fit ledger keyed by acceptance " +
        "criterion, the criteria themselves and who verifies each, as the stage recorded them. " +
        "Ask by `initiative`. It returns the claims only — nothing records which plugin a claim " +
        "is about, so nothing joins them to tool-call telemetry.",
      inputSchema: {
        initiative: z.string().min(1).describe("Reconcile this one initiative."),
      },
    },
    async ({ initiative }) => {
      const p = db();
      if (!p) return text("ERROR: no platform database — reconciliation reads the indexed document bodies");

      const who = parseCaller(requestHeaders());
      const team = await teamFor(who.email);
      if (!team) return text("ERROR: no team — reconciliation is scoped to the team that made the predictions");
      const bad = safeName(initiative, "initiative");
      if (bad) return text(bad);
      // What was claimed, computed from the documents' own bodies: a stage states them in the
      // text it writes for a reader, and `decisionRows` parses that text back out.
      //
      // COUPLED: a document reaches its initiative through `initiative_id` and its bytes through
      // the revision it currently points at; neither slug is a column of `zz.doc` and a version
      // is a `doc_revision` row, so there is no snapshot path to exclude and one document is one
      // row.
      const { rows: docs } = await p.query<{ path: string; type: string | null; body: string | null }>(
        `select d.path, d.type, coalesce(r.body, d.body) as body
           from zz.doc d
           join zz.initiative i on i.id = d.initiative_id
           join zz.team t on t.id = i.team_id
           left join zz.doc_revision r on r.doc_id = d.id and r.revision = d.current_revision
          where t.slug = $1 and i.slug = $2
          order by d.path`,
        [team, initiative]);
      const claims: (DecisionRow & { path: string })[] = [];
      for (const d of docs) {
        // A type that states no claims is skipped, and a body this cannot read is one document
        // with no claims, never an empty answer for the whole initiative.
        const role = (d.type ?? "").trim();
        if (!/^(selection|agreement|plan)$/.test(role) || typeof d.body !== "string") continue;
        for (const c of decisionRows(d.body).sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))) {
          claims.push({ path: d.path, ...c });
        }
      }
      if (!claims.length) {
        return text(`No claims recorded for ${initiative}. A stage records them by writing its fit ledger or its acceptance criteria; nothing to reconcile until one has.`);
      }

      // Claims only: nothing records which plugin a claim is about, so nothing joins these to
      // `zz.event`.
      const out = claims.map((c) => ({
        initiative,
        key: c.key,
        predicted: { verdict: c.verdict, qualifier: c.qualifier || null, by: c.detail || null,
                     verified_by: c.checker || null },
      }));
      return text(JSON.stringify({
        team,
        scope: { initiative },
        claims: out.length,
        note: "What a stage predicted, in the flow's own words. Nothing records which plugin a " +
              "claim is about, so a claim listed here has not been checked against anything.",
        claims_recorded: out,
      }, null, 2));
    },
  );
}
