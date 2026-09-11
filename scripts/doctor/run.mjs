/**
 * THE PROBE RUNNER, AND ITS ONE RULE: a probe that could not RUN did not FAIL.
 *
 * This exists because of an hour on 2026-09-11. Release 0.26.1 deployed, and the release's own
 * verification reported six failures — "gateway /health: PUBLIC is not defined", "MCP
 * initialize /core/mcp: envToken is not defined" — so the release rolled a perfectly healthy
 * platform back to 0.26.0. Those messages are ReferenceErrors from INSIDE the verifier: the
 * split of release.mjs had left verify.mjs using three names it never imported. The platform
 * was serving correctly the entire time. The thing checking it was not.
 *
 * The old runner had one `catch`, and everything it caught became a problem attributed to the
 * deployment. That is the defect, not the missing import: a checker that cannot tell its own
 * breakage from its subject's will eventually report the subject as broken, and it will do it
 * at the moment somebody is most likely to act on it.
 *
 * SO THERE ARE THREE VERDICTS, NOT TWO:
 *
 *   ok           the probe ran and the deployment agrees with what this repository declares
 *   wrong        the probe ran and they disagree. THIS is the only one that means "broken",
 *                and the only one a release may roll back on
 *   unknown      the probe did not run. Its own bug, an unreachable host, a missing token.
 *                Never a verdict about the deployment, never a rollback — and never silently
 *                green either: an unknown is reported, and it makes the run non-zero
 *
 * How the runner tells them apart, deterministically rather than by reading the message: a
 * ReferenceError, a TypeError or a SyntaxError thrown out of a probe is a defect in the probe
 * — no amount of platform misbehaviour produces one — so it is `unknown`, tagged as the
 * doctor's own bug. Anything else thrown is `unknown` too, tagged as the environment. Only a
 * probe that RETURNS a description of a disagreement is `wrong`.
 *
 * That rule is the house rule already written in sdlc-execute, applied to ourselves: "a check
 * that dies on a denied port bind, a missing binary or a bare timeout did not fail — it did
 * not run", and conflating the two throws away finished work.
 */
import { log, redact } from "../deployment.mjs";

const layers = [];
let current = null;
export const findings = [];

/** Declare a layer: a question with ONE source of truth on each side.
 *
 * `owns` is the repository paths this layer's claim is made of, and it is not decoration —
 * `--since` reads it to say which commits since a known-good version touched the layer that
 * disagrees. A layer that owns nothing can still run; it just cannot be correlated, and
 * report() says so rather than implying the change list is empty. */
export function layer(name, question, owns = []) {
  current = { name, question, owns, probes: [] };
  layers.push(current);
}

/** Register a probe. `fn` returns null when the two sides agree, or a string saying how they
 *  disagree. It must not throw to mean "wrong" — a throw is always `unknown`. */
export function probe(name, fn) {
  if (!current) throw new Error(`probe("${name}") was registered before any layer() — the entry file's import order decides which layer a probe lands in`);
  current.probes.push({ name, fn });
}

/* ReferenceError ALONE, and the two that were here with it are the point.
 *
 * A SyntaxError or a TypeError raised inside a probe is very often the PLATFORM's doing, not
 * the doctor's: a Caddy 502 hands back an HTML page, JSON.parse throws SyntaxError, and calling
 * that "a bug in the doctor" is the same misattribution this file exists to prevent, aimed the
 * other way — at a platform that really is broken. Only a ReferenceError is unambiguously our
 * own code, because no amount of platform misbehaviour produces one.
 *
 * This is a backstop, not the fix. The fix is that a probe never lets live data throw at all:
 * a precondition may throw, an answer must be returned. See doors.mjs and contract.mjs. */
const MINE = new Set(["ReferenceError"]);

/** Run one layer's probes and record what each of them turned out to be. */
function runLayer(l, ctx) {
  const results = [];
  for (const p of l.probes) {
    let r;
    try {
      const detail = p.fn(ctx);
      r = detail ? { verdict: "wrong", detail: redact(detail) } : { verdict: "ok" };
    } catch (err) {
      // The one distinction this whole file exists for.
      const mine = MINE.has(err?.constructor?.name);
      r = { verdict: "unknown", mine, detail: redact(err?.message ?? err) };
    }
    results.push({ layer: l.name, probe: p.name, ...r });
  }
  return results;
}

/** Run the named layers in the order they were declared. `only` filters by layer name. */
export function diagnose({ only = null, ctx = {} } = {}) {
  const chosen = only ? layers.filter((l) => only.includes(l.name)) : layers;
  const unknownNames = (only || []).filter((n) => !layers.some((l) => l.name === n));
  if (unknownNames.length) {
    throw new Error(`no such layer: ${unknownNames.join(", ")}. Layers are: ${layers.map((l) => l.name).join(", ")}`);
  }
  let firstWrong = null;
  for (const l of chosen) {
    // A layer with no probes is a layer that was declared and never filled, and it must say
    // so rather than contribute a silent pass. Same empty-set rule the gate holds.
    if (!l.probes.length) {
      findings.push({ layer: l.name, probe: "(the layer itself)", verdict: "unknown", mine: true,
                      detail: "this layer registered no probes — it is reading nothing" });
      continue;
    }
    for (const r of runLayer(l, ctx)) {
      // DOWNSTREAM, NOT INDEPENDENT. If the host is running last release's image, the contract
      // layer will disagree with the source — correctly, and it is not a bug in the contract.
      // Later layers still RUN, because knowing HOW they disagree is most of a diagnosis; they
      // are just tagged with what already explains them.
      if (firstWrong && r.verdict === "wrong") r.downstream = firstWrong;
      findings.push(r);
      if (!firstWrong && r.verdict === "wrong") firstWrong = l.name;
    }
  }
  return findings;
}

export const layerNames = () => layers.map((l) => l.name);
export const layerOwns = (name) => layers.find((l) => l.name === name)?.owns ?? [];
const layerQuestion = (name) => layers.find((l) => l.name === name)?.question ?? "";

const GREEN = "\x1b[32m", RED = "\x1b[31m", YEL = "\x1b[33m", DIM = "\x1b[2m", OFF = "\x1b[0m";

/** Print the diagnosis. Returns the exit code rather than taking it, so a caller that is
 *  mid-release decides for itself what to do about an unknown. */
export function report({ json = false } = {}) {
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
