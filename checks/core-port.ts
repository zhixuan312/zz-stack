#!/usr/bin/env node
/**
 * zz-core's listening port: --port <n> when n is a port number in plain decimal, 8000 with no --port, refused otherwise.
 * Run: node checks/core-port.ts   (after npm run build; also run by scripts/gate.ts)
 */
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const { listenPort } = await import(pathToFileURL(join(process.cwd(), "services/zz-core/dist/listen-port.js")).href);
const fail: string[] = [];
const is = (cond: unknown, why: string) => { if (!cond) fail.push(why); };
const argv = (...rest: string[]) => ["node", "server.js", ...rest];
const refuses = (value: string | null) => {
  try { listenPort(value === null ? argv("--port") : argv("--port", value)); return false; }
  catch (err) { return err instanceof Error && (value === null || err.message.includes(value)); }
};
is(listenPort(argv()) === 8000, "no --port is not 8000");
is(listenPort(argv("--port", "8123")) === 8123, "a port number is not used");
is(listenPort(argv("--port", "1")) === 1, "the lowest port is refused");
is(listenPort(argv("--port", "65535")) === 65535, "the highest port is refused");
is(refuses(null), "--port with no value was accepted");
for (const bad of ["0", "65536", "-1", "+80", "80.5", "1e3", "0x50", "08123", " 8123", "8123 ", "   ", "", "eighty", "8000abc"]) {
  is(refuses(bad), `${JSON.stringify(bad)} was accepted, or refused without naming it`);
}
if (fail.length) {
  console.error(`core-port: ${fail.length} failure(s)\n  - ${fail.join("\n  - ")}`);
  process.exit(1);
}
console.log("core-port: --port names zz-core's port in plain decimal, none is 8000, and anything else stops startup by name");
