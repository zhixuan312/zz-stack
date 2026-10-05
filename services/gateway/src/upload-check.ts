/**
 * upload-check — `PUT /upload/source`, driven for real: every path a caller can take through it.
 *
 * The route is the one place a file's bytes reach the platform without passing through a model, and
 * nothing exercised it. `extract-check` proves the reader that turns bytes into text; the route
 * around it — which content types it refuses before reading a body at all, what it does with a body
 * past the cap, whether the caller's own identity headers are forwarded to `source_add`, and whether
 * an `ERROR:` from zz-core comes back as the caller's own refusal rather than a 500 — had no check.
 * A route is reachable by a consumer the moment `source_upload` prints its curl line, so "nothing
 * tests it" is a gap in what the platform claims, not a note about coverage.
 *
 * `mountUpload` is handed a stub app that captures the handler it registers, so every case below
 * drives the REAL handler rather than a copy of its branches. zz-core is a stub MCP server on a
 * free port, answering the handshake and `tools/call` the way `mcp-client-check`'s does.
 *
 *   npm run check:upload      # exits non-zero on failure, like every engine here
 */
import { EventEmitter } from "node:events";
import { Buffer } from "node:buffer";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import type { Express, Request, Response } from "express";

import { mountUpload } from "./upload.js";

type Handler = (req: Request, res: Response) => void;
let handler: Handler | null = null;
mountUpload({ put: (_path: string, h: Handler) => { handler = h; } } as unknown as Express);

/** What `source_add` was called with, one entry per call. */
const CALLS: { name?: string; args?: Record<string, unknown> }[] = [];
const HEADERS: IncomingMessage["headers"][] = [];

/** What the stub zz-core answers. Set per case; `down` is a closed port, not a mode of this server. */
let reply = "Source added on 2026-10-05: notes.md";

function stub(req: IncomingMessage, res: ServerResponse): void {
  HEADERS.push(req.headers);
  const chunks: Buffer[] = [];
  req.on("data", (c: Buffer) => chunks.push(c));
  req.on("end", () => {
    const body = JSON.parse(Buffer.concat(chunks).toString() || "{}") as {
      method?: string;
      params?: { name?: string; arguments?: Record<string, unknown> };
    };
    const json = (payload: string, code = 200): void => {
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(payload);
    };
    if (body.method === "initialize") {
      res.writeHead(200, { "mcp-session-id": "S1", "Content-Type": "application/json" });
      res.end('{"jsonrpc":"2.0","id":1,"result":{"serverInfo":{"name":"stub","version":"1"}}}');
      return;
    }
    if (body.method === "notifications/initialized") { res.writeHead(202); res.end(); return; }
    CALLS.push({ name: body.params?.name, args: body.params?.arguments });
    // The reply is a `text` result either way: zz-core refuses in its own words, which the route
    // has to hand back to the caller rather than turn into a failure of the route itself.
    json(JSON.stringify({ jsonrpc: "2.0", id: 2, result: { content: [{ text: reply }] } }));
  });
}

/** A request the route can read: its query and headers, and the bytes it will stream if asked. */
function request(opts: {
  query?: Record<string, string>;
  headers?: Record<string, string>;
  body?: Buffer;
  length?: number;
}): Request {
  const req = new EventEmitter() as unknown as Request & EventEmitter;
  const any = req as unknown as Record<string, unknown>;
  any.query = opts.query ?? {};
  any.headers = {
    "content-type": "application/octet-stream",
    ...(opts.length === undefined ? {} : { "content-length": String(opts.length) }),
    ...(opts.headers ?? {}),
  };
  // The caller's own identity, as the gateway's auth middleware sets it before this route runs.
  any.zzIdentity = { email: "ada@zz.test", activeTeam: "atlas" };
  if (opts.body) {
    // On the next tick, so the handler has attached its listeners before anything is emitted.
    setImmediate(() => {
      req.emit("data", opts.body);
      req.emit("end");
    });
  }
  return req;
}

/** What the route answered, and the promise that settles when it does. */
function drive(req: Request): Promise<{ code: number; body: unknown }> {
  if (!handler) throw new Error("mountUpload registered no handler");
  return new Promise((resolve) => {
    let code: number | undefined;
    const res = {
      headersSent: false,
      status(n: number) { code = n; return res; },
      json(body: unknown) { res.headersSent = true; resolve({ code: code ?? 200, body }); return res; },
    } as unknown as Response;
    handler!(req, res);
  });
}

const message = (body: unknown): string => JSON.stringify(body);

