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
 * a skill and a version, or a plugin and a version. The rubric, the subjects and their text are
 * assembled from the database and the artifact store; the model is pinned by deployment
 * configuration and named on every row. The caller cannot supply the artifact, cannot supply
 * the ruler, and cannot supply the model. What it could do from a terminal — set JUDGE_MODEL,
 * hand judge-stats a different --psql — it cannot do from here.
 *
 * What the CLI kept that a container cannot is the `claude` binary. There is none in this
 * image and there will not be one, so the pinned judge is a model on the platform's own LLM
 * endpoint. `zz.eval.judge_model` has always carried the judge's name and every comparison
 * groups by it, so scores taken under the old judge stay their own group rather
 * than being silently averaged with these.
 *
 * WHAT IS IN THIS FILE AND WHAT IS BESIDE IT. This is the judge: the pinned model, the prompt
 * it is given, the one loop that marks a subject and stores what came back. What a SUBJECT is
 * lives next door — tools/plugin-judge.ts knows what a plugin's subjects are. The split
 * happened when a second subject kind arrived and this file would otherwise have gone past the
 * repository's own size ceiling; the skill-side half that prompted it has since been deleted
 * with the flow it served, and the split is kept because the loop is better off not knowing.
 */
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
 * under the fast judge using-the block's gap fell from 1.67 to 1.00 and
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

/** How many subjects one round judges, whatever the subject is.
 *
 * ONE CONSTANT FOR BOTH, because a cap is part of what a number means: a round over 20 of a
 * skill's documents and a round over every one of a plugin's runs are not the same kind of
 * measurement, and two caps drifting apart would make that difference invisible. The reports
 * print it beside the denominator so a capped round reads as a sample rather than a census. */
export const SUBJECT_CAP = 20;

export type Subject = "document" | "trace";

interface Mark { dimension: string; score: number; cite: string; why: string }

export interface Dim {
  dim_id: string; name: string; five_means: string; one_means: string;
  /** 'qualitative' is what a dimension has always been: a reader places the artifact between
   *  two written ends. 'quantitative' is a line a person drew over a figure a tool computed,
   *  and it is not scored by reading the artifact at all — see the threshold pass below. */
  kind: string;
  threshold: string;
  threshold_reason: string;
}

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

function systemFor(kind: Subject, noun: string, name: string, version: string,
                   dims: Dim[], control = false): string {
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
    ...dims.map((d) => `- ${d.name}\n    5 = ${d.five_means}\n    1 = ${d.one_means}`),
    "",
    "RULES.",
    ...RULES,
  ].join("\n");
}

/** One run as the text a judge reads. Truncation is announced in the text AND returned, so
 *  neither the judgement nor the stored record can claim more coverage than it had. */
