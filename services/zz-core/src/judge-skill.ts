/**
 * A SKILL AS THE SUBJECT OF THE JUDGE. Everything here knows what a skill is; judge.ts does
 * not, and that is the split.
 *
 * It used to all be one file, correctly: with one subject kind there was no second thing to
 * separate, and the repository's own size rule says so — a 627-line judge.ts with three
 * exports was named in the check as the example of a file that would only make fragments if
 * it were cut. What changed is that a plugin became a subject too. The loop that marks and
 * stores is now shared by two callers that agree on nothing about their subjects except that
 * both leave artifacts behind, so "how a judge marks" and "what a skill is" stopped being one
 * subject — and keeping them together would have pushed the judge past the ceiling to say so.
 *
 * What lives here: which ruler a skill version declares, which of its artifacts can be
 * judged and how many there were to choose from, where its own text is served from, and which
 * other skill's work stands in for the control.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { catalogPackages } from "@zz/catalog";
import type pg from "pg";

import { Dim, JudgeResult, Marking, SUBJECT_CAP, Subject, markAll, traceOf } from "./judge.js";

/** A skill's own text, from the shelf the platform serves it off.
 *
 * Read from the catalog rather than from the database, because the catalog IS what an agent
 * is handed: `skill_view` resolves the same directories in the same order, so what the judge
 * reads is what a reader would have got. zz.skill_version keeps a body_hash and not the body,
 * which is the right split — the hash says whether the text moved, the shelf holds the text.
 */
