/**
 * How chain-check SAYS what it found — separate from what it walks.
 *
 * THREE WAYS TO ASSERT, AND THE DIFFERENCE BETWEEN THEM IS THE POINT. `record` states a claim
 * this file cannot evaluate for you. `check` asserts a call succeeded or was refused, and
 * `because` is what stops it passing on the WRONG refusal. `eitherOr` is for a tool whose
 * subject is not this run's throwaway initiative, where "did the work" and "refused" are both
 * correct and only an UNNAMED refusal says the tool is broken.
 *
 * Split out of chain-check.ts, which had reached the size where a file in this repository has
 * always turned out to hold a second subject. Reporting is that second subject: the walk is
 * about a flow's declared procedure, and none of these three functions knows what a flow is.
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
 * "the call errored" and "the rule fired" are different claims, and this probe already knows
 * it — the journal probe fills in every other argument precisely so a schema rejection cannot
 * be mistaken for the subject rule. The hand-written-approval probe did not have that, and it
 * patched `status: draft` on a document approved forty lines earlier: document_patch answered
 * "`find` occurs 0 times" long before any guard ran, and the check printed ok having never
 * reached ownershipCheck at all.
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
 * A tool whose real subject is not this run's throwaway initiative — a plugin's release
 * history, a skill's install state, an evaluation nobody has started — cannot be asserted on
 * the way `check` does: which of "did the work" or "refused" is correct depends on state the
 * probe does not control and a fresh initiative does not create. So this asserts on the SHAPE
 * of the answer instead: either the tool did its work, or it refused for a cause it names. An
 * unnamed refusal, or the call throwing at all, is what actually says the tool is broken.
 */
export function eitherOr(name: string, got: string, acceptableRefusal: RegExp): void {
  const body = got.trim();
  const refused = /^(ERROR|REFUSED):/i.test(body);
  const ok = !refused || acceptableRefusal.test(body);
  record(ok, name, got);
  if (!ok) console.log(`        refused for an unnamed reason: ${body.slice(0, 200)}`);
}
