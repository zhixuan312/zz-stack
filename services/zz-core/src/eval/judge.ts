/**
 * The judge, server-side.
 *
 * The flow's agent must not be the judge: a judge that varies with the conversation makes every
 * number incomparable with every other. The tool takes identifiers only — a plugin and a version.
 * The rubric, the subjects and their text are assembled from the database and the artifact store;
 * the model is pinned by deployment configuration and named on every row. The caller cannot supply
 * the artifact, the ruler or the model. Every comparison groups by `zz.eval.judge_model`.
 *
 * COUPLED: this file is the model, its prompt and the loop that marks a subject. What a subject is
 * lives in tools/plugin-judge.ts.
 */
import type pg from "pg";

import { MARK_SCALE } from "@zz/contracts";

import { configured as typedJudgeConfigured } from "../typed-service.js";
import { JUDGE_BASE, JUDGE_MODEL, LLM_BASE, LLM_KEY, THINKING, typedJudgeName } from "./judge-model.js";
import { markTyped } from "./judge-typed.js";
import { applyThresholds } from "./judge-thresholds.js";
import { traceOf } from "./judge-trace.js";
import { bodyWithin, pairOf } from "./judge-pair.js";


/** How many subjects one round judges, whatever the subject is. One constant for both subject
 * kinds; the reports print it beside the denominator so a capped round reads as a sample rather
 * than a census. */
export const SUBJECT_CAP = 20;

export type Subject = "document" | "trace" | "initiative";

export interface Mark {
  dimension: string; score: number; cite: string; why: string;
  /** Present only from the typed judge — the shape of its distribution, and the distribution
   *  itself, so a later reader can apply their own threshold rather than ours. */
  confidence?: number; probabilities?: Record<string, number>;
}

export interface Dim {
  dim_id: string; name: string; five_means: string; one_means: string;
  /** 2-5 ordered level descriptions, low end first. Null on a ruler that names only its ends, and
   *  that decides which judge can mark it: the typed judgement service is asked against named
   *  levels, and cannot be asked against two ends and a number. */
  levels: string[] | null;
  /** 'qualitative': a reader places the artifact between two written ends. 'quantitative': a line
   *  drawn over a figure a tool computed, scored by the threshold pass below and never by reading
   *  the artifact. */
  kind: string;
  threshold: string;
  threshold_reason: string;
  /** The figure the line is drawn over, as dotted paths into the facts sheet — empty on a
   *  qualitative dimension. The threshold pass answers not met for a missing figure, so an
   *  unresolvable path is indistinguishable afterwards from a line the plugin really missed.
   *  Resolved at ruler_record, and again before any round is marked.
   *  COUPLED: the paths resolve against plugin-facts.ts. */
  reads: string[] | null;
}

/** What the provider said a call cost, read from the response's own `usage` block and nothing
 *  else, never a token figure derived from the bytes we sent.
 *  `usage.prompt_tokens_details.cached_tokens` is the confirmed nesting and spelling, and is 0 on
 *  an uncached call; `count()` below keeps a zero and an absence apart. */
interface Usage {
  prompt_tokens?: unknown;
  completion_tokens?: unknown;
  prompt_tokens_details?: { cached_tokens?: unknown } | null;
}

/** A count the provider reported, or null. Never 0.
 *  DELIBERATE: no `?? 0`. "Reported nothing" and "consumed nothing" must not land as the same row,
 *  or a sum over the column reads as complete while it is silently short. */
const count = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? Math.trunc(v) : null;

/** One call to the pinned judge, answering JSON.
 *
 * DELIBERATE: one attempt, no retry on an unparseable answer. The request carrying the call is
 * severed at two minutes and a document takes about eighty seconds, so a retry loses the whole
 * call including the subject that would have parsed. The caller judges one subject per call and
 * resumes, so a failed subject is retried by the next call with its own fresh budget.
 *
 * The timeout is explicit because fetch has none.
 *
 * `purpose` names what `zz.model_call.purpose` records for this call — the round (judge.ts,
 * judge-thresholds.ts) always passes `"plugin-judge"`; `discover.ts`'s generative-critic step
 * (Task I-9), the other caller of this, the shared reading-judge endpoint outside the typed
 * service, passes its own so the two callers' rows stay distinguishable by purpose rather than
 * indistinguishable under one borrowed label. */
