/**
 * The server-held LLM client — generation for the console's "ask" feature.
 *
 * Server-side only. The console renders in a browser, and a credential the browser can reach
 * is a credential every visitor can reach.
 * COUPLED: the gate's "the server-held LLM client stays off the console" asserts that
 * nothing under zz-stack-dashboard/ imports this file, reads LLM_API_KEY or LLM_BASE_URL, or
 * ships either through a NEXT_PUBLIC_* name.
 *
 * The same dialect as the other caller of this endpoint, judge.ts (services/zz-core): one
 * bounded attempt, no retry, a named error on a truncated answer, because a console visitor
 * waits on the call synchronously.
 *
 * The credential is per deployment, read from LLM_API_KEY / LLM_BASE_URL /
 * PLATFORM_BASE_MODEL. There is no team-scoped credential resolution here, and there must not
 * be: the reason this lives on the server is that a deployment's own .env is where the secret
 * belongs.
 *
 * Never throws at import, and nothing calls out at module load, so a deployment with no LLM_*
 * configured still boots — the ask feature is off, not the platform. generateConfigured() lets
 * a route answer with a 503 naming the unset variable instead of discovering the gap when
 * generate() throws.
 */

const LLM_BASE = (process.env.LLM_BASE_URL ?? "").replace(/\/+$/, "");
const LLM_KEY = (process.env.LLM_API_KEY ?? "").trim();
const LLM_MODEL = (process.env.PLATFORM_BASE_MODEL ?? "").trim();

/** Spelled as literals above, never assembled: a name built from a variable cannot be found by
 *  searching the source, so it cannot be checked against .env.example. */
const REQUIRED: Array<[name: string, value: string]> = [
  ["LLM_BASE_URL", LLM_BASE],
  ["LLM_API_KEY", LLM_KEY],
  ["PLATFORM_BASE_MODEL", LLM_MODEL],
];

/** Which of the three required variables are unset, in the order above. Empty once the
 *  endpoint is fully configured. */
function missingVars(): string[] {
  return REQUIRED.filter(([, value]) => !value).map(([name]) => name);
}

/** Whether a route can even attempt a call. Check this before calling generate(), so a missing
 *  credential answers as a 503 naming the variable rather than a thrown error. */
export function generateConfigured(): boolean {
  return missingVars().length === 0;
}

/** Generous on purpose. This endpoint's model spends output budget on reasoning tokens before
 *  the prose or JSON it was asked for, so a small cap returns `finish_reason: "length"` with
 *  the answer cut off mid-sentence at HTTP 200 — which reads, to a route not checking, like a
 *  working call. */
const DEFAULT_MAX_TOKENS = 8000;
/** Shorter than judge.ts (110s), because a person is waiting on this one. A caller answering a question that needs longer may pass a larger timeoutMs. */
const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * One call to the platform's base model. Errors are named refusals, not opaque throws — a
 * route maps the `status` this carries to the HTTP status it sends back:
 *   503 — not configured; `missing` names exactly which variable(s) to set.
 *   502 — the provider timed out, answered badly, or produced nothing usable.
 * The API key is never included in a thrown message, logged, or returned.
 */
export async function generate(input: {
  system: string;
  user: string;
  maxTokens?: number;
  timeoutMs?: number;
}): Promise<string> {
  const { system, user, maxTokens = DEFAULT_MAX_TOKENS, timeoutMs = DEFAULT_TIMEOUT_MS } = input;

  const missing = missingVars();
  if (missing.length) {
    throw Object.assign(
      new Error(`the ask feature has no LLM endpoint configured — set ${missing.join(", ")}`),
      { status: 503 as const, missing },
    );
  }

  let r: Response;
  try {
    r = await fetch(`${LLM_BASE}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${LLM_KEY}` },
      // Explicit because fetch has none: without it a stalled endpoint hangs the request
      // until something upstream gives up, and the console visitor never learns why.
      signal: AbortSignal.timeout(timeoutMs),
      body: JSON.stringify({
        model: LLM_MODEL,
        temperature: 0,
        max_tokens: maxTokens,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
    });
  } catch (exc) {
    const timedOut = exc instanceof Error && exc.name === "TimeoutError";
    throw Object.assign(
      new Error(
        timedOut
          ? `the LLM endpoint did not answer within ${timeoutMs}ms`
          : `the LLM endpoint could not be reached: ${exc instanceof Error ? exc.message : String(exc)}`,
      ),
      { status: 502 as const },
    );
  }

  if (!r.ok) {
    // Sliced, and never the key: the key rides in the Authorization header, which this
    // response cannot echo back, and the provider's own error text is passed through far
    // enough to diagnose.
    const detail = (await r.text()).slice(0, 300);
    throw Object.assign(new Error(`the LLM endpoint answered ${r.status}: ${detail}`), { status: 502 as const });
  }

  const said = (await r.json()) as {
    choices?: { finish_reason?: string; message?: { content?: string; reasoning_content?: string } }[];
  };
  const choice = said.choices?.[0];
  // Said out loud, because a truncated answer is not a real answer and must never be
  // returned as one — see the DEFAULT_MAX_TOKENS note above for how this actually happens.
  if (choice?.finish_reason === "length") {
    throw Object.assign(new Error("the model ran out of output budget mid-answer"), { status: 502 as const });
  }
  const text = (choice?.message?.content ?? "").trim();
  if (!text) {
    // Empty content with reasoning present means the cap landed mid-thought rather than the
    // provider having nothing to say.
    const why = choice?.message?.reasoning_content
      ? "it stopped while still reasoning and never wrote an answer"
      : "the model returned no text";
    throw Object.assign(new Error(`the LLM endpoint produced no answer: ${why}`), { status: 502 as const });
  }
  return text;
}