function bodyOfSkill(name: string): string | null {
  for (const { dir } of catalogPackages()) {
    for (const sub of ["skills", "."]) {
      const f = join(dir, sub, name, "SKILL.md");
      if (existsSync(f)) return readFileSync(f, "utf8");
    }
  }
  for (const root of ["/skills", "/blocks"]) {
    if (!existsSync(root)) continue;
    for (const e of readdirSync(root, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      for (const f of [join(root, e.name, "SKILL.md"), join(root, e.name, "skills", name, "SKILL.md")]) {
        if (e.name === name && existsSync(f)) return readFileSync(f, "utf8");
        if (f.includes(`/${name}/SKILL.md`) && existsSync(f)) return readFileSync(f, "utf8");
      }
    }
  }
  return null;
}

/** Any other skill's text, for the control. Deliberately the first one that is not this skill
 *  and is not trivially short: a two-line stub would collapse under any ruler for reasons that
 *  say nothing about whether the judge was reading. */
function otherSkillBody(notThis: string): string | null {
  for (const { dir } of catalogPackages()) {
    const skillsDir = join(dir, "skills");
    if (!existsSync(skillsDir)) continue;
    for (const e of readdirSync(skillsDir, { withFileTypes: true })) {
      if (!e.isDirectory() || e.name === notThis) continue;
      const f = join(skillsDir, e.name, "SKILL.md");
      if (!existsSync(f)) continue;
      const body = readFileSync(f, "utf8");
      if (body.length > 2000) return body;
    }
  }
  return null;
}

/** WHICH SUBJECTS THIS RULER APPLIES TO, and how many there were to choose from.
 *
 * ONE FUNCTION, because two readers need the same answer and a second query would drift from
 * it. The judge takes `docs`/`runs` and scores them; the report takes `population` and prints
 * the denominator — which no tool computed at all until now, so every findings.md said "13
 * subjects" and nothing anywhere said 13 OF WHAT. A reader could not tell a round that
 * covered everything from one that covered a tenth of it.
 *
 * The cap is real and belongs in the denominator too: a round judges at most SUBJECT_CAP, so
 * a skill with sixty runs is sampled, and a report that did not say so would be claiming a
 * census. */
export async function enumerate(p: pg.Pool, versionId: string, declared: Subject | "auto"): Promise<{
  kind: Subject;
  docs: { team_slug: string; initiative: string; path: string; id: string }[];
  runs: { run_id: string; started: string }[];
  population: { total: number; eligible: number; capped: boolean; what: string };
}> {
  const docs = declared === "trace" || declared === "body" ? []
    : (await p.query<{ team_slug: string; initiative: string; path: string; id: string }>(`
        select d.team_slug, d.initiative, d.path, d.id::text as id
          from zz.doc d join zz.run r on r.id = d.produced_by_run_id
         where r.skill_version_id = $1::uuid and d.path not like '\\_versions/%'
         order by d.created_at desc limit ${SUBJECT_CAP}`, [versionId])).rows;

  const kind: Subject = declared === "body" ? "body" : docs.length ? "document" : "trace";
  const runs = kind === "trace"
    ? (await p.query<{ run_id: string; started: string }>(`
        select r.id::text as run_id, to_char(r.started_at,'YYYY-MM-DD HH24:MI') as started
          from zz.run r
         where r.skill_version_id = $1::uuid
           and exists (select 1 from zz.event e where e.run_id = r.id)
         order by r.started_at desc limit ${SUBJECT_CAP}`, [versionId])).rows
    : [];

  // TOTAL is everything of that kind this version produced, before the cap and before the
  // eligibility test. The gap between total and eligible is the sentence a report has to be
  // able to write: "14 runs exist; one recorded no events, so it cannot be judged."
  const total = kind === "body" ? 1
    : kind === "document"
      ? Number((await p.query<{ n: string }>(`
          select count(*)::text as n from zz.doc d join zz.run r on r.id = d.produced_by_run_id
           where r.skill_version_id = $1::uuid and d.path not like '\\_versions/%'`,
          [versionId])).rows[0].n)
      : Number((await p.query<{ n: string }>(
          "select count(*)::text as n from zz.run r where r.skill_version_id = $1::uuid",
          [versionId])).rows[0].n);

  const eligible = kind === "body" ? 1 : kind === "document" ? docs.length : runs.length;
  return {
    kind, docs, runs,
    population: {
      total, eligible, capped: eligible >= SUBJECT_CAP,
      what: kind === "body" ? "the skill's own text"
        : kind === "document" ? "documents this version produced"
        : "runs of this version that left events",
    },
  };
}

/** The ruler this version declares. No ruler, no judging — that refusal IS zz-skill-define's
 *  gate showing through, and routing around it produces scores under a scale nobody agreed
 *  to, indistinguishable afterwards from scores that were. */
async function ruler(p: pg.Pool, skill: string, version: string) {
  const { rows } = await p.query<Dim & { version_id: string; rubric_id: string; rubric_version: string; subject: string }>(`
    select sv.id::text as version_id, r.id::text as rubric_id, r.version as rubric_version, r.subject,
           d.id::text as dim_id, d.name, d.five_means, d.one_means,
           d.kind, d.threshold, d.threshold_reason
      from zz.skill s
      join zz.skill_version sv on sv.skill_id = s.id
      join zz.rubric r on r.id = sv.rubric_id
      join zz.rubric_dimension d on d.rubric_id = r.id
     where s.name = $1 and sv.version = $2
     order by d.ordinal`, [skill, version]);
  return rows;
}

/** Score one version of one skill against the ruler it declares.
 *
 * A RESOLVER, not a loop: it turns two identifiers into the descriptor markAll marks, and
 * every refusal it can give is about this subject in particular — no ruler, no artifact, a
 * body ruler for a skill the catalog does not serve. */
export async function judgeSkill(
  p: pg.Pool, skill: string, version: string, control: boolean, take: number,
  evalId: string | null,
  bodyOf: (teamSlug: string, initiative: string, path: string) => string | null,
): Promise<JudgeResult> {
  const dims = await ruler(p, skill, version);
  if (!dims.length) {
    throw new Error(
      `${skill} ${version} declares no ruler, so nothing can be scored against it. ` +
      "That is zz-skill-define's gate showing through: agree rulers.md, then " +
      `eval_skill_affirm(skill: "${skill}", version: "${version}").`);
  }
  const versionId = dims[0].version_id;

  // WHAT THIS RULER IS FOR, and the rubric says so — not the caller, and not an inference
  // from what the skill happened to leave behind. `auto` keeps the old inference, which is
  // right for a flow stage: documents where it wrote any, traces where it did not. `body`
  // is a vendored file, whose ruler asks whether it earns its place beside the block's own
  // tools — a question no run trace can answer, and traces were all the judge could see.
  const declared = (dims[0].subject ?? "auto") as Subject | "auto";

  const { kind, docs, runs } = await enumerate(p, versionId, declared);

  if (kind === "trace" && !runs.length) {
    throw new Error(`${skill} ${version} left neither a document nor a run with events — ` +
                    "there is nothing to judge. This is a fact about its reach, not its quality.");
  }
  // The skill's own text, which the platform serves and therefore holds. One subject: there
  // is one body, and padding it would be inventing subjects.
  const body = kind === "body" ? bodyOfSkill(skill) : null;
  if (kind === "body" && !body) {
    throw new Error(`this ruler judges the text of ${skill}, and the catalog does not serve ` +
                    "a skill by that name — register-skills runs first.");
  }

  const items = kind === "body"
    ? [{ key: `body:${versionId}`, label: `${skill} ${version} (the skill itself)`,
         runId: null, docId: null, team: "", init: "", path: "", text: body }]
    : kind === "document"
    ? docs.map((d) => ({ key: d.id, label: `${d.initiative}/${d.path}`, runId: null,
                         docId: d.id, team: d.team_slug, init: d.initiative, path: d.path }))
    : runs.map((r) => ({ key: r.run_id, label: r.started, runId: r.run_id,
                         docId: null, team: "", init: "", path: "" }));

  const marking: Marking = {
    versionColumn: "skill_version_id", versionId, noun: "skill", name: skill, version,
    rubricId: dims[0].rubric_id, rubricVersion: dims[0].rubric_version, dims, kind, items,
    // A skill's ruler has no quantitative dimension today: every one of them asks a reader to
    // place a text between two written ends. Null rather than an empty string, so the judge
    // can tell "this ruler draws no lines" from "the facts came back blank".
    facts: null,
    control: async () => {
      if (kind === "body") {
        // Another skill's TEXT under this ruler. A judge that is reading sees at once that a
        // different skill does not answer these dimensions; one rewarding confident prose does
        // not. Same test as the trace control, same artifact kind as the subject — a control of
        // a different kind would measure the kind, not the judge.
        const other = otherSkillBody(skill);
        if (!other) throw new Error("no other skill's text to use as a control");
        return { text: other, truncated: 0 };
      }
      const other = (await p.query<{ run_id: string }>(`
        select r.id::text as run_id from zz.run r
         join zz.skill_version sv on sv.id = r.skill_version_id
         join zz.skill s on s.id = sv.skill_id
        where s.name <> $1 and exists (select 1 from zz.event e where e.run_id = r.id)
        order by r.started_at desc limit 1`, [skill])).rows[0];
      if (!other) throw new Error("no other skill's run to use as a control");
      return traceOf(p, other.run_id);
    },
  };
  return markAll(p, marking, control, take, evalId, bodyOf);
}

/** Record that a version is judged by its skill's current ruler.
 *
 * `zz.skill_version.rubric_id` is what says "this version is judged by this ruler", and until
 * now the only thing that set it was eval-store, as a side effect of STORING A JUDGED RUN —
 * so re-affirming a ruler before judging, which is zz-skill-define's entire purpose, had
 * nowhere to land. You had to judge first to record the ruler you were meant to agree on
 * first. `zz-tool rubric-load --affirm` was the door, and an agent has MCP tools and no
 * shell, so from inside the flow that gate could not be closed at all.
 *
 * It records a decision; it does not make one. Whether rulers.md was approved first is the
 * stage's rule and stays there — a tool that enforced it would be a tool inventing the
 * stakeholder. */
export async function affirmRuler(p: pg.Pool, skill: string, version: string): Promise<string> {
  const { rows } = await p.query<{ id: string; rubric: string | null; rv: string | null }>(`
    select sv.id::text as id, r.id::text as rubric, r.version as rv
      from zz.skill s
      join zz.skill_version sv on sv.skill_id = s.id
      left join zz.rubric r on r.skill_id = s.id
     where s.name = $1 and sv.version = $2
     order by r.version::numeric desc nulls last limit 1`, [skill, version]);
  if (!rows.length) return `ERROR: no ${skill} ${version} in zz.skill_version`;
  if (!rows[0].rubric) {
    return `ERROR: ${skill} has no ruler to affirm. One is written at ` +
           "<skill>/evals/rubric.json in the catalog and loaded by the platform team; " +
           "until it exists there is nothing for this version to be judged by.";
  }
  await p.query("update zz.skill_version set rubric_id = $1::uuid where id = $2::uuid",
                [rows[0].rubric, rows[0].id]);
  return `${skill} ${version} is now judged by this skill's rubric v${rows[0].rv}. ` +
         "Scores taken from here are comparable with every other round under it.";
}
