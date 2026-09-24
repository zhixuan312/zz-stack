/**
 * Who a call is from, and how this platform addresses the machines it talks to.
 *
 * A caller is resolved from a platform token and stamped on the request as headers; a peer is
 * resolved from a socket and compared against the addresses a hostname currently answers with.
 * Both are the platform deciding "who is this", and the token's shape and the address fold
 * each live in exactly one function here.
 */
import { randomBytes } from "node:crypto";
import { lookup as dnsLookup } from "node:dns/promises";

/** Who a call is FROM. The gateway resolves it from a platform token and stamps it on the
 * request; every adapter downstream resolves to this one shape. */
interface Caller {
  email: string;
  name: string;
  id: string;
  role: string;
}

type HeaderBag = Record<string, string | string[] | undefined>;

const one = (v: string | string[] | undefined): string =>
  (Array.isArray(v) ? v[0] : v) ?? "";

/** Parse the forwarded-identity headers into a Caller.
 *
 * The x-zz-* headers are the gateway's own: it resolves every caller from their token and
 * stamps them, and zz-core trusts them because only the gateway may reach it. Inbound x-zz-*
 * is stripped at the proxy, so a caller cannot assert one.
 *
 * The email is lowercased here and nowhere else. Every reader either compares this field — to
 * the `user` in activity.jsonl, to a row the database returned, to an address typed as a tool
 * argument — or writes it into a record something later compares, and that needs one spelling
 * of a person. Everything that stores it is lowercase already: `principal.email` is citext,
 * every insert lowercases, every predicate says `lower(p.email)`.
 *
 * A caller whose address has a capital in it only reaches a call site raw when the gateway has
 * no platform database and passes the forwarded caller straight through, which is local
 * development. */
export function parseCaller(headers: HeaderBag): Caller {
  return {
    email: one(headers["x-zz-user-email"]).trim().toLowerCase(),
    name: one(headers["x-zz-user-name"]),
    id: one(headers["x-zz-user-id"]),
    role: one(headers["x-zz-user-role"]),
  };
}

/** Which team a person is acting as, decided once for the whole platform.
 *
 * A person can belong to several teams and almost nothing takes a team argument: the store is
 * per team, and the tools just act. The answer has to be the same one everywhere, or documents
 * land in team A's store while a call acts for team B.
 * COUPLED: both zz-core and the gateway resolve a team through this.
 *
 * The order, and why:
 *   1. A bound token wins, or resolves to nothing. Binding is what makes a token safe for
 *      automation, so a token bound to a team its owner is not in gets no team at all rather
 *      than falling back to another of theirs.
 *   2. The team they chose, when it is still a live membership. Somebody removed from a team
 *      must not keep acting inside it because a column still says so.
 *   3. Otherwise admin-role first, then alphabetical — deterministic, never silent.
 */
export function actingTeam(
  memberships: readonly { slug: string; role?: "admin" | "member" }[],
  storedActive: string | null,
  boundTeam: string | null,
): string | null {
  const live = memberships.filter((m) => !!m.slug);
  if (boundTeam) return live.some((m) => m.slug === boundTeam) ? boundTeam : null;
  if (storedActive && live.some((m) => m.slug === storedActive)) return storedActive;
  const ranked = [...live].sort((a, b) =>
    Number(b.role === "admin") - Number(a.role === "admin") || a.slug.localeCompare(b.slug));
  return ranked[0]?.slug ?? null;
}

/**
 * The platform's own credential: what a token is, in one place.
 *
 * COUPLED: `deploy/issue-first-pat.sh` writes the same shape in shell, because it runs on a
 * host with no toolchain and mints the first token there is. The shape is a contract between whatever writes a token, whatever reads
 * one back and whatever recognises one in a log — raising the entropy at a minter alone leaves
 * a reader looking for the old length and reporting a perfectly minted token as unmintable.
 *
 * The prefix is what makes a leaked token identifiable as ours, and what release.ts redacts on.
 */
const PAT_PREFIX = "zzp_";
const PAT_BYTES = 24;

/** A whole token, exactly as every minter writes one. */
export const PAT_TOKEN = new RegExp(`${PAT_PREFIX}[0-9a-f]{${PAT_BYTES * 2}}`);

/** Mint one. The only place in TypeScript that decides what a token looks like. */
export function mintPat(): string {
  return PAT_PREFIX + randomBytes(PAT_BYTES).toString("hex");
}

/**
 * One host, one spelling.
 *
 * A socket peer reaching a container over IPv6 arrives as `::ffff:10.0.0.5` and the same host
 * resolved out of DNS arrives as `10.0.0.5`. A set membership test between the two forms is
 * false, so this fold is half of every "is this caller who it says it is" decision on the
 * compose network. Both the peer and the resolved addresses must be folded; folding one side
 * only makes the comparison never match, and the platform 403s every call from its own gateway.
 */
// Not exported: every caller wants one of the two below, and an exported fold invites the
// comparison being spelled out again elsewhere.
const hostAddress = (raw: string): string => raw.replace(/^::ffff:/, "");

/** The peer at the other end of a socket, in that one spelling. */
export const peerAddress = (socket: { remoteAddress?: string | undefined }): string =>
  hostAddress(socket.remoteAddress ?? "");

/**
 * The addresses a set of hostnames currently resolves to — the mechanism both services
 * authenticate their own network with. The policy differs and stays in each service: the
 * gateway's trusted front end is off by default and warns when it is set and unresolvable,
 * zz-core defaults to cred-proxy and refuses with 403.
 *
 * Null, never a guess, on three cases: no hosts to trust, DNS unable to answer, and a hostname
 * that resolves to nothing. A returned set is never empty.
 */
export function addressResolver(
  hosts: readonly string[],
  ttlMs = 60_000,
): () => Promise<Set<string> | null> {
  let cache: { ips: Set<string>; expires: number } | null = null;
  return async () => {
    if (!hosts.length) return null;
    if (cache && cache.expires > Date.now()) return cache.ips;
    const ips = new Set<string>();
    for (const host of hosts) {
      try {
        for (const r of await dnsLookup(host, { all: true })) ips.add(hostAddress(r.address));
      } catch { /* a host that is not deployed is not one of ours */ }
    }
    if (!ips.size) return null;
    cache = { ips, expires: Date.now() + ttlMs };
    return ips;
  };
}
