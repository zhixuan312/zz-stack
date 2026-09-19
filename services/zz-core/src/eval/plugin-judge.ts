/**
 * A PLUGIN AS THE SUBJECT OF THE JUDGE: what a ruler is written from, the record
 * that one was approved, the marking itself, and reading the marks back.
 *
 * WHY THESE ARE NOT IN plugin-eval.ts. That file's whole rule is that nothing in it returns a
 * judgement — every field there is a count, a set, an ordering or a difference. These four are
 * the other half: they exist to produce judgements, from a ruler a person approved, through a
 * model nobody in the conversation chose. Putting them in one file would make that boundary
 * something a reader has to hold in their head rather than something they can see.
 *
 * THE JUDGE IS NOT THE AGENT, and this door keeps that the same way judge.ts does: every tool
 * here takes identifiers. The ruler comes from the plugin version, the artifacts from the
 * database and the artifact store, the model from deployment configuration. `round_judge`
 * takes a rubric_id and it is a GUARD, not a supply — see the tool.
 *
 * TWO KINDS OF DIMENSION, and the split is why this subject needed anything new at all. A
 * 'qualitative' dimension is what a rubric has always held: a reader places an artifact between
 * two written ends. A 'quantitative' one is a line a person drew over a figure plugin_profile
 * computed, and the line is written down BEFORE any artifact is measured — which is the only
 * thing standing between a ruler and a number chosen to flatter the result it will produce.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { parseCaller } from "@zz/contracts";
import { ARTIFACTS_DIR } from "@zz/indexing";
import { requestHeaders, text } from "@zz/mcp-http";
import type pg from "pg";
import { z } from "zod";

import { entryOf, servesOwnDoor, toolsNamedBy } from "./plugin-eval.js";
import { stageDocsOf, usageDocs, usageInitiatives, usageRuns } from "./plugin-subjects.js";
import { Dim, MarkItem, Marking, Subject, markAll } from "./judge.js";
import { effectiveness, headroom } from "./judge-score.js";
import { traceOf } from "./judge-trace.js";
import { logActivity } from "../persist.js";
import { pluginTraces } from "./plugin-profile.js";
import { sanitize, userRoot } from "../paths.js";
import { db } from "../platform-db.js";

const json = (v: unknown) => text(JSON.stringify(v, null, 2));
const noDb = () => text("ERROR: this deployment has no platform database, so nothing about a " +
                        "plugin's evaluation can be read or written");


/** The ruler this plugin VERSION declares, dimension by dimension. Through
 *  zz.plugin_version.rubric_id and never through zz.rubric.plugin_id: a plugin may carry more
 *  than one ruler over its life, and which one judges THIS version is a decision ruler_affirm
 *  records rather than a lookup anybody can shortcut. */
async function pluginRuler(p: pg.Pool, plugin: string, version: string) {
  return (await p.query<Dim & { version_id: string; rubric_id: string; rubric_version: string; subject: string }>(`
    select pv.id::text as version_id, rb.id::text as rubric_id, rb.version as rubric_version,
           rb.subject, d.id::text as dim_id, d.name, d.five_means, d.one_means,
           -- THE NAMED LEVELS, which decide which judge can mark this ruler: a typed
           -- judgement service is asked against described levels and cannot be asked against
           -- two ends and a number. Null on a ruler written before levels existed.
           d.levels,
           d.kind, d.threshold, d.threshold_reason
      from zz.plugin p
      join zz.plugin_version pv on pv.plugin_id = p.id
      join zz.rubric rb on rb.id = pv.rubric_id
      join zz.rubric_dimension d on d.rubric_id = rb.id
     where p.name = $1 and pv.version = $2
     order by d.ordinal`, [plugin, version])).rows;
}

/** The document body, out of the artifact store. Resolved HERE and not passed in, which is what
 *  keeps the judge's input out of the conversation: the caller names a plugin and a version. */
const bodyOf = (team: string, initiative: string, path: string): string | null => {
  try {
    const f = join(ARTIFACTS_DIR, "teams", sanitize(team), initiative, path);
    return existsSync(f) ? readFileSync(f, "utf8") : null;
  } catch { return null; }
};

/** Everything a threshold could be written against, as one sheet.
 *
 * THE WHOLE PROFILE MINUS THE STAGE PATHS. A threshold reads a figure — how many runs, how many
 * returns, how many named tools were never called, what the mean delta was — and stage_paths is
 * a per-initiative listing rather than a figure, so it is the one block that would spend the
 * budget without being able to answer anything. Everything else stays, because a fact sheet
 * trimmed to what somebody expected the thresholds to ask makes an unanswerable threshold look
 * like a failed one. */
