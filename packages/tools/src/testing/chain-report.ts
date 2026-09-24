/**
 * How chain-check says what it found — separate from what it walks.
 *
 * Three ways to assert, and the difference between them is the point. `record` states a claim
 * this file cannot evaluate. `check` asserts a call succeeded or was refused, and `because` is
 * what stops it passing on the wrong refusal. `eitherOr` is for a tool whose subject is not this
 * run's throwaway initiative, where "did the work" and "refused" are both correct and only an
 * unnamed refusal says the tool is broken.
 *
 * None of these three functions knows what a flow is; the walk is the other subject.
 */

/** Every claim this run made, in order, for the summary at the end. */
export const RESULTS: { ok: boolean; name: string; got: string }[] = [];

export function record(ok: boolean, name: string, got: string): void {
  RESULTS.push({ ok, name, got: got.trim().slice(0, 200) });
  console.log((ok ? "  ok   " : "  FAIL ") + name);
}

/**
 * `because` is what stops a check passing on the wrong refusal.
 *
 * "the call errored" and "the rule fired" are different claims. Without it, a probe that patches
 * `status: draft` on an already-approved document gets "`find` occurs 0 times" long before any
 * guard runs, and prints ok having never reached ownershipCheck.
 */
export function check(name: string, got: string, wantError: boolean, because?: RegExp): void {
  const body = got.trim();
  const err = body.toUpperCase().startsWith("ERROR");
  let ok = err === wantError;
  if (ok && err && because && !because.test(body)) {
    ok = false;
    console.log(`        refused, but not by the rule this names — wanted /${because.source}/`);
  }
  record(ok, name, got);
  if (!ok && err !== wantError) {
    console.log(`        wanted ${wantError ? "an ERROR" : "success"}, got: ${body.slice(0, 200)}`);
  }
}

/**
 * A tool whose real subject is not this run's throwaway initiative — a plugin's release history, a
 * skill's install state, an evaluation nobody has started — cannot be asserted on the way `check`
 * does: which of "did the work" or "refused" is correct depends on state the probe does not
 * control. So this asserts on the shape of the answer instead: either the tool did its work, or it
 * refused for a cause it names. An unnamed refusal, or the call throwing, is what says the tool is
 * broken.
 */
export function eitherOr(name: string, got: string, acceptableRefusal: RegExp): void {
  const body = got.trim();
  const refused = /^(ERROR|REFUSED):/i.test(body);
  const ok = !refused || acceptableRefusal.test(body);
  record(ok, name, got);
  if (!ok) console.log(`        refused for an unnamed reason: ${body.slice(0, 200)}`);
}
