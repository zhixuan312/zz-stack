/**
 * The ChatGPT `file` route of `checks/document-upload.ts` (AC-4.1, AC-4.2), in this process and
 * never through the zz-core child: the tools build `fileSource` from `OPENAI_FILE_HOSTS` alone, so
 * only here can it be handed a resolver, a dialler and a root (`inProcess().fileWrite`).
 *
 * The file server is a local HTTPS server with a certificate made for the test hostname at run
 * time (a tracked key would fail scripts/gate/checks/security-secrets.ts). `lookup` answers a
 * documentation address for that hostname, `connect` asserts it is handed exactly that checked
 * address and maps it to the local server, and `ca` trusts the server's certificate — the address
 * rules themselves are never relaxed. checks/file-fetch.ts holds the network boundary; this holds
 * what a fetched file becomes.
 *
 * A helper, not a check: every `.ts` under `checks/` is a check the gate runs, so the case groups
 * that check runs live here, beside the harness they run on.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { first } from "./normalize-cases.ts";
import type { Core } from "./throwaway-core.ts";
import { exact, type Gateway } from "./upload-cases.ts";

const HOST = "files.example.test";
/** What `lookup` answers for HOST: a documentation address no rule blocks. */
const CHECKED = "203.0.113.20";
const utf8 = (s: string): Buffer => Buffer.from(s, "utf8");
const sha = (b: Buffer): string => createHash("sha256").update(b).digest("hex");

/** The ChatGPT file route, in process, from a local HTTPS server reached through the checked
 *  address. */
