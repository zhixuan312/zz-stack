/**
 * Records /manage's own tool surface, the way zz-core records /core's and /eval's
 * (services/zz-core/src/server.ts `recordOwnSurface`).
 *
 * /manage is zz-access's door and this service serves it, so nothing else could: with no row in
 * zz.plugin_tool for any zz-access version, an evaluation fell back to every tool zz-access's
 * skills name — /core's bug_list and initiative_status among them — and reported those as its
 * surface and as never called.
 *
 * The door is built once with every role's registrations: the surface of a version is what it
 * serves to anybody, not what a member is offered. Attached only to a zz.plugin_version row the
 * release already registered, and a version already recorded is left alone.
 */
import { pluginForDoor } from "@zz/catalog";
import { serviceVersion } from "@zz/mcp-http";

import { buildAccessServer } from "./access-door.js";
import { platformDb, platformDbReady } from "./db.js";

const DOOR = "manage";

export async function recordAccessSurface(): Promise<void> {
  if (!platformDbReady()) return;
  const plugin = pluginForDoor(DOOR);
  if (!plugin) return;                  // a door no manifest claims: never guessed at
  const version = serviceVersion(import.meta.url);
  try {
    const names: string[] = [];
    await buildAccessServer({ onTool: (name) => names.push(name) });
    const p = platformDb();
    const row = (await p.query<{ id: string }>(
      `select pv.id::text as id from zz.plugin_version pv
         join zz.plugin pl on pl.id = pv.plugin_id
        where pl.name = $1 and pv.version = $2`, [plugin, version])).rows[0];
    if (!row) {
      // The release registers the version, then restarts this service so this finds it.
      console.warn(`no zz.plugin_version row for ${plugin} ${version} — /manage's tool surface was not recorded`);
      return;
    }
    for (const name of [...new Set(names)].sort()) {
      await p.query(
        `insert into zz.plugin_tool (plugin_version_id, name, door) values ($1::uuid, $2, $3)
         on conflict (plugin_version_id, name) do nothing`, [row.id, name, DOOR]);
    }
    console.log(`recorded /manage's surface at ${version}: ${plugin}=${new Set(names).size}`);
  } catch (err) {
    // Never fatal: a measurement nobody is waiting on must not stop the door starting.
    console.error("could not record /manage's surface:", err instanceof Error ? err.message : err);
  }
}
