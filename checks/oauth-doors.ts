#!/usr/bin/env node
/**
 * OAuth authorises exactly the doors the gateway mounts — every one of them, and nothing else.
 *
 * `doorOf` once matched a pattern of its own that named /core and /manage and not /eval, so a client
 * connecting to the evaluation door by OAuth was refused "Unknown resource" for a door the gateway
 * serves. The set now comes from server.ts's `DOORS`, the same map `/` announces and its startup
 * guard holds equal to the router's.
 *
 *   1. read: server.ts hands `Object.keys(DOORS)` to `mountMcpOauth`, and mcp-oauth.ts names no door
 *      path itself — a second list is the bug coming back;
 *   2. driven: `doorOf` accepts every key of `DOORS` (with or without a trailing slash, on any
 *      origin) and refuses a path that is not one, or that only starts like one.
 *
 * Run: node checks/oauth-doors.ts   (also run by scripts/gate.ts)
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

process.env.GATEWAY_PUBLIC_URL ??= "https://api.doors.test";

const fail: string[] = [];
const is = (cond: unknown, why: string) => { if (!cond) fail.push(why); };

const server = readFileSync("services/gateway/src/server.ts", "utf8");
const oauth = readFileSync("services/gateway/src/mcp-oauth.ts", "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");

// 1. One list
is(/mountMcpOauth\(\s*app\s*,\s*Object\.keys\(DOORS\)\s*\)/.test(server),
   "server.ts does not hand Object.keys(DOORS) to mountMcpOauth — OAuth would authorise a set of its own");
is(!/["'`/]\/?(core|manage|eval)\/mcp|core\|manage|\(core/.test(oauth),
   "mcp-oauth.ts names a door path itself — the mounted set is server.ts's DOORS, and a second list drifts");

// 2. Every mounted door, and nothing else
const block = /const DOORS[^=]*=\s*\{([\s\S]*?)\n\};/.exec(server)?.[1] ?? "";
const doors = [...block.matchAll(/^\s{2}"(\/[^"]+)":/gm)].map((m) => m[1]!);
is(doors.length >= 3, `found ${doors.length} doors in server.ts's DOORS — this scan is blind`);
const { doorOf } = await import(pathToFileURL(join(process.cwd(), "services/gateway/dist/mcp-oauth.js")).href);
for (const d of doors) {
  is(doorOf(`https://api.doors.test${d}`, doors) === d, `OAuth refuses ${d}, a door the gateway mounts`);
  is(doorOf(`http://10.0.0.5:8000${d}/`, doors) === d, `OAuth refuses ${d} reached on an internal address or with a trailing slash`);
}
for (const bad of ["/nope/mcp", "/core/mcp/extra", "/mcp", "/core", "not a url"]) {
  is(doorOf(bad.startsWith("/") ? `https://api.doors.test${bad}` : bad, doors) === null, `OAuth accepts ${bad}, which is not a door`);
}

if (fail.length) {
  for (const f of fail) console.error(`FAIL ${f}`);
  process.exit(1);
}
console.log(`PASS OAuth authorises the ${doors.length} mounted doors and nothing else`);
