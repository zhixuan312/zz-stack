/**
 * A PLUGIN AS THE SUBJECT OF THE JUDGE. Four tools: what a ruler is written from, the record
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
 * database and the artifact store, the model from deployment configuration. `plugin_judge`
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
import { requestHeaders, text } from "@zz/mcp-http";
import type pg from "pg";
import { z } from "zod";

import { entryOf, toolsNamedBy } from "./plugin-eval.js";
import { Dim, MarkItem, Marking, SUBJECT_CAP, Subject, markAll, traceOf } from "./judge.js";
import { logActivity } from "../persist.js";
import { pluginCases } from "./plugin-cases.js";
import { pluginTraces } from "./plugin-profile.js";
import { sanitize, userRoot } from "../paths.js";
import { ARTIFACTS_DIR, db } from "../platform-db.js";

const json = (v: unknown) => text(JSON.stringify(v, null, 2));
const noDb = () => text("ERROR: this deployment has no platform database, so nothing about a " +
                        "plugin's evaluation can be read or written");

/** The runs a plugin version owns, through the skill membership recorded at release. The same
 *  join plugin-profile.ts uses and for the same reason — zz.event.step_version is stamped only
 *  when a skill is served whole, and release is the only moment anybody knows what a plugin
 *  version contained. */
const RUNS_OF = `
  from zz.run r
  join zz.plugin_version_skill pvs on pvs.skill_version_id = r.skill_version_id
  join zz.plugin_version pv on pv.id = pvs.plugin_version_id
  join zz.plugin p on p.id = pv.plugin_id
 where p.name = $1 and pv.version = $2`;

/** The documents this plugin version's runs produced, newest first.
 *
 * `scored` says whether a round has already marked it, and it is a fact the define stage needs
 * before it writes anything: a ruler derived from work that was already judged under an earlier
 * ruler is a ruler fitted to its own answers. */
async function usageDocs(p: pg.Pool, plugin: string, version: string) {
  return (await p.query<{ team_slug: string; initiative: string; path: string; id: string; scored: boolean }>(`
    select d.team_slug, d.initiative, d.path, d.id::text as id,
           exists (select 1 from zz.eval_subject es
                    where es.doc_id = d.id and es.plugin_version_id = pv.id) as scored
      from zz.doc d
      join zz.run r on r.id = d.produced_by_run_id
      join zz.plugin_version_skill pvs on pvs.skill_version_id = r.skill_version_id
      join zz.plugin_version pv on pv.id = pvs.plugin_version_id
      join zz.plugin p on p.id = pv.plugin_id
     where p.name = $1 and pv.version = $2 and d.path not like '\\_versions/%'
     order by d.created_at desc limit ${SUBJECT_CAP}`, [plugin, version])).rows;
}

/** The runs of this plugin version that left events. A run with no events is not a subject —
 *  there is nothing for a judge to read — and it is reported as a gap by plugin_profile rather
 *  than silently dropped here. */
async function usageRuns(p: pg.Pool, plugin: string, version: string) {
  return (await p.query<{ run_id: string; started: string; scored: boolean }>(`
    select r.id::text as run_id, to_char(r.started_at,'YYYY-MM-DD HH24:MI') as started,
           exists (select 1 from zz.eval_subject es
                    where es.run_id = r.id and es.plugin_version_id = pv.id) as scored
    ${RUNS_OF}
       and exists (select 1 from zz.event e where e.run_id = r.id)
     order by r.started_at desc limit ${SUBJECT_CAP}`, [plugin, version])).rows;
}

/** The ruler this plugin VERSION declares, dimension by dimension. Through
 *  zz.plugin_version.rubric_id and never through zz.rubric.plugin_id: a plugin may carry more
 *  than one ruler over its life, and which one judges THIS version is a decision plugin_affirm
 *  records rather than a lookup anybody can shortcut. */
