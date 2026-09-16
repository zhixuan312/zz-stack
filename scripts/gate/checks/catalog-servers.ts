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

import { root } from "../read.ts";
import { check } from "../run.ts";
import { flows } from "../facts.ts";

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
  const known = (p: string): boolean => literal.has(p) || templates.some((re) => re.test(p));

  // AND THE CLIENT'S COPY OF THE SAME SET. `packages/tools` cannot import a service, so
  // `zz-tool call` validates a door against `DOORS_PRINTED` in @zz/contracts before it opens a
  // socket. That is a SECOND statement of what this gateway serves, and the only thing that
  // makes a second statement honest is this comparison — without it the CLI drifts silently,
  // which is exactly what it had done: it accepted `/admin/mcp`, a door retired long enough ago
  // that admin.ts opens by saying so.
  //
  // Compared on the PRINTED spelling, because that is what the two sets have in common: the
  // gateway keys DOORS by express's mount path (`/p/:block/mcp`) and `/` rewrites the parameter
  // for a reader (`/p/<block>/mcp`), which is the form a person types and the CLI validates.
  // READ FROM alias.ts's SOURCE, not from @zz/contracts' dist. A module under scripts/gate may
  // not import build output: dist/ is gitignored, so it is here on the machine that just built
  // and absent on a fresh clone, where the gate would throw before reporting anything. The gate
  // told me so when this first imported it. server.ts is read the same way, two lines up.
  const aliasSrc = readFileSync(join(root, "packages/contracts/src/alias.ts"), "utf8");
  const fixed = /export const FIXED_DOORS = Object\.freeze\(\[([^\]]*)\]\)/.exec(aliasSrc)?.[1];
  if (!fixed) {
    return "packages/contracts/src/alias.ts no longer declares FIXED_DOORS where this can read it — the client's door set is unchecked";
  }
  // EVERY DOOR IS FIXED NOW. There used to be one more, `/p/<block>/mcp`, appended here from
  // BLOCK_DOOR — a per-third-party-server door the gateway proxied. Nothing registers a block
  // any more, so the door set is the fixed set and nothing is concatenated onto it.
  const clientDoors = [...fixed.matchAll(/"([^"]+)"/g)].map((m) => m[1]);

  const printed = doors.map((d) => d.replace(/:([A-Za-z_]\w*)/g, "<$1>"));
  const onlyGateway = printed.filter((d) => !clientDoors.includes(d));
  const onlyClient = clientDoors.filter((d) => !printed.includes(d));
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
      continue;   // catalog-manifest.ts owns "it parses"; one failure, one check
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
