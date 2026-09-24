/**
 * The tools that write down what a person decided: the ruler the define stage derived, the
 * findings the report stage concluded, what became of each finding, and the verdict the round
 * ends on. Everything else in the plugin evaluation reads.
 *
 * Both a ruler and a finding refuse incomplete input at recording time rather than at judging
 * time: a quantitative dimension with no threshold, a threshold with no stated reason, or a
 * generic finding proposing no change. Refusing later means refusing once the figures exist.
 *
 * Neither tool approves. A ruler is recorded, then put to a person, then affirmed; a finding
 * lands `deferred`. The platform holds what was decided.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { parseCaller } from "@zz/contracts";
import { requestHeaders, text } from "@zz/mcp-http";
import { z } from "zod";

import { logActivity } from "../persist.js";
import { userRoot } from "../paths.js";
import { db } from "../platform-db.js";
import { ask, configured, NOT_CONFIGURED, type ScoreQuestion } from "../typed-service.js";
import { effectiveness, headroom, headroomNote } from "./judge-score.js";
import { factObject, readsRefusal } from "./plugin-facts.js";

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
        "quantitative dimension with no threshold, with no threshold_reason, or whose `reads` " +
        "name a figure that is not on this plugin's facts sheet — a line that cannot reach " +
        "its figure is scored FAILED rather than unanswered, which costs the plugin twice " +
        "and is indistinguishable afterwards from a real miss. Re-recording replaces the " +
        "dimensions of the ruler at the same rubric version.",
      inputSchema: {
        plugin: z.string(),
        version: z.string(),
        rubric_version: z.string().describe("this ruler's own version, e.g. \"1\""),
        subject: z.enum(["auto", "document", "trace", "initiative"])
          .describe("what the qualitative dimensions are applied to"),
        dimensions: z.array(z.object({
          name: z.string(),
          kind: z.enum(["qualitative", "quantitative"]),
          /** 2-5 ordered level descriptions, low end first.
           *
           *  COUPLED: five is the ceiling because `effectiveness` in judge-score.ts rescales a
           *  mark with `(mean - 1) / 4` and stores the result out of ten. Raising it means
           *  changing the divisor too. */
          levels: z.array(z.string()).min(2).max(5).optional(),
          /** The two-ends form. Kept for the rulers written before levels existed; a new
           *  qualitative dimension must send `levels`. */
          five_means: z.string().optional(),
          one_means: z.string().optional(),
          threshold: z.string().optional(),
          threshold_reason: z.string().optional(),
          /** Which figure the line is drawn over, as dotted paths into the facts sheet
           *  plugin_profile produces (`record.revised_with_evidence_pct`, `refusals.total`).
           *  Required on a quantitative dimension and resolved against this plugin's own sheet. */
          reads: z.array(z.string()).optional(),
        })).min(1),
      },
    },
    async ({ plugin, version, rubric_version, subject, dimensions }) => {
      const p = db();
      if (!p) return noDb();

      // Validated here and not at judging time: by then the figures exist, and a threshold
      // written after them cannot be told from one written before.
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
        } else if (!d.levels?.length) {
          // Every level is named. Two ends and a 1-5 scale leave three rungs to the marker's
          // taste, so two rounds mark the same artifact differently for no recorded reason.
          bad.push(`${d.name}: qualitative and carries no levels — give 2-5 ordered level ` +
                   "descriptions, low end first. Two ends and a 1-5 scale leave the rungs " +
                   "between them to whoever is marking, and that is where two rounds stop " +
                   "being comparable");
        } else if (d.levels.some((l) => !l.trim())) {
          bad.push(`${d.name}: a level is blank — every level a marker may award has to say ` +
                   "what it means");
        }
      }
      if (bad.length) return text(`REFUSED: ${bad.join("; ")}`);

      // The line has to be able to reach its figure, checked against this plugin's real sheet
      // while the ruler is still a draft. Judging time cannot refuse at all: `applyThresholds`
      // answers not met when the facts lack the figure a line needs, so an unanswerable line
      // comes back failed and writes a 1 into eval_score indistinguishable from a real miss.
      if (dimensions.some((d) => d.kind === "quantitative")) {
        const refusal = readsRefusal(dimensions, await factObject(p, plugin, version));
        if (refusal) return text(refusal);
      }

      const pv = (await p.query<{ id: string; plugin_id: string }>(`
        select pv.id::text as id, p.id::text as plugin_id
          from zz.plugin p join zz.plugin_version pv on pv.plugin_id = p.id
         where p.name = $1 and pv.version = $2`, [plugin, version])).rows[0];
      if (!pv) return text(`ERROR: no released version ${version} of "${plugin}" is recorded`);

      const rubricId = (await p.query<{ id: string }>(`
        insert into zz.rubric (plugin_id, version, subject) values ($1::uuid, $2, $3)
        on conflict (plugin_id, version) do update set subject = excluded.subject
        returning id::text as id`, [pv.plugin_id, rubric_version, subject])).rows[0].id;

      // Replaced, not merged, and matched by name, because zz.eval_score carries a foreign key
      // to rubric_dimension.id. A dimension still in the ruler is updated in place and keeps its
      // id, so a score taken against "document depth" stays attached to that row rather than to
      // a replacement that happens to read the same. A dimension the new draft drops is deleted,
      // unless something has already been scored against it — then the caller is told to move to
      // a new rubric version rather than have history rewritten underneath them.
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
                   threshold = $6, threshold_reason = $7, levels = $8::text[],
                   reads = $9::text[]
             where id = $1::uuid`,
            [id, d.five_means ?? "", d.one_means ?? "", i,
             d.kind, d.threshold ?? "", d.threshold_reason ?? "", d.levels ?? null,
             d.reads ?? []]);
        } else {
          await p.query(`
            insert into zz.rubric_dimension
              (rubric_id, name, five_means, one_means, ordinal, kind, threshold, threshold_reason,
               levels, reads)
            values ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9::text[], $10::text[])`,
            [rubricId, d.name, d.five_means ?? "", d.one_means ?? "", i,
             d.kind, d.threshold ?? "", d.threshold_reason ?? "", d.levels ?? null,
             d.reads ?? []]);
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
        "owns the plugin. THERE IS NO `decision` TO SEND: recording cannot close.",
      inputSchema: {
        eval_id: z.string(),
        findings: z.array(z.object({
          pattern: z.string().describe("what recurred, in one sentence"),
          docs_affected: z.number().int().min(0).optional(),
          scope: z.enum(["generic", "specific"]),
          proposed_change: z.string().optional()
            .describe("one change, and what you expect it to do. Omit for a third-party plugin."),
        })).min(1),
      },
    },
    async ({ eval_id, findings }) => {
      const p = db();
      if (!p) return noDb();
      const ev = (await p.query<{ id: string }>(
        "select id::text as id from zz.eval where id = $1::uuid", [eval_id])).rows[0];
      if (!ev) return text(`ERROR: no evaluation ${eval_id}`);

      // A generic finding with no proposed change is an observation: `generic` claims the plugin
      // has a habit worth changing it over, and naming no change leaves the next round nothing
      // to test against. `specific` may stand alone.
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

      // The ids come back, because a finding nobody can name is a finding nobody can close.
      //
      // DELIBERATE: `'deferred'` is a literal in this statement, not a parameter, and there is
      // no input that could supply a decision. A finding closed at birth carries no
      // `decided_by`, `decided_at` or `decision_note`, never counts against headroom because
      // `round_score` reads openness as `decision = 'deferred'`, and can never be decided later
      // because `finding_decide` updates `where decision = 'deferred'`.
      const stored: { id: string; scope: string; pattern: string }[] = [];
      for (const f of findings) {
        const id = (await p.query<{ id: string }>(`
          insert into zz.eval_finding (eval_id, pattern, docs_affected, scope, proposed_change, decision)
          values ($1::uuid, $2, $3, $4, $5, 'deferred') returning id::text as id`,
          [eval_id, f.pattern, f.docs_affected ?? 0, f.scope,
           f.proposed_change ?? ""])).rows[0].id;
        stored.push({ id, scope: f.scope, pattern: f.pattern });
      }
      const who = parseCaller(requestHeaders()).email;
      logActivity(await userRoot(), null,
        { user: who, action: "finding_record", eval_id, findings: stored.length });
      return json({
        eval_id, recorded: stored.length, findings: stored,
        generic: findings.filter((f) => f.scope === "generic").length,
        specific: findings.filter((f) => f.scope === "specific").length,
        next: "These are DEFERRED. Nothing here changes the plugin — the catalog is read-only " +
              "wherever the platform runs, and a change is a repository edit and a release by " +
              "whoever owns it. They stay open, and COUNT AGAINST THIS PLUGIN'S HEADROOM in " +
              "every later round, until finding_decide records that somebody applied or " +
              "rejected each one.",
      });
    },
  );

  server.registerTool(
    "finding_decide",
    {
      description:
        "WHEN somebody who owns the plugin has applied a change an earlier round named, or has " +
        "decided not to. It closes those findings and RETURNS each as it now stands, with who " +
        "decided and when. This is the act finding_record's own description promises and " +
        "nothing performed: a finding lands `deferred` and stays there, counting against this " +
        "plugin's headroom in every later round, until this is called. REFUSES an id nothing " +
        "minted, a finding already decided, and `deferred` as a decision — deferring is where a " +
        "finding starts, so choosing it here would be a decision that changes nothing while " +
        "looking like one that did. A note is required for both real decisions, because " +
        "`applied` with no change named and `rejected` with no reason are the two ways this " +
        "ledger stops being readable.",
      inputSchema: {
        decisions: z.array(z.object({
          finding_id: z.string().describe("from finding_record, or round_score's open_changes"),
          decision: z.enum(["applied", "rejected"]),
          note: z.string().describe(
            "applied: what was changed and where — a version, a file, a release. " +
            "rejected: why this is not worth doing."),
        })).min(1),
      },
    },
    async ({ decisions }) => {
      const p = db();
      if (!p) return noDb();
      const blank = decisions.filter((d) => !d.note.trim());
      if (blank.length) {
        return text(
          `REFUSED: ${blank.length} decision(s) carry no note. An \`applied\` that does not say ` +
          "what changed cannot be checked by the next round, and a `rejected` that does not say " +
          "why is indistinguishable from the finding being forgotten. Both close a change " +
          "somebody proposed; say what happened to it.");
      }
      const who = parseCaller(requestHeaders()).email;
      const done: unknown[] = [];
      const refused: string[] = [];
      for (const d of decisions) {
        // One statement, guarded in the where clause. Reading the row and then updating it would
        // let two callers deciding the same finding both see `deferred` and both write.
        const row = (await p.query<{ id: string; pattern: string; decision: string; at: string }>(`
          update zz.eval_finding
             set decision = $2, decision_note = $3, decided_by = $4, decided_at = now()
           where id = $1::uuid and decision = 'deferred'
          returning id::text as id, pattern, decision, decided_at::text as at`,
          [d.finding_id, d.decision, d.note.trim(), who])).rows[0];
        if (row) { done.push({ ...row, decided_by: who, note: d.note.trim() }); continue; }
        // Which of the two, because they need opposite responses: an unknown id is a caller
        // working from the wrong round, an already-decided one is about to undo someone's work.
        const was = (await p.query<{ decision: string; by: string | null; note: string }>(
          "select decision, decided_by as by, decision_note as note from zz.eval_finding where id = $1::uuid",
          [d.finding_id])).rows[0];
        refused.push(was
          ? `${d.finding_id} was already ${was.decision}${was.by ? ` by ${was.by}` : ""}` +
            `${was.note ? ` — "${was.note}"` : ""}. Reopening a decided finding is not something ` +
            "this tool does: record what the next round found instead."
          : `${d.finding_id} names no finding. Ids come from finding_record, or from the ` +
            "open_changes round_score returns.");
      }
      logActivity(await userRoot(), null,
        { user: who, action: "finding_decide", decided: done.length, refused: refused.length });
      return json({
        decided: done.length, findings: done,
        refused: refused.length ? refused : undefined,
        next: done.length
          ? "These no longer count against the plugin's headroom. The next round will read the " +
            "remaining open ones and say what is still available to do."
          : "Nothing was decided.",
      });
    },
  );

  server.registerTool(
    "round_score",
    {
      description:
        "WHEN a round's marks and findings are in and the report needs its numbers. It " +
        "computes the TWO AXES from figures no model touched — effectiveness out of 10 with " +
        "the band it falls in, and headroom: the distance from 10, the count of named changes " +
        "still open on this plugin, and which of four states that puts it in. It records both " +
        "and RETURNS them, with the open changes enumerated so the count can be checked. It " +
        "also asks the typed service one thing the marks cannot answer — how strong this body " +
        "of evidence is. IT RECOMMENDS NOTHING: it used to choose `keep` / `keep-and-change` / " +
        "`retire`, and that question has one permanent answer, because a plugin somebody " +
        "installed on purpose is one they keep. The headroom state is what replaced it and it " +
        "reports the evidence rather than prescribing an action: `no change needed`, `change " +
        "identified`, `unexplained gap`, `not measured`. REFUSES an eval_id nothing minted, " +
        "the CONTROL run's eval_id, and an eval_id no control run names — a round whose ruler " +
        "was never tried against another plugin's work establishes nothing. Reports evidence " +
        "strength as ABSENT, without failing and without withholding the axes, when the " +
        "deployment has no key for the service.",
      inputSchema: { eval_id: z.string() },
    },
    async ({ eval_id }) => {
      const p = db();
      if (!p) return noDb();
      const round = (await p.query<{
        plugin: string; version: string; rubric: string; judge: string; is_control: boolean;
      }>(`
        select pl.name as plugin, pv.version, rb.version as rubric, e.judge_model as judge,
               e.is_control
          from zz.eval e
          join zz.plugin_version pv on pv.id = e.plugin_version_id
          join zz.plugin pl on pl.id = pv.plugin_id
          join zz.rubric rb on rb.id = e.rubric_id
         where e.id = $1::uuid`, [eval_id])).rows[0];
      if (!round) return text(`ERROR: no plugin evaluation ${eval_id}`);
      if (round.is_control) {
        return text(
          "ERROR: that eval_id is the CONTROL run. A control marks another plugin's work to " +
          "test whether the ruler discriminates; it is not the round being recommended on. " +
          "Pass the real round's eval_id — round_scores shows both.");
      }

      // No control, no verdict. A score without a blind control establishes nothing: a ruler
      // that cannot tell this plugin's work from another plugin's produces marks that mean
      // nothing, and the gap is the only thing that says which case you are in.
      //
      // DELIBERATE: a refusal here rather than a ruler line. The figure is not in the profile
      // and the control runs after the pass that would read it, so such a line would be false at
      // the instant it is measured whatever the truth is.
      const ctl = (await p.query<{ id: string }>(
        "select id::text as id from zz.eval where controls = $1::uuid limit 1", [eval_id])).rows[0];
      if (!ctl) {
        return text(
          "REFUSED: no control run names this round, so there is no verdict to give. A control " +
          "marks ANOTHER plugin's work against this same ruler; the gap between the two is what " +
          "says whether the ruler can tell the right artifact from the wrong one. Without it " +
          "the marks are unfalsifiable — a ruler that scores everything 4 and a ruler that " +
          "works look identical. Run round_judge again with `control: true` for this version, " +
          "then call this. Rounds taken before controls were recorded cannot be recommended on " +
          "and have to be re-taken.");
      }

      // What this round established, read back rather than re-derived. Every figure is already
      // stored: the means the judge produced, the control it was tried against, the thresholds.
      // Re-deriving would let the recommendation rest on numbers the report never showed.
      const dims = (await p.query<{ dimension: string; kind: string; mean: string; n: string;
                                    confidence: string | null }>(`
        select d.name as dimension, d.kind, round(avg(s.score),2)::text as mean,
               count(*)::text as n, round(avg(s.confidence),2)::text as confidence
          from zz.eval_score s join zz.rubric_dimension d on d.id = s.dimension_id
         where s.eval_id = $1::uuid and not s.is_control
         group by d.name, d.kind, d.ordinal order by d.ordinal`, [eval_id])).rows;
      // This round's own control, named — not every round that shares a version and a ruler.
      // Pooling across `plugin_version_id + rubric_id` lets a round whose own control collapsed
      // read as discriminating because an earlier round's did.
      const control = (await p.query<{ real: string | null; ctl: string | null }>(`
        select round(avg(s.score) filter (where not s.is_control),2)::text as real,
               round(avg(s.score) filter (where s.is_control),2)::text as ctl
          from zz.eval_score s
          join zz.rubric_dimension d on d.id = s.dimension_id and d.kind <> 'quantitative'
         where s.eval_id in ($1::uuid, $2::uuid)`, [eval_id, ctl.id])).rows[0];
      // Every finding still open on this plugin, not just this round's: headroom counts named
      // changes, and a change named by an earlier round and never decided is one.
      //
      // `deferred` is the open state; the other two are closed. `applied` would charge the
      // plugin for work already done, and `rejected` is a change nobody intends to make. Neither
      // is a silent drop — `finding_decide` records who closed it and why.
      const findings = (await p.query<{ id: string; scope: string; pattern: string;
                                        change: string; round: string; open: boolean }>(`
        select f.id::text as id, f.scope, f.pattern, f.proposed_change as change,
               pv2.version as round, (f.decision = 'deferred') as open
          from zz.eval_finding f
          join zz.eval e2 on e2.id = f.eval_id
          join zz.plugin_version pv2 on pv2.id = e2.plugin_version_id
         where pv2.plugin_id = (select pv.plugin_id from zz.eval e
                                  join zz.plugin_version pv on pv.id = e.plugin_version_id
                                 where e.id = $1::uuid)
           and (f.eval_id = $1::uuid or f.decision = 'deferred')
         order by f.created_at`, [eval_id])).rows;
      const open = findings.filter((f) => f.open);

      const gap = control?.real && control?.ctl
        ? Math.round((Number(control.real) - Number(control.ctl)) * 100) / 100 : null;
      // The score goes into the state, so the enum is chosen knowing it. The word and the number
      // answer different questions and must not be derived independently, or a report can carry
      // "keep" beside a 4.2 with nothing saying which to believe.
      const qual = dims.filter((d) => d.kind === "qualitative");
      const quant = dims.filter((d) => d.kind === "quantitative");
      const qualMean = qual.length
        ? Math.round((qual.reduce((a, d) => a + Number(d.mean), 0) / qual.length) * 100) / 100
        : null;
      const metCount = quant.filter((d) => Number(d.mean) >= 5).length;
      const effective = effectiveness(qualMean, metCount, quant.length, gap);
      const room = headroom(effective.score, quant.length - metCount,
                            open.filter((f) => f.scope === "generic").length);

      const state = [
        `Plugin under evaluation: ${round.plugin} ${round.version}, marked against rubric ` +
        `version ${round.rubric} by judge ${round.judge}.`,
        effective.score === null
          ? `Effectiveness: NOT MEASURABLE. ${effective.basis}`
          : `Effectiveness: ${effective.score} out of 10 — "${effective.band}". ${effective.basis}.`,
        `Room to improve: ${room.state} — ${headroomNote(room)}.`,
        dims.length
          ? "Dimension results: " + dims.map((d) => `${d.dimension} (${d.kind}) mean ${d.mean} ` +
              `over ${d.n} mark(s)` + (d.confidence ? `, judge confidence ${d.confidence}` : "")).join("; ") + "."
          : "No dimension produced a mark in this round.",
        gap === null
          ? "No blind control was run, so nothing establishes whether the ruler can tell this " +
            "plugin's work from another plugin's."
          : `Judge on trial: the real subjects averaged ${control?.real} and the blind control ` +
            `averaged ${control?.ctl}, a gap of ${gap}. A gap below 1.5 means the ruler failed ` +
            "to tell the right artifact from the wrong one and the round establishes nothing.",
        // The same set the score was computed from. A state naming only this round's findings
        // while headroom counted every open one would let `keep` be chosen against a plugin with
        // four changes waiting that were never shown.
        open.length
          ? `Changes still open on this plugin: ${open.length}, of which ` +
            `${open.filter((f) => f.round === round.version).length} were named by this round ` +
            `and the rest by earlier ones and never decided (` +
            open.map((f) => `${f.scope}, from ${f.round}: ${f.pattern}`).join(" | ").slice(0, 1200) + ")."
          : findings.length
            ? `This round recorded ${findings.length} finding(s) and every change named against ` +
              "this plugin has since been applied or rejected, so nothing is open."
            : "No findings were recorded against this round, and none are open from earlier ones.",
      ].join(" ");

      // Absence is an answer. A deployment with no key still produces a report — one that says
      // the typed judgement was not taken and why, which a reader can act on.
      if (!configured()) {
        return json({
          eval_id, plugin: round.plugin, version: round.version,
          effectiveness: effective, headroom: { ...room, note: headroomNote(room) },
          evidence_strength: null, absent: NOT_CONFIGURED,
          state_that_would_have_been_asked: state,
          next: "BOTH AXES ARE STILL GOOD — they are computed from figures no model touched, " +
                "and they are above. What is absent is only how strong the typed judge would " +
                "have called this body of evidence. Write the report, carry both axes, and say " +
                "in section 1 that evidence strength was not taken and why.",
        });
      }

      // No recommendation is asked for. Both axes are computed from figures no model touched, so
      // a choice between `keep`/`re-run`/`retire` adds nothing.
      //
      // What is asked is how strong the body of evidence is: a judgement about the round rather
      // than the plugin, not derivable from the marks.
      const questions: Record<string, ScoreQuestion> = {
        evidence_strength: {
          type: "score",
          instructions: "How strong is the body of evidence behind this verdict?",
          criteria: ["No usable evidence", "Thin — one source only", "Adequate", "Strong across two independent sources"],
        },
      };
      let strength;
      try {
        strength = (await ask(state, questions)).evidence_strength;
      } catch (err) {
        return text(String((err as Error).message));
      }

      // The number is stored, not only returned, so anything reading this table later sees a
      // measurement and not just a verb.
      //
      // COUPLED: judge-score.ts owns the arithmetic. Stored rather than recomputed by the
      // reader, because a second copy in the console's API would drift the first time a weight
      // changed. The band is not stored — it is `band(score)` over a column in the same row, so
      // storing it stores a cache. The rule lives in @zz/contracts; both services call it.
      await p.query(`
        update zz.eval set effectiveness = $2, headroom_points = $3,
                           headroom_named = $4, headroom_state = $5
         where id = $1::uuid`,
        [eval_id, effective.score, room.points, room.named_changes, room.state]);

      const who = parseCaller(requestHeaders()).email;
      logActivity(await userRoot(), null,
        { user: who, action: "round_score", eval_id, plugin: round.plugin,
          version: round.version, effectiveness: effective.score, headroom: room.state });

      return json({
        eval_id, plugin: round.plugin, version: round.version,
        // Two axes and nothing else. They answer different questions — how well it performs, and
        // whether anything is left to do — and neither is derivable from the other.
        effectiveness: effective,
        headroom: { ...room, note: headroomNote(room) },
        // What the headroom is made of, with the handle needed to close each one — the rows the
        // count was computed from, including ones earlier rounds named and nobody has decided.
        open_changes: open.map((f) => ({
          finding_id: f.id, scope: f.scope, named_by_round: f.round,
          pattern: f.pattern, proposed_change: f.change,
          carried_over: f.round !== round.version,
        })),
        // The figure, its scale and how sure the judge was, all three as the adapter validated
        // them. A reply carrying none of that never reaches here — `ask` refuses it — so a null
        // here is the absence of a score rather than a score nobody could read.
        evidence_strength: strength && strength.readings.score !== null
          ? { score: strength.readings.score, legend: strength.readings.legend,
              confidence: strength.readings.confidence }
          : null,
        judge_on_trial_gap: gap,
        next: "Both axes are recorded. Section 1 of findings.md carries them verbatim — the " +
              "score with its band, and the headroom state with its count; the paragraphs " +
              "underneath are yours to write, from these numbers and from reading the " +
              "artifacts, never a different conclusion reached in prose.",
      });
    },
  );
}