async function pluginRuler(p: pg.Pool, plugin: string, version: string) {
  return (await p.query<Dim & { version_id: string; rubric_id: string; rubric_version: string; subject: string }>(`
    select pv.id::text as version_id, rb.id::text as rubric_id, rb.version as rubric_version,
           rb.subject, d.id::text as dim_id, d.name, d.five_means, d.one_means,
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
  const traces = await pluginTraces(p, plugin, version, toolsNamedBy(plugin), stages);
  const cases = await pluginCases(p, plugin, version);
  const { stage_paths, ...figures } = traces;
  return JSON.stringify({
    plugin, version,
    traces: { ...figures, initiatives_with_a_path: stage_paths.length },
    cases,
  }, null, 2);
}

export function registerPluginJudgeTools(server: McpServer): void {
  server.registerTool(
    "plugin_ruler",
    {
      description:
        "Everything a ruler for this plugin version is written FROM, and no ruler: the computed " +
        "profile (traces and recorded cases), the documents and runs its use has left behind " +
        "with whether each has already been scored, and any ruler the plugin already has. " +
        "Facts only — nothing here says whether the plugin is any good, which is the question " +
        "the ruler you write from it will answer. Read-only.",
      inputSchema: { plugin: z.string(), version: z.string() },
    },
    async ({ plugin, version }) => {
      const p = db();
      if (!p) return noDb();
      const entry = entryOf(plugin);
      const stages: string[] = (entry?.manifest.stages ?? []).map((s) => s.name);
      const [traces, cases, docs, runs] = await Promise.all([
        pluginTraces(p, plugin, version, toolsNamedBy(plugin), stages),
        pluginCases(p, plugin, version),
        usageDocs(p, plugin, version),
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
        profile: { traces, cases, sufficient_for_judging: traces.sufficient || cases.sufficient },
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
            "and record their approval with plugin_affirm.",
      });
    },
  );

  server.registerTool(
    "plugin_affirm",
    {
      description:
        "Record that this plugin version is judged by the ruler the stakeholder approved, and " +
        "return the rubric it now declares, who approved it and when. It records a decision; " +
        "it does not make one. It REFUSES when the plugin has no ruler at all, and when any " +
        "quantitative dimension carries no threshold — a line written after the figure is " +
        "known is not a threshold. Call it after rulers.md is approved, never before.",
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
          "plugin_ruler's facts, put it to the stakeholder, and call this once they have agreed " +
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
        { user: who, action: "plugin_affirm", plugin, version, rubric: rows[0].rv });
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
    "plugin_judge",
    {
      description:
        "Score one version of one plugin against the ruler it declares, and store every mark. " +
        "It returns what the PINNED judge recorded — subjects marked, what is left, and the " +
        "threshold results — not an opinion of yours or of this tool. YOU ARE NOT THE JUDGE: " +
        "you name a plugin, a version and the rubric you believe is in force, and you cannot " +
        "supply the artifact, the ruler or the model. Subjects are what the version's use left " +
        "behind: the documents its runs produced, or their traces where it produced none. Run " +
        "it once plainly and once with control: true — the control marks a DIFFERENT plugin's " +
        "work under this ruler, and a judge that is reading collapses on it; one without the " +
        "other is not a measurement. IT MARKS ONE SUBJECT PER CALL: call again with the " +
        "`eval_id` it returns until `remaining` is 0.",
      inputSchema: {
        plugin: z.string(),
        version: z.string(),
        rubric_id: z.string()
          .describe("The ruler you believe judges this version, from plugin_affirm. It is " +
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
            `plugin_affirm(plugin: "${plugin}", version: "${version}").`);
        }
        // THE RUBRIC ID IS A GUARD. The caller cannot choose a ruler — the version declares one
        // — but a caller working from an earlier turn can name one that has since been
        // replaced, and marking under a ruler the caller thinks is different from the one in
        // force produces a number nobody can attribute. Refused rather than silently corrected.
        if (rubric_id !== dims[0].rubric_id) {
          return text(
            `ERROR: ${plugin} ${version} is judged by rubric ${dims[0].rubric_id} ` +
            `(v${dims[0].rubric_version}) and you named ${rubric_id}. Re-read plugin_affirm and ` +
            "call again with the ruler this version actually declares.");
        }
        // `body` was a fourth value here and is not one any more. It marked a skill's own text
        // as the artifact, a plugin has none, and this refused it — but 048 dropped it from
        // zz.rubric's check constraint, so the database cannot hold such a ruler and the
        // refusal became a guard against a state nothing can reach. Removed rather than kept
        // as insurance: an unreachable branch costs the next reader the time to work out what
        // could ever trip it, and the answer is nothing.
        const declared = (dims[0].subject ?? "auto") as Subject | "auto";
        const docs = declared === "trace" ? [] : await usageDocs(p, plugin, version);
        const kind: Subject = docs.length ? "document" : "trace";
        const runs = kind === "trace" ? await usageRuns(p, plugin, version) : [];
        if (kind === "trace" && !runs.length) {
          return text(
            `ERROR: ${plugin} ${version} has left neither a document nor a run with events — ` +
            "there is nothing to judge. This is a fact about its reach, not its quality: " +
            "plugin_profile says how thin the evidence is and why.");
        }
        const items: MarkItem[] = kind === "document"
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
            const candidates = ownFlow ? (await p.query<{ id: string; team_slug: string; initiative: string; path: string }>(`
              select d.id::text as id, d.team_slug, d.initiative, d.path
                from zz.doc d
                join zz.team t on t.slug = d.team_slug
                left join zz.initiative i on i.team_id = t.id and i.slug = d.initiative
               where d.path not like '\\_versions/%'
                 and coalesce(d.flow, '') <> $1 and coalesce(i.flow, '') <> $1
               order by (d.initiative = '_knowledge'), d.created_at desc limit 50`, [ownFlow])).rows : [];
            const doc = candidates.find((c) => !judging.has(c.id));
            if (doc) {
              const body = bodyOf(doc.team_slug, doc.initiative, doc.path);
              if (body?.trim()) {
                controlSource = doc.initiative === "_knowledge"
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
          user: parseCaller(requestHeaders()).email, action: "plugin_judge",
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
    "plugin_scores",
    {
      description:
        "Read one round's marks back: the round itself, the qualitative dimensions with their " +
        "means, the judge on trial against its blind control, every quantitative dimension " +
        "with the threshold it was held to and the figure it was read against, and the " +
        "findings recorded so far. Stored facts, retrieved — every judgement in them was made " +
        "by the pinned judge at the time and nothing is re-scored here. The control is counted " +
        "separately and never averaged into the real mean.",
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
        return text(`ERROR: ${eval_id} is not an evaluation of a plugin. plugin_judge returns ` +
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
      const trial = (await p.query<{ rubric: string; judge: string; real_mean: string | null;
                                     control_mean: string | null }>(`
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
      return json({
        eval_id, round, dimensions,
        judge_on_trial: trial.map((t) => ({
          ...t,
          gap: t.real_mean && t.control_mean
            ? Number((Number(t.real_mean) - Number(t.control_mean)).toFixed(2)) : null,
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
            "judge was reading. Treat every score above as unverified until plugin_judge has " +
            "run with control: true.",
      });
    },
  );
}