export async function fileRoute(c: Core, g: Gateway): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "zz-upload-file-"));
  let key: Buffer, cert: Buffer;
  try {
    execFileSync("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes",
      "-keyout", join(dir, "k.pem"), "-out", join(dir, "c.pem"), "-days", "1", "-subj", `/CN=${HOST}`,
      "-addext", `subjectAltName=DNS:${HOST}`], { stdio: "ignore" });
    key = readFileSync(join(dir, "k.pem"));
    cert = readFileSync(join(dir, "c.pem"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  /** What each path answers; a path not here is a 404. */
  const served = new Map<string, Buffer>();
  const fetched: string[] = [];
  const server = createServer({ key, cert }, (req, res) => {
    const path = (req.url ?? "").split("?")[0];
    fetched.push(path);
    const body = served.get(path);
    if (body) res.end(body); else { res.writeHead(404); res.end("gone"); }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as { port: number }).port;
  const dialled: string[] = [];
  const route = {
    hosts: [HOST],
    lookup: async (host: string) => {
      if (host !== HOST) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: "ENOTFOUND" });
      return [CHECKED];
    },
    connect: (address: string, to: number) => {
      dialled.push(address);
      if (address !== CHECKED || to !== 443) throw new Error(`connect was handed ${address}:${to}, not the checked ${CHECKED}:443`);
      return { host: "127.0.0.1", port };
    },
    ca: cert,
  };
  const { fileWrite } = await c.inProcess();
  const file = (path: string, name?: string) => ({
    download_url: `https://${HOST}${path}?sig=SIGNEDsecret`, file_id: `file-${path.replace(/\W/g, "")}`,
    mime_type: "text/plain", ...(name ? { file_name: name } : {}) });
  const ok = async (step: string, tool: Parameters<typeof fileWrite>[0], args: Parameters<typeof fileWrite>[1]) => {
    const reply = await fileWrite(tool, args, route);
    return reply.startsWith("ERROR") ? c.fail(step, reply) : reply;
  };
  const refused = async (step: string, tool: Parameters<typeof fileWrite>[0], args: Parameters<typeof fileWrite>[1], want: RegExp) => {
    const reply = await fileWrite(tool, args, route);
    if (!want.test(reply)) c.fail(step, `expected ${want}, got: ${reply}`);
  };

  try {
    const I = await c.open("file-route");
    let step = "a ChatGPT file, fetched in process from a listed host at the address checked, becomes a document byte for byte, its receipt naming the file and its digest";
    const tsv = utf8("id\tnote\r\n1\t<i>x</i>\r\n");
    served.set("/files/table.tsv", tsv);
    const d = `${I}/table.md`;
    const said = await ok(step, "document_write", { path: d, file: file("/files/table.tsv") });
    await exact(c, g, step, d, tsv);
    if (!said.includes(`file: file-filestabletsv — "table.tsv", ${tsv.length} bytes, sha256 ${sha(tsv)}, staged via file`)
        || dialled.some((a) => a !== CHECKED) || !dialled.length) c.fail(step, `${said}\ndialled: ${dialled.join(", ")}`);
    c.pass(step);

    step = "document_edit takes a file as the whole body, and source_add files one, each byte for byte";
    const next = utf8("id\tnote\r\n2\t\r\n");
    served.set("/files/next.tsv", next);
    await ok(step, "document_edit", { path: d, file: file("/files/next.tsv", "table.tsv") });
    await exact(c, g, step, d, next);
    const json = utf8('{"decided": "ship", "by": ["ada"]}');
    served.set("/files/decision.json", json);
    const src = /^source recorded: (\S+)$/m.exec(await ok(step, "source_add", { initiative: I, title: "Decision", file: file("/files/decision.json") }))?.[1];
    await exact(c, g, step, src ?? c.fail(step, "no source recorded"), json);
    c.pass(step);

    step = "a keyed file write whose URL now answers 404 replays its first receipt without fetching, while the same write unkeyed answers FILE_UNAVAILABLE";
    const once = utf8("a,b\n1,2\n");
    served.set("/files/once.csv", once);
    const keyed = { path: `${I}/once.md`, file: file("/files/once.csv"), request_id: "file-1" };
    const landed = await ok(step, "document_write", keyed);
    served.delete("/files/once.csv");
    const before = fetched.length;
    const again = await ok(step, "document_write", { ...keyed, file: { ...keyed.file, download_url: `https://${HOST}/files/once.csv?sig=refreshed` } });
    if (first(again) !== `${first(landed)} (replayed)` || fetched.length !== before) {
      c.fail(step, `first:\n${landed}\nagain (${fetched.length - before} fetches):\n${again}`);
    }
    await refused(step, "document_write", { path: `${I}/once-2.md`, file: keyed.file }, /^ERROR: FILE_UNAVAILABLE — .*404/);
    const sourceKeyed = { initiative: I, title: "Once", file: file("/files/source.txt"), request_id: "file-2" };
    served.set("/files/source.txt", utf8("noted\n"));
    const filed = await ok(step, "source_add", sourceKeyed);
    served.delete("/files/source.txt");
    if (first(await ok(step, "source_add", sourceKeyed)) !== `${first(filed)} (replayed)`) c.fail(step, "the keyed source did not replay");
    c.pass(step);

    step = "a file of an unsupported format is refused before it is fetched, and one past 8 MiB or not UTF-8 is refused, writing nothing";
    served.set("/files/deck.pptx", utf8("PK"));
    served.set("/files/big.txt", Buffer.alloc(8 * 1024 * 1024 + 1, 0x61));
    served.set("/files/latin1.txt", Buffer.from([0x63, 0x61, 0x66, 0xe9]));
    const fetchedBefore = fetched.length;
    await refused(step, "document_write", { path: `${I}/deck.md`, file: file("/files/deck.pptx") }, /^ERROR: UNSUPPORTED_FORMAT — /);
    if (fetched.length !== fetchedBefore) c.fail(step, "an unsupported file was fetched");
    await refused(step, "document_write", { path: `${I}/big.md`, file: file("/files/big.txt") }, /^ERROR: SIZE_LIMIT — /);
    await refused(step, "source_add", { initiative: I, title: "Latin", file: file("/files/latin1.txt") }, /^ERROR: INVALID_ENCODING — /);
    for (const p of ["deck.md", "big.md"]) {
      if (!(await c.call(step, "document_read", { path: `${I}/${p}` })).startsWith("ERROR")) c.fail(step, `${p} was written`);
    }
    c.pass(step);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
