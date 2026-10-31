/**
 * Where an end-to-end walk may be aimed: loopback, and nothing else. Both walks (`control-loop-e2e.ts`,
 * `eval-flow-e2e.ts`) check what they were handed here before they write anything.
 *
 * An allowlist, not a blocklist, so it fails closed. A blocklist has to name every deployment that must not be touched
 * and fails open for the one somebody forgot or the one that gets a new address next month; anything that is not
 * plainly a local scratch deployment is refused here, and a second deployment tomorrow is refused without anybody
 * adding it. It also means this file names no production address.
 */
const LOOPBACK = /^(https?:\/\/)?(127\.0\.0\.1|localhost|\[::1\])(:\d+)?([/?]|$)/;
const localDb = (url: string): boolean => /@(127\.0\.0\.1|localhost|\[::1\])[:/]/.test(url);

/** Why a walk handed this gateway, token and database must not run, or null when all three are a scratch deployment
 *  on this machine. `writes` says what the walk would write, for the refusal to name. */
export function refuseUnlessScratch(url: string, pat: string, db: string, writes: string): string | null {
  if (!url || !pat || !db) return "REFUSED — no gateway, token or database to walk against.";
  if (!LOOPBACK.test(url)) {
    return `REFUSED — the gateway ${url} is not a loopback address. This walk writes ${writes}; it runs against a ` +
           "scratch deployment on this machine and nothing else.";
  }
  if (!localDb(db)) {
    return `REFUSED — the database does not point at a database on this machine, and this walk writes ${writes} ` +
           "into whichever one it is given.";
  }
  return null;
}
