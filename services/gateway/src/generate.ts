/**
 * The server-held LLM client — generation for the console's "ask" feature.
 *
 * SERVER-SIDE ONLY, AND THE GATE SAYS SO. The console (zz-stack-dashboard) renders in a
 * browser, and a credential the browser can reach is a credential every visitor can reach —
 * that is exactly what Next.js's `NEXT_PUBLIC_*` convention means. This module is its own
 * file, imported by nothing outside this service, so the gate has one thing to point a
 * check at: "the server-held LLM client stays off the console" in scripts/gate.ts asserts
 * that nothing under zz-stack-dashboard/ imports this file, reads LLM_API_KEY or
 * LLM_BASE_URL, or ships either through a NEXT_PUBLIC_* name.
 *
 * THE SAME DIALECT AS THE OTHER TWO CALLERS. judge.ts (services/zz-core) and
 * stakeholder.ts (packages/tools/src/smoke) already speak to this endpoint, and a third
 * slightly-different way of forming the same request is how three places quietly drift.
 * This follows judge.ts's shape — one bounded attempt, no retry, a named error on a
 * truncated answer — because a console visitor is waiting on this call synchronously the
 * way judge.ts's caller is. stakeholder.ts's 429-backoff loop is for a batch smoke harness
 * that can afford to wait several seconds per attempt; a person looking at a spinner cannot,
 * so that retry loop is deliberately not repeated here.
 *
 * CREDENTIAL, PER DEPLOYMENT. Read from LLM_API_KEY / LLM_BASE_URL / PLATFORM_BASE_MODEL —
 * the same three variables stakeholder.ts reads, because generation here runs on the
 * platform's own base model, not a separately-pinned judge model. Per-deployment, exactly as
 * multi-model-agent-forge, a sibling project of mine, already reads these three: there is no team-scoped credential resolution in this
 * file, and there must not be one — the reason this lives on the server at all is that a
 * deployment's own .env is the one place this secret is supposed to live.
 *
 * NEVER THROWS AT IMPORT. Reading three environment variables cannot fail, and nothing here
 * calls out to anything at module load, so a deployment with no LLM_* configured still boots
 * and serves everything else — the ask feature is off, not the platform. generateConfigured()
 * lets a route ask "can I even try" before it does, and answer with a 503 naming exactly
 * which variable is unset instead of discovering the gap only when generate() throws.
 */

const LLM_BASE = (process.env.LLM_BASE_URL ?? "").replace(/\/+$/, "");
const LLM_KEY = (process.env.LLM_API_KEY ?? "").trim();
const LLM_MODEL = (process.env.PLATFORM_BASE_MODEL ?? "").trim();

/** Spelled as literals above, never assembled — see signin.ts's ISSUER comment for why: a
 *  name built from a variable cannot be found by searching the source, so it cannot be
 *  checked against .env.example, and a variable nobody can find is a variable nobody sets. */
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

/** Whether a route can even attempt a call. Check this BEFORE calling generate() so a
 *  missing credential answers as a 503 naming the variable, rather than a route having to
 *  catch a thrown error to learn the same thing. */
export function generateConfigured(): boolean {
  return missingVars().length === 0;
}

/** Generous on purpose. judge.ts's own note explains why a low cap is the trap rather than
 *  the safeguard it looks like: this endpoint's model spends output budget on reasoning
 *  tokens before the prose or JSON it was asked for, so a small cap returns
 *  `finish_reason: "length"` with the visible answer cut off mid-sentence at HTTP 200 — a
 *  truncated answer that looks, to a route not checking for this, like a working call. */
const DEFAULT_MAX_TOKENS = 8000;
/** Bounded shorter than judge.ts (110s) or stakeholder.ts (120s), because nothing waiting on
 *  either of those is a person — this one is, watching a spinner on the console. A caller
 *  answering a question that genuinely needs longer may pass a larger timeoutMs. */
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
    // Sliced, and never the key: the key rides in the Authorization header this response
    // cannot echo back, but the provider's own error text is passed through far enough to
    // diagnose without this file fabricating its own second version of the same message.
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
    // provider having nothing to say — stakeholder.ts found this exact shape and named it
    // rather than silently treating it as a normal empty answer.
    const why = choice?.message?.reasoning_content
      ? "it stopped while still reasoning and never wrote an answer"
      : "the model returned no text";
    throw Object.assign(new Error(`the LLM endpoint produced no answer: ${why}`), { status: 502 as const });
  }
  return text;
}
