#!/usr/bin/env node
/**
 * The ChatGPT `file` route's network boundary — AC-4.2's evidence for it. `fetchFile`
 * (services/zz-core/src/file-fetch.ts) fetches a `file.download_url` only over HTTPS, only from a
 * host in the allow list, resolving the host once and connecting to exactly the address it
 * checked; it refuses private, loopback, link-local and metadata addresses, a host that
 * re-resolves to one, and every redirect that breaks a rule the first hop is held to; it stops at
 * 30 seconds and 8 MiB, sends no platform credential and writes no URL anywhere. `fileSource`
 * (upload-consume.ts) answers that the route is off when no host is set, and reads what it
 * fetched through the same `uploadText` every upload goes through.
 *
 * In process, no database. The address rules are never relaxed: `lookup` answers documentation
 * addresses (203.0.113.0/24, which no rule blocks) for the test hostnames, `connect` asserts it is
 * handed exactly an address `lookup` answered and the rules passed, then maps it to a local HTTPS
 * server, and `ca` trusts that server's certificate — made here by `openssl`, the one child this
 * check starts, because a private key may not sit in the tree. The timeout is driven by
 * `node:test`'s mocked `setTimeout`, so the 30 seconds cost none.
 *
 * Run: node checks/file-fetch.ts   (also run by scripts/gate.ts)
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import type { IncomingHttpHeaders } from "node:http";
import { createServer } from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mock } from "node:test";
import { pathToFileURL } from "node:url";

import { internalAddress } from "@zz/contracts";

const load = (p: string) => import(pathToFileURL(join(process.cwd(), p)).href);
const { fetchFile } = await load("services/zz-core/dist/file-fetch.js");
const { fileSource } = await load("services/zz-core/dist/upload-consume.js");

const fail: string[] = [];
const is = (cond: unknown, why: string) => { if (!cond) fail.push(why); };

// ── the certificate, for every test hostname ───────────────────────────────────────────────────
const NAMES = ["files", "inside", "loop", "meta", "link", "six", "mapped", "nat64", "compat", "sixto4", "mixed", "rebind",
               "rehop", "offlist", "nowhere"]
  .map((n) => `${n}.example.test`);
const dir = mkdtempSync(join(tmpdir(), "zz-file-fetch-"));
let key: Buffer, cert: Buffer;
try {
  execFileSync("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes",
    "-keyout", join(dir, "k.pem"), "-out", join(dir, "c.pem"), "-days", "1", "-subj", "/CN=files.example.test",
    "-addext", `subjectAltName=${NAMES.map((n) => `DNS:${n}`).join(",")}`], { stdio: "ignore" });
  key = readFileSync(join(dir, "k.pem"));
  cert = readFileSync(join(dir, "c.pem"));
} finally {
  rmSync(dir, { recursive: true, force: true });
}

// ── the server every checked address is mapped to ──────────────────────────────────────────────
const SIG = "sig=Zq9SIGNEDsecretTOKEN";
const MAX = 8 * 1024 * 1024;
const BODY = "# Notes\n\nplain text, kept as it is\n";
const seen: { path: string; headers: IncomingHttpHeaders }[] = [];
let stalled: () => void = () => {};
const server = createServer({ key, cert }, (req, res) => {
  const path = req.url ?? "";
  seen.push({ path, headers: req.headers });
  const go = (to: string) => { res.writeHead(302, { location: to }); res.end(); };
  const route = path.split("?")[0];
  if (route === "/ok" || route === "/files/notes.csv") { res.end(BODY); return; }
  if (route === "/bom.txt") { res.end(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("a,b\n")])); return; }
  if (route === "/bad.txt") { res.end(Buffer.from([0x61, 0xff, 0xfe, 0x62])); return; }
  if (route === "/exact") { res.end(Buffer.alloc(MAX, 0x61)); return; }
  if (route === "/over") {
    // Chunked, no length declared: only the stream can tell it is too long.
    res.writeHead(200);
    const chunk = Buffer.alloc(1024 * 1024, 0x61);
    for (let i = 0; i < 8; i++) res.write(chunk);
    res.end(Buffer.from("b"));
    return;
  }
  if (route === "/declared") { res.writeHead(200, { "content-length": String(MAX + 1) }); res.end("short"); return; }
  if (route === "/gzip") { res.writeHead(200, { "content-encoding": "gzip" }); res.end("x"); return; }
  if (route === "/missing") { res.writeHead(404); res.end("gone"); return; }
  if (route === "/stall") { res.writeHead(200); res.write("x", () => stalled()); return; }
  if (route === "/to-ok") { go(`/ok?${SIG}`); return; }
  if (route === "/to-inside") { go(`https://inside.example.test/ok?${SIG}`); return; }
  if (route === "/to-offlist") { go(`https://offlist.example.test/ok?${SIG}`); return; }
  if (route === "/to-http") { go(`http://files.example.test/ok?${SIG}`); return; }
  if (route === "/to-loop") { go("/to-loop"); return; }
  if (route === "/to-self") { go(`/ok?${SIG}`); return; }
  res.writeHead(500); res.end();
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const port = (server.address() as AddressInfo).port;

// ── the resolver and the dialler the helper is handed ─────────────────────────────────────────
// DELIBERATE: answers per call, so a second resolution of `rebind` and `rehop` gives loopback —
// a host that passed its check once and then re-resolves to an internal address.
const lookups: string[] = [];
const ANSWERS: Record<string, string[] | (() => string[])> = {
  "files.example.test": ["203.0.113.10"],
  "inside.example.test": ["10.0.0.5"],
  "loop.example.test": ["127.0.0.1"],
  "meta.example.test": ["169.254.169.254"],
  "link.example.test": ["fe80::1"],
  "six.example.test": ["fd00:ec2::254"],
  "mapped.example.test": ["::ffff:10.0.0.7"],
  "nat64.example.test": ["64:ff9b:1::7f00:1"],
  "compat.example.test": ["::7f00:1"],
  "sixto4.example.test": ["2002:a9fe:a9fe::1"],
  "mixed.example.test": ["203.0.113.11", "192.168.1.9"],
  "offlist.example.test": ["203.0.113.13"],
};
for (const h of ["rebind.example.test", "rehop.example.test"]) {
  let n = 0;
  ANSWERS[h] = () => (n++ === 0 ? ["203.0.113.12"] : ["127.0.0.1"]);
}
const lookup = async (host: string): Promise<string[]> => {
  lookups.push(host);
  const a = ANSWERS[host];
  if (!a) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: "ENOTFOUND" });
  return typeof a === "function" ? a() : a;
};
// Only these addresses may ever reach a socket: every one is an answer `lookup` gave that no rule
// blocks. An address outside them reaching `connect` is the helper dialling something it did not
// check — a second resolution, or a blocked answer let through.
const PUBLIC = new Set(["203.0.113.10", "203.0.113.11", "203.0.113.12", "203.0.113.13"]);
const dialled: string[] = [];
const connect = (address: string, to: number) => {
  dialled.push(address);
  is(PUBLIC.has(address), `connect was handed ${address}, which is not an address the rules passed`);
  is(to === 443, `connect was handed port ${to}, not the URL's 443`);
  return { host: "127.0.0.1", port };
};
const HOSTS = [...NAMES.filter((n) => n !== "offlist.example.test"), "127.0.0.1"];
const route = { hosts: HOSTS, lookup, connect, ca: cert };

// No URL is ever logged: everything the helper and the route write to the console is collected.
const logged: string[] = [];
for (const k of ["log", "info", "warn", "error", "debug"] as const) {
  const real = console[k].bind(console);
  console[k] = (...a: unknown[]) => { logged.push(a.map(String).join(" ")); real(...a); };
}

type Got = { bytes: Buffer } | { refusal: string };
const refusals: string[] = [];
const get = async (url: string, r: object = route): Promise<Got> => {
  const got: Got = await fetchFile(url, r);
  if ("refusal" in got) refusals.push(got.refusal);
  return got;
};
const refused = async (url: string, code: string, says: RegExp, why: string) => {
  const got = await get(url);
  is("refusal" in got && got.refusal.startsWith(`ERROR: ${code} — `) && says.test(got.refusal),
     `${why}: expected ${code} matching ${says}, got ${JSON.stringify(got).slice(0, 240)}`);
};
const text = (g: Got) => ("bytes" in g ? g.bytes.toString("utf8") : g.refusal);

// ── the first hop ─────────────────────────────────────────────────────────────────────────────
let got = await get(`https://files.example.test/ok?${SIG}`);
is("bytes" in got && text(got) === BODY, `an allowed host's file arrives whole: ${text(got).slice(0, 120)}`);
is(dialled.at(-1) === "203.0.113.10", `the connection goes to the address that was checked: ${dialled.at(-1)}`);
const asked = seen.at(-1);
is(asked?.path === `/ok?${SIG}`, `the request asks for the URL's own path and query: ${asked?.path}`);
const sent = Object.keys(asked?.headers ?? {});
is(!sent.some((h) => /^(authorization|proxy-authorization|cookie)$|^x-zz-/i.test(h)),
   `no platform credential is sent: ${sent.join(", ")}`);
is(asked?.headers.host === "files.example.test", `the Host header names the host, not the address: ${asked?.headers.host}`);
await refused(`https://elsewhere.example.com/ok?${SIG}`, "FORBIDDEN", /elsewhere\.example\.com.*OPENAI_FILE_HOSTS/,
              "a host outside the list");
await refused(`http://files.example.test/ok?${SIG}`, "FORBIDDEN", /https/, "plain http");
await refused(`ftp://files.example.test/ok`, "FORBIDDEN", /https/, "another scheme");
await refused("not a url", "FORBIDDEN", /https/, "a value that is no URL");
await refused(`https://inside.example.test/ok?${SIG}`, "FORBIDDEN", /10\.0\.0\.5/, "a private address");
await refused(`https://loop.example.test/ok?${SIG}`, "FORBIDDEN", /127\.0\.0\.1/, "a loopback address");
await refused(`https://meta.example.test/ok?${SIG}`, "FORBIDDEN", /169\.254\.169\.254/, "the cloud metadata address");
await refused(`https://link.example.test/ok?${SIG}`, "FORBIDDEN", /fe80::1/, "an IPv6 link-local address");
await refused(`https://six.example.test/ok?${SIG}`, "FORBIDDEN", /fd00:ec2::254/, "an IPv6 unique-local metadata address");
await refused(`https://mapped.example.test/ok?${SIG}`, "FORBIDDEN", /10\.0\.0\.7/, "an IPv4-mapped private address");
await refused(`https://nat64.example.test/ok?${SIG}`, "FORBIDDEN", /64:ff9b:1::7f00:1/, "a local-use NAT64 address embedding loopback");
await refused(`https://compat.example.test/ok?${SIG}`, "FORBIDDEN", /::7f00:1/, "an IPv4-compatible loopback address");
await refused(`https://sixto4.example.test/ok?${SIG}`, "FORBIDDEN", /2002:a9fe:a9fe::1/, "a 6to4 address embedding the metadata address");
await refused(`https://mixed.example.test/ok?${SIG}`, "FORBIDDEN", /192\.168\.1\.9/,
              "one private address among public ones");
await refused(`https://127.0.0.1/ok?${SIG}`, "FORBIDDEN", /127\.0\.0\.1/, "a listed host that is itself a loopback literal");
await refused(`https://nowhere.example.test/ok`, "FILE_UNAVAILABLE", /does not resolve/, "a host that does not resolve");

// DNS rebinding: resolved once, and that answer is the one dialled. Asked again, `rebind` answers
// loopback, so a second resolution would reach `connect` with an address it refuses.
const before = lookups.filter((h) => h === "rebind.example.test").length;
got = await get(`https://rebind.example.test/ok?${SIG}`);
is("bytes" in got && text(got) === BODY, `a rebinding host is fetched from the address it was checked at: ${text(got).slice(0, 120)}`);
is(lookups.filter((h) => h === "rebind.example.test").length === before + 1, "the host is resolved once per hop");
is(dialled.at(-1) === "203.0.113.12", `the checked address is the one dialled: ${dialled.at(-1)}`);

// ── every redirect is a first hop again ───────────────────────────────────────────────────────
got = await get(`https://files.example.test/to-ok`);
is("bytes" in got && text(got) === BODY, `an allowed redirect is followed: ${text(got).slice(0, 120)}`);
await refused(`https://files.example.test/to-inside`, "FORBIDDEN", /redirect.*10\.0\.0\.5/, "a redirect to a private address");
await refused(`https://files.example.test/to-offlist`, "FORBIDDEN", /redirect.*offlist\.example\.test/,
              "a redirect to a host outside the list");
await refused(`https://files.example.test/to-http`, "FORBIDDEN", /redirect.*https/, "a redirect to plain http");
await refused(`https://files.example.test/to-loop`, "FORBIDDEN", /redirects/, "a redirect loop");
await refused(`https://rehop.example.test/to-self`, "FORBIDDEN", /redirect.*127\.0\.0\.1/,
              "a redirect back to a host that now re-resolves to loopback");

// ── the size and the answer ───────────────────────────────────────────────────────────────────
got = await get(`https://files.example.test/exact`);
is("bytes" in got && got.bytes.length === MAX, `exactly 8 MiB arrives: ${"bytes" in got ? got.bytes.length : text(got)}`);
await refused(`https://files.example.test/over`, "SIZE_LIMIT", /8 MiB/, "a stream one byte over 8 MiB, no length declared");
await refused(`https://files.example.test/declared`, "SIZE_LIMIT", /8 MiB/, "a declared length over 8 MiB");
await refused(`https://files.example.test/gzip`, "FILE_UNAVAILABLE", /gzip/, "an encoded body the cap could not bound");
await refused(`https://files.example.test/missing`, "FILE_UNAVAILABLE", /404/, "a download that answers 404");

// ── the route: off without hosts, and a fetched file read as every upload is ────────────────
const file = (url: string, extra: object = {}) => ({ download_url: url, file_id: "file-AbC123", ...extra });
const looked = lookups.length;
const off = await fileSource({ hosts: [] })(file(`https://files.example.test/ok?${SIG}`, { file_name: "notes.md" }));
is("refusal" in off && /^ERROR: FORBIDDEN — /.test(off.refusal) && /upload_start/.test(off.refusal)
   && /OPENAI_FILE_HOSTS/.test(off.refusal),
   `with no hosts set, a file answers that the route is off and names upload_start: ${JSON.stringify(off)}`);
const source = fileSource(route);
const staged = await source(file(`https://files.example.test/ok?${SIG}`, { file_name: "notes.md", mime_type: "text/markdown" }));
is("text" in staged && staged.text === BODY && staged.id === "file-AbC123" && staged.via === "file"
   && staged.filename === "notes.md" && staged.bytes === Buffer.byteLength(BODY)
   && staged.sha256 === createHash("sha256").update(BODY).digest("hex") && staged.stagedVia === "file" && !staged.bom,
   `a fetched file is staged as the file it is, named by its file_id and digest: ${JSON.stringify(staged).slice(0, 300)}`);
const named = await source(file(`https://files.example.test/files/notes.csv?${SIG}`));
is("text" in named && named.filename === "notes.csv", `with no file_name, the URL's last segment names it: ${JSON.stringify(named).slice(0, 200)}`);
const bom = await source(file(`https://files.example.test/bom.txt?${SIG}`, { file_name: "rows.txt" }));
is("text" in bom && bom.text === "a,b\n" && bom.bom, `a BOM is removed and reported: ${JSON.stringify(bom).slice(0, 200)}`);
const bad = await source(file(`https://files.example.test/bad.txt?${SIG}`, { file_name: "bad.txt" }));
is("refusal" in bad && /^ERROR: INVALID_ENCODING — /.test(bad.refusal), `invalid UTF-8 is refused by uploadText: ${JSON.stringify(bad)}`);
const asks = seen.length;
const pdf = await source(file(`https://files.example.test/ok?${SIG}`, { file_name: "minutes.pdf" }));
is("refusal" in pdf && /^ERROR: UNSUPPORTED_FORMAT — /.test(pdf.refusal) && seen.length === asks,
   `a format outside the family is refused before anything is fetched: ${JSON.stringify(pdf)}`);
const far = await source(file(`https://inside.example.test/ok?${SIG}`, { file_name: "notes.md" }));
is("refusal" in far && /^ERROR: FORBIDDEN — /.test(far.refusal), `the route refuses what the helper refuses: ${JSON.stringify(far)}`);
is(lookups.length > looked, "the route with hosts set resolves through the lookup it was given");
for (const r of [off, pdf, far, bad]) if ("refusal" in r) refusals.push(r.refusal);

// ── the deadline, last and alone: mocked timers would stall every other case ──────────────────
mock.timers.enable({ apis: ["setTimeout"] });
stalled = () => mock.timers.tick(30_000);
const slow = await get(`https://files.example.test/stall?${SIG}`);
mock.timers.reset();
is("refusal" in slow && /^ERROR: FORBIDDEN — /.test(slow.refusal) && /30 seconds/.test(slow.refusal),
   `a download that does not finish in 30 seconds is stopped: ${text(slow).slice(0, 200)}`);

// ── no URL anywhere ─────────────────────────────────────────────────────────────────────────────
// The rule itself, over the spellings an IPv6 address can hide an internal IPv4 in: every one
// refused, and a public address in each family, and a 6to4 or NAT64 neighbour that is not one of
// those prefixes, still allowed.
for (const a of ["::ffff:127.0.0.1", "::ffff:7f00:1", "0:0:0:0:0:ffff:7f00:1", "::ffff:a9fe:a9fe", "fe80::1%eth0", "::1", "::",
                 "::7f00:1", "::127.0.0.1", "::a00:5", "64:ff9b::a9fe:a9fe", "64:ff9b:1::7f00:1", "64:ff9b:1:ffff::1",
                 "2002:7f00:1::", "2002:a9fe:a9fe::1", "2002:c0a8:101::1", "2002:808:808::1", "fd00:ec2::254"]) {
  is(internalAddress(a), `${a} is internal`);
}
for (const a of ["198.51.100.7", "203.0.113.10", "2001:db8::8888", "2003::1", "64:ff9a::1"]) {
  is(!internalAddress(a), `${a} is a public address`);
}
for (const r of refusals) is(!r.includes(SIG) && !r.includes("/ok") && !r.includes("https://"), `a refusal carries the URL: ${r}`);
for (const l of logged) is(!l.includes(SIG) && !l.includes("example.test/"), `the console was handed a URL: ${l}`);

server.closeAllConnections();
server.close();
if (fail.length) {
  for (const f of fail) console.log(`FAIL: ${f}`);
  process.exit(1);
}
console.log("file-fetch: https only, allowed hosts only, the checked address dialled, every redirect re-checked, " +
  "30 seconds and 8 MiB, no credential and no URL: ok");
