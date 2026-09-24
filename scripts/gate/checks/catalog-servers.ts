/**
 * A manifest's `servers` name doors this gateway actually mounts.
 *
 * `flow.json`'s `servers` is copied verbatim into the `.mcp.json` of that package's plugin, as
 * `${GATEWAY_PUBLIC_URL}${path}`. Nothing between the manifest and the installed client asks
 * whether the path resolves, so a typo ships, installs, and shows up as an MCP server that
 * will not connect on somebody else's machine.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { root } from "../read.ts";
import { check } from "../run.ts";
import { flows } from "../facts.ts";

check("every server a manifest declares is a door the gateway mounts", () => {
  // Read from server.ts's own DOORS, not retyped here: each key is the path its entry mounts
  // the route at, and the object is what `/` serves, what the process prints on boot, and what
  // registers the routes. A second list in the gate would drift from both. The regex expects
  // the `Record` shape and this check says so rather than passing on an empty list.
  const src = readFileSync(join(root, "services/gateway/src/server.ts"), "utf8");
  const block = /const DOORS: Record<[\s\S]*?> = \{([\s\S]*?)\n\};/.exec(src)?.[1];
  if (!block) return "server.ts no longer declares DOORS where this can read it";

  const doors = [...block.matchAll(/^  "([^"]+)":/gm)].map((m) => m[1]);
  if (!doors.length) return "DOORS was found and holds no path — this check is reading nothing";

  const known = new Set(doors);

  // And the client's copy of the same set. `packages/tools` cannot import a service, so
  // `zz-tool call` validates a door against `DOORS_PRINTED` in @zz/contracts before it opens a
  // socket. This comparison is the only thing that keeps that second statement honest.
  //
  // DELIBERATE: read from alias.ts's source, not from @zz/contracts' dist. A module under
  // scripts/gate may not import build output — dist/ is gitignored, so it is present on a
  // machine that just built and absent on a fresh clone, where the gate would throw before
  // reporting anything. server.ts is read the same way, two lines up.
  const aliasSrc = readFileSync(join(root, "packages/contracts/src/alias.ts"), "utf8");
  const fixed = /export const FIXED_DOORS = Object\.freeze\(\[([^\]]*)\]\)/.exec(aliasSrc)?.[1];
  if (!fixed) {
    return "packages/contracts/src/alias.ts no longer declares FIXED_DOORS where this can read it — the client's door set is unchecked";
  }
  // Every door is fixed, so the door set is the fixed set and nothing is concatenated onto it.
  const clientDoors = [...fixed.matchAll(/"([^"]+)"/g)].map((m) => m[1]);

  const onlyGateway = doors.filter((d) => !clientDoors.includes(d));
  const onlyClient = clientDoors.filter((d) => !known.has(d));
  if (onlyGateway.length || onlyClient.length) {
    return [
      onlyGateway.length ? `the gateway mounts ${onlyGateway.join(", ")}, which @zz/contracts does not name — zz-tool call would refuse a door that works` : "",
      onlyClient.length ? `@zz/contracts names ${onlyClient.join(", ")}, which this gateway does not mount — zz-tool call would accept a door that 404s` : "",
    ].filter(Boolean).join("; ");
  }

  const bad = [];
  for (const f of flows) {
    let m;
    try {
      m = JSON.parse(readFileSync(join(f.dir, "flow.json"), "utf8"));
    } catch {
      continue;   // COUPLED: catalog-manifest.ts owns "it parses"
    }
    for (const sv of m.servers ?? []) {
      if (!sv?.path) { bad.push(`${f.flow}: a server with no path`); continue; }
      if (!known.has(sv.path)) {
        bad.push(`${f.flow}: server '${sv.name}' points at ${sv.path}, which this gateway ` +
                 `does not mount (it serves ${doors.join(", ")})`);
      }
    }
  }
  return bad.length ? bad.join("; ") : null;
});