async function main(): Promise<number> {
  const srv = createServer(stub);
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const port = (srv.address() as AddressInfo).port;
  process.env.CORE_MCP_URL = `http://127.0.0.1:${port}/core/mcp`;

  const failures: string[] = [];
  let cases = 0;
  const is = (name: string, ok: boolean, got: unknown = ""): void => {
    cases++;
    if (!ok) failures.push(`${name} — got ${message(got)}`);
  };

  // A body the route must refuse BEFORE reading it. curl sends this when told nothing else, and a
  // global JSON parser above this route would have eaten the file and left form fields behind.
  for (const type of ["application/json", "application/x-www-form-urlencoded", "multipart/form-data"]) {
    const a = await drive(request({ query: { initiative: "i", title: "t", filename: "f.md" }, headers: { "content-type": type }, body: Buffer.from("x") }));
    is(`${type} is refused as a file that is not file bytes`, a.code === 415 && /send the file itself/.test(message(a.body)), a);
  }

  // A `; charset=` suffix is the same type: the guard reads the type, not the whole header.
  const withCharset = await drive(request({ query: { initiative: "i", title: "t", filename: "f.md" }, headers: { "content-type": "application/json; charset=utf-8" }, body: Buffer.from("x") }));
  is("a content type with parameters is read as its type", withCharset.code === 415, withCharset);

  const missing = await drive(request({ query: { initiative: "", title: "t", filename: "f.md" } }));
  is("a missing initiative is refused by name", missing.code === 400 && /initiative, title and filename/.test(message(missing.body)), missing);

  const empty = await drive(request({ query: { initiative: "i", title: "t", filename: "f.md" }, body: Buffer.alloc(0) }));
  is("an empty upload is refused", empty.code === 400 && /carried no bytes/.test(message(empty.body)), empty);

  // The cap, both ways: the length the caller declares, and the stream that outruns it. The second
  // is the one that matters — `Content-Length` is the client's claim, and a cap that trusts it is a
  // cap that a chunked body walks past.
  const declared = await drive(request({ query: { initiative: "i", title: "t", filename: "f.md" }, length: 17 * 1024 * 1024 }));
  is("a declared length past the cap is refused", declared.code === 413 && /platform's 16777216-byte limit|past this platform/.test(message(declared.body)), declared);

  const streamed = await drive(request({ query: { initiative: "i", title: "t", filename: "f.md" }, body: Buffer.alloc(17 * 1024 * 1024, 0x61) }));
  is("a body that passes the cap while streaming is refused", streamed.code === 413 && /passed 16777216 bytes/.test(message(streamed.body)), streamed);

  const pdf = await drive(request({ query: { initiative: "i", title: "t", filename: "report.pdf" }, body: Buffer.from("%PDF-1.7\n") }));
  is("a file the reader does not read is refused with the reader's own words", pdf.code === 415 && /Upload a file this platform reads/.test(message(pdf.body)), pdf);

  // The happy path. What matters beyond the 200 is what zz-core was actually asked to write: the
  // file's own text, under the title the caller gave, and the caller's identity headers forwarded —
  // the gateway writes no platform table itself.
  CALLS.length = 0;
  reply = "Source added on 2026-10-05: notes.md";
  const ok = await drive(request({
    query: { initiative: "2026-01-01-atlas", title: "Interview notes", filename: "notes.md", supports: "spec.md", stage: "sdlc-spec" },
    headers: { "content-type": "text/markdown", "x-zz-client": "claude-code", "x-zz-email": "ada@zz.test" },
    body: Buffer.from("# Notes\n\nwhat the interview said\n"),
  }));
  is("a readable file is accepted", ok.code === 200 && /"ok":true/.test(message(ok.body)), ok);
  is("it is written through source_add and nothing else", CALLS.length === 1 && CALLS[0].name === "source_add", CALLS);
  is("the file's own text is what source_add is given", /what the interview said/.test(String(CALLS[0]?.args?.content ?? "")), CALLS[0]);
  is("the title, the supports and the stage are passed as the caller wrote them",
     CALLS[0]?.args?.title === "Interview notes" && CALLS[0]?.args?.supports === "spec.md" && CALLS[0]?.args?.stage === "sdlc-spec", CALLS[0]);
  is("the caller's identity headers reach zz-core",
     HEADERS.some((h) => h["x-zz-client"] === "claude-code" && h["x-zz-email"] === "ada@zz.test"), HEADERS);

  // zz-core refusing in its own words is the CALLER's refusal, not a failure of the route.
  reply = "ERROR: initiative \"2026-01-01-atlas\" is not open";
  const refused = await drive(request({ query: { initiative: "2026-01-01-atlas", title: "t", filename: "notes.md" }, body: Buffer.from("# x\n") }));
  is("source_add's own refusal comes back as a 400 carrying its words",
     refused.code === 400 && /is not open/.test(message(refused.body)), refused);

  // And zz-core being unreachable is the route's own failure, said as such.
  process.env.CORE_MCP_URL = "http://127.0.0.1:1/mcp";
  const down = await drive(request({ query: { initiative: "i", title: "t", filename: "notes.md" }, body: Buffer.from("# x\n") }));
  is("an unreachable zz-core is a 502 rather than a 500", down.code === 502, down);

  srv.close();
  if (failures.length) {
    for (const f of failures) console.error(`  ✗ ${f}`);
    console.error(`\nupload: ${failures.length} of ${cases} assertions failed`);
    return 1;
  }
  console.log(`  upload: ${cases} assertions across every path through PUT /upload/source — the content-type guard, the cap both ways, the reader's refusal, the write through source_add, and zz-core's own refusal and absence`);
  return 0;
}

process.exit(await main());
