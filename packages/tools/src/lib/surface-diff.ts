/**
 * What changed between two recorded tool surfaces, including a tool that stayed and moved.
 *
 * A diff of two name sets can answer only that a name arrived or a name left: a tool that moved
 * from one door to another changes no name, and a name-set diff answers "no change".
 *
 * `zz.plugin_tool.door` is recorded by `recordingDoor` at registration, on every row: the column
 * is NOT NULL and checked against the three doors. This is the half that reads it.
 *
 * Pure, and separate from the op that prints it: every op in this package calls `process.exit`
 * at module scope, so importing one to test its logic ends the importing process.
 * checks/eval-door.ts drives the functions below over a synthetic before and after.
 */

/** One tool as the surface record holds it. */
export interface RecordedTool {
  name: string;
  door: string;
}

/** One version's recorded surface. */
export interface RecordedSurface {
  version: string;
  tools: RecordedTool[];
}

export interface SurfaceChange {
  added: RecordedTool[];
  removed: RecordedTool[];
  /** Same name, and the doors differ. The finding this module exists for. */
  moved: { name: string; from: string; to: string }[];
  /** Same name, same door. */
  stayed: { name: string; door: string }[];
}

export function diffSurfaces(before: RecordedSurface, after: RecordedSurface): SurfaceChange {
  const b = new Map(before.tools.map((t) => [t.name, t.door]));
  const a = new Map(after.tools.map((t) => [t.name, t.door]));

  const change: SurfaceChange = { added: [], removed: [], moved: [], stayed: [] };

  for (const [name, door] of [...a].sort()) {
    const was = b.get(name);
    if (was === undefined) { change.added.push({ name, door }); continue; }
    if (was === door) change.stayed.push({ name, door });
    else change.moved.push({ name, from: was, to: door });
  }
  for (const [name, door] of [...b].sort()) {
    if (!a.has(name)) change.removed.push({ name, door });
  }
  return change;
}

/** The report, as the lines an operator reads. The headline is the moves. */
export function renderSurfaceChange(plugin: string, before: RecordedSurface,
                                    after: RecordedSurface, c: SurfaceChange): string {
  const out: string[] = [];
  out.push(`\n  ${plugin}: ${before.version} → ${after.version} ` +
           `(${before.tools.length} tools → ${after.tools.length})\n`);

  if (c.moved.length) {
    out.push(`  MOVED DOOR (${c.moved.length}) — the same tool, served somewhere else:`);
    for (const m of c.moved) out.push(`    ${m.name}: ${m.from} → ${m.to}`);
    out.push("");
  }
  if (c.added.length) {
    out.push(`  ADDED (${c.added.length}):`);
    for (const t of c.added) out.push(`    ${t.name} (${t.door})`);
    out.push("");
  }
  if (c.removed.length) {
    out.push(`  REMOVED (${c.removed.length}):`);
    for (const t of c.removed) out.push(`    ${t.name} (${t.door})`);
    out.push("");
  }

  if (!c.moved.length) {
    out.push(`  No tool changed door. Every one of the ${c.stayed.length} tool(s) on both ` +
             "versions was recorded on the same door in each.");
    out.push("");
  }

  const byDoor = new Map<string, number>();
  for (const t of after.tools) byDoor.set(t.door, (byDoor.get(t.door) ?? 0) + 1);
  out.push(`  ${after.version} by door: ` +
           [...byDoor].sort().map(([d, n]) => `${d}=${n}`).join(", "));
  return out.join("\n");
}
