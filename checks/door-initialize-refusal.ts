#!/usr/bin/env node
/**
 * A door that refuses initialize is not a door that answers.
 *
 * The gateway answers a dead upstream with HTTP 200 and a JSON-RPC error frame (relay.ts
 * `mcpRefusal`), so a probe that reads the status alone reads a refusing door as up. Release
 * 0.98.2's first run met both halves: the doors layer printed `MCP initialize /core/mcp` green
 * while zz-core was still restarting, step 5 started on the gateway's /health alone, and the
 * contract probe's refusal rolled a good release back.
 *
 * Against a stub door in a child process — the helper calls curl synchronously, so a server in
 * this process could not answer it:
 *   1. the stub's refusal is HTTP 200, which is why a status code cannot tell;
 *   2. initializeRefusal names a refusal frame, and the code it carries;
 *   3. it passes a result frame, plain or as SSE;
 *   4. it names an answer that is not JSON, as a Caddy 502 page is;
 *   5. the doors layer's initialize probe and release step 5's readiness poll both ask it.
 *
 * Run: node checks/door-initialize-refusal.ts
 */
import { execFileSync, spawn } from "node:child_process";
import { readFileSync } from "node:fs";

import { initializeRefusal } from "../scripts/deployment.ts";

const fail: string[] = [];
const is = (cond: unknown, why: string) => { if (!cond) fail.push(why); };

const STUB = `
const http = require("node:http");
const refusal = {jsonrpc: "2.0", id: 1, error: {code: -32000, message: "The ZZ platform service is not reachable right now."}};
const result = {jsonrpc: "2.0", id: 1, result: {serverInfo: {name: "stub", version: "0"}}};
const server = http.createServer((req, res) => {
  req.resume();
  req.on("end", () => {
    if (req.url.startsWith("/refusing/")) { res.writeHead(200, {"content-type": "application/json"}); res.end(JSON.stringify(refusal)); }
    else if (req.url.startsWith("/working/")) { res.writeHead(200, {"content-type": "application/json"}); res.end(JSON.stringify(result)); }
    else if (req.url.startsWith("/sse/")) { res.writeHead(200, {"content-type": "text/event-stream"}); res.end("event: message\\ndata: " + JSON.stringify(result) + "\\n\\n"); }
    else { res.writeHead(502, {"content-type": "text/html"}); res.end("<html><body>502 Bad Gateway</body></html>"); }
  });
});
server.listen(0, "127.0.0.1", () => console.log(server.address().port));
`;

const stub = spawn(process.execPath, ["-e", STUB], { stdio: ["ignore", "pipe", "inherit"] });
try {
  const port = await new Promise<string>((resolve, reject) => {
    stub.stdout.once("data", (b: Buffer) => resolve(String(b).trim()));
    stub.once("exit", (c) => reject(new Error(`the stub door exited (${c}) before it listened`)));
  });
  const base = `http://127.0.0.1:${port}`;

  // 1
  const status = execFileSync("curl", ["-s", "-o", "/dev/null", "-w", "%{http_code}", "-m", "10",
    "-d", "{}", `${base}/refusing/core/mcp`], { encoding: "utf8" }).trim();
  is(status === "200", `the stub's refusal answered http ${status}, not the 200 the gateway sends — this check reads nothing`);

  // 2
  const refused = initializeRefusal(`${base}/refusing`, "stub-token", "/core/mcp", "check");
  is(refused && /refused initialize/.test(refused) && /-32000/.test(refused),
     `a refusal frame was read as a working door: ${JSON.stringify(refused)}`);

  // 3
  is(initializeRefusal(`${base}/working`, "stub-token", "/core/mcp", "check") === null,
     "a door answering initialize with a result was reported as refusing");
  is(initializeRefusal(`${base}/sse`, "stub-token", "/core/mcp", "check") === null,
     "a door answering initialize as SSE was reported as refusing");

  // 4
  const html = initializeRefusal(`${base}/broken`, "stub-token", "/core/mcp", "check");
  is(html && /not JSON/.test(html), `a 502 page was not named as an answer that is not JSON: ${JSON.stringify(html)}`);
} finally {
  if (stub.pid) process.kill(stub.pid);
}

// 5
const doors = readFileSync("scripts/doctor/layers/doors.ts", "utf8");
is(/probe\(`MCP initialize \$\{path\}`, \(\) =>\s*initializeRefusal\(/.test(doors),
   "the doors layer's MCP initialize probe does not ask initializeRefusal — it can pass a refusing door again");
const rel = readFileSync("scripts/release.ts", "utf8");
const step5 = rel.indexOf('step(5, "verify")');
const asked = rel.indexOf("initializeRefusal(", step5);
const verified = rel.indexOf("verifyLive()", step5);
is(step5 > 0 && asked > step5 && asked < verified,
   "release step 5 starts verifyLive without waiting for the doors the gateway relays to");

if (fail.length) {
  console.error(`door-initialize-refusal: ${fail.length} failure(s)`);
  for (const f of fail) console.error(`  - ${f}`);
  process.exit(1);
}
console.log("door-initialize-refusal: a refusal frame is named, a result passes, and the doctor and the release both ask");
