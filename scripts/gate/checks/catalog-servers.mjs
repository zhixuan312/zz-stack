/**
 * A manifest's `servers` name doors this gateway actually mounts.
 *
 * `flow.json`'s `servers` is copied verbatim into the `.mcp.json` of that package's plugin,
 * as `${GATEWAY_PUBLIC_URL}${path}`. Nothing between the manifest and the installed client
 * ever asks whether the path resolves — so a typo ships, installs, and shows up as an MCP
 * server that will not connect, on somebody else's machine, with the reason nowhere near it.
 *
 * It shipped: `zz-block-eval` and `zz-skill-eval` both declared zz-core at `/mcp`, and the
 * door is `/core/mcp`. `/mcp` answers 404. Two of the five plugins on the public shelf
 * carried a dead server through every release that had one, because the only reader that
 * could have noticed — a person installing that plugin — sees a connection error and not a
 * path comparison.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { root } from "../read.mjs";
import { check } from "../run.mjs";
import { flows } from "../facts.mjs";

check("every server a manifest declares is a door the gateway mounts", () => {
  // FROM server.ts's own DOORS, not retyped here. Each key IS the path its entry mounts the
  // route at — the object is what `/` serves, what the process prints on boot, and what
  // registers the routes — so it is already the one statement of what this gateway offers; a
  // second list in the gate would be a third answer to the same question and would drift from
  // both. It was an ARRAY of `{ path: … }` until Task I-33 made the key the mount path; a
  // regex still looking for the array shape would find nothing and this check says so rather
  // than passing on an empty list.
  const src = readFileSync(join(root, "services/gateway/src/server.ts"), "utf8");
  const block = /const DOORS: Record<[\s\S]*?> = \{([\s\S]*?)\n\};/.exec(src)?.[1];
  if (!block) return "server.ts no longer declares DOORS where this can read it";

  const doors = [...block.matchAll(/^  "([^"]+)":/gm)].map((m) => m[1]);
  if (!doors.length) return "DOORS was found and holds no path — this check is reading nothing";

  // `/p/:platform/mcp` is a template, not a literal path: it is express's own parameter syntax,
  // because that string is what the route is mounted at. A manifest naming a block door names
  // one block, so it is matched on the shape rather than on the placeholder.
  const templates = doors.filter((d) => d.includes(":")).map((d) => new RegExp(
    "^" + d.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/:[A-Za-z_]\w*/g, "[^/]+") + "$"));
  const literal = new Set(doors.filter((d) => !d.includes(":")));
  const known = (p) => literal.has(p) || templates.some((re) => re.test(p));

  const bad = [];
  for (const f of flows) {
    let m;
    try {
      m = JSON.parse(readFileSync(join(f.dir, "flow.json"), "utf8"));
    } catch {
      continue;   // catalog-manifest.mjs owns "it parses"; one failure, one check
    }
    for (const sv of m.servers ?? []) {
      if (!sv?.path) { bad.push(`${f.flow}: a server with no path`); continue; }
      if (!known(sv.path)) {
        bad.push(`${f.flow}: server '${sv.name}' points at ${sv.path}, which this gateway ` +
                 `does not mount (it serves ${doors.join(", ")})`);
      }
    }
  }
  return bad.length ? bad.join("; ") : null;
});
