/**
 * The two model endpoints zz-core asks, answered deterministically on loopback: the typed
 * judgement service (`TYPESAFE_BASE_URL`, `POST /v1/systemone`, typed-service.ts) and the reading
 * judge (`LLM_BASE_URL`, `POST /v1/chat/completions`, eval/judge.ts).
 *
 * Every answer is read off the question and the state text, never off the call order: an answer
 * that depends on how many calls came before it passes a walk for a reason nobody can name. The
 * rules are TRUTHFUL where the text carries a truth (a counted sentence says N of D; a source is
 * in the first person or it is not) and MARKED where it cannot: a replay's text is only the stand-in
 * session's own output, so the candidate patch carries `CANDIDATE_MARKER` and the stand-in echoes
 * `RELEASED_MARKER` when the tree it ran in already has the patch committed.
 *
 * Probabilities stay out of 0.35–0.65, where semantic.ts reads a yes/no as `unclear`.
 */
import { appendFileSync } from "node:fs";
import { createServer, type Server } from "node:http";

export const CANDIDATE_MARKER = "EVAL-FLOW-CANDIDATE";
export const RELEASED_MARKER = "EVAL-FLOW-RELEASED";

const OWNER_KINDS = ["plugin", "dependency", "platform", "environment", "user_input", "unknown"];
const COUNTED = /^SUBJECT:\nOf (\d+) (?:run|tool)\(s\) .*?, (\d+) were (?:usable|actually called)/;

interface Question { type?: string; instructions?: string; criteria?: unknown }
type Answer = Record<string, unknown>;

/** How the stub answered, by family — what the walk's report prints. */
export const asked = new Map<string, number>();

const noul = (p: number): Answer => ({ type: "noul", noul: p, confidence: Math.abs(p - 0.5) * 2 });
function choice(keys: string[], pick: string): Answer {
  const probabilities = Object.fromEntries(keys.map((k) => [k, k === pick ? 1 : 0]));
  return { type: "choice", choice: pick, confidence: 1, probabilities };
}

/** One question, one answer, and the family it was recognised as. */
function answer(state: string, q: Question): { family: string; a: Answer } {
  const text = q.instructions ?? "";
  const keys = q.criteria && typeof q.criteria === "object" && !Array.isArray(q.criteria)
    ? Object.keys(q.criteria) : [];
  // The leakage screen quotes the diff, which carries the marker: matched before the markers.
  if (text.startsWith("Below is one candidate patch")) return { family: "leakage", a: noul(0.05) };
  if (q.type === "choice" && OWNER_KINDS.every((k) => keys.includes(k))) {
    return { family: "discover.owner_kind", a: choice(keys, "plugin") };
  }
  if (q.type === "choice" && keys.includes("person_statement")) {
    const subject = state.slice(state.indexOf("SUBJECT:"));
    const first = /\b(I|I'm|I've|my|we|our)\b/.test(subject);
    return { family: "replay.source_kind", a: choice(keys, first ? "person_statement" : "agent_record") };
  }
  const counted = COUNTED.exec(state);
  if (counted) {
    return { family: "qualify.counted_fact", a: noul(Number(counted[2]) > 0 ? 0.95 : 0.05) };
  }
  if (state.includes("TRANSCRIPT (the session's own final reply)")) {
    const artifacts = state.slice(state.indexOf("ARTIFACTS ("));
    if (artifacts.includes(CANDIDATE_MARKER)) return { family: "replay.candidate", a: noul(0.95) };
    // The released tree regresses in the walk on purpose: release_verify's guardrail rule is
    // the only road to `rolled_back`, and the rollback is part of what is exercised.
    if (state.includes(RELEASED_MARKER)) return { family: "replay.released", a: noul(0.2) };
    return { family: "replay.baseline", a: noul(0.7) };
  }
  if (q.type === "choice" && keys.length) return { family: "choice.other", a: choice(keys, keys[0]) };
  if (q.type === "score") {
    const n = Array.isArray(q.criteria) ? q.criteria.length : 2;
    return { family: "score.other", a: { type: "score", score: n - 1, confidence: 0.9 } };
  }
  return { family: q.type === "noul" ? "noul.other" : `${q.type ?? "untyped"}.other`, a: noul(0.9) };
}

function reply(res: import("node:http").ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

export function startStub(logFile: string, port = 0): Promise<{ server: Server; port: number }> {
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c: Buffer) => { raw += c.toString("utf8"); });
    req.on("end", () => {
      let body: Record<string, unknown> = {};
      try {
        const parsed: unknown = JSON.parse(raw);
        if (parsed && typeof parsed === "object") body = parsed as Record<string, unknown>;
      } catch { /* answered below as a 400 */ }
      if (req.url === "/v1/systemone") {
        const state = typeof body.state === "string" ? body.state : "";
        const questions = (body.questions ?? {}) as Record<string, Question>;
        const answers: Record<string, Answer> = {};
        for (const [key, q] of Object.entries(questions)) {
          const { family, a } = answer(state, q);
          asked.set(family, (asked.get(family) ?? 0) + 1);
          answers[key] = a;
          appendFileSync(logFile, `${JSON.stringify({
            at: new Date().toISOString(), family, type: q.type, answer: a.noul ?? a.choice ?? a.score,
            instructions: (q.instructions ?? "").slice(0, 160), state: state.slice(0, 240),
          })}\n`);
        }
        reply(res, 200, { model: body.model ?? "jev-latest", usage: { input_tokens: 100, output_tokens: 5 }, answers });
        return;
      }
      if (req.url === "/v1/chat/completions") {
        asked.set("judge.describe", (asked.get("judge.describe") ?? 0) + 1);
        appendFileSync(logFile, `${JSON.stringify({ at: new Date().toISOString(), family: "judge.describe" })}\n`);
        reply(res, 200, {
          choices: [{ finish_reason: "stop", message: { role: "assistant",
            content: JSON.stringify({ description: "A tool refused with no recorded text." }) } }],
          usage: { prompt_tokens: 100, completion_tokens: 10 },
        });
        return;
      }
      reply(res, 404, { error: `the stub serves no ${req.url}` });
    });
  });
  return new Promise((ok) => {
    server.listen(port, "127.0.0.1", () => {
      const addr = server.address();
      ok({ server, port: typeof addr === "object" && addr ? addr.port : 0 });
    });
  });
}
