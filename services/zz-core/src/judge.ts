/**
 * The judge, server-side.
 *
 * WHAT MOVED AND WHAT DID NOT. Scoring used to run from a terminal: `judge-stats.mjs` for a
 * skill that writes no document, `eval-judge` for one that does, both shelling out to the
 * `claude` CLI. judge-stats carried a paragraph saying it "is NOT an MCP tool, and must not
 * become one" — and the thing that paragraph was protecting is real, but it is not the
 * invocation channel. It is that THE FLOW'S AGENT MUST NOT BE THE JUDGE: a judge that varies
 * with the conversation makes every number incomparable with every other number.
 *
 * That invariant is kept here, harder than the CLI kept it. The tool takes identifiers only —
 * a skill and a version. The rubric, the subjects and their text are assembled from the
 * database and the artifact store; the model is pinned by deployment configuration and named
 * on every row. The caller cannot supply the artifact, cannot supply the ruler, and cannot
 * supply the model. What it could do from a terminal — set JUDGE_MODEL, hand judge-stats a
 * different --psql — it cannot do from here.
 *
 * What the CLI kept that a container cannot is the `claude` binary. There is none in this
 * image and there will not be one, so the pinned judge is a model on the platform's own LLM
 * endpoint. `zz.eval.judge_model` has always carried the judge's name and every comparison in
 * evaluation.ts groups by it, so scores taken under the old judge stay their own group rather
 * than being silently averaged with these.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { catalogPackages } from "@zz/catalog";
import type pg from "pg";

/** The judge is NOT the platform's base model. The base model is what the flows' own agents
 *  run on, and judging with it would make the judge exactly as good as the thing being
 *  judged — the one property a ruler must not have. It is pinned separately and defaults to
 *  the full model where the agents run on the flash one. */
const JUDGE_BASE = process.env.ZZ_JUDGE_MODEL || "glm-5.3";

/** EXTENDED REASONING IS ON, and the control is why.
 *
 * It was turned off for a good reason and put back for a better one. With it on, a control
 * call ran past 95 seconds and timed out three times in a row, storing nothing — and a lost
 * control costs a round the only number that establishes the judge was reading rather than
 * rewarding confident prose. Off, the same call answered in five seconds. That looked like a
 * clear trade.
 *
 * Then the control judged the change, and THE CONCLUSION DRAWN FROM IT WAS WRONG. It read:
 * under the fast judge using-casebox's gap fell from 1.67 to 1.00 and
 * writing-case-queries went to minus 0.33, therefore the fast judge is broken.
 *
 * Both of those rounds have `subject: body`, and no body round has EVER cleared the collapse
 * line, under any judge, with reasoning on or off. Measured across the whole store on
 * 2026-09-06: using-casebox is -1.83 with reasoning and -1.00 without;
 * writing-case-queries is 0.00 with and +0.33 without. Reasoning-off scored BETTER on both.
 * The "1.67" was a gap that was already negative, reported as though it were positive and
 * shrinking.
 *
 * The cause is the ruler, not the mode. A body rubric asks generic questions about a skill's
 * text, the control is another skill's text, and a decent one answers them — so the control
 * cannot fail and the comparison measures nothing about the judge. Turning reasoning off made
 * a meaningless number noisier; it did not make it meaningless.
 *
 * Reasoning stays ON, and the reason is now the honest one: a mode change is a judge change,
 * it starts an incomparable series, and there is no measured benefit to buying that. The
 * timeout is paid rather than avoided, which the resume design affords — a subject whose call
 * times out is reported skipped, `remaining` does not move, and the next call retries it with
 * a fresh budget.
 *
 * ZZ_JUDGE_THINKING=off is kept, because the comparison above is worth being able to re-run —
 * and because a mode is part of a judge's identity, it records as a different judge name and
 * never averages with these. */
const THINKING = (process.env.ZZ_JUDGE_THINKING || "on").toLowerCase() === "on";
const JUDGE_MODEL = THINKING ? JUDGE_BASE : `${JUDGE_BASE}/no-reasoning`;
const LLM_BASE = (process.env.LLM_BASE_URL || "").replace(/\/+$/, "");
const LLM_KEY = process.env.LLM_API_KEY || "";

