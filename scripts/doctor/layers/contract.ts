/**
 * Layer 5 — is the live surface the one the source declares?
 *
 * A door that fails to mount does not 500: it answers 200 with a shorter list, and every probe in
 * the `doors` layer stays green.
 *
 * Source is the declaration, the deployment is the fact, and this compares them by name rather
 * than by count. A count passes a tool that was renamed, passes one deleted while another was
 * added, and can only ever notice a door that lost one and gained nothing.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { initFrame } from "../../deployment.ts";
import { mcpFrame, type McpFrame } from "../../door-frame.ts";
import { root, zzCoreTools } from "../../gate/read.ts";
import { checkoutVersion, layer, liveToken, liveUrl, probe } from "../run.ts";

layer("contract", "is the live surface the one the source declares", ["services/zz-core/src", "packages/contracts/src"]);

/** One MCP call to a door, with this layer's own address and token resolved first. */
const mcp = (path: string, body: string): McpFrame => mcpFrame(liveUrl(), liveToken(), path, body);

/** Registered behind `if (sup)`, the gate checks/core-surface.ts holds knowledge_reindex to: only a
 *  superadmin is offered it, so its absence under the member token this layer usually asks with is
 *  not a fault. Read off the line the registration starts on. */
const superadminOnly = (t: { file: string; from: number }): boolean => {
  const src = readFileSync(join(root, t.file), "utf8");
  return /if \(sup\) server\.$/.test(src.slice(src.lastIndexOf("\n", t.from) + 1, t.from));
};

/** Every tool zz-core's source registers for every caller that `served` lacks, as `<file> (<names>)`
 *  per module, or null. Each tool is looked for on its own: a module that registers one tool is
 *  as droppable from a builder as one that registers five. */
export function unservedTools(served: Set<string>): string | null {
  const byFile = new Map<string, string[]>();
  for (const t of zzCoreTools()) {
    if (served.has(t.name) || superadminOnly(t)) continue;
    byFile.set(t.file, [...(byFile.get(t.file) ?? []), t.name]);
  }
  return byFile.size ? [...byFile].map(([f, ns]) => `${f} (${ns.join(", ")})`).join("; ") : null;
}

probe("every tool the source registers is on the live door", () => {
  // The initialize handshake first: the doors are stateless, but a server that throws at
  // construction answers the handshake with an error rather than a tool list, and "0 tools" and
  // "the server would not start" are different diagnoses.
  //
  // COUPLED: both of zz-core's doors, and the union of what they serve. The service mounts two MCP
  // endpoints — published as /core/mcp and /eval/mcp — and `zzCoreTools()` below reads the whole of
  // services/zz-core/src, so it declares the tools of both. Asking only the core door would report
  // every `plugin_*` tool as missing on a healthy deployment.
  const DOORS = ["/core/mcp", "/eval/mcp"];
  const names: string[] = [];
  for (const door of DOORS) {
    const hello = mcp(door, initFrame("doctor"));
    if (hello.unreachable) return `${door}: ${hello.unreachable}`;
    if (hello.error) return `${door} refused initialize: ${JSON.stringify(hello.error).slice(0, 200)}`;

    const live = mcp(door, JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }));
    if (live.unreachable) return `${door}: ${live.unreachable}`;
    const served = (live?.result?.tools ?? []).map((t) => t.name);
    // Per door, not on the union: one door mounting empty is invisible in a union the other
    // door fills, and an empty door is the failure this whole probe exists to catch.
    if (!served.length) return `${door} lists no tools at all — a door that failed to mount answers 200 with an empty list`;
    names.push(...served);
  }

  // Per tool, so the answer names the module a missing tool came from — which is the whole
  // diagnosis when a register<Door>Tools call is dropped from a builder. What this cannot see:
  // which of zz-core's two doors a tool is on. The lists are unioned, so a tool that moved from
  // one to the other reads as present; checks/eval-door.ts holds that offline, against the
  // builders themselves.
  const unserved = unservedTools(new Set(names));
  return unserved
    ? `zz-core's doors (${DOORS.join(", ")}) carry ${names.length} tools between them and are ` +
      `missing ${unserved} — every caller is offered these, so that is the shape of a register ` +
      "call dropped from a builder. A tool MOVED between these two doors is invisible here, " +
      "because both are asked and their lists are unioned."
    : null;
});

probe("the live door is running this version", () => {
  const want = checkoutVersion();
  // The handshake, not a package download. `serverInfo.version` answers what the running image
  // thinks it is in one frame, from the same `serviceVersion` read, with no archive in the middle.
  const hello = mcp("/core/mcp", initFrame("doctor"));
  if (hello.unreachable) return hello.unreachable;
  if (hello.error) return `the door refused initialize: ${JSON.stringify(hello.error).slice(0, 200)}`;
  const live = hello?.result?.serverInfo?.version;
  if (!live) return "the handshake carried no serverInfo.version";
  return live === want ? null : `the door reports "${live}", this checkout is ${want}`;
});
