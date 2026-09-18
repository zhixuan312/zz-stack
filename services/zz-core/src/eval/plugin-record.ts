/**
 * THE TWO TOOLS THAT WRITE DOWN WHAT A PERSON DECIDED.
 *
 * Everything else in the plugin evaluation reads: it counts runs, reads a recorded delta, marks
 * artifacts against a ruler. These two are where a judgement made by somebody comes back into
 * the platform as a row — the ruler the define stage derived, and the findings the report stage
 * concluded. They are their own subject for that reason, and not because plugin-judge.ts got
 * long: the tools there answer "what is true of this plugin", these answer "what did a person
 * decide about it", and the second is not a smaller version of the first.
 *
 * BOTH REFUSE INCOMPLETE INPUT, and for the same reason at both ends. A quantitative dimension
 * with no threshold, or a threshold with no stated reason, is a line somebody can move later
 * to make a result come out differently and nobody would be able to tell. A finding scoped
 * generic that proposes no change claims the plugin has a habit worth changing it over and
 * leaves the next round nothing to test against. Both are refused at RECORDING time, because
 * the alternative is refusing at judging time, and by then the figures exist.
 *
 * NEITHER IS APPROVING. A ruler is recorded, then put to a person, then affirmed. A finding
 * lands deferred. The platform holds what was decided; it does not decide.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { parseCaller } from "@zz/contracts";
import { requestHeaders, text } from "@zz/mcp-http";
import { z } from "zod";

import { logActivity } from "../persist.js";
import { userRoot } from "../paths.js";
import { db } from "../platform-db.js";

const json = (v: unknown) => text(JSON.stringify(v, null, 2));
const noDb = () => text("ERROR: this deployment has no platform database, so nothing can be recorded");

export function registerPluginRecordTools(server: McpServer): void {
  server.registerTool(
    "ruler_record",
    {
      description:
        "WHEN rulers.md says what good means for this plugin, and BEFORE the stakeholder " +
        "approves — approving is `ruler_affirm`'s job and it is a separate act. It writes the " +
        "ruler the define stage derived into the registry so the judge can be run against it, " +
        "and RETURNS the dimensions as they now stand. Each dimension is qualitative (a reader " +
        "scores 1-5 between two written ends) or quantitative (a tool computes a fact and this " +
        "carries the line drawn over it, with the reason it was drawn there). REFUSES a " +
        "quantitative dimension with no threshold. Re-recording replaces the dimensions of the " +
        "ruler at the same rubric version.",
      inputSchema: {
        plugin: z.string(),
        version: z.string(),
        rubric_version: z.string().describe("this ruler's own version, e.g. \"1\""),
        subject: z.enum(["auto", "document", "trace"])
          .describe("what the qualitative dimensions are applied to"),
        dimensions: z.array(z.object({
          name: z.string(),
          kind: z.enum(["qualitative", "quantitative"]),
          five_means: z.string().optional(),
          one_means: z.string().optional(),
          threshold: z.string().optional(),
          threshold_reason: z.string().optional(),
        })).min(1),
      },
    },
    async ({ plugin, version, rubric_version, subject, dimensions }) => {
      const p = db();
      if (!p) return noDb();

      // VALIDATED HERE AND NOT AT JUDGING TIME, because judging time is too late: by then the
      // figures exist, and a threshold written after them is a number somebody chose knowing
      // the answer. Nobody afterwards can tell that from one chosen before.
      const bad: string[] = [];
      for (const d of dimensions) {
        if (d.kind === "quantitative") {
          if (!d.threshold?.trim()) {
            bad.push(`${d.name}: quantitative and carries no threshold — a tool computes the ` +
                     "figure, and this is where the line over it is drawn");
          }
          if (!d.threshold_reason?.trim()) {
            bad.push(`${d.name}: quantitative and carries no threshold_reason — a line with no ` +
                     "stated reason is a number somebody can move later to make a result come " +
                     "out differently, and nobody would be able to tell");
          }
        } else if (!d.five_means?.trim() || !d.one_means?.trim()) {
          // Both ends, for 016_reference.sql's own reason: "a dimension a marker cannot place
          // is a dimension that gets placed by mood."
          bad.push(`${d.name}: qualitative and missing five_means or one_means — a dimension a ` +
                   "marker cannot place is one that gets placed by mood");
        }
      }
      if (bad.length) return text(`REFUSED: ${bad.join("; ")}`);

      const pv = (await p.query<{ id: string; plugin_id: string }>(`
        select pv.id::text as id, p.id::text as plugin_id
          from zz.plugin p join zz.plugin_version pv on pv.plugin_id = p.id
         where p.name = $1 and pv.version = $2`, [plugin, version])).rows[0];
      if (!pv) return text(`ERROR: no released version ${version} of "${plugin}" is recorded`);

      const rubricId = (await p.query<{ id: string }>(`
        insert into zz.rubric (plugin_id, version, subject) values ($1::uuid, $2, $3)
        on conflict (plugin_id, version) do update set subject = excluded.subject
        returning id::text as id`, [pv.plugin_id, rubric_version, subject])).rows[0].id;

      // REPLACED, not merged — and BY NAME, because a score points at a dimension row.
      //
      // This deleted every dimension and re-inserted them, which is right about the ruler and
      // wrong about the database: zz.eval_score carries a foreign key to rubric_dimension.id,
      // so the moment a round has been scored the delete fails and the caller gets a raw
      // Postgres constraint name instead of a sentence. It is not a rare corner either — it
      // is what "reuse this plugin's existing ruler" runs into the first time it is tried,
      // which is the path ruler_read itself tells the define stage to take.
      //
      // So a dimension that is still in the ruler is UPDATED IN PLACE and keeps its id, which
      // is also the more honest record: a score taken against "document depth" stays attached
      // to "document depth" rather than to a row that was deleted and replaced by one that
      // happens to read the same.
      //
      // A dimension the new draft drops is deleted — leaving it behind would score the plugin
      // against a line nobody currently holds — unless something has already been scored
      // against it, and then the caller is told to move to a new rubric version rather than
      // have history rewritten underneath them.
      const existing = (await p.query<{ id: string; name: string; scored: string }>(`
        select d.id::text as id, d.name,
               (select count(*)::text from zz.eval_score s where s.dimension_id = d.id) as scored
          from zz.rubric_dimension d where d.rubric_id = $1::uuid`, [rubricId])).rows;
      const keep = new Set(dimensions.map((d) => d.name));
      const orphaned = existing.filter((e) => !keep.has(e.name) && Number(e.scored) > 0);
      if (orphaned.length) {
        return text(
          `REFUSED: ${orphaned.map((o) => `"${o.name}"`).join(", ")} ` +
          `${orphaned.length === 1 ? "has" : "have"} already been scored under rubric ` +
          `version ${rubric_version}, so dropping ${orphaned.length === 1 ? "it" : "them"} ` +
          "would leave marks pointing at a line nobody holds. Record this as a NEW " +
          "rubric_version instead — the old scale keeps its scores and the new one starts " +
          "clean, which is what makes two rounds comparable or honestly incomparable.");
      }
      const byName = new Map(existing.map((e) => [e.name, e.id]));
      for (const e of existing) if (!keep.has(e.name)) {
        await p.query("delete from zz.rubric_dimension where id = $1::uuid", [e.id]);
      }
      for (const [i, d] of dimensions.entries()) {
        const id = byName.get(d.name);
        if (id) {
          await p.query(`
            update zz.rubric_dimension
               set five_means = $2, one_means = $3, ordinal = $4, kind = $5,
                   threshold = $6, threshold_reason = $7
             where id = $1::uuid`,
            [id, d.five_means ?? "", d.one_means ?? "", i,
             d.kind, d.threshold ?? "", d.threshold_reason ?? ""]);
        } else {
          await p.query(`
            insert into zz.rubric_dimension
              (rubric_id, name, five_means, one_means, ordinal, kind, threshold, threshold_reason)
            values ($1::uuid, $2, $3, $4, $5, $6, $7, $8)`,
            [rubricId, d.name, d.five_means ?? "", d.one_means ?? "", i,
             d.kind, d.threshold ?? "", d.threshold_reason ?? ""]);
        }
      }

      const who = parseCaller(requestHeaders()).email;
      logActivity(await userRoot(), null,
        { user: who, action: "ruler_record", plugin, version,
          rubric: rubric_version, dimensions: dimensions.length });
      return json({
        plugin, version, rubric_id: rubricId, rubric_version, subject,
        qualitative: dimensions.filter((d) => d.kind === "qualitative").length,
        quantitative: dimensions.filter((d) => d.kind === "quantitative").length,
        next: "Put rulers.md to the stakeholder. Nothing is scored until ruler_affirm records " +
              "that they agreed to it.",
      });
    },
  );

  server.registerTool(
    "finding_record",
    {
      description:
        "WHEN the scores are in and the report stage has decided what the pattern is. It " +
        "records what this round found as rows the NEXT round can read, and RETURNS them as " +
        "stored. Each finding is generic (it recurs across unrelated work, so it is the " +
        "plugin's habit and worth changing the plugin over) or specific (one piece of work's " +
        "own problem). A finding on somebody else's plugin carries no proposed_change — we " +
        "assess and stop. REFUSES an eval_id nothing minted. Recording is not deciding: a " +
        "finding lands deferred, and applying or rejecting it is a separate act by whoever " +
        "owns the plugin.",
      inputSchema: {
        eval_id: z.string(),
        findings: z.array(z.object({
          pattern: z.string().describe("what recurred, in one sentence"),
          docs_affected: z.number().int().min(0).optional(),
          scope: z.enum(["generic", "specific"]),
          proposed_change: z.string().optional()
            .describe("one change, and what you expect it to do. Omit for a third-party plugin."),
          decision: z.enum(["applied", "rejected", "deferred"]).optional(),
        })).min(1),
      },
    },
    async ({ eval_id, findings }) => {
      const p = db();
      if (!p) return noDb();
      const ev = (await p.query<{ id: string }>(
        "select id::text as id from zz.eval where id = $1::uuid", [eval_id])).rows[0];
      if (!ev) return text(`ERROR: no evaluation ${eval_id}`);

      // A GENERIC FINDING WITH NO PROPOSED CHANGE IS AN OBSERVATION, and the distinction is
      // load-bearing. `generic` claims the plugin has a habit worth changing it over; saying so
      // and then naming no change leaves the next round nothing to test against, and a finding
      // nothing can contradict reads as vindicated whatever happens next. `specific` may stand
      // alone -- one piece of work's own problem is fixed by doing that work better, not by
      // editing a plugin.
      const mute = findings.filter((f) => f.scope === "generic" && !f.proposed_change?.trim());
      if (mute.length) {
        return text(
          `REFUSED: ${mute.length} finding(s) are scoped generic and propose no change — ` +
          `${mute.map((f) => JSON.stringify(f.pattern.slice(0, 60))).join(", ")}. Generic means ` +
          "this is the plugin's habit and worth changing the plugin over; say what change, and " +
          "what you expect it to move. If you cannot, it is an observation about one round — " +
          "scope it specific, or leave it in the prose of findings.md where a reader can weigh " +
          "it without the platform treating it as a claim about the plugin.");
      }

      let stored = 0;
      for (const f of findings) {
        await p.query(`
          insert into zz.eval_finding (eval_id, pattern, docs_affected, scope, proposed_change, decision)
          values ($1::uuid, $2, $3, $4, $5, $6)`,
          [eval_id, f.pattern, f.docs_affected ?? 0, f.scope,
           f.proposed_change ?? "", f.decision ?? "deferred"]);
        stored++;
      }
      const who = parseCaller(requestHeaders()).email;
      logActivity(await userRoot(), null,
        { user: who, action: "finding_record", eval_id, findings: stored });
      return json({
        eval_id, recorded: stored,
        generic: findings.filter((f) => f.scope === "generic").length,
        specific: findings.filter((f) => f.scope === "specific").length,
        next: "These are DEFERRED. Nothing here changes the plugin — the catalog is read-only " +
              "wherever the platform runs, and a change is a repository edit and a release by " +
              "whoever owns it.",
      });
    },
  );
}