/** Events shown to the judge, per subject. The cap is announced in the text and recorded in
 *  the stored note — an ops-build run reaches 569 events, and a judge handed the first 400
 *  scores a different run from the one that happened. */
const TRACE_CAP = 400;

type Subject = "document" | "trace" | "body";

interface Mark { dimension: string; score: number; cite: string; why: string }

interface Dim { dim_id: string; name: string; five_means: string; one_means: string }

/** One call to the pinned judge, answering JSON.
 *
 * ONE ATTEMPT, BOUNDED. This retried once on an unparseable answer, which is the right
 * instinct — a model occasionally emits JSON it did not finish, and the same question asked
 * again usually parses — and exactly the wrong shape here. A document takes this judge about
 * eighty seconds, the request that carries the call is severed at two minutes, and a retry
 * makes the failure certain rather than recoverable: the whole call is lost, including the
 * subject that would have parsed. The caller judges one subject per call and resumes, so a
 * failed subject is retried by the NEXT call, with its own fresh budget. That is the retry,
 * moved to where it can afford itself.
 *
 * The timeout is explicit because fetch has none: without it a stalled endpoint hangs the
 * request until something upstream gives up, and the reason never reaches anybody.
 */
async function ask(system: string, user: string): Promise<Record<string, unknown> | null> {
  if (!LLM_BASE || !LLM_KEY) throw new Error("no LLM endpoint configured for the judge");
  let body: string;
  const r = await fetch(`${LLM_BASE}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${LLM_KEY}` },
    // As long as the request that carries it can survive. Something between this tool and
    // its caller closes an MCP request at about two minutes, so there is no point waiting
    // longer than the answer could be delivered — and no point stopping earlier either,
    // which 95 seconds did: a control that needed a hundred was abandoned three times with
    // twenty-five seconds of the window unused.
    signal: AbortSignal.timeout(110_000),
    body: JSON.stringify({
      // The model as the ENDPOINT knows it. JUDGE_MODEL carries the mode as well, because a
      // mode is part of the judge's identity, and that is what lands in zz.eval.judge_model.
      model: JUDGE_BASE,
      ...(THINKING ? {} : { thinking: { type: "disabled" } }),
      // Deterministic on purpose. A judge that samples gives two different numbers for one
      // artifact, and the whole point of pinning it is that it does not.
      temperature: 0,
      // GENEROUS, because the cap was the bug. At 4000 this model spent most of the budget on
      // reasoning tokens and returned `finish_reason: "length"` — JSON cut off mid-string,
      // which is unparseable, which triggered the retry, which spent the request's whole
      // remaining time. The symptom was a tool that returned nothing; the cause was a number.
      max_tokens: 16000,
      messages: [{ role: "system", content: system }, { role: "user", content: user }],
    }),
  });
  if (!r.ok) {
    const t = (await r.text()).slice(0, 300);
    // Quota is not a formatting slip: rediscovering it once per subject would spend a whole
    // round learning the same thing.
    if (r.status === 429 || /limit|quota/i.test(t)) throw new Error(`the judge is out of quota: ${t}`);
    throw new Error(`the judge answered ${r.status}: ${t}`);
  }
  const said = (await r.json()) as {
    choices?: { finish_reason?: string; message?: { content?: string } }[] };
  // Said out loud, because a truncated answer is not a bad document and must never be scored
  // as one.
  if (said.choices?.[0]?.finish_reason === "length") {
    throw new Error("the judge ran out of output budget mid-answer — the mark is incomplete " +
                    "and is not being stored");
  }
  body = String(said.choices?.[0]?.message?.content ?? "");
  const m = /\{[\s\S]*\}/.exec(body);
  if (!m) return null;
  try { return JSON.parse(m[0]) as Record<string, unknown>; } catch { return null; }
}

