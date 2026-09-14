// The attribution key is the loaded skill, never the team's last-installed flow.
import { readFileSync } from "node:fs";
const fail = [];
const tel = readFileSync("services/gateway/src/tool-telemetry.ts", "utf8");
const trace = readFileSync("services/gateway/src/step-trace.ts", "utf8");

if (!/\bplugin\s*:/.test(tel) || !/plugin_version|pluginVersion/.test(tel)) {
  fail.push("tool-telemetry does not write plugin / plugin_version");
}
// The join, not the flow_install shortcut, must be what resolves a plugin.
if (!/plugin_version_skill/.test(trace + tel)) {
  fail.push("plugin is not resolved through zz.plugin_version_skill");
}
// flowFor must not be the source of the plugin field.
const pluginFromFlow = /plugin\s*:\s*(await\s+)?flowFor\(/.test(tel);
if (pluginFromFlow) fail.push("plugin is derived from flowFor() — the team's last-installed flow");
// Nor may it come from the client header, which names the program, not the plugin.
if (/plugin\s*:[^,\n]*x-zz-client/.test(tel) || /plugin\s*:[^,\n]*detail\.client/.test(tel)) {
  fail.push("plugin is populated from x-zz-client — that is the client program, not the plugin");
}
// Control: `flow` itself must STILL be written. A check that removed it would be too broad.
if (!/\bflow\s*:/.test(tel)) fail.push("flow stopped being recorded; it remains valid team context");
// A null plugin must be reachable rather than defaulted.
if (/plugin\s*:\s*[^,\n]*\?\?\s*["'`]/.test(tel)) {
  fail.push("plugin falls back to a string default; an unresolved plugin must be null");
}
if (fail.length) { console.error(fail.join("\n")); process.exit(1); }
console.log("attribution: ok");
