/**
 * The probe runner, and its one rule: a probe that could not run did not fail.
 *
 * A checker that cannot tell its own breakage from its subject's will eventually report the
 * subject as broken, at the moment somebody is most likely to act on it.
 *
 * Three verdicts, not two:
 *
 *   ok           the probe ran and the deployment agrees with what this repository declares
 *   wrong        the probe ran and they disagree. The only one that means "broken", and the
 *                only one a release may roll back on
 *   unknown      the probe did not run: its own bug, an unreachable host, a missing token.
 *                Never a verdict about the deployment and never a rollback — and never
 *                silently green either: an unknown is reported, and it makes the run non-zero
 *
 * The runner tells them apart deterministically rather than by reading the message: a
 * ReferenceError thrown out of a probe is a defect in the probe, so it is `unknown`, tagged as
 * the doctor's own bug. Anything else thrown is `unknown` too, tagged as the environment. Only
 * a probe that returns a description of a disagreement is `wrong`.
 */
import { errMessage, log, redact } from "../deployment.ts";

/** A probe either agrees (returns `null`) or names how the two sides disagree. `ctx` is
 *  whatever `diagnose()` was called with — no probe reads it today, but the signature is the
 *  contract a probe is registered against, not a survey of current callers. */
type ProbeFn = (ctx: Record<string, unknown>) => string | null;

interface ProbeEntry {
  name: string;
  fn: ProbeFn;
}

interface Layer {
  name: string;
  question: string;
  owns: string[];
  probes: ProbeEntry[];
}

type Verdict = "ok" | "wrong" | "unknown";

/** One probe's outcome. `detail` is set for `wrong` and `unknown`; `mine` only for `unknown`
 *  (whether the doctor's own code broke, or the thing it asked about could not be reached);
 *  `downstream` is added after the fact, by `diagnose()`, when an earlier layer already
 *  disagreed. */
interface Finding {
  layer: string;
  probe: string;
  verdict: Verdict;
  detail?: string;
  mine?: boolean;
  downstream?: string;
}

const layers: Layer[] = [];
let current: Layer | null = null;
export const findings: Finding[] = [];

/** Declare a layer: a question with one source of truth on each side.
 *
 * `owns` is the repository paths this layer's claim is made of, and it is not decoration —
 * `--since` reads it to say which commits since a known-good version touched the layer that
 * disagrees. A layer that owns nothing can still run; it just cannot be correlated, and
 * report() says so rather than implying the change list is empty. */
export function layer(name: string, question: string, owns: string[] = []): void {
  current = { name, question, owns, probes: [] };
  layers.push(current);
}

/** Register a probe. `fn` returns null when the two sides agree, or a string saying how they
 *  disagree. It must not throw to mean "wrong" — a throw is always `unknown`. */
export function probe(name: string, fn: ProbeFn): void {
  if (!current) throw new Error(`probe("${name}") was registered before any layer() — the entry file's import order decides which layer a probe lands in`);
  current.probes.push({ name, fn });
}


/* DELIBERATE: ReferenceError alone. A SyntaxError or a TypeError raised inside a probe is often
 * the platform's doing — a Caddy 502 hands back an HTML page and JSON.parse throws SyntaxError
 * — and calling that a bug in the doctor is the same misattribution aimed the other way. Only
 * a ReferenceError is unambiguously our own code.
 *
 * A backstop, not the fix: a probe never lets live data throw at all — a precondition may
 * throw, an answer must be returned. See doors.ts and contract.ts. */
const MINE = new Set(["ReferenceError"]);

/** Run one layer's probes and record what each of them turned out to be. */
function runLayer(l: Layer, ctx: Record<string, unknown>): Finding[] {
  const results: Finding[] = [];
  for (const p of l.probes) {
    let r: Finding;
    try {
      const detail = p.fn(ctx);
      r = detail ? { layer: l.name, probe: p.name, verdict: "wrong", detail: redact(detail) }
                  : { layer: l.name, probe: p.name, verdict: "ok" };
    } catch (err) {
      // The one distinction this whole file exists for.
      const mine = err instanceof Error && MINE.has(err.constructor.name);
      r = { layer: l.name, probe: p.name, verdict: "unknown", mine, detail: redact(errMessage(err)) };
    }
    results.push(r);
  }
  return results;
}

