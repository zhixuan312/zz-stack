/**
 * Who a call is from, and how this platform addresses the machines it talks to.
 *
 * TWO THINGS THAT LOOK UNRELATED AND ARE ONE. A caller is resolved from a platform token and
 * stamped on the request as headers; a peer is resolved from a socket and compared against
 * the addresses a hostname currently answers with. Both are the platform deciding "who is
 * this", one for a person and one for a machine, and both were written twice before they
 * were written once — which is why the token's shape and the address fold each live in
 * exactly one function here.
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
 * The identity headers are the gateway's own, and they say so.
 *
 * They were named x-openwebui-user-* — after the front end, because that front end was
 * once the thing asserting them. It has not been for a while: the gateway resolves every
 * caller from their token and stamps these itself, and zz-core trusts them because only
 * the gateway may reach it. Keeping a retired product's name on the platform's internal
 * wire format is how a reader concludes the coupling is still there.
 *
 * Inbound x-zz-* is stripped at the proxy, so a caller cannot assert one.
 *
 * THE EMAIL IS LOWERCASED HERE AND NOWHERE ELSE. Every reader of this field either compares
 * it — to the `user` stored in activity.jsonl, to a row the database returned, to an address
 * somebody typed as a tool argument — or writes it into a record something later compares.
 * That only works if there is one spelling of a person, and the platform had settled on
 * lowercase everywhere that spelling is STORED: `principal.email` is citext, every insert
 * lowercases, every predicate says `lower(p.email)`.
 *
 * What it did not have was a place where the header BECAME that, so twenty-odd call sites
 * each carried `.trim().toLowerCase()` as a ritual and three forgot it — each of them then
 * comparing a lowercased value against this raw one, which is never equal for a caller whose
 * address has a capital in it. `initiativeNameTaken` read a person's own draft as somebody
 * else's and told them to open a second initiative; pat_issue and client_setup refused a
 * person their own token. All three were invisible because the database happens to hold
 * lowercase, so the defect waited on the one identity that does not come from it: the
 * forwarded caller a gateway with no platform database passes straight through, which is
 * local development.
 *
 * Normalising at the boundary is what makes the ritual unnecessary rather than merely usual.
 * A call site that has to remember is a call site that can forget. */
export function parseCaller(headers: HeaderBag): Caller {
  return {
    email: one(headers["x-zz-user-email"]).trim().toLowerCase(),
    name: one(headers["x-zz-user-name"]),
    id: one(headers["x-zz-user-id"]),
    role: one(headers["x-zz-user-role"]),
  };
}

/** WHICH TEAM A PERSON IS ACTING AS, decided once for the whole platform.
 *
 * A person can belong to several teams, and almost nothing here takes a team argument: the
 * store is per team, a block key can be per team, and the tools just act. So "which one" has
 * exactly one right answer per request, and it has to be the SAME answer everywhere — a
 * deployment where documents land in team A's store while the block call spends team B's
 * quota is incoherent in a way nobody would think to look for.
 *
 * It lived in zz-core alone, so the gateway picked the first row of a differently ordered
 * query when it needed a team for credential resolution. Both call this now.
 *
 * The order, and why:
 *   1. A BOUND token wins, or resolves to nothing. Binding a token to a team is what makes
 *      it safe for automation, and the whole point is that it cannot wander — so a token
 *      bound to a team its owner is not in gets no team at all, rather than quietly falling
 *      back to another one of theirs.
 *   2. The team they CHOSE, when it is still a live membership. Somebody removed from a team
 *      must not keep acting inside it because a column still says so.
 *   3. Otherwise admin-role first, then alphabetical — a deterministic fallback, never a
 *      silent one: this used to be the whole rule, so a person's active team was decided by
 *      their role and the alphabet, invisibly and with no way to change it.
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
 * The platform's own credential: what a token IS, in one place.
 *
 * Four sites decided this independently. `pat_issue` and `client_setup` each wrote
 * `"zzp_" + randomBytes(24).toString("hex")`; deploy/issue-first-pat.sh writes the same
 * shape in shell, because it runs on a host with no toolchain and mints the very first
 * token there is; and provision-librechat READ one back out of an MCP answer with
 * `/zzp_[0-9a-f]{48}/` — a length nobody derived, hardcoded from one of the minters.
 *
 * That asymmetry is the cost. Raising the entropy is a one-word edit at a minter, and the
 * reader would go on looking for 48 hex characters: `could not mint a token for <person>`
 * on a token that was minted perfectly, in the tool that provisions everybody. Nothing
 * about the shape is the minter's to choose alone — it is a contract between whatever
 * writes a token, whatever reads one back, and whatever recognises one in a log.
 *
 * The prefix earns its place separately: it is what makes a leaked token identifiable as
 * ours in someone else's paste buffer, and what release.mjs redacts on.
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
 * A socket peer reaching a container over IPv6 arrives as `::ffff:10.0.0.5` and the same
 * host resolved out of DNS arrives as `10.0.0.5`. They are the same machine, and a set
 * membership test between the two forms is simply false — so the fold is not cosmetic:
 * it is half of every "is this caller who it says it is" decision on the compose network.
 *
 * It was written out four times, twice in each service, and the two halves are what make
 * it correct: fold the PEER and not the RESOLVED addresses, or the reverse, and the
 * comparison never matches. Fail-closed, so nobody would be let in — the platform would
 * simply 403 every call from its own gateway, which is a whole deployment down and reads
 * like a network fault.
 */
// Not exported: every caller wants one of the two below, and an exported fold is an
// invitation to spell the comparison out again somewhere else.
const hostAddress = (raw: string): string => raw.replace(/^::ffff:/, "");

/** The peer at the other end of a socket, in that one spelling. */
export const peerAddress = (socket: { remoteAddress?: string | undefined }): string =>
  hostAddress(socket.remoteAddress ?? "");

/**
 * The addresses a set of hostnames currently resolves to — the mechanism both services
 * authenticate their own network with.
 *
 * zz-core's copy says so in its own comment: "The mechanism is the gateway's own, for the
 * same decision." It was the gateway's own and it was also a second implementation of it,
 * down to the sixty-second cache and the fold. The POLICY differs and stays where it is —
 * the gateway's trusted front end is off by default and warns when it is set and
 * unresolvable, zz-core defaults to cred-proxy and refuses with 403 — but resolving a
 * hostname to a comparable set of addresses is one thing.
 *
 * Null, never a guess, on three cases that mean the same thing: no hosts to trust, DNS
 * unable to answer, and a hostname that resolves to nothing. Each service decides what to
 * do about that; neither may approximate it. A returned set is never empty.
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
      } catch { /* a host that is not deployed is simply not one of ours */ }
    }
    if (!ips.size) return null;
    cache = { ips, expires: Date.now() + ttlMs };
    return ips;
  };
}
