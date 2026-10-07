/**
 * The fetch behind the ChatGPT `file` route (`fileSource`, upload-consume.ts): a caller's
 * `file.download_url`, read from inside the platform.
 *
 * The URL is the caller's, so every rule is about where it may lead. A hop is fetched only over
 * HTTPS, only from a host the deployment listed (`OPENAI_FILE_HOSTS`), and only once the host has
 * been resolved and every address it answered found public (`internalAddress`, @zz/contracts — the
 * same list a git source is held to). The connection then goes to exactly one of those checked
 * addresses — the socket is dialled by address, the certificate checked against the hostname — so
 * nothing resolves the name a second time between the check and the connect, which is where a
 * rebinding host would swap in an internal address. A redirect is a new
 * hop, held to all of it again. The whole fetch has 30 seconds and the body 8 MiB, counted on the
 * stream rather than taken from a declared length.
 *
 * Nothing is sent but the request line, Host, a user agent and `Accept`: no platform credential,
 * no cookie, no `Accept-Encoding`, because a compressed body would be capped before it was
 * decompressed. Nothing is logged, and no refusal carries the URL: a signed download URL is a bearer credential for the
 * file, and refusals are stored with the call's details.
 *
 * DELIBERATE: `lookup`, `connect` and `ca` are injectable for checks/file-fetch.ts and for nothing
 * else — the tools pass `hosts` alone. Injected or not, the address rules run on what `lookup`
 * answered and `connect` is handed only an address they passed; TLS is verified either way.
 */
import { request, type RequestOptions } from "node:https";
import { isIP } from "node:net";
import { connect as tlsConnect } from "node:tls";

import { addressResolver, internalAddress, UPLOAD_MAX_BYTES } from "@zz/contracts";

/** How the helper reaches a host. `hosts` is the allow list; the rest default to the system's
 *  resolver, a socket to the checked address itself, and the system's trusted roots. */
export interface FetchRoute {
  hosts: readonly string[];
  /** Every address a hostname resolves to. */
  lookup?: (host: string) => Promise<string[]>;
  /** Where to dial for a checked address — called only with an address the rules passed. */
  connect?: (address: string, port: number) => { host: string; port: number };
  /** The roots a server's certificate must chain to. */
  ca?: string | Buffer;
}

/** The whole fetch, redirects included. */
const DEADLINE_MS = 30_000;
/** Redirects followed before the fetch is refused. */
const MAX_REDIRECTS = 5;

/** Every address `host` resolves to now, through the platform's one resolver (@zz/contracts), uncached:
 *  a cached answer would be a resolution the check did not make. */
const systemLookup = async (host: string): Promise<string[]> => [...(await addressResolver([host], 0)()) ?? []];

const forbidden = (why: string): { refusal: string } => ({
  refusal: `ERROR: FORBIDDEN — ${why}; stage the file with upload_start instead.`,
});
const unavailable = (why: string): { refusal: string } => ({
  refusal: `ERROR: FILE_UNAVAILABLE — ${why}; attach the file again, or stage it with upload_start.`,
});
const tooBig = (): { refusal: string } => ({
  refusal: `ERROR: SIZE_LIMIT — the file is over the 8 MiB (${UPLOAD_MAX_BYTES}-byte) limit for one upload; ` +
    "send a smaller file, or split it into parts.",
});

/** One hop's answer: the body, a redirect to follow, or the refusal that ends the fetch. */
type Hop = { bytes: Buffer } | { location: string } | { refusal: string };

/** The file at `url`, or the refusal that says which rule stopped it — the host, the address, the
 *  scheme, a redirect, the deadline or the size, each by name, and never the URL. */
