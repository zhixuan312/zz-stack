/**
 * A plugin as the subject of the judge: what a ruler is written from, the record that one was
 * approved, the marking itself, and reading the marks back.
 *
 * COUPLED: `plugin-eval.ts` holds the half that returns no judgement — every field there is a
 * count, a set, an ordering or a difference. A tool that returns a judgement belongs here.
 *
 * Every tool here takes identifiers. The ruler comes from the plugin version, the artifacts from
 * the database and the artifact store, the model from deployment configuration. `round_judge`
 * takes a rubric_id as a guard, not a supply.
 *
 * Two kinds of dimension: a 'qualitative' one places an artifact between two written ends; a
 * 'quantitative' one is a line drawn over a figure `plugin_profile` computed, and the line is
 * written down before any artifact is measured.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { parseCaller } from "@zz/contracts";
import { requestHeaders, text } from "@zz/mcp-http";
import type pg from "pg";
import { z } from "zod";

import { entryOf, servesOwnDoor, toolsNamedBy } from "./plugin-eval.js";
import { bodyOf, factObject, readsRefusal } from "./plugin-facts.js";
import { stageDocsOf, usageDocs, usageInitiatives, usageRuns } from "./plugin-subjects.js";
import { Dim, MarkItem, Marking, Subject, markAll } from "./judge.js";
import { effectiveness, headroom } from "./judge-score.js";
import { traceOf } from "./judge-trace.js";
import { logActivity } from "../persist.js";
import { UNBOUNDED_WINDOW, pluginTraces } from "./plugin-profile.js";
import { userRoot } from "../paths.js";
import { db, teamFor } from "../platform-db.js";

const json = (v: unknown) => text(JSON.stringify(v, null, 2));
const noDb = () => text("ERROR: this deployment has no platform database, so nothing about a " +
                        "plugin's evaluation can be read or written");


/** The ruler this plugin version declares, dimension by dimension. Through
 *  zz.plugin_version.rubric_id and never zz.rubric.plugin_id: a plugin may carry more than one
 *  ruler over its life, and which one judges this version is a decision ruler_affirm records. */
async function pluginRuler(p: pg.Pool, plugin: string, version: string) {
  return (await p.query<Dim & { version_id: string; rubric_id: string; rubric_version: string; subject: string }>(`
    select pv.id::text as version_id, rb.id::text as rubric_id, rb.version as rubric_version,
           rb.subject, d.id::text as dim_id, d.name, d.five_means, d.one_means,
           -- The named levels, which decide which judge can mark this ruler: a typed judgement
           -- service is asked against described levels and cannot be asked against two ends and a
           -- number. Null on a ruler that has none.
           d.levels,
           d.kind, d.threshold, d.threshold_reason, d.reads
      from zz.plugin p
      join zz.plugin_version pv on pv.plugin_id = p.id
      join zz.rubric rb on rb.id = pv.rubric_id
      join zz.rubric_dimension d on d.rubric_id = rb.id
     where p.name = $1 and pv.version = $2
     order by d.ordinal`, [plugin, version])).rows;
}


