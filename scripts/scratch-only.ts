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
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

/** The host node-pg would connect to for this connection string, or null where it is not a plain
 *  postgres URL naming one. Read the way node-pg reads it, not by looking for an `@`: a `host`
 *  query parameter wins over the URL's own host, the last of several wins, and the URL's host is
 *  what follows the last `@` of the authority.
 *
 *  COUPLED: pg-connection-string's `parse`, which node-pg hands every `connectionString`. A socket
 *  path, an empty host (node-pg then falls back to $PGHOST) and anything `new URL` refuses are null,
 *  so they are refused. */
export function pgHost(db: string): string | null {
  if (db.startsWith("/")) return null;
  // pg-connection-string's own re-encoding, so a space or a stray `%` parses as it does there.
  const text = / |%[^a-f0-9]|%[a-f0-9][^a-f0-9]/i.test(db) ? encodeURI(db).replace(/%25(\d\d)/g, "%$1") : db;
  let url: URL;
  try { url = new URL(text, "postgres://base"); } catch { return null; }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") return null;
  let host = url.searchParams.getAll("host").at(-1) || "";
  if (!host) {
    try { host = decodeURIComponent(url.hostname); } catch { return null; }
  }
  return host || null;
}

const localDb = (db: string): boolean => LOOPBACK_HOSTS.has(pgHost(db) ?? "");

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