/** Run the named layers in the order they were declared. `only` filters by layer name. */
export function diagnose({ only = null, ctx = {} }:
    { only?: string[] | null; ctx?: Record<string, unknown> } = {}): Finding[] {
  const chosen = only ? layers.filter((l) => only.includes(l.name)) : layers;
  const unknownNames = (only || []).filter((n) => !layers.some((l) => l.name === n));
  if (unknownNames.length) {
    throw new Error(`no such layer: ${unknownNames.join(", ")}. Layers are: ${layers.map((l) => l.name).join(", ")}`);
  }
  let firstWrong: string | null = null;
  for (const l of chosen) {
    // A layer with no probes is a layer that was declared and never filled, and it must say
    // so rather than contribute a silent pass. Same empty-set rule the gate holds.
    if (!l.probes.length) {
      findings.push({ layer: l.name, probe: "(the layer itself)", verdict: "unknown", mine: true,
                      detail: "this layer registered no probes — it is reading nothing" });
      continue;
    }
    for (const r of runLayer(l, ctx)) {
      // Downstream, not independent. If the host is running last release's image, the contract
      // layer will disagree with the source, correctly. Later layers still run, because knowing
      // how they disagree is most of a diagnosis; they are tagged with what explains them.
      if (firstWrong && r.verdict === "wrong") r.downstream = firstWrong;
      findings.push(r);
      if (!firstWrong && r.verdict === "wrong") firstWrong = l.name;
    }
  }
  return findings;
}

export const layerNames = (): string[] => layers.map((l) => l.name);
export const layerOwns = (name: string): string[] => layers.find((l) => l.name === name)?.owns ?? [];
const layerQuestion = (name: string): string => layers.find((l) => l.name === name)?.question ?? "";

const GREEN = "\x1b[32m", RED = "\x1b[31m", YEL = "\x1b[33m", DIM = "\x1b[2m", OFF = "\x1b[0m";

/** Print the diagnosis. Returns the exit code rather than taking it, so a caller that is
 *  mid-release decides for itself what to do about an unknown. */
export function report({ json = false }: { json?: boolean } = {}): number {
  const wrong = findings.filter((f) => f.verdict === "wrong");
  const unknown = findings.filter((f) => f.verdict === "unknown");
  if (json) {
    console.log(JSON.stringify({ findings, wrong: wrong.length, unknown: unknown.length }, null, 2));
    return wrong.length || unknown.length ? 1 : 0;
  }
  let shown = null;
  for (const f of findings) {
    if (f.layer !== shown) {
      shown = f.layer;
      log(`\n  \x1b[1m${f.layer}\x1b[0m ${DIM}— ${layerQuestion(f.layer)}${OFF}`);
    }
    if (f.verdict === "ok") log(`    ${GREEN}✓${OFF} ${f.probe}`);
    else if (f.verdict === "wrong") {
      log(`    ${RED}✗${OFF} ${f.probe} — ${f.detail}` +
          (f.downstream ? `\n        ${DIM}downstream of ${f.downstream}: fix that layer before reading this one as a defect${OFF}` : ""));
    } else {
      log(`    ${YEL}?${OFF} ${f.probe} — did not run: ${f.detail}` +
          `\n        ${DIM}${f.mine ? "this is a bug in the doctor, not a verdict about the platform"
                                   : "the probe could not reach what it asks about"}${OFF}`);
    }
  }
  log("\n  " + "─".repeat(56));
  const real = wrong.filter((f) => !f.downstream);
  if (!wrong.length && !unknown.length) {
    log(`  ${GREEN}EVERY LAYER AGREES${OFF} — ${findings.length} probes, the deployment is what this checkout declares\n`);
    return 0;
  }
  if (real.length) {
    log(`  ${RED}${real.length} DISAGREEMENT(S)${OFF}, first in \x1b[1m${real[0].layer}\x1b[0m` +
        (wrong.length > real.length ? ` ${DIM}(+${wrong.length - real.length} downstream)${OFF}` : ""));
  }
  if (unknown.length) {
    const mine = unknown.filter((u) => u.mine).length;
    log(`  ${YEL}${unknown.length} probe(s) did not run${OFF}` +
        (mine ? ` — ${mine} of them because the doctor itself is broken` : "") +
        `\n  ${DIM}A probe that could not run is not a probe that failed. Nothing here says the ` +
        `platform is wrong.${OFF}`);
  }
  log("");
  return 1;
}
