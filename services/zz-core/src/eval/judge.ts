/**
 * The reading judge, server-side: one call to the model pinned by deployment configuration, with
 * what that call cost recorded on `zz.model_call`.
 *
 * The round loop that used to live here — marking a plugin version's documents against its
 * `zz.rubric` for `round_judge` — is gone with that tool. `ask` stays because
 * `failure_discover`'s generative-critic step (`discover.ts`) reaches the same endpoint through
 * it; the protocol lifecycle's own measures go through the typed service instead.
 */
import type pg from "pg";

import { JUDGE_BASE, JUDGE_MODEL, LLM_BASE, LLM_KEY, THINKING } from "./judge-model.js";

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
 * severed at two minutes and a long answer takes about eighty seconds, so a retry loses the whole
 * call. A caller that can fall back does so on the throw or the null — `discover.ts` keeps its
 * deterministic description and records why the critic was not used.
 *
 * The timeout is explicit because fetch has none.
 *
 * `purpose` names what `zz.model_call.purpose` records for this call. `discover.ts`'s
 * generative-critic step (Task I-9) passes `"failure-discover"`; historic rows from the removed
 * round loop carry `"plugin-judge"`, so a new caller passes its own label rather than borrowing
 * one and making two callers' spend indistinguishable. */
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
      // DELIBERATE: no retry here, unlike the typed client next door — see the header: a retry
      // cannot fit inside the two minutes the request carrying it has.
      signal: AbortSignal.timeout(110_000),
      body: JSON.stringify({
        // The model as the endpoint knows it. JUDGE_MODEL carries the mode as well, and that is
        // what lands in zz.model_call.model.
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
    // Quota is not a formatting slip, and a caller asking many times must be able to stop on it.
    if (r.status === 429 || /limit|quota/i.test(t)) throw new Error(`the judge is out of quota: ${t}`);
    throw new Error(`the judge answered ${r.status}: ${t}`);
  }
  const said = (await r.json()) as {
    choices?: { finish_reason?: string; message?: { content?: string } }[]; usage?: Usage };
  // Said out loud, because a truncated answer is not a bad answer and must never be read as one.
  if (said.choices?.[0]?.finish_reason === "length") {
    // Recorded before the throw, with the figures the provider reported rather than nulls: this
    // failure burned the whole output budget and returns nothing for it.
    await record(false, said.usage);
    throw new Error("the judge ran out of output budget mid-answer — the answer is incomplete " +
                    "and is not being used");
  }
  await record(true, said.usage);
  body = String(said.choices?.[0]?.message?.content ?? "");
  const m = /\{[\s\S]*\}/.exec(body);
  if (!m) return null;
  try { return JSON.parse(m[0]) as Record<string, unknown>; } catch { return null; }
}
