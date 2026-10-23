#!/usr/bin/env node
/**
 * zz-core's listening port: --port <n> when n is a port number in plain decimal, 8000 with no --port, refused otherwise —
 * `--port=<n>` and a repeated --port included, each by name. Its listening address: --host <ip> when ip is an IP
 * literal, every interface with no --host, refused otherwise; and the two scripts that start a throwaway zz-core on
 * this machine pass `--host 127.0.0.1`, so a local run is never reachable from the network.
 * Run: node checks/core-port.ts   (after npm run build; also run by scripts/gate.ts)
 */
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { readFileSync } from "node:fs";

const { listenPort, listenHost } = await import(pathToFileURL(join(process.cwd(), "services/zz-core/dist/listen-port.js")).href);
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
const refusedWith = (args: string[], says: RegExp) => {
  try { listenPort(argv(...args)); return false; } catch (err) { return err instanceof Error && says.test(err.message); }
};
is(refusedWith(["--port=8123"], /"--port=8123" is not accepted; write --port <n> with a space/), "--port=8123 was accepted, or refused without naming it");
is(refusedWith(["--port", "1", "--port", "2"], /--port was given more than once/), "a repeated --port was accepted, or refused without saying so");
for (const bad of ["0", "65536", "-1", "+80", "80.5", "1e3", "0x50", "08123", " 8123", "8123 ", "   ", "", "eighty", "8000abc"]) {
  is(refuses(bad), `${JSON.stringify(bad)} was accepted, or refused without naming it`);
}
is(listenHost(argv()) === "0.0.0.0", "no --host is not every interface");
is(listenHost(argv("--port", "8123", "--host", "127.0.0.1")) === "127.0.0.1", "an IPv4 host is not used");
is(listenHost(argv("--host", "::1")) === "::1", "an IPv6 host is not used");
const hostRefusedWith = (args: string[], says: RegExp) => {
  try { listenHost(argv(...args)); return false; } catch (err) { return err instanceof Error && says.test(err.message); }
};
is(hostRefusedWith(["--host"], /--host needs a value/), "--host with no value was accepted");
is(hostRefusedWith(["--host=127.0.0.1"], /"--host=127.0.0.1" is not accepted; write --host <ip> with a space/), "--host=127.0.0.1 was accepted, or refused without naming it");
is(hostRefusedWith(["--host", "127.0.0.1", "--host", "::1"], /--host was given more than once/), "a repeated --host was accepted, or refused without saying so");
for (const bad of ["localhost", "", " 127.0.0.1", "127.0.0.256", "--port"]) {
  is(hostRefusedWith(["--host", bad], new RegExp(`--host ${JSON.stringify(JSON.stringify(bad)).slice(1, -1)} is not an IP address`)),
     `--host ${JSON.stringify(bad)} was accepted, or refused without naming it`);
}
for (const launcher of ["scripts/schema/throwaway-core.ts", "scripts/skeleton-work.ts"]) {
  const src = readFileSync(join(process.cwd(), launcher), "utf8");
  is(/"services\/zz-core\/dist\/server\.js", "--port", String\(port\), "--host", "127\.0\.0\.1"\]/.test(src),
     `${launcher} starts zz-core without --host 127.0.0.1, so it listens on every interface`);
}
if (fail.length) {
  console.error(`core-port: ${fail.length} failure(s)\n  - ${fail.join("\n  - ")}`);
  process.exit(1);
}
console.log("core-port: --port and --host name zz-core's port and address, none is 8000 on every interface, anything else stops startup by name, and local launches bind loopback");