export async function ask(p: pg.Pool, plugin: string | null,
                   system: string, user: string, purpose: string): Promise<Record<string, unknown> | null> {
  if (!LLM_BASE || !LLM_KEY) throw new Error("no LLM endpoint configured for the judge");
  let body: string;

  /* What this call cost, recorded on every path that actually sent a request: the fetch throwing,
   * a non-2xx answer, a truncated answer, and a whole one. `ok` separates the four. A truncated
   * answer spent the entire output budget, so it is recorded too.
   *
   * DELIBERATE: the refusal above writes nothing — no request was made, so there is no call to
   * record. `started` is taken here so `duration_ms` measures the fetch and the reading of its
   * body.
   *
   * An insert that fails propagates rather than being swallowed. */
  const started = Date.now();
  const record = async (ok: boolean, u: Usage | undefined) => {
    await p.query(`
      insert into zz.model_call
        (plugin, purpose, model, input_tokens, output_tokens, cache_read_tokens, duration_ms, ok)
      values ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [plugin, purpose, JUDGE_MODEL,
       count(u?.prompt_tokens), count(u?.completion_tokens),
       count(u?.prompt_tokens_details?.cached_tokens),
       Date.now() - started, ok]);
  };

  let r: Response;
  try {
    r = await fetch(`${LLM_BASE}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${LLM_KEY}` },
      // Something between this tool and its caller closes an MCP request at about two minutes, so
      // there is no point waiting longer than the answer could be delivered, and none stopping
      // earlier.
      //
      // DELIBERATE: no retry here, unlike the typed client next door. A subject that times out is
      // reported skipped: `remaining` does not move and the caller's next call retries it with a
      // fresh budget. The typed client has no such resume — its whole ruler rides in one request.
      signal: AbortSignal.timeout(110_000),
      body: JSON.stringify({
        // The model as the endpoint knows it. JUDGE_MODEL carries the mode as well, and that is
        // what lands in zz.eval.judge_model.
        model: JUDGE_BASE,
        ...(THINKING ? {} : { thinking: { type: "disabled" } }),
        // Deterministic: a judge that samples gives two different numbers for one artifact.
        temperature: 0,
        // Reasoning tokens come out of this budget. Too low a cap returns
        // `finish_reason: "length"` with JSON cut off mid-string, which is unparseable.
        max_tokens: 16000,
        messages: [{ role: "system", content: system }, { role: "user", content: user }],
      }),
    });
  } catch (err) {
    // A timeout is a call that happened and may well have been billed. It reports no usage, so the
    // three token columns stay null, and the row still says a call was made and failed.
    await record(false, undefined);
    throw err;
  }
  if (!r.ok) {
    const t = (await r.text()).slice(0, 300);
    await record(false, undefined);
    // Quota is not a formatting slip: rediscovering it once per subject spends a whole round.
    if (r.status === 429 || /limit|quota/i.test(t)) throw new Error(`the judge is out of quota: ${t}`);
    throw new Error(`the judge answered ${r.status}: ${t}`);
  }
  const said = (await r.json()) as {
    choices?: { finish_reason?: string; message?: { content?: string } }[]; usage?: Usage };
  // Said out loud, because a truncated answer is not a bad document and must never be scored
  // as one.
  if (said.choices?.[0]?.finish_reason === "length") {
    // Recorded before the throw, with the figures the provider reported rather than nulls: this
    // failure burned the whole output budget and stores no mark for it.
    await record(false, said.usage);
    throw new Error("the judge ran out of output budget mid-answer — the mark is incomplete " +
                    "and is not being stored");
  }
  await record(true, said.usage);
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

function systemFor(kind: Subject, noun: string, name: string, version: string,
                   dims: Dim[], control = false): string {
  // DELIBERATE: the control is not told which skill it is reading. Naming a skill over a different
  // artifact is a contradiction the judge must reconcile before it can answer, and it invites
  // scoring the ruler's fit rather than the text in front of it.
  if (control) name = "the artifact below";
  return [
    control
      ? "You are marking the text below against the dimensions given. It may or may not be "
        + "the kind of thing they were written for; score what is in front of you."
      : kind === "trace"
      ? `You are judging one RUN of the ${noun} "${name}" version ${version}.`
      : `You are marking one document produced by the ${noun} "${name}" version ${version}.`,
    "",
    kind === "trace"
      ? [
        `This ${noun} writes no document. What it leaves is a changed system and a trail of tool`,
        "calls, and that trail is what you are reading. Judge the WORK, not the prose — there is",
        "no prose. A read-back after a write is evidence of verification; a write with no read",
        "after it is evidence of its absence; an identical failing call repeated is evidence of",
        "not learning within the run.",
      ].join("\n")
      : "Judge the document in front of you. Quote it as your evidence, never paraphrase it.",
    "",
    "THE DIMENSIONS, and what each end of them looks like:",
    ...dims.map((d) =>
      `- ${d.name}\n    ${MARK_SCALE.max} = ${d.five_means}\n    ${MARK_SCALE.min} = ${d.one_means}`),
    "",
    "RULES.",
    ...RULES,
  ].join("\n");
}

/** One artifact to mark, already identified. A document is fetched through `bodyOf` and a run
 *  through `traceOf`, at the moment it is judged, so a round that stops early never paid to read
 *  what it did not mark. */
export interface MarkItem {
  key: string; label: string;
  runId: string | null; docId: string | null;
  team: string; init: string; path: string;
  /** The closing document, when the subject is a whole initiative rather than one document.
   *  "Does the end deliver what the beginning asked for" is a property of the sequence, so both
   *  ends go over at once: `path` is the opening document and this the closing one. */
  closePath?: string;
}

/**
 * What is being marked, resolved from identifiers before any model is called.
 *
 * The loop below treats both subject kinds the same. Four answers differ and arrive here: which
 * column on zz.eval carries the version, where the ruler hangs, which artifacts belong to the
 * subject, and what "a different artifact" means for the control. The loop never learns a subject
 * kind.
 */
export interface Marking {
  /** The column on zz.eval and zz.eval_subject that carries the subject's version. A field rather
   *  than inlined, because the loop never learns what a subject is. */
  versionColumn: "plugin_version_id";
  versionId: string;
  /** How the prompt names the subject: "skill" or "plugin". DELIBERATE: the skill wording is
   *  unchanged to the byte — a prompt change is a judge change, and would start an incomparable
   *  series for every skill already scored. */
  noun: string;
  name: string;
  version: string;
  rubricId: string;
  rubricVersion: string;
  /** Which initiative this round belongs to, and the team that owns it — carried through from
   *  `round_judge`'s caller and written onto the row when the round is minted. Nothing else on
   *  zz.eval names an initiative, so it cannot be derived. Both are null for a control, which
   *  inherits them from the round it controls. */
  initiative: string | null;
  teamSlug: string | null;
  dims: Dim[];
  kind: Subject;
  items: MarkItem[];
  /** The blind control: a different artifact of the same kind under this ruler. A function because
   *  it costs a query, is only wanted when there is work left, and what counts as "different" is
   *  known only to the caller. */
  control(): Promise<{ text: string; truncated: number }>;
  /** The computed facts a quantitative dimension reads, or null when the ruler has none. Never
   *  the artifact: a threshold is applied to what a tool measured, and handing the judge the
   *  artifact here would let it re-derive the figure it is supposed to be reading. */
  facts: string | null;
}

interface JudgeResult {
  subject: string; version: string; judge: string; rubric_version: string;
  eval_id: string; kind: Subject; control: boolean;
  judged_now: number; judged_total: number; remaining: number;
  stored: number; uncited: number; truncated: number;
  subjects: { subject: string; mean: number; truncated: number }[];
  skipped: string[];
  /** Marks the judge named that the ruler has no dimension for — measured nothing, and said so. */
  unmatched: string[];
  /** Quantitative dimensions and the line each was held to. Empty on a control run, and the
   *  reason is in the threshold pass below. */
  thresholds: { dimension: string; meets: boolean; fact: string }[];
  next: string;
}

/** Where a round's quantitative marks hang: one subject row for the version, not one per document.
 *  Repeated per document, a single unmet threshold would weigh once per document and the mean would
 *  move with how much work the version happened to produce. */
const factsKey = (versionId: string): string => `facts:${versionId}`;

/** Two ways to match a dimension name: the exact name, else the name reduced to its letters and
 * digits with any parenthetical dropped. A judge answering with the name minus its parenthetical
 * otherwise stores no mark, and the mean is computed over whatever survived.
 *
 * The loose form is built only where it is unambiguous — if two dimensions reduce to the same key,
 * neither gets a loose entry and both must be named exactly.
 *
 * COUPLED: the threshold pass uses this too. With an exact-match lookup of its own it stores a 1
 * for a renamed quantitative dimension, indistinguishable from a threshold the plugin missed.
 */
export function matcher(dims: Dim[]): (named: unknown) => string | null {
  const loosen = (n: string) => n.replace(/\([^)]*\)/g, " ").toLowerCase().replace(/[^a-z0-9]+/g, "");
  const byName = new Map(dims.map((d) => [d.name, d.dim_id]));
  const loose = new Map<string, string | null>();
  for (const d of dims) {
    const k = loosen(d.name);
    loose.set(k, loose.has(k) ? null : d.dim_id);
  }
  return (named) => {
    const n = String(named ?? "");
    return byName.get(n) ?? loose.get(loosen(n)) ?? null;
  };
}

/**
 * Score one version of one subject against its ruler, a few artifacts at a time.
 *
 * Subjects are whatever the version left behind: a gated document, or a changed system and a trail
 * of tool calls. Both are judged against the same ruler, never both at once — two subject kinds
 * under one mean is a number about nothing.
 *
 * It resumes rather than finishing: something between this and its caller closes a request at two
 * minutes, so a call judges what it can and says what is left. The `zz.eval` row is the session, so
 * passing its id back continues the same evaluation, skipping subjects already scored under it.
 *
 * `control` hands the judge a different subject's artifact under this ruler. It is its own session,
 * stored with is_control, and it is not optional: one without the other is not a measurement.
 */
export async function markAll(
  p: pg.Pool, m: Marking, control: boolean, take: number, evalId: string | null,
  bodyOf: (teamSlug: string, initiative: string, path: string) => string | null,
): Promise<JudgeResult> {
  const { dims, kind, versionId } = m;
  // Every zz.model_call row from here is attributed to the plugin being judged; `plugin` is the
  // column the per-plugin roll-up indexes. Anything other than "plugin" is a subject with no plugin
  // to charge, and null says so.
  const plugin = m.noun === "plugin" ? m.name : null;

  // Only qualitative dimensions are shown the artifact. A quantitative dimension asks whether a
  // measured figure clears a line; putting it in the prompt below would ask the judge to re-derive
  // that figure from a document that does not contain it.
  const qual = dims.filter((d) => d.kind !== "quantitative");
  const quant = dims.filter((d) => d.kind === "quantitative");

  // Which judge marks this ruler, decided once per round and recorded on it. The typed service is
  // asked against named levels, so it can only mark a ruler whose dimensions have them; a ruler
  // carrying two ends and a 1-5 scale stays with the reading judge, which also keeps its earlier
  // rounds comparable.
  //
  // `judge_model` goes on the round: two rounds marked by different judges are two scales, and the
  // column is what lets a reader see that.
  const typed = typedJudgeConfigured() && qual.length > 0
    && qual.every((d) => (d.levels?.length ?? 0) >= 2);
  const judgeName = typed ? typedJudgeName() : JUDGE_MODEL;


  // The session. A caller that passes an id continues that evaluation; one that does not
  // starts a new one, which is what a fresh round is.
  let session = evalId;
  if (session) {
    const ok = await p.query<{ is_control: boolean }>(
      `select is_control from zz.eval where id = $1::uuid and ${m.versionColumn} = $2::uuid`,
      [session, versionId]);
    if (!ok.rowCount) throw new Error(`eval ${session} is not an evaluation of ${m.name} ${m.version}`);
    // A control is its own session. Resuming a plain run under `control: true` finds its subject
    // already judged and answers `remaining: 0, stored: 0`, which reads as a complete control while
    // losing the one number that establishes the judge was reading at all.
    if (ok.rows[0].is_control !== control) {
      throw new Error(
        `eval ${session} is ${ok.rows[0].is_control ? "a control" : "a plain"} run and you asked ` +
        `for ${control ? "a control" : "a plain"} one. They are separate evaluations by ` +
        "construction — the control scores different work under this ruler, so it cannot " +
        "continue the session that scored the real work. " +
        (ok.rows[0].is_control
          // Name the fix: dropping the id instead of adding `control: true` mints a second control
          // chain and re-judges a subject that was already scored.
          ? "To continue THIS control, send eval_id AND control: true together — both, every " +
            "call. Dropping the id starts a second control run beside this one."
          : "To continue THIS run, send eval_id and leave control out. Omit eval_id entirely " +
            "to start the control."));
    }
  } else {
    // A control names the round it controls, at the moment it is created. The gap is a property of
    // one round — these subjects, marked this way, against this control — and pooling every score
    // under a version and a rubric stops reading correctly the moment a version has two rounds.
    //
    // The newest real round under the same version and ruler is the one being controlled, since
    // `next` sends a caller to the control immediately after the subjects are judged. Null when
    // there is no such round, which leaves the pooled fallback to answer.
    const controlled = control
      ? (await p.query<{ id: string }>(`
          select id::text from zz.eval
           where ${m.versionColumn} = $1::uuid and rubric_id = $2::uuid
             and is_control is false
           order by started_at desc limit 1`, [versionId, m.rubricId])).rows[0]?.id ?? null
      : null;
    // A control inherits the round it controls rather than being told again: the two belong to one
    // measurement and one initiative by construction.
    const from = controlled
      ? (await p.query<{ initiative: string | null; team_slug: string | null }>(
          "select initiative, team_slug from zz.eval where id = $1::uuid", [controlled])).rows[0]
      : null;
    const initiative = from ? from.initiative : m.initiative;
    const teamSlug = from ? from.team_slug : m.teamSlug;
    session = (await p.query<{ id: string }>(`
      insert into zz.eval (${m.versionColumn}, rubric_id, judge_model, selection_note, doc_count,
                           is_control, controls, initiative, team_slug)
      values ($1::uuid, $2::uuid, $3, $4, 0, $5, $6::uuid, $7, $8) returning id::text`,
      [versionId, m.rubricId, judgeName,
       `${kind === "document" ? "documents" : "run traces"}` +
       ` of ${m.name} ${m.version}${control ? ", control" : ""}`, control, controlled,
       initiative, teamSlug])).rows[0].id;
  }

  // Already scored under this session, so a resumed call does not re-judge what it paid for.
  const done = new Set((await p.query<{ k: string }>(`
    select coalesce(es.doc_id::text, es.run_id::text, es.path) as k
      from zz.eval_subject es where es.eval_id = $1::uuid`, [session])).rows.map((r) => r.k));

  const todo = m.items.filter((x) => !done.has(x.key)).slice(0, take);

  const controlText = control && todo.length ? await m.control() : null;

  const system = systemFor(control ? "trace" : kind, m.noun, m.name, m.version,
                           qual, control);
  const dimOf = matcher(qual);
  // The top of the scale is the ruler's own, never a literal. A dimension that names its rungs
  // declares how many it has and `markTyped` rebases them to 1..N, so a fixed ceiling of 5 stores a
  // mark that ruler never defined. `ruler_record`'s schema caps `levels` at five, which bounds
  // this above but not below. The two-ends form names no rungs and its scale is 1-5, so it keeps 5.
  const ceilingOf = new Map(qual.map((d) => [d.dim_id, d.levels?.length ?? 5]));
  const marked: { subject: string; mean: number; truncated: number }[] = [];
  const skipped: string[] = [], unmatched: string[] = [];
  let stored = 0, uncited = 0, cutTotal = 0;

  const store = async (subjId: string, dim: string, score: number, quote: string, reason: string,
                      confidence?: number, probabilities?: Record<string, number>) => {
    await p.query(`
      insert into zz.eval_score (eval_id, subject_id, dimension_id, score, quote, reason,
                                 is_control, confidence, probabilities)
      values ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, $8, $9::jsonb)
      on conflict (eval_id, subject_id, dimension_id, is_control) do update
        set score = excluded.score, quote = excluded.quote, reason = excluded.reason,
            confidence = excluded.confidence, probabilities = excluded.probabilities`,
      [session, subjId, dim, score, quote.slice(0, 800), reason.slice(0, 800), control,
       confidence ?? null, probabilities ? JSON.stringify(probabilities) : null]);
    stored++;
  };
  const subjectRow = async (init: string, path: string | null, runId: string | null, docId: string | null) =>
    (await p.query<{ id: string }>(`
      insert into zz.eval_subject (eval_id, initiative_slug, path, run_id, doc_id, ${m.versionColumn})
      values ($1::uuid, $2, $3, $4::uuid, $5::uuid, $6::uuid) returning id::text`,
      [session, init, path, runId, docId, versionId])).rows[0].id;

  // The threshold pass runs on the real round only, never on the control. Quantitative dimensions
  // read the version's own facts and not the artifact, so under a control they would score exactly
  // what they scored on the real round — identical rows on both sides, shrinking the gap by
  // arithmetic.
  const thresholds: JudgeResult["thresholds"] = [];
  if (!control && quant.length && m.facts && !done.has(factsKey(versionId))) {
    try {
      const applied = await applyThresholds(p, plugin, quant, m.facts);
      const subjId = await subjectRow("", factsKey(versionId), null, null);
      for (const t of applied) {
        const d = quant.find((x) => x.name === t.dimension);
        if (!d) continue;
        // Met is 5 and unmet is 1 because a line is binary; the distribution behind the verdict is
        // stored beside it, so a line cleared at 0.51 and one cleared at 0.99 stop reading as the
        // same result. Present only from the typed judge.
        await store(subjId, d.dim_id, t.meets ? 5 : 1, t.fact, d.threshold_reason,
                    t.confidence, t.probabilities);
        thresholds.push(t);
      }
    } catch (err) {
      if (/out of quota/.test(String((err as Error).message))) throw err;
      skipped.push(`the thresholds — ${(err as Error).message}`);
    }
  }

  for (const x of todo) {
    let text = "", truncated = 0;
    if (controlText) { text = controlText.text; truncated = controlText.truncated; }
    else if (x.closePath) {
      const pair = pairOf(x.init, x.path, bodyOf(x.team, x.init, x.path),
                          x.closePath, bodyOf(x.team, x.init, x.closePath));
      text = pair.text;
      truncated = pair.truncated;
    }
    else if (x.docId) {
      // Capped like a pair is: a single document can exceed the service's 32,768-token ceiling,
      // and then it scores nothing at all.
      const one = bodyWithin(bodyOf(x.team, x.init, x.path));
      text = one.text;
      truncated = one.truncated;
    }
    else if (x.runId) { const t = await traceOf(p, x.runId); text = t.text; truncated = t.truncated; }
    if (!text.trim()) { skipped.push(`${x.label} — nothing to read`); continue; }
    let marks: Mark[] = [];
    try {
      if (typed) {
        marks = await markTyped(qual, text);
      } else {
        const got = await ask(p, plugin, system, text, "plugin-judge");
        marks = (got?.marks as Mark[] | undefined) ?? [];
      }
    } catch (err) {
      // Out of quota stops the round; anything else is this subject's problem, and the next
      // call retries it with a fresh budget.
      if (/out of quota/.test(String((err as Error).message))) throw err;
      skipped.push(`${x.label} — ${(err as Error).message}`);
      continue;
    }
    if (!marks.length) { skipped.push(`${x.label} — the judge answered nothing parseable`); continue; }

    const subjId = await subjectRow(x.init, x.docId ? x.path : null, x.runId, x.docId);
    let sum = 0, n = 0;
    for (const mk of marks) {
      const dim = dimOf(mk.dimension);
      // A name the ruler does not have is reported, not dropped. The mean is computed over whatever
      // survived, and nothing else in the record says which dimension was never measured.
      if (!dim) { unmatched.push(`${x.label}: "${mk.dimension}"`); continue; }
      // A score whose citation is empty is stored with the citation blank rather than dropped: how
      // well the judge evidenced it is a fact about the judge worth reporting.
      if (!String(mk.cite ?? "").trim()) uncited++;
      const score = Math.max(1, Math.min(ceilingOf.get(dim) ?? 5, Number(mk.score) || 1));
      await store(subjId, dim, score, String(mk.cite ?? ""), String(mk.why ?? ""),
                  mk.confidence, mk.probabilities);
      sum += score; n++;
    }
    cutTotal += truncated;
    marked.push({ subject: x.label, mean: n ? Number((sum / n).toFixed(2)) : 0, truncated });
  }

  // The artifacts, not the threshold row. `remaining` is what a caller loops on, and counting a
  // subject that is never in `items` would leave it at 1 for ever.
  const judgedTotal = [...done].filter((k) => k !== factsKey(versionId)).length + marked.length;
  const remaining = m.items.length - judgedTotal;
  // finished_at is what says the session is over, and it is set only when nothing is left.
  // A half-judged evaluation that claimed a finish would be averaged as if it were whole.
  await p.query(
    `update zz.eval set doc_count = $2, finished_at = case when $3 then now() else null end
      where id = $1::uuid`, [session, judgedTotal, remaining === 0]);

  return {
    // The judge that actually marked, not the one this file would have used: the judge is the
    // scale, so a round marked by the typed service must not name the reading judge.
    subject: m.name, version: m.version, judge: judgeName, rubric_version: m.rubricVersion,
    eval_id: session, kind, control,
    judged_now: marked.length, judged_total: judgedTotal, remaining,
    stored, uncited, truncated: cutTotal, subjects: marked, skipped, unmatched, thresholds,
    next: remaining > 0
      ? `${remaining} subject(s) left. Call again with eval_id: "${session}" to continue this ` +
        "evaluation — a new call without it starts a separate round."
      : control
        ? "The control is complete. The scores tool compares it with the real mean."
        : "Every subject is judged. Now run the control: the same call with control: true.",
  };
}