async function factSheet(p: pg.Pool, plugin: string, version: string): Promise<string> {
  const entry = entryOf(plugin);
  const stages: string[] = (entry?.manifest.stages ?? []).map((s) => s.name);
  const traces = await pluginTraces(p, plugin, version, toolsNamedBy(plugin), stages, servesOwnDoor(plugin));
  const { stage_paths, ...figures } = traces;
  const named = toolsNamedBy(plugin);
  return JSON.stringify({
    plugin, version,
    // THE DENOMINATOR, STATED. A threshold is routinely written as a share of "the tools this
    // plugin's skills name" — and the sheet listed `never_called` and `use` but never that
    // set, so the judge had to infer its size from the two and got it wrong: zz-core's ruler
    // was read against 16 named tools on a plugin that names 15, because the one tool a run
    // had called (`skill_read`) is not one this plugin's skills name and was added in anyway.
    // A figure a threshold is measured against belongs on the sheet, not in the reader's head.
    tools_named: named,
    tools_named_count: named.length,
    // THE TOTAL, ALONGSIDE THE PER-TOOL ROWS. A threshold over refusals is written as a SHARE
    // -- at least half of them are the guardrail firing -- and a judge handed fifteen per-tool
    // rows has to add four columns across all of them before it can read the line. It is the
    // same argument as tools_named_count above: a figure a threshold is measured against
    // belongs on the sheet rather than in the reader's arithmetic.
    refusals: figures.use.reduce(
      (a, u) => ({ total: a.total + u.refusals, guardrail: a.guardrail + u.guardrail,
                   ours: a.ours + u.ours, theirs: a.theirs + u.theirs,
                   unattributed: a.unattributed + u.unattributed }),
      { total: 0, guardrail: 0, ours: 0, theirs: 0, unattributed: 0 }),
    // THE RECORD, ON THE SHEET. A threshold over rows needs the rows counted here; asking a
    // judge that reads markdown about the contents of a database column is how a dimension
    // comes to measure something other than what it is named for.
    record: figures.record
      ? { ...figures.record,
          revised_with_evidence_pct: figures.record.revised
            ? Math.round(1000 * Number(figures.record.revised_with_evidence) / Number(figures.record.revised)) / 10
            : null,
          patched_with_evidence_pct: figures.record.patched
            ? Math.round(1000 * Number(figures.record.patched_with_evidence) / Number(figures.record.patched)) / 10
            : null }
      : null,
    traces: { ...figures, initiatives_with_a_path: stage_paths.length },
  }, null, 2);
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
      const [traces, docs, runs] = await Promise.all([
        pluginTraces(p, plugin, version, toolsNamedBy(plugin), stages, servesOwnDoor(plugin)),
        usageDocs(p, plugin, version, servesOwnDoor(plugin)),
        usageRuns(p, plugin, version),
      ]);
      // EVERY RULER THE PLUGIN HAS, not only the one this version declares. The skill side
      // learned this the expensive way: a rubric nobody had affirmed read as no rubric at all,
      // and the stage that read it went off and derived a second one beside it — splitting the
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
      // NOT "no rubric found". The absence is not a lookup failure, it is the define stage's
      // gate showing through, and a refusal that says "not found" sends an agent looking for a
      // row instead of back to the person who has to agree what good means here.
      if (!rows[0].rubric_id) {
        return text(
          `REFUSED: the define stage's document — rulers.md for ${plugin} ${version} — has not ` +
          "been approved, so there is no ruler for this version to be judged by. Write it from " +
          "ruler_read's facts, put it to the stakeholder, and call this once they have agreed " +
          "it. Scores taken under a ruler nobody approved are indistinguishable afterwards from " +
          "scores taken under one that was.");
      }
      const dims = (await p.query<{ name: string; kind: string; threshold: string }>(
        "select name, kind, threshold from zz.rubric_dimension where rubric_id = $1::uuid order by ordinal",
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
      const who = parseCaller(requestHeaders()).email;
      await p.query("update zz.plugin_version set rubric_id = $1::uuid where id = $2::uuid",
                    [rows[0].rubric_id, rows[0].pv_id]);
      // WHO, on the rubric; WHEN, from the statement that records it. zz.rubric keeps
      // approved_by and no approved_at, so the moment is this call's — a re-affirmation stamps
      // a new one, which is honest: it is a fresh decision by whoever made it.
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
        "`remaining` is 0.",
      inputSchema: {
        plugin: z.string(),
        version: z.string(),
        rubric_id: z.string()
          .describe("The ruler you believe judges this version, from ruler_affirm. It is " +
                    "CHECKED against what the version declares and refused on a mismatch — it " +
                    "cannot select a ruler, only catch a caller working from a stale one."),
        control: z.boolean().optional()
          .describe("Mark another plugin's work under this ruler, stored as the control."),
        eval_id: z.string().optional()
          .describe("Continue an evaluation this tool started, from its `eval_id`. Omit to begin one."),
        take: z.number().int().min(1).max(4).optional()
          .describe("How many subjects to mark in THIS call. Default 1: each takes about thirty seconds, and a call still running at two minutes returns nothing at all."),
      },
    },
    async ({ plugin, version, rubric_id, control, eval_id, take }) => {
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
        // THE RUBRIC ID IS A GUARD. The caller cannot choose a ruler — the version declares one
        // — but a caller working from an earlier turn can name one that has since been
        // replaced, and marking under a ruler the caller thinks is different from the one in
        // force produces a number nobody can attribute. Refused rather than silently corrected.
        if (rubric_id !== dims[0].rubric_id) {
          return text(
            `ERROR: ${plugin} ${version} is judged by rubric ${dims[0].rubric_id} ` +
            `(v${dims[0].rubric_version}) and you named ${rubric_id}. Re-read ruler_affirm and ` +
            "call again with the ruler this version actually declares.");
        }
        // `body` was a fourth value here and is not one any more. It marked a skill's own text
        // as the artifact, a plugin has none, and this refused it — but 048 dropped it from
        // zz.rubric's check constraint, so the database cannot hold such a ruler and the
        // refusal became a guard against a state nothing can reach. Removed rather than kept
        // as insurance: an unreachable branch costs the next reader the time to work out what
        // could ever trip it, and the answer is nothing.
        const declared = (dims[0].subject ?? "auto") as Subject | "auto";
        // AN INITIATIVE IS ASKED FOR, never fallen back to. A ruler whose dimensions are about
        // the sequence — does the end deliver the beginning — declares `subject: "initiative"`,
        // and if this version has left no initiative with two ends then that ruler cannot be
        // scored and says so, rather than quietly marking single documents against dimensions
        // written about a whole arc.
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
          ? [] : await usageDocs(p, plugin, version, servesOwnDoor(plugin));
        // A DOCUMENT IS ASKED FOR TOO, and for the reason the initiative branch above already
        // gives. This used to fall through: a ruler that declared `document`, finding none,
        // silently marked run transcripts instead — against dimensions asking whether a
        // document carries its frontmatter and moves version on approval, which a transcript
        // cannot answer at all. It scored the backbone 1.68 and the round read as a verdict.
        // A declared subject the evidence cannot supply is a refusal, never a substitution.
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
        // Computed only when a threshold will read it. The profile costs six queries; a ruler
        // of purely qualitative dimensions has nothing to apply them to, and a CONTROL round
        // never runs the threshold pass at all — its dimensions read the version's own facts,
        // so scoring them on both arms would shrink the gap the control exists to measure.
        const facts = !control && dims.some((d) => d.kind === "quantitative")
          ? await factSheet(p, plugin, version) : null;

        // WHAT THE CONTROL ACTUALLY READ, captured so the response can name it.
        //
        // A control round iterates this plugin's own subjects and substitutes the control's
        // text for each, so `subjects` labels the plugin's document while the bytes judged were
        // somebody else's. Printing only the label let a control round read as though it had
        // scored the artifact named beside it — which is the one number in the record whose
        // provenance a reader most needs, because it is what says the rest are trustworthy.
        let controlSource = "";

        const marking: Marking = {
          versionColumn: "plugin_version_id", versionId: dims[0].version_id, noun: "plugin",
          name: plugin, version, rubricId: dims[0].rubric_id,
          rubricVersion: dims[0].rubric_version, dims, kind, items, facts,
          // THE BLIND CONTROL IS UNCHANGED: a different subject's artifact of the same kind,
          // under this ruler. Another PLUGIN's run rather than another skill's, because the
          // subject moved — everything else about the test, including that a document round
          // still controls against a trace, is exactly what the skill side does. Redefining it
          // here would start a series that cannot be read beside the one already recorded.
          control: async () => {
            // FIRST CHOICE: another plugin's run. Strongest, because the subject differs in
            // every respect the ruler was written about.
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

            // FALLBACK: a document THIS plugin's runs did not produce.
            //
            // The first choice threw on the platform that built this, and the failure mode is
            // the worst available: one plugin has runs, so the control could never be taken,
            // and a round with no control is a round in which nothing says whether the judge
            // was reading or rewarding confident prose. Every number would have been recorded
            // and none of them validated.
            //
            // A document from another initiative keeps the invariant that matters -- a subject
            // this ruler was not written about, marked under it, so a high score is the judge
            // failing to discriminate. It is weaker than another plugin's run only in that the
            // two subjects share a house style, which makes it a HARDER control to pass, not
            // an easier one.
            // EXCLUDED BY THE ROUND'S OWN ITEM SET, not by produced_by_run_id.
            //
            // The first version of this fallback said "a document this plugin's runs did not
            // produce" and asked the database with `produced_by_run_id is null or not in
            // (...)`. Every document on this deployment has a NULL there — the column is set by
            // a linkback that has attributed none of them — so the predicate was true of
            // everything, and the control picked THE VERY DOCUMENT the real round was judging.
            //
            // It scored 5.0 against the real round's 4.5 on the same bytes under the same
            // ruler. That is not a weak control, it is a broken test: two readings of one
            // artifact will always agree, and a reader would have concluded the judge cannot
            // discriminate when nothing had actually been asked of it. Worse than no control,
            // because it looks like one.
            //
            // The round's items are what it is judging. A control must not be among them, and
            // that is knowable here without trusting a column nothing writes.
            //
            // AND IT MUST NOT COME FROM THIS PLUGIN'S OWN FLOW EITHER, which the second version
            // of this fallback still allowed. It excluded the round's items and nothing else,
            // so on this deployment it reached for the newest document that was not being
            // judged and found `2026-09-13-console-brand-adoption/plan.md` — an initiative that
            // ran sdlc-flow. sdlc's plan.md marked against sdlc's ruler is not a control; it is
            // a second sample. It scored 4.00/5.00 against the real round's 4.00/5.00, and the
            // round was read as "the ruler does not discriminate" when what had actually been
            // asked was whether two sdlc documents score alike. They do, and should.
            //
            // The exclusion is by INITIATIVE, not by document. An initiative that ran this flow
            // also holds documents the platform never stamped a flow on — 2026-09-13-console-
            // brand-adoption carries three with `sdlc-flow` and two with nothing — and those
            // are exactly as contaminated as their siblings. Filtering on `d.flow` alone would
            // have let one of the two through and left the finding intact.
            //
            // A PLUGIN WITH NO FLOW OF ITS OWN SKIPS THIS ENTIRELY, rather than matching the
            // empty string and sweeping in every document whose flow is blank. `zz` is the
            // case, it has no flow.json, and an empty `ownFlow` compared with `<>` would have
            // excluded precisely the unflowed documents and offered it sdlc's — the same defect
            // this fallback was just fixed for, arriving through the fix.
            //
            // AN INITIATIVE DOCUMENT IS PREFERRED OVER A KNOWLEDGE NODE, and the ordering is
            // the point rather than a tidiness. The blind control is "a different subject's
            // artifact OF THE SAME KIND", and a knowledge node is a ten-line finding while the
            // artifacts under judgement are specs and plans. A node will score low against a
            // spec ruler because it is a different genre, not because the judge discriminated
            // — so it validates that the judge is READING and proves nothing about whether it
            // is calibrated. It is still far better than no control, so it is kept as the last
            // resort and `control_read` names it in full: on this deployment every non-node
            // initiative has run sdlc-flow, so a node is what sdlc's control actually is
            // today, and a report that does not say so is claiming more than it measured.
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
              -- THE LAST-RESORT CONTROL, FROM ITS OWN TABLE NOW. Nodes left zz.doc when
              -- knowledge became its own subject, and dropping them from this pool would
              -- leave sdlc with NO control: every non-node initiative on this deployment has
              -- run sdlc-flow, so a node is what sdlc's control actually is today. is_node
              -- carries the ordering that used to be d.initiative = the knowledge shelf.
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

            // NEITHER. Said plainly rather than skipped: a round whose control could not be
            // taken is unvalidated, and that is a fact about the round the report has to carry.
            //
            // `zz` reaches here by construction and will keep reaching here, which is the
            // honest answer rather than a gap. Every initiative on this platform runs on zz —
            // it is the required plugin — so there is no document anywhere that zz did not have
            // a hand in, and no amount of searching produces one. A control for zz's document
            // half would have to come from a platform zz does not run. Its CASE half needs no
            // control: the ablation arm IS the control, taken by construction.
            throw new Error(
              `no control subject exists for "${plugin}" — this platform holds no run from ` +
              "another plugin, and every document it holds comes from an initiative that ran " +
              `${ownFlow || "this plugin"}. The round can still be scored, but nothing in it ` +
              "says whether the judge was reading, so report it as unvalidated rather than " +
              "averaging its numbers into a series.");
          },
        };
        const got = await markAll(p, marking, control === true, take ?? 1, eval_id ?? null, bodyOf);
        // A round costs the platform's own LLM budget and leaves rows nobody else writes. WHO
        // marked WHAT and WHEN is provenance a later reader needs, and it is the only record of
        // a call that timed out after spending most of it.
        logActivity(await userRoot(), null, {
          user: parseCaller(requestHeaders()).email, action: "round_judge",
          plugin, version, eval_id: got.eval_id, control: got.control, stored: got.stored,
        });
        // `subjects` names this plugin's documents even on a control round, because the loop
        // stores a control score against the same subject row. So the source is reported beside
        // it: without that, a control round reads as though it had scored the artifact named.
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
      // ACROSS EVERY ROUND OF THIS PLUGIN VERSION, not this round alone. A round resumes and a
      // control is its own row, so the one number worth reading — how far the real mean sits
      // above the control's — cannot be computed inside a single eval by construction.
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
      // QUALITATIVE ONLY, and that is not a detail. A quantitative dimension reads the version's
      // computed facts and never the artifact, so it scores identically whichever artifact is in
      // front of the judge — folding it into both arms would shrink the gap by arithmetic and
      // make a ruler look worse the more lines it draws.
      // THIS ROUND AGAINST ITS OWN CONTROL, when the control named it.
      //
      // A gap is a property of ONE round and this pooled every score under the version and
      // ruler, real on one side and control on the other, because nothing linked them. Correct
      // while a version had one round; wrong the moment it had two, and a round later shown to
      // be defective moved the number of every round beside it until its rows were deleted.
      //
      // The pooled form is still the fallback and is LABELLED as such, because every round
      // recorded before migration 063 has no link and was always measured that way. Changing
      // what those numbers mean retroactively would be worse than reporting how they were got.
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
      // ROUND BY ROUND, and that is not decoration. A second real round re-applies every
      // threshold, so an ungrouped listing shows each dimension twice with nothing saying which
      // reading is today's — and a line that moved from met to unmet is the finding.
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
      // THE TWO NUMBERS A PERSON ACTUALLY ASKED FOR, computed here from what is already above.
      //
      // The recommendation enum is a DECISION and was being read as a MEASUREMENT. "Keep" does
      // not say whether a plugin is excellent or barely adequate, and how-good-is-it and
      // what-is-left-to-fix are independent: a plugin at 9 can still have a named change
      // waiting, and one at 5 with nothing identified is a worse situation than one at 5 with
      // three. See judge-score.ts for the weights and the bands, which are fixed before any
      // round is read rather than fitted to one.
      //
      // THIS ROUND'S OWN FIGURES, not the pooled ones. `dimensions` above groups by rubric and
      // judge across every round under this version, which is right for a series and wrong for
      // scoring one round — a second round would otherwise be scored partly on the first.
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
        // FIRST IN THE ANSWER, because it is the first question. Everything below is what it
        // was computed from, in the order somebody would check it.
        effectiveness: effective,
        headroom: room,
        dimensions,
        judge_on_trial: trial.map((t) => ({
          ...t,
          gap: t.real_mean && t.control_mean
            ? Number((Number(t.real_mean) - Number(t.control_mean)).toFixed(2)) : null,
          // WHICH ROUNDS THE NUMBER IS OVER, said rather than left to be assumed. A reader
          // comparing two reports needs to know whether a gap is this round's or an average
          // across every round under the ruler.
          over: paired.length ? "this round and the control that names it"
                              : "every round under this ruler, pooled - no control names this one",
        })),
        // Met is 5 and unmet is 1 because a line is binary; the reason is the ruler's own
        // threshold_reason, recorded when the line was drawn and not written after the fact.
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