export async function fetchFile(url: string, route: FetchRoute): Promise<{ bytes: Buffer } | { refusal: string }> {
  const allowed = new Set(route.hosts.map((h) => h.trim().toLowerCase()).filter(Boolean));
  const resolve = route.lookup ?? systemLookup;
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), DEADLINE_MS);
  const late = forbidden(`the file did not arrive within ${DEADLINE_MS / 1000} seconds`);
  try {
    let at = url;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const via = hop ? `a redirect led to ` : "";
      let parsed: URL;
      try {
        parsed = new URL(at);
      } catch {
        return forbidden(`${via}an address that is not a URL; only https file addresses are fetched`);
      }
      if (parsed.protocol !== "https:") {
        return forbidden(`${via}a ${parsed.protocol.replace(/:$/, "")} address; only https file addresses are fetched`);
      }
      const host = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
      if (!allowed.has(host)) {
        return forbidden(`${via}${host}, which is not a host this deployment fetches files from (OPENAI_FILE_HOSTS)`);
      }
      let addresses: string[];
      try {
        addresses = isIP(host) ? [host] : await resolve(host);
      } catch {
        addresses = [];
      }
      if (abort.signal.aborted) return late;
      if (!addresses.length) return unavailable(`${via}${host}, which does not resolve`);
      // Every address, not the first: a resolver answering one public and one internal address
      // would otherwise pass whenever the public one came first.
      const internal = addresses.find((a) => internalAddress(a));
      if (internal) {
        return forbidden(`${via}${host}, which resolves to ${internal} — a private, loopback, link-local or ` +
          "metadata address; files are fetched only from public addresses");
      }
      const got = await get(parsed, host, addresses[0], route, abort.signal);
      if (abort.signal.aborted) return late;
      if (!("location" in got)) return got;
      at = new URL(got.location, parsed).href;
    }
    return forbidden(`the file's address led through more than ${MAX_REDIRECTS} redirects`);
  } finally {
    clearTimeout(timer);
  }
}

/** One request, to the checked `address` and nowhere else, its certificate verified against
 *  `host`. A redirect is returned for `fetchFile` to check as a new hop, never followed here. */
function get(url: URL, host: string, address: string, route: FetchRoute, signal: AbortSignal): Promise<Hop> {
  const port = Number(url.port || 443);
  const dial = (route.connect ?? ((a: string, p: number) => ({ host: a, port: p })))(address, port);
  // SNI never carries an IP literal; a listed literal is verified as the address it is.
  const servername = isIP(host) ? undefined : host;
  const options: RequestOptions = {
    method: "GET", path: `${url.pathname}${url.search}`, signal,
    headers: { host: url.port ? `${host}:${url.port}` : host, "user-agent": "zz-core", accept: "*/*" },
    // DELIBERATE: no agent, so this is the only socket the request can use — dialled by address,
    // which no resolver touches. `servername` is what the certificate is checked against.
    createConnection: () => tlsConnect({ host: dial.host, port: dial.port, servername, ca: route.ca,
                                          rejectUnauthorized: true }),
  };
  return new Promise<Hop>((done) => {
    const req = request(options, (res) => {
      const status = res.statusCode ?? 0;
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume();
        done({ location: res.headers.location });
        return;
      }
      if (status < 200 || status >= 300) {
        res.resume();
        done(unavailable(`${host} answered HTTP ${status} for the file`));
        return;
      }
      const encoding = String(res.headers["content-encoding"] ?? "identity").toLowerCase();
      if (encoding !== "identity") {
        req.destroy();
        done(unavailable(`${host} sent the file ${encoding}-encoded, which this route does not read`));
        return;
      }
      if (Number(res.headers["content-length"] ?? 0) > UPLOAD_MAX_BYTES) {
        req.destroy();
        done(tooBig());
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      res.on("data", (c: Buffer) => {
        size += c.length;
        if (size > UPLOAD_MAX_BYTES) {
          req.destroy();
          done(tooBig());
          return;
        }
        chunks.push(c);
      });
      res.on("end", () => done({ bytes: Buffer.concat(chunks) }));
      res.on("error", () => done(unavailable(`the connection to ${host} broke off mid-file`)));
    });
    req.on("error", (err: NodeJS.ErrnoException) =>
      done(unavailable(`${host} could not be fetched from (${err.code ?? err.name})`)));
    req.end();
  });
}
