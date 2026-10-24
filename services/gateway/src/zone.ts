/**
 * The deployment's reporting zone, one definition for every reader and writer of a week.
 *
 * A week is cut on this calendar rather than UTC's: a call at 23:30 Sunday UTC is Monday morning
 * here, so a UTC cut files it in the week before and two readers of the same call disagree about
 * which week it belongs to. The fallback is Asia/Singapore, not UTC, and it is deliberately the same
 * expression zz-core's write guards stamp dates through.
 *
 * DELIBERATE: a FUNCTION, not a constant, and this module imports nothing. The gateway's event
 * writer needs the zone on the path of every tool call, and it is loaded first by anything that
 * opens a database connection. A constant would freeze whichever value the environment held at the
 * moment this module was first reached — which, for a process that sets `ZZ_TZ` after importing a
 * module, is the wrong one, silently, and only in the deployment that overrides it. Reading the
 * variable per call costs a property lookup and makes the answer independent of import order.
 */
export function zone(): string {
  return (process.env.ZZ_TZ ?? "").trim() || "Asia/Singapore";
}
