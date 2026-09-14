// A second door exists, is announced, and is declared by the plugin that owns it.
import { readFileSync } from "node:fs";
const fail = [];
const core = readFileSync("services/zz-core/src/server.ts", "utf8");
const gw = readFileSync("services/gateway/src/server.ts", "utf8");

const mounts = [...core.matchAll(/serveMcp\(\s*app\s*,\s*["'`]([^"'`]+)["'`]/g)].map((m) => m[1]);
if (mounts.length < 2) fail.push(`zz-core mounts ${mounts.length} path(s); two doors need two`);
if (!mounts.some((p) => /eval/.test(p))) fail.push("zz-core has no eval mount");
// Two DIFFERENT factories, or both doors would serve the same tools.
const factories = [...core.matchAll(/serveMcp\(\s*app\s*,\s*["'`][^"'`]+["'`]\s*,\s*(\w+)/g)].map((m) => m[1]);
if (new Set(factories).size < 2) fail.push("both mounts use the same factory; the doors would be identical");

if (!/app\.all\(\s*["'`]\/eval\/mcp["'`]/.test(gw)) fail.push("the gateway does not route /eval/mcp");
if (!/\/eval\/mcp/.test(gw.split("const DOORS")[1]?.slice(0, 2000) ?? "")) {
  fail.push("DOORS does not announce /eval/mcp");
}
const mf = JSON.parse(readFileSync("catalog/zz/zz-plugin-eval/flow.json", "utf8"));
const paths = (mf.servers || []).map((s) => s.path);
if (!paths.includes("/eval/mcp")) fail.push("zz-plugin-eval does not declare /eval/mcp");
if (paths.includes("/core/mcp")) fail.push("zz-plugin-eval still declares /core/mcp");
// Control: /core/mcp must STILL be routed and announced.
if (!/app\.all\(\s*["'`]\/core\/mcp["'`]/.test(gw)) fail.push("the core door stopped being routed");
if (fail.length) { console.error(fail.join("\n")); process.exit(1); }
console.log("eval door: ok");