export async function traceOf(p: pg.Pool, runId: string): Promise<{ text: string; truncated: number }> {
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

/** One artifact to mark, already identified. A document is fetched through `bodyOf` and a run
 *  through `traceOf`, at the moment it is judged, so a round that stops early never paid to
 *  read what it did not mark. There was a third way in — a `text` the caller had already read,
 *  for a skill's own body off the catalog shelf — and it went with the body subject. */
export interface MarkItem {
  key: string; label: string;
  runId: string | null; docId: string | null;
  team: string; init: string; path: string;
}

/**
 * WHAT IS BEING MARKED, resolved from identifiers before any model is called.
 *
 * A DESCRIPTOR, RATHER THAN A SECOND LOOP OR A `plugin?: string` THREADED THROUGH THIS ONE.
 * Everything the loop below protects is the same for both subjects: one subject per call, the
 * eval row as the session, the control as its own session, a mark stored only when its
 * dimension matched, `finished_at` set only when nothing is left. What differs is four
 * answers — which column on zz.eval carries the version, where the ruler hangs, which
 * artifacts belong to the subject, and what "a different artifact" means for the control.
 *
 * So those four are an argument. A boolean would have put four `if (plugin)` branches inside
 * the loop, which is a second loop written interleaved with the first; a copy of the loop
 * would have let the two drift, and the drift a reader would notice last is the control's.
 * The caller that knows what a subject is resolves it; the loop never learns a subject kind.
 */
export interface Marking {
  /** The column on zz.eval and zz.eval_subject that carries the subject's version. It was a
   *  union of two while a round could be about a skill or about a plugin; 048 dropped the
   *  skill-side columns and there is one kind of subject now. Kept as a field rather than
   *  inlined because the loop's whole design is that it never learns what a subject is. */
  versionColumn: "plugin_version_id";
  versionId: string;
  /** How the prompt names the subject: "skill" or "plugin". The skill wording is unchanged to
   *  the byte — a prompt change is a judge change, and it would start an incomparable series
   *  for every skill already scored. */
  noun: string;
  name: string;
  version: string;
  rubricId: string;
  rubricVersion: string;
  dims: Dim[];
  kind: Subject;
  items: MarkItem[];
  /** THE BLIND CONTROL, unchanged: a DIFFERENT artifact of the same kind under this ruler. A
   *  function because it costs a query and is only wanted when there is work left, and
   *  because what counts as "different" is the one thing only the caller knows. */
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

/** Where a round's quantitative marks hang. They are about the VERSION and not about any one
 *  document, so they get one subject row of their own rather than being repeated against every
 *  artifact — repeated, a single unmet threshold would weigh once per document and the mean
 *  would move with how much work the version happened to produce. */
const factsKey = (versionId: string): string => `facts:${versionId}`;

/** TWO WAYS TO MATCH A DIMENSION NAME, and the second is why every score arrives.
 *
 * The first real run stored 4 marks against a 5-dimension rubric. The dimension it lost was
 * "Criterion Fidelity (as written, not as built)", and the judge had answered with the name
 * minus its parenthetical — a reasonable thing for a model to do and a silent hole in the
 * measurement, because the mean is then computed over whatever happened to survive.
 *
 * So: exact name, else the name reduced to its letters and digits with any parenthetical
 * dropped. The loose form is built ONLY where it is unambiguous — if two dimensions reduce
 * to the same key, neither gets a loose entry and both must be named exactly, because a
 * wrong dimension is worse than a missing one.
 *
 * BOTH PASSES USE IT, and the threshold pass is why it is here rather than inside the loop. It
 * was written with an exact-match lookup of its own, which is the same hole with a worse floor:
 * a renamed qualitative dimension goes unstored and is REPORTED in `unmatched`, while a renamed
 * quantitative one would have stored a 1 — a threshold failed by a spelling, indistinguishable
 * afterwards from a threshold the plugin actually missed.
 */
function matcher(dims: Dim[]): (named: unknown) => string | null {
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

/** The threshold pass: quantitative dimensions, scored against figures a tool computed.
 *
 * THE MODEL IS NOT ASKED WHETHER THIS IS GOOD. It is asked one question per dimension — does
 * the recorded threshold hold against the recorded fact — and the stored `reason` is the
 * ruler's own threshold_reason rather than anything it says back. That ordering is the whole
 * guard: the line was written down before any artifact was measured, so it cannot be moved
 * afterwards to flatter the number it produces, and a reason generated here would be exactly
 * that move made invisibly.
 *
 * Met is 5 and unmet is 1 because a line is binary. A band between them would be this pass
 * inventing degrees the ruler did not write.
 */
async function applyThresholds(dims: Dim[], facts: string): Promise<{ dimension: string; meets: boolean; fact: string }[]> {
  const system = [
    "The message below is a set of facts about one subject, computed by a tool with no model",
    "anywhere in the derivation. You are applying thresholds that were written down BEFORE any",
    "of those measurements were taken. You are not judging quality, you are not reading any",
    "artifact, and you are not deciding where a line should be.",
    "",
    "THE THRESHOLDS:",
    ...dims.map((d) => `- ${d.name}\n    the line: ${d.threshold}`),
    "",
    "For each one, answer whether the line is met by the facts above, and quote the single",
    "figure you read it against. If the facts do not contain the figure a threshold needs, the",
    "line is NOT met and the quote says which figure is missing.",
    "",
    'Answer as JSON only: {"met": [{"dimension": string, "meets": boolean, "fact": string}]}',
  ].join("\n");
  const got = await ask(system, facts);
  const said = (got?.met as { dimension?: unknown; meets?: unknown; fact?: unknown }[] | undefined) ?? [];
  const dimOf = matcher(dims);
  const answered = new Map<string, { meets: boolean; fact: string }>();
  for (const one of said) {
    const id = dimOf(one.dimension);
    if (!id || answered.has(id)) continue;
    answered.set(id, {
      // The type is not trusted, for the same reason the qualitative pass coerces its score: a
      // model asked for a boolean returns the string "true" often enough that reading it
      // strictly turns a met line into an unmet one.
      meets: one.meets === true || String(one.meets).toLowerCase() === "true",
      fact: String(one.fact ?? "").slice(0, 800),
    });
  }
  return dims.map((d) => {
    const hit = answered.get(d.dim_id);
    return {
      dimension: d.name,
      // ABSENT IS NOT MET. A dimension the answer skipped has no evidence that its line holds,
      // and scoring it met would let a truncated answer pass a threshold silently.
      meets: hit?.meets ?? false,
      fact: hit?.fact || "the answer said nothing about this dimension",
    };
  });
}

/**
 * Score one version of one subject against its ruler, A FEW ARTIFACTS AT A TIME.
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
 * `control` hands the judge a DIFFERENT subject's artifact under this ruler. A judge that is
 * reading collapses on it; one rewarding busy-looking output barely moves. It is its own
 * session, stored with is_control, and it is not optional: one without the other is not a
 * measurement.
 */
export async function markAll(
  p: pg.Pool, m: Marking, control: boolean, take: number, evalId: string | null,
  bodyOf: (teamSlug: string, initiative: string, path: string) => string | null,
): Promise<JudgeResult> {
  const { dims, kind, versionId } = m;

  // The session. A caller that passes an id continues that evaluation; one that does not
  // starts a new one, which is what a fresh round is.
  let session = evalId;
  if (session) {
    const ok = await p.query<{ is_control: boolean }>(
      `select is_control from zz.eval where id = $1::uuid and ${m.versionColumn} = $2::uuid`,
      [session, versionId]);
    if (!ok.rowCount) throw new Error(`eval ${session} is not an evaluation of ${m.name} ${m.version}`);
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
      insert into zz.eval (${m.versionColumn}, rubric_id, judge_model, selection_note, doc_count, is_control)
      values ($1::uuid, $2::uuid, $3, $4, 0, $5) returning id::text`,
      [versionId, m.rubricId, JUDGE_MODEL,
       `${kind === "document" ? "documents" : "run traces"}` +
       ` of ${m.name} ${m.version}${control ? ", control" : ""}`, control])).rows[0].id;
  }

  // Already scored under THIS session, so a resumed call does not re-judge what it paid for.
  const done = new Set((await p.query<{ k: string }>(`
    select coalesce(es.doc_id::text, es.run_id::text, es.path) as k
      from zz.eval_subject es where es.eval_id = $1::uuid`, [session])).rows.map((r) => r.k));

  const todo = m.items.filter((x) => !done.has(x.key)).slice(0, take);

  // TWO KINDS OF DIMENSION, AND ONLY ONE OF THEM IS SHOWN THE ARTIFACT. A quantitative
  // dimension asks whether a measured figure clears a line; putting it in the prompt below
  // would ask the judge to re-derive that figure from a document that does not contain it.
  const qual = dims.filter((d) => d.kind !== "quantitative");
  const quant = dims.filter((d) => d.kind === "quantitative");

  const controlText = control && todo.length ? await m.control() : null;

  const system = systemFor(control ? "trace" : kind, m.noun, m.name, m.version,
                           qual, control);
  const dimOf = matcher(qual);
  const marked: { subject: string; mean: number; truncated: number }[] = [];
  const skipped: string[] = [], unmatched: string[] = [];
  let stored = 0, uncited = 0, cutTotal = 0;

  const store = async (subjId: string, dim: string, score: number, quote: string, reason: string) => {
    await p.query(`
      insert into zz.eval_score (eval_id, subject_id, dimension_id, score, quote, reason, is_control)
      values ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7)
      on conflict (eval_id, subject_id, dimension_id, is_control) do update
        set score = excluded.score, quote = excluded.quote, reason = excluded.reason`,
      [session, subjId, dim, score, quote.slice(0, 800), reason.slice(0, 800), control]);
    stored++;
  };
  const subjectRow = async (init: string, path: string | null, runId: string | null, docId: string | null) =>
    (await p.query<{ id: string }>(`
      insert into zz.eval_subject (eval_id, initiative_slug, path, run_id, doc_id, ${m.versionColumn})
      values ($1::uuid, $2, $3, $4::uuid, $5::uuid, $6::uuid) returning id::text`,
      [session, init, path, runId, docId, versionId])).rows[0].id;

  // THE THRESHOLD PASS RUNS ON THE REAL ROUND ONLY, and never on the control.
  //
  // The control exists to produce one number: the gap between this ruler applied to the right
  // artifact and applied to the wrong one. Quantitative dimensions read the version's own
  // facts and not the artifact at all, so under a control they would score exactly what they
  // scored on the real round — identical rows on both sides, shrinking the gap by arithmetic
  // and making the judge look worse the more thresholds a ruler has.
  const thresholds: JudgeResult["thresholds"] = [];
  if (!control && quant.length && m.facts && !done.has(factsKey(versionId))) {
    try {
      const applied = await applyThresholds(quant, m.facts);
      const subjId = await subjectRow("", factsKey(versionId), null, null);
      for (const t of applied) {
        const d = quant.find((x) => x.name === t.dimension);
        if (!d) continue;
        await store(subjId, d.dim_id, t.meets ? 5 : 1, t.fact, d.threshold_reason);
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
    else if (x.docId) text = bodyOf(x.team, x.init, x.path) ?? "";
    else if (x.runId) { const t = await traceOf(p, x.runId); text = t.text; truncated = t.truncated; }
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

    const subjId = await subjectRow(x.init, x.docId ? x.path : null, x.runId, x.docId);
    let sum = 0, n = 0;
    for (const mk of marks) {
      const dim = dimOf(mk.dimension);
      // A NAME THE RULER DOES NOT HAVE IS REPORTED, not dropped. The first real run stored 4
      // scores against a 5-dimension rubric and said nothing: the judge had renamed one
      // dimension slightly and that mark went nowhere. A silently missing dimension is worse
      // than a bad score — the mean is computed over whatever survived, and nothing in the
      // record says which dimension was never measured.
      if (!dim) { unmatched.push(`${x.label}: "${mk.dimension}"`); continue; }
      // A score whose citation is empty is STORED with the citation blank rather than
      // dropped: the row is real, and how well the judge evidenced it is a fact about the
      // judge worth keeping and reporting.
      if (!String(mk.cite ?? "").trim()) uncited++;
      const score = Math.max(1, Math.min(5, Number(mk.score) || 1));
      await store(subjId, dim, score, String(mk.cite ?? ""), String(mk.why ?? ""));
      sum += score; n++;
    }
    cutTotal += truncated;
    marked.push({ subject: x.label, mean: n ? Number((sum / n).toFixed(2)) : 0, truncated });
  }

  // THE ARTIFACTS, not the threshold row. `remaining` is what a caller loops on, and counting
  // a subject that is never in `items` would leave it at 1 for ever.
  const judgedTotal = [...done].filter((k) => k !== factsKey(versionId)).length + marked.length;
  const remaining = m.items.length - judgedTotal;
  // finished_at is what says the session is over, and it is set only when nothing is left.
  // A half-judged evaluation that claimed a finish would be averaged as if it were whole.
  await p.query(
    `update zz.eval set doc_count = $2, finished_at = case when $3 then now() else null end
      where id = $1::uuid`, [session, judgedTotal, remaining === 0]);

  return {
    subject: m.name, version: m.version, judge: JUDGE_MODEL, rubric_version: m.rubricVersion,
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