export function registerPluginJudgeTools(server: McpServer): void {
  server.registerTool(
    "ruler_read",
    {
      description:
        "WHEN the define stage is writing rulers.md and needs everything a ruler for this " +
        "plugin version is written FROM. RETURNS the computed profile (traces and recorded " +
        "the computed profile), the documents and runs its use has left behind with whether each has already " +
        "been scored, and any ruler the plugin already has — and no ruler. REFUSES only a " +
        "deployment with no platform database: a version nothing has been recorded against " +
        "comes back as empty facts, because \"nothing recorded\" is an answer. It decides " +
        "nothing and never says whether the plugin is any good, which is the question the " +
        "ruler you write from it will answer. Read-only.",
      inputSchema: { plugin: z.string(), version: z.string() },
    },
    async ({ plugin, version }) => {
      const p = db();
      if (!p) return noDb();
      const entry = entryOf(plugin);
      const stages: string[] = (entry?.manifest.stages ?? []).map((s) => s.name);
      // ruler_read reads the plugin's whole recorded history, not one bounded evidence window —
      // that window is plugin_profile's own (observe.ts, Task I-7), named here rather than
      // defaulted inside pluginTraces.
      const [traces, docs, runs] = await Promise.all([
        pluginTraces(p, plugin, version, toolsNamedBy(plugin), stages, servesOwnDoor(plugin), UNBOUNDED_WINDOW),
        usageDocs(p, plugin, version, servesOwnDoor(plugin), entry?.flow ?? ""),
        usageRuns(p, plugin, version),
      ]);
      // Every ruler the plugin has, not only the one this version declares. A rubric nobody has
      // affirmed reads as no rubric at all, and a second one derived beside it splits the
      // subject's history into two scales that can never be compared.
      const rulers = (await p.query<{ rubric_id: string; version: string; approved_by: string | null;
                                      dims: string; declared_by: string | null }>(`
        select rb.id::text as rubric_id, rb.version, rb.approved_by,
               (select count(*)::text from zz.rubric_dimension d where d.rubric_id = rb.id) as dims,
               (select string_agg(pv.version, ', ' order by pv.version) from zz.plugin_version pv
                 where pv.rubric_id = rb.id) as declared_by
          from zz.rubric rb join zz.plugin p on p.id = rb.plugin_id
         where p.name = $1
         order by rb.created_at`, [plugin])).rows;
      return json({
        plugin, version,
        profile: { traces, sufficient_for_judging: traces.sufficient },
        usage: {
          documents: docs, runs,
          unscored_documents: docs.filter((d) => !d.scored).length,
          unscored_runs: runs.filter((r) => !r.scored).length,
        },
        rulers,
        note: rulers.length
          ? "REUSE, DO NOT DERIVE. This plugin already has a ruler. Read it, decide whether it " +
            "still holds, and affirm it — a new one beside it starts a second scale, and the " +
            "two can never be compared afterwards."
          : "No ruler yet. Write rulers.md from the facts above, put it to the stakeholder, " +
            "and record their approval with ruler_affirm.",
      });
    },
  );

  server.registerTool(
    "ruler_affirm",
    {
      description:
        "WHEN rulers.md has been approved and the stakeholder has agreed what good means " +
        "here — after that, never before. RETURNS the rubric this version now declares, who " +
        "approved it and when. It records a decision; it does not make one. REFUSES when the " +
        "plugin has no ruler at all, and when any quantitative dimension carries no " +
        "threshold — a line written after the figure is known is not a threshold.",
      inputSchema: { plugin: z.string(), version: z.string() },
    },
    async ({ plugin, version }) => {
      const p = db();
      if (!p) return noDb();
      const { rows } = await p.query<{ pv_id: string; rubric_id: string | null; rv: string | null }>(`
        select pv.id::text as pv_id, rb.id::text as rubric_id, rb.version as rv
          from zz.plugin p
          join zz.plugin_version pv on pv.plugin_id = p.id
          left join zz.rubric rb on rb.plugin_id = p.id
         where p.name = $1 and pv.version = $2
         order by rb.created_at desc nulls last limit 1`, [plugin, version]);
      if (!rows.length) return text(`ERROR: no released version ${version} of "${plugin}" is recorded`);
      // Not "no rubric found". The absence is the define stage's gate showing through, and a
      // refusal that says "not found" sends an agent looking for a row.
      if (!rows[0].rubric_id) {
        return text(
          `REFUSED: the define stage's document — rulers.md for ${plugin} ${version} — has not ` +
          "been approved, so there is no ruler for this version to be judged by. Write it from " +
          "ruler_read's facts, put it to the stakeholder, and call this once they have agreed " +
          "it. Scores taken under a ruler nobody approved are indistinguishable afterwards from " +
          "scores taken under one that was.");
      }
      const dims = (await p.query<{ name: string; kind: string; threshold: string; reads: string[] | null }>(
        "select name, kind, threshold, reads from zz.rubric_dimension where rubric_id = $1::uuid order by ordinal",
        [rows[0].rubric_id])).rows;
      const blank = dims.filter((d) => d.kind === "quantitative" && !d.threshold.trim());
      if (blank.length) {
        return text(
          `REFUSED: the define stage's document — rulers.md for ${plugin} ${version} — has not ` +
          `been approved as written: ${blank.length} quantitative dimension(s) carry no ` +
          `threshold (${blank.map((d) => d.name).join(", ")}). A quantitative dimension is a ` +
          "line drawn over a figure a tool computed, and the line has to exist before the judge " +
          "sees any artifact — a blank one becomes a number somebody picks after seeing the " +
          "result, which nobody afterwards can tell from one they picked before. Fill in " +
          "`threshold` and `threshold_reason` for each, put the document back, and call again.");
      }
      // The same clause again at the last gate. ruler_record refuses a line that cannot reach its
      // figure, so this catches only what changed in between — a ruler recorded before `reads`
      // existed, or a sheet whose shape moved while the document was with the stakeholder. A line
      // that gets past here becomes a 1 in eval_score nobody can distinguish from a real failure.
      if (dims.some((d) => d.kind === "quantitative")) {
        const refusal = readsRefusal(dims, await factObject(p, plugin, version));
        if (refusal) return text(refusal);
      }
      const who = parseCaller(requestHeaders()).email;
      await p.query("update zz.plugin_version set rubric_id = $1::uuid where id = $2::uuid",
                    [rows[0].rubric_id, rows[0].pv_id]);
      // Who, on the rubric; when, from the statement that records it. zz.rubric keeps approved_by
      // and no approved_at, so the moment is this call's and a re-affirmation stamps a new one.
      const at = (await p.query<{ at: string }>(
        "update zz.rubric set approved_by = $1 where id = $2::uuid returning now()::text as at",
        [who, rows[0].rubric_id])).rows[0].at;
      logActivity(await userRoot(), null,
        { user: who, action: "ruler_affirm", plugin, version, rubric: rows[0].rv });
      return json({
        plugin, version, rubric_id: rows[0].rubric_id, rubric_version: rows[0].rv,
        approved_by: who, approved_at: at,
        qualitative: dims.filter((d) => d.kind === "qualitative").length,
        quantitative: dims.filter((d) => d.kind === "quantitative").length,
        note: `${plugin} ${version} is now judged by this plugin's rubric v${rows[0].rv}. ` +
              "Scores taken from here are comparable with every other round under it.",
      });
    },
  );

  server.registerTool(
    "round_judge",
    {
      description:
        "WHEN a ruler is in force for this version and the round is ready to be scored: it " +
        "scores one version of one plugin against the ruler it declares and stores every " +
        "mark. It RETURNS what the PINNED judge recorded — subjects marked, what is left, and the " +
        "threshold results — not an opinion of yours or of this tool. YOU ARE NOT THE JUDGE: " +
        "you name a plugin, a version and the rubric you believe is in force, and you cannot " +
        "supply the artifact, the ruler or the model. Subjects are what the version's use left " +
        "behind: the documents its runs produced, or their traces where it produced none. Run " +
        "it once plainly and once with control: true — the control marks a DIFFERENT plugin's " +
        "work under this ruler, and a judge that is reading collapses on it; one without the " +
        "other is not a measurement. It REFUSES a rubric_id the version does not declare, and " +
        "it MARKS ONE SUBJECT PER CALL: call again with the `eval_id` it returns until " +
        "`remaining` is 0. It records which INITIATIVE the round belongs to, so a score can " +
        "be read back to the report that explains it.",
      inputSchema: {
        plugin: z.string(),
        version: z.string(),
        rubric_id: z.string()
          .describe("The ruler you believe judges this version, from ruler_affirm. It is " +
                    "CHECKED against what the version declares and refused on a mismatch — it " +
                    "cannot select a ruler, only catch a caller working from a stale one."),
        control: z.boolean().optional()
          .describe("Mark another plugin's work under this ruler, stored as the control."),
        initiative: z.string().optional()
          .describe("The evaluation initiative this round belongs to — the one whose rulers.md " +
                    "was approved and whose findings.md will carry the result. Recorded on the " +
                    "round so a score can be read back to the report that explains it, and a " +
                    "report back to the rows behind it. Omit only when continuing a round the " +
                    "tool already minted; a control inherits it from the round it controls."),
        eval_id: z.string().optional()
          .describe("Continue an evaluation this tool started, from its `eval_id`. Omit to begin one."),
        take: z.number().int().min(1).max(4).optional()
          .describe("How many subjects to mark in THIS call. Default 1: each takes about thirty seconds, and a call still running at two minutes returns nothing at all."),
      },
    },
    async ({ plugin, version, rubric_id, control, eval_id, take, initiative }) => {
      const p = db();
      if (!p) return noDb();
      try {
        const dims = await pluginRuler(p, plugin, version);
        if (!dims.length) {
          return text(
            `ERROR: ${plugin} ${version} declares no ruler, so nothing can be scored against ` +
            "it. That is the define stage's gate showing through: agree rulers.md, then " +
            `ruler_affirm(plugin: "${plugin}", version: "${version}").`);
        }
        // The rubric id is a guard. The caller cannot choose a ruler — the version declares one —
        // but a caller working from an earlier turn can name one that has since been replaced.
        // Refused rather than silently corrected.
        if (rubric_id !== dims[0].rubric_id) {
          return text(
            `ERROR: ${plugin} ${version} is judged by rubric ${dims[0].rubric_id} ` +
            `(v${dims[0].rubric_version}) and you named ${rubric_id}. Re-read ruler_affirm and ` +
            "call again with the ruler this version actually declares.");
        }
        const declared = (dims[0].subject ?? "auto") as Subject | "auto";
        // An initiative is asked for, never fallen back to. A ruler whose dimensions are about
        // the sequence declares `subject: "initiative"`; if this version has left no initiative
        // with two ends, that ruler cannot be scored and says so.
        const stageDocs = stageDocsOf(plugin);
        const inits = declared === "initiative"
          ? await usageInitiatives(p, plugin, version, stageDocs, entryOf(plugin)?.flow ?? "") : [];
        if (declared === "initiative" && !inits.length) {
          return text(
            stageDocs.length < 2
              ? `ERROR: ${plugin} declares ${stageDocs.length} document-producing stage(s), so ` +
                "it has no sequence to judge and a ruler whose subject is the initiative " +
                "cannot read it. That is a fact about the plugin's shape — a flow is what has " +
                "an arc — rather than about this version's quality."
              : `ERROR: ${plugin} ${version} has left no initiative that reached ` +
                `${stageDocs[stageDocs.length - 1]}, so a ruler whose subject is the ` +
                "initiative has nothing to read. An initiative still in flight has no end, and " +
                "asking whether the end delivers the beginning of one that has not ended marks " +
                "the work's incompleteness rather than the plugin. This is a fact about the " +
                "version's reach rather than its quality — plugin_profile says how thin the " +
                "evidence is. Either wait for an initiative to close under this version, or " +
                "record a ruler whose subject is the document."); 
        }
        const docs = declared === "trace" || declared === "initiative"
          ? [] : await usageDocs(p, plugin, version, servesOwnDoor(plugin), entryOf(plugin)?.flow ?? "");
        // A document is asked for too. A declared subject the evidence cannot supply is a refusal,
        // never a substitution: marking run transcripts against dimensions asking whether a
        // document carries its frontmatter answers a different question.
        if (declared === "document" && !docs.length) {
          return text(
            `ERROR: ${plugin} ${version} governs no document this round could read, so a ruler ` +
            "whose subject is the document has nothing to mark. Marking its run transcripts " +
            "instead would answer different questions from the ones the ruler asks and report " +
            "the answers as though they were the same. This is a fact about the version's " +
            "reach rather than its quality — plugin_profile says how thin the evidence is. " +
            "Either wait for documents to be written under this version, or record a ruler " +
            "whose subject is the trace.");
        }
        const kind: Subject = inits.length ? "initiative" : docs.length ? "document" : "trace";
        const runs = kind === "trace" ? await usageRuns(p, plugin, version) : [];
        if (kind === "trace" && !runs.length) {
          return text(
            `ERROR: ${plugin} ${version} has left neither a document nor a run with events — ` +
            "there is nothing to judge. This is a fact about its reach, not its quality: " +
            "plugin_profile says how thin the evidence is and why.");
        }
        const items: MarkItem[] = kind === "initiative"
          ? inits.map((i) => ({ key: i.open_id, label: `${i.initiative} (${i.open_path} -> ${i.close_path})`,
                                runId: null, docId: i.open_id, team: i.team_slug,
                                init: i.initiative, path: i.open_path, closePath: i.close_path }))
          : kind === "document"
          ? docs.map((d) => ({ key: d.id, label: `${d.initiative}/${d.path}`, runId: null,
                               docId: d.id, team: d.team_slug, init: d.initiative, path: d.path }))
          : runs.map((r) => ({ key: r.run_id, label: r.started, runId: r.run_id,
                               docId: null, team: "", init: "", path: "" }));
        // Computed only when a threshold will read it. The profile costs six queries, a ruler of
        // purely qualitative dimensions has nothing to apply them to, and a control round never
        // runs the threshold pass — its dimensions read the version's own facts, so scoring them
        // on both arms would shrink the gap the control exists to measure.
        //
        // The sheet is built once and checked before it is used. ruler_record already refused any
        // line that could not reach its figure, so reaching this refusal means the sheet changed
        // under a ruler somebody had already affirmed: a profile block that stopped being
        // computed, or a door that no longer writes documents so `record` came back null.
        //
        // Refused before the first mark, not reported after the last — a round that discovers this
        // halfway has already paid for the qualitative pass and written rows nobody can use.
        const sheet = !control && dims.some((d) => d.kind === "quantitative")
          ? await factObject(p, plugin, version) : null;
        if (sheet) {
          const refusal = readsRefusal(dims, sheet);
          if (refusal) {
            // DELIBERATE: concatenated, never String.replace. The refusal carries a plugin's own
            // ruler text, and `$&` or `$'` inside a replacement value is read as a pattern.
            return text(
              `REFUSED: the ruler in force for ${plugin} ${version} can no longer be measured ` +
              `against this version —${refusal.slice("REFUSED:".length)}` +
              "\n\nThis ruler was affirmed when the figure existed. Record the dimension " +
              "against a figure that is on the sheet today, or drop it, and affirm the ruler " +
              "again before marking anything.");
          }
        }
        const facts = sheet ? JSON.stringify(sheet, null, 2) : null;

        // What the control actually read, captured so the response can name it. A control round
        // iterates this plugin's own subjects and substitutes the control's text for each, so
        // `subjects` labels the plugin's document while the bytes judged were somebody else's.
        let controlSource = "";

        // Resolved from the caller, not asked for. An initiative is keyed (team_slug, initiative),
        // so the slug alone does not identify one, and the team is a fact about who is calling.
        const teamSlug = initiative?.trim() ? await teamFor(parseCaller(requestHeaders()).email) : null;
        const marking: Marking = {
          versionColumn: "plugin_version_id", versionId: dims[0].version_id, noun: "plugin",
          name: plugin, version, rubricId: dims[0].rubric_id,
          initiative: initiative?.trim() || null, teamSlug,
          rubricVersion: dims[0].rubric_version, dims, kind, items, facts,
          // The blind control: a different subject's artifact of the same kind, under this ruler.
          // Another plugin's run rather than another skill's, and a document round still controls
          // against a trace.
          control: async () => {
            // First choice: another plugin's run — the subject differs in every respect the ruler
            // was written about.
            const other = (await p.query<{ run_id: string }>(`
              select r.id::text as run_id from zz.run r
               join zz.plugin_version_skill pvs on pvs.skill_version_id = r.skill_version_id
               join zz.plugin_version pv on pv.id = pvs.plugin_version_id
               join zz.plugin p on p.id = pv.plugin_id
              where p.name <> $1 and exists (select 1 from zz.event e where e.run_id = r.id)
              order by r.started_at desc limit 1`, [plugin])).rows[0];
            if (other) {
              controlSource = `run ${other.run_id} of another plugin`;
              return traceOf(p, other.run_id);
            }

            // Fallback: a document from an initiative that did not run this plugin's own flow. A
            // subject this ruler was not written about, marked under it, so a high score is the
            // judge failing to discriminate.
            //
            // COUPLED: the exclusion is by initiative, not by document. An initiative that ran
            // this flow also holds documents the platform never stamped a flow on, and those are
            // as contaminated as their siblings — filtering on `d.flow` alone lets one through.
            //
            // Excluded by the round's own item set, not by `produced_by_run_id`: that column is
            // null for every document here, so the predicate would be true of everything and the
            // control would pick the very document the real round is judging.
            //
            // DELIBERATE: a plugin with no flow of its own skips this entirely rather than
            // matching the empty string. An empty `ownFlow` compared with `<>` would exclude
            // precisely the unflowed documents and offer another flow's instead.
            //
            // An initiative document is preferred over a knowledge node. A node is a ten-line
            // finding while the artifacts under judgement are specs and plans, so a low score
            // against it shows the judge is reading and says nothing about calibration. It is kept
            // as the last resort and `control_read` names it in full.
            const ownFlow = entryOf(plugin)?.flow ?? "";
            const judging = new Set(items.map((i) => i.docId).filter(Boolean));
            const candidates = ownFlow ? (await p.query<{ id: string; team_slug: string; initiative: string; path: string; is_node: boolean }>(`
              select d.id::text as id, d.team_slug, d.initiative, d.path, false as is_node
                from zz.doc d
                join zz.team t on t.slug = d.team_slug
                left join zz.initiative i on i.team_id = t.id and i.slug = d.initiative
               where d.path not like '\\_versions/%'
                 and coalesce(d.flow, '') <> $1 and coalesce(i.flow, '') <> $1
               union all
              -- The last-resort control, from the knowledge nodes' own table: every non-node initiative
              -- on a deployment may run the flow under evaluation, so a node can be the only control
              -- there is. is_node carries that ordering.
              select n.id::text as id, n.team_slug, '_knowledge' as initiative, n.path, true as is_node
                from zz.knowledge_node n
                join zz.team t on t.slug = n.team_slug
               order by is_node, id limit 50`, [ownFlow])).rows : [];
            const doc = candidates.find((c) => !judging.has(c.id));
            if (doc) {
              const body = bodyOf(doc.team_slug, doc.initiative, doc.path);
              if (body?.trim()) {
                controlSource = doc.is_node
                  ? `${doc.initiative}/${doc.path} (a knowledge node — a different kind of ` +
                    "artifact from the ones judged, so a low control score here shows the judge " +
                    "is reading and does not show it is calibrated)"
                  : `${doc.initiative}/${doc.path}`;
                return { text: body, truncated: 0 };
              }
            }

            // Neither. Said plainly rather than skipped: a round whose control could not be taken
            // is unvalidated, and that is a fact about the round the report has to carry.
            //
            // `zz` reaches here by construction — every initiative on this platform runs on zz, so
            // no document exists that zz did not have a hand in.
            throw new Error(
              `no control subject exists for "${plugin}" — this platform holds no run from ` +
              "another plugin, and every document it holds comes from an initiative that ran " +
              `${ownFlow || "this plugin"}. The round can still be scored, but nothing in it ` +
              "says whether the judge was reading, so report it as unvalidated rather than " +
              "averaging its numbers into a series.");
          },
        };
        const got = await markAll(p, marking, control === true, take ?? 1, eval_id ?? null, bodyOf);
        // Who marked what and when. It is the only record of a call that timed out after spending
        // most of the platform's LLM budget.
        logActivity(await userRoot(), null, {
          user: parseCaller(requestHeaders()).email, action: "round_judge",
          plugin, version, eval_id: got.eval_id, control: got.control, stored: got.stored,
        });
        // `subjects` names this plugin's documents even on a control round, because the loop
        // stores a control score against the same subject row. The source is reported beside it.
        return json(control === true ? { ...got, control_read: controlSource || '(none)' } : got);
      } catch (err) {
        return text(`ERROR: ${(err as Error).message}`);
      }
    },
  );

  server.registerTool(
    "round_scores",
    {
      description:
        "WHEN a round's marks are in and the report stage needs to read them back. RETURNS " +
        "the round itself, the qualitative dimensions with their means, the judge on trial " +
        "against its blind control, every quantitative dimension with the threshold it was " +
        "held to and the figure it was read against, and the findings recorded so far — " +
        "stored facts, retrieved, every judgement made by the pinned judge at the time and " +
        "nothing re-scored here. REFUSES an eval_id that is not a plugin evaluation, and the " +
        "control is counted separately and never averaged into the real mean.",
      inputSchema: { eval_id: z.string() },
    },
    async ({ eval_id }) => {
      const p = db();
      if (!p) return noDb();
      const round = (await p.query<{ plugin: string; version: string; rubric: string; judge: string;
                                     is_control: boolean; started: string; finished: string | null;
                                     doc_count: number; plugin_version_id: string }>(`
        select p.name as plugin, pv.version, rb.version as rubric, ev.judge_model as judge,
               ev.is_control, ev.started_at::text as started, ev.finished_at::text as finished,
               ev.doc_count, ev.plugin_version_id::text as plugin_version_id
          from zz.eval ev
          join zz.plugin_version pv on pv.id = ev.plugin_version_id
          join zz.plugin p on p.id = pv.plugin_id
          join zz.rubric rb on rb.id = ev.rubric_id
         where ev.id = $1::uuid`, [eval_id])).rows[0];
      if (!round) {
        return text(`ERROR: ${eval_id} is not an evaluation of a plugin. round_judge returns ` +
                    "the id of the round it started; that is the only id this reads.");
      }
      const pvId = round.plugin_version_id;
      // Across every round of this plugin version, not this round alone. A round resumes and a
      // control is its own row, so the gap between the real mean and the control's cannot be
      // computed inside a single eval.
      const dimensions = (await p.query<{ rubric: string; judge: string; dimension: string;
                                          n: string; mean: string; worst: string; best: string }>(`
        select rb.version as rubric, ev.judge_model as judge, d.name as dimension,
               count(*)::text as n, round(avg(sc.score),2)::text as mean,
               min(sc.score)::text as worst, max(sc.score)::text as best
          from zz.eval_score sc
          join zz.eval ev on ev.id = sc.eval_id
          join zz.rubric rb on rb.id = ev.rubric_id
          join zz.rubric_dimension d on d.id = sc.dimension_id
         where ev.plugin_version_id = $1::uuid and sc.is_control is false and d.kind = 'qualitative'
         group by 1,2,3,d.ordinal order by 1,2,d.ordinal`, [pvId])).rows;
      // Qualitative only. A quantitative dimension reads the version's computed facts and never
      // the artifact, so it scores identically whichever artifact is in front of the judge;
      // folding it into both arms would shrink the gap by arithmetic.
      //
      // This round against its own control, when the control named it: a gap is a property of one
      // round. The pooled form is the fallback and is labelled as such, because every round
      // recorded before the link existed has none and was always measured that way.
      const paired = (await p.query<{ rubric: string; judge: string; real_mean: string | null;
                                      control_mean: string | null }>(`
        select rb.version as rubric, ev.judge_model as judge,
               round(avg(sc.score) filter (where sc.eval_id = $1::uuid),2)::text as real_mean,
               round(avg(sc.score) filter (where sc.eval_id = ctl.id),2)::text as control_mean
          from zz.eval ev
          join zz.eval ctl on ctl.controls = ev.id
          join zz.rubric rb on rb.id = ev.rubric_id
          join zz.eval_score sc on sc.eval_id in (ev.id, ctl.id)
          join zz.rubric_dimension d on d.id = sc.dimension_id and d.kind = 'qualitative'
         where ev.id = $1::uuid
         group by 1,2`, [eval_id])).rows;
      const trial = paired.length ? paired : (await p.query<{ rubric: string; judge: string;
                                     real_mean: string | null; control_mean: string | null }>(`
        select rb.version as rubric, ev.judge_model as judge,
               round(avg(sc.score) filter (where sc.is_control is false),2)::text as real_mean,
               round(avg(sc.score) filter (where sc.is_control is true),2)::text as control_mean
          from zz.eval_score sc
          join zz.eval ev on ev.id = sc.eval_id
          join zz.rubric rb on rb.id = ev.rubric_id
          join zz.rubric_dimension d on d.id = sc.dimension_id
         where ev.plugin_version_id = $1::uuid and d.kind = 'qualitative'
         group by 1,2 having count(*) filter (where sc.is_control is true) > 0`, [pvId])).rows;
      // Round by round. A second real round re-applies every threshold, so an ungrouped listing
      // shows each dimension twice with nothing saying which reading is today's.
      const thresholds = (await p.query<{ round: string; rubric: string; judge: string; when: string;
                                          dimension: string; threshold: string; reason: string;
                                          score: number; fact: string }>(`
        select ev.id::text as round, rb.version as rubric, ev.judge_model as judge,
               ev.started_at::text as when,
               d.name as dimension, d.threshold, d.threshold_reason as reason,
               sc.score, sc.quote as fact
          from zz.eval_score sc
          join zz.eval ev on ev.id = sc.eval_id
          join zz.rubric rb on rb.id = ev.rubric_id
          join zz.rubric_dimension d on d.id = sc.dimension_id
         where ev.plugin_version_id = $1::uuid and d.kind = 'quantitative'
           and sc.is_control is false
         order by ev.started_at, d.ordinal`, [pvId])).rows;
      const findings = (await p.query<{ pattern: string; scope: string; docs_affected: number;
                                        proposed_change: string; decision: string }>(`
        select pattern, scope, docs_affected, proposed_change, decision
          from zz.eval_finding where eval_id = $1::uuid order by created_at`, [eval_id])).rows;
      // The two numbers a person actually asked for, computed here from what is already above.
      // The recommendation enum is a decision, not a measurement: how-good-is-it and
      // what-is-left-to-fix are independent. See judge-score.ts for the weights and the bands,
      // which are fixed before any round is read.
      //
      // This round's own figures, not the pooled ones. `dimensions` above groups by rubric and
      // judge across every round under this version, which would score a second round partly on
      // the first.
      const thisRound = dimensions.filter((d) => d.rubric === round.rubric && d.judge === round.judge);
      const qualMean = thisRound.length
        ? Math.round((thisRound.reduce((a, d) => a + Number(d.mean), 0) / thisRound.length) * 100) / 100
        : null;
      const mine = thresholds.filter((t) => t.round === eval_id);
      const met = mine.filter((t) => t.score >= 5).length;
      const gapNow = trial[0]?.real_mean && trial[0]?.control_mean
        ? Number((Number(trial[0].real_mean) - Number(trial[0].control_mean)).toFixed(2)) : null;
      const effective = effectiveness(qualMean, met, mine.length, gapNow);
      const room = headroom(effective.score, mine.length - met,
                            findings.filter((f) => f.scope === "generic").length);

      return json({
        eval_id, round,
        // First in the answer, because it is the first question. Everything below is what it was
        // computed from, in the order somebody would check it.
        effectiveness: effective,
        headroom: room,
        dimensions,
        judge_on_trial: trial.map((t) => ({
          ...t,
          gap: t.real_mean && t.control_mean
            ? Number((Number(t.real_mean) - Number(t.control_mean)).toFixed(2)) : null,
          // Which rounds the number is over: a reader comparing two reports needs to know whether
          // a gap is this round's or an average across every round under the ruler.
          over: paired.length ? "this round and the control that names it"
                              : "every round under this ruler, pooled - no control names this one",
        })),
        // Met is 5 and unmet is 1 because a line is binary; the reason is the ruler's own
        // threshold_reason, recorded when the line was drawn.
        thresholds: thresholds.map((t) => ({ ...t, meets: t.score >= 5 })),
        findings,
        note: trial.length
          ? "The gap is the only number that says the judge was reading rather than rewarding " +
            "confident output. Below 1.5 the ruler failed to tell the right artifact from the " +
            "wrong one, and nothing else here establishes anything."
          : "NO CONTROL has been run against this plugin version, so nothing establishes the " +
            "judge was reading. Treat every score above as unverified until round_judge has " +
            "run with control: true.",
      });
    },
  );
}