const RULES = [
  "- Score each dimension 1 to 5 and cite your evidence VERBATIM, in under 200 characters. If",
  "  you cannot cite something that supports your score, the score is wrong.",
  "- Use each dimension's name EXACTLY as given, punctuation and parentheses included. A name",
  "  you shortened is a dimension nobody scored.",
  "- Be brief: one or two sentences of `why` per dimension. Length is not thoroughness here,",
  "  and a long answer is one that gets cut off before it is finished.",
  "- Name the single most consequential weakness, cited, with a concrete fix. Everything has a",
  "  weakest point, including good work. Writing 'none' is refusing the job.",
  "- Do not be generous. A 5 means you would hold this up as how it should be done. Most work",
  "  is a 3.",
  "",
  'Answer as JSON only: {"marks": [{"dimension": string, "score": number, "cite": string,',
  '"why": string}], "worst": {"cite": string, "fix": string}}',
];

function systemFor(kind: Subject, skill: string, version: string, dims: Dim[], control = false): string {
  // THE CONTROL IS NOT TOLD IT IS READING THE SKILL IT IS NOT READING.
  //
  // The control hands the judge a DIFFERENT artifact under this ruler, and the prompt said
  // "You are marking the skill writing-templates ITSELF" over the top of it. That is a
  // contradiction the judge has to reconcile before it can answer anything, and it is the
  // best explanation for why two of these ran past the request's whole budget while the
  // plain judgement of the same skill answered in half the time.
  //
  // Naming no skill also protects the measurement. The control asks whether this ruler
  // discriminates between artifacts; telling the judge which skill it is supposed to be
  // reading invites it to score the ruler's fit rather than the text in front of it.
  if (control) skill = "the artifact below";
  return [
    control
      ? "You are marking the text below against the dimensions given. It may or may not be "
        + "the kind of thing they were written for; score what is in front of you."
      : kind === "trace"
      ? `You are judging one RUN of the skill "${skill}" version ${version}.`
      : kind === "body"
      ? `You are marking the skill "${skill}" version ${version} ITSELF — the text below is the skill.`
      : `You are marking one document produced by the skill "${skill}" version ${version}.`,
    "",
    kind === "body"
      ? [
        "This is not work the skill produced. It is the skill: the instructions an agent is",
        "handed when it loads this name. Judge whether these instructions earn their place —",
        "whether they say anything a reader could not get elsewhere, whether they fit the work",
        "they are served into, whether they are honest about their own age. Do not judge",
        "whether they are well written.",
      ].join("\n")
      : kind === "trace"
      ? [
        "This skill writes no document. What it leaves is a changed system and a trail of tool",
        "calls, and that trail is what you are reading. Judge the WORK, not the prose — there is",
        "no prose. A read-back after a write is evidence of verification; a write with no read",
        "after it is evidence of its absence; an identical failing call repeated is evidence of",
        "not learning within the run.",
      ].join("\n")
      : "Judge the document in front of you. Quote it as your evidence, never paraphrase it.",
    "",
    "THE DIMENSIONS, and what each end of them looks like:",
    ...dims.map((d) => `- ${d.name}\n    5 = ${d.five_means}\n    1 = ${d.one_means}`),
    "",
    "RULES.",
    ...RULES,
  ].join("\n");
}

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
const SUBJECT_CAP = 20;

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
           d.id::text as dim_id, d.name, d.five_means, d.one_means
      from zz.skill s
      join zz.skill_version sv on sv.skill_id = s.id
      join zz.rubric r on r.id = sv.rubric_id
      join zz.rubric_dimension d on d.rubric_id = r.id
     where s.name = $1 and sv.version = $2
     order by d.ordinal`, [skill, version]);
  return rows;
}

/** One run as the text a judge reads. Truncation is announced in the text AND returned, so
 *  neither the judgement nor the stored record can claim more coverage than it had. */
async function traceOf(p: pg.Pool, runId: string): Promise<{ text: string; truncated: number }> {
  const total = Number((await p.query<{ n: string }>(
    "select count(*) as n from zz.event where run_id = $1::uuid", [runId])).rows[0]?.n ?? 0);
  const { rows } = await p.query<{ at: string; subject: string; ok: boolean | null; refusal: string }>(`
    select to_char(e.ts,'HH24:MI:SS') as at, e.subject, e.ok,
           coalesce(left(e.refusal, 160), '') as refusal
      from zz.event e where e.run_id = $1::uuid
     order by e.ts limit ${TRACE_CAP}`, [runId]);
  const body = rows.map((e) => `${e.at}  ${e.subject}  ${e.ok === false ? "REFUSED" : "ok"}` +
                               `${e.refusal ? `  ${e.refusal}` : ""}`).join("\n");
  const cut = total - rows.length;
  return cut > 0
    ? { text: `${body}\n[TRACE TRUNCATED: ${rows.length} of ${total} events shown]`, truncated: cut }
    : { text: body, truncated: 0 };
}

interface JudgeResult {
  skill: string; version: string; judge: string; rubric_version: string;
  eval_id: string; kind: Subject; control: boolean;
  judged_now: number; judged_total: number; remaining: number;
  stored: number; uncited: number; truncated: number;
  subjects: { subject: string; mean: number; truncated: number }[];
  skipped: string[];
  /** Marks the judge named that the ruler has no dimension for — measured nothing, and said so. */
  unmatched: string[];
  next: string;
}

/**
 * Score one version of one skill against its ruler, A FEW SUBJECTS AT A TIME.
 *
 * SUBJECTS ARE WHATEVER THE VERSION LEFT BEHIND. Five of the platform's skills produce a
 * gated document; the rest produce a changed system and a trail of tool calls. Both are
 * artifacts a judge reads, so both are judged here against the same ruler rather than one
 * being judged and the other reported as unmeasurable. Never both at once: two subject kinds
 * under one mean is a number about nothing.
 *
 * WHY IT RESUMES RATHER THAN FINISHING. One document takes the judge about thirty seconds,
 * and something between this and its caller closes a request at two minutes — so a call that
 * judged a whole corpus could not return, whoever made it. It returned nothing at all: the
 * connection ended, the work was abandoned mid-flight, and the event log recorded a failed
 * call with no message, which is the least useful record a platform can keep.
 *
 * So a call judges what it can and says what is left. The `zz.eval` row IS the session:
 * pass its id back and the next call continues into the same evaluation, skipping subjects
 * already scored under it. Progress survives a dropped connection, a killed turn and a
 * different conversation picking the work up, and it is visible in the table while it runs
 * rather than only after it finishes.
 *
 * `control` hands the judge a DIFFERENT skill's artifact under this skill's rubric. A judge
 * that is reading collapses on it; one rewarding busy-looking output barely moves. It is its
 * own session, stored with is_control, and it is not optional: one without the other is not
 * a measurement.
 */
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
  const versionId = dims[0].version_id, rubricId = dims[0].rubric_id;

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

  // The session. A caller that passes an id continues that evaluation; one that does not
  // starts a new one, which is what a fresh round is.
  let session = evalId;
  if (session) {
    const ok = await p.query<{ is_control: boolean }>(
      "select is_control from zz.eval where id = $1::uuid and skill_version_id = $2::uuid",
      [session, versionId]);
    if (!ok.rowCount) throw new Error(`eval ${session} is not an evaluation of ${skill} ${version}`);
    // A CONTROL IS ITS OWN SESSION, and continuing the wrong one used to look like success.
    // A body-subject skill has one subject, so resuming the plain run under `control: true`
    // found it already judged, answered `remaining: 0, stored: 0`, and said "the control is
    // complete" — losing the one number that establishes the judge was reading at all.
    if (ok.rows[0].is_control !== control) {
      throw new Error(
        `eval ${session} is ${ok.rows[0].is_control ? "a control" : "a plain"} run and you asked ` +
        `for ${control ? "a control" : "a plain"} one. They are separate evaluations by ` +
        "construction — the control scores different work under this ruler, so it cannot " +
        "continue the session that scored the real work. " +
        (ok.rows[0].is_control
          // NAME THE FIX, because the obvious reading of this refusal is wrong. A caller
          // continuing a control dropped `control: true` and kept the id; the id then read as
          // a plain continuation, was refused here, and they dropped the ID instead — which
          // minted a SECOND control chain and re-judged a subject that was already scored.
          // The refusal was correct and the next move it implied was not.
          ? "To continue THIS control, send eval_id AND control: true together — both, every " +
            "call. Dropping the id starts a second control run beside this one."
          : "To continue THIS run, send eval_id and leave control out. Omit eval_id entirely " +
            "to start the control."));
    }
  } else {
    session = (await p.query<{ id: string }>(`
      insert into zz.eval (skill_version_id, rubric_id, judge_model, selection_note, doc_count, is_control)
      values ($1::uuid, $2::uuid, $3, $4, 0, $5) returning id::text`,
      [versionId, rubricId, JUDGE_MODEL,
       `${kind === "body" ? "the skill body" : kind === "document" ? "documents" : "run traces"}` +
       ` of ${skill} ${version}${control ? ", control" : ""}`, control])).rows[0].id;
  }

  // Already scored under THIS session, so a resumed call does not re-judge what it paid for.
  const done = new Set((await p.query<{ k: string }>(`
    select coalesce(es.doc_id::text, es.run_id::text, es.path) as k
      from zz.eval_subject es where es.eval_id = $1::uuid`, [session])).rows.map((r) => r.k));

  const all = kind === "body"
    ? [{ key: `body:${versionId}`, label: `${skill} ${version} (the skill itself)`,
         runId: null as string | null, docId: null as string | null, team: "", init: "", path: "" }]
    : kind === "document"
    ? docs.map((d) => ({ key: d.id, label: `${d.initiative}/${d.path}`, runId: null as string | null,
                         docId: d.id as string | null, team: d.team_slug, init: d.initiative, path: d.path }))
    : runs.map((r) => ({ key: r.run_id, label: r.started, runId: r.run_id as string | null,
                         docId: null as string | null, team: "", init: "", path: "" }));
  const todo = all.filter((x) => !done.has(x.key)).slice(0, take);

  // The control artifact: ONE other skill's, scored under this skill's rubric.
  let controlText: { text: string; truncated: number } | null = null;
  if (control && todo.length && kind === "body") {
    // Another skill's TEXT under this ruler. A judge that is reading sees at once that a
    // different skill does not answer these dimensions; one rewarding confident prose does
    // not. Same test as the trace control, same artifact kind as the subject — a control of
    // a different kind would measure the kind, not the judge.
    const other = otherSkillBody(skill);
    if (!other) throw new Error("no other skill's text to use as a control");
    controlText = { text: other, truncated: 0 };
  } else if (control && todo.length) {
    const other = (await p.query<{ run_id: string }>(`
      select r.id::text as run_id from zz.run r
       join zz.skill_version sv on sv.id = r.skill_version_id
       join zz.skill s on s.id = sv.skill_id
      where s.name <> $1 and exists (select 1 from zz.event e where e.run_id = r.id)
      order by r.started_at desc limit 1`, [skill])).rows[0];
    if (!other) throw new Error("no other skill's run to use as a control");
    controlText = await traceOf(p, other.run_id);
  }

  const system = systemFor(control && kind !== "body" ? "trace" : kind, skill, version, dims, control);
  // TWO WAYS TO MATCH A DIMENSION NAME, and the second is why every score arrives.
  //
  // The first real run stored 4 marks against a 5-dimension rubric. The dimension it lost was
  // "Criterion Fidelity (as written, not as built)", and the judge had answered with the name
  // minus its parenthetical — a reasonable thing for a model to do and a silent hole in the
  // measurement, because the mean is then computed over whatever happened to survive.
  //
  // So: exact name, else the name reduced to its letters and digits with any parenthetical
  // dropped. The loose form is built ONLY where it is unambiguous — if two dimensions reduce
  // to the same key, neither gets a loose entry and both must be named exactly, because a
  // wrong dimension is worse than a missing one.
  const byName = new Map(dims.map((d) => [d.name, d.dim_id]));
  const loosen = (n: string) => n.replace(/\([^)]*\)/g, " ").toLowerCase().replace(/[^a-z0-9]+/g, "");
  const loose = new Map<string, string | null>();
  for (const d of dims) {
    const k = loosen(d.name);
    loose.set(k, loose.has(k) ? null : d.dim_id);
  }
  const marked: { subject: string; mean: number; truncated: number }[] = [];
  const skipped: string[] = [], unmatched: string[] = [];
  let stored = 0, uncited = 0, cutTotal = 0;

  for (const x of todo) {
    let text = "", truncated = 0;
    if (controlText) { text = controlText.text; truncated = controlText.truncated; }
    else if (kind === "body") text = body ?? "";
    else if (kind === "document") text = bodyOf(x.team, x.init, x.path) ?? "";
    else { const t = await traceOf(p, x.runId as string); text = t.text; truncated = t.truncated; }
    if (!text.trim()) { skipped.push(`${x.label} — nothing to read`); continue; }
    let marks: Mark[] = [];
    try {
      const got = await ask(system, text);
      marks = (got?.marks as Mark[] | undefined) ?? [];
    } catch (err) {
      // Out of quota stops the round; anything else is this subject's problem, and the next
      // call retries it with a fresh budget.
      if (/out of quota/.test(String((err as Error).message))) throw err;
      skipped.push(`${x.label} — ${(err as Error).message}`);
      continue;
    }
    if (!marks.length) { skipped.push(`${x.label} — the judge answered nothing parseable`); continue; }

    const subjId = (await p.query<{ id: string }>(`
      insert into zz.eval_subject (eval_id, initiative_slug, path, run_id, doc_id, skill_version_id)
      values ($1::uuid, $2, $3, $4::uuid, $5::uuid, $6::uuid) returning id::text`,
      [session, x.init, kind === "body" ? x.key : x.docId ? x.path : null,
       x.runId, x.docId, versionId])).rows[0].id;
    let sum = 0, n = 0;
    for (const m of marks) {
      const dim = byName.get(m.dimension) ?? loose.get(loosen(String(m.dimension ?? ""))) ?? null;
      // A NAME THE RULER DOES NOT HAVE IS REPORTED, not dropped. The first real run stored 4
      // scores against a 5-dimension rubric and said nothing: the judge had renamed one
      // dimension slightly and that mark went nowhere. A silently missing dimension is worse
      // than a bad score — the mean is computed over whatever survived, and nothing in the
      // record says which dimension was never measured.
      if (!dim) { unmatched.push(`${x.label}: "${m.dimension}"`); continue; }
      // A score whose citation is empty is STORED with the citation blank rather than
      // dropped: the row is real, and how well the judge evidenced it is a fact about the
      // judge worth keeping and reporting.
      if (!String(m.cite ?? "").trim()) uncited++;
      const score = Math.max(1, Math.min(5, Number(m.score) || 1));
      await p.query(`
        insert into zz.eval_score (eval_id, subject_id, dimension_id, score, quote, reason, is_control)
        values ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7)
        on conflict (eval_id, subject_id, dimension_id, is_control) do update
          set score = excluded.score, quote = excluded.quote, reason = excluded.reason`,
        [session, subjId, dim, score, String(m.cite ?? "").slice(0, 800),
         String(m.why ?? "").slice(0, 800), control]);
      stored++; sum += score; n++;
    }
    cutTotal += truncated;
    marked.push({ subject: x.label, mean: n ? Number((sum / n).toFixed(2)) : 0, truncated });
  }

  const judgedTotal = done.size + marked.length;
  const remaining = all.length - judgedTotal;
  // finished_at is what says the session is over, and it is set only when nothing is left.
  // A half-judged evaluation that claimed a finish would be averaged as if it were whole.
  await p.query(
    `update zz.eval set doc_count = $2, finished_at = case when $3 then now() else null end
      where id = $1::uuid`, [session, judgedTotal, remaining === 0]);

  return {
    skill, version, judge: JUDGE_MODEL, rubric_version: dims[0].rubric_version,
    eval_id: session, kind, control,
    judged_now: marked.length, judged_total: judgedTotal, remaining,
    stored, uncited, truncated: cutTotal, subjects: marked, skipped, unmatched,
    next: remaining > 0
      ? `${remaining} subject(s) left. Call again with eval_id: "${session}" to continue this ` +
        "evaluation — a new call without it starts a separate round."
      : control
        ? "The control is complete. eval_skill_scores compares it with the real mean."
        : "Every subject is judged. Now run the control: eval_skill_judge with control: true.",
  };
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
