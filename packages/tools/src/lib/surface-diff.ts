/**
 * What changed between two recorded tool surfaces, including a tool that stayed and moved.
 *
 * A diff of two name sets can answer only that a name arrived or a name left: a tool that moved
 * from one door to another changes no name, and a name-set diff answers "no change".
 *
 * `zz.plugin_tool.door` is recorded by `recordingDoor` at registration. This is the half that
 * reads it.
 *
 * DELIBERATE: null is not a door, and especially not the core door. A row whose door was never
 * recorded has `door` null, and `door ?? "core"` would invent moves that never happened. So a
 * name present on both sides with a door known on only one side is undecidable and reported as
 * such, naming the version whose doors were never recorded.
 *
 * Pure, and separate from the op that prints it: every op in this package calls `process.exit`
 * at module scope, so importing one to test its logic ends the importing process.
 * checks/eval-door.ts drives the functions below over a synthetic before and after.
 */

/** One tool as the surface record holds it. `door` is null when it was never recorded. */
export interface RecordedTool {
  name: string;
  door: string | null;
}

/** One version's recorded surface. */
export interface RecordedSurface {
  version: string;
  tools: RecordedTool[];
}

export interface SurfaceChange {
  added: RecordedTool[];
  removed: RecordedTool[];
  /** Same name, both doors recorded, and they differ. The finding this module exists for. */
  moved: { name: string; from: string; to: string }[];
  /** Same name, same recorded door. */
  stayed: { name: string; door: string }[];
  /** Same name, and at least one side never recorded a door. Neither a move nor a non-move. */
  undecidable: RecordedTool[];
  /** Did that side record a door for any of its tools? False means it predates door recording. */
  doorsRecorded: { before: boolean; after: boolean };
}

export function diffSurfaces(before: RecordedSurface, after: RecordedSurface): SurfaceChange {
  const b = new Map(before.tools.map((t) => [t.name, t.door]));
  const a = new Map(after.tools.map((t) => [t.name, t.door]));

  const change: SurfaceChange = {
    added: [], removed: [], moved: [], stayed: [], undecidable: [],
    doorsRecorded: {
      before: before.tools.some((t) => t.door !== null),
      after: after.tools.some((t) => t.door !== null),
    },
  };

  for (const [name, door] of [...a].sort()) {
    if (!b.has(name)) { change.added.push({ name, door }); continue; }
    const was = b.get(name) ?? null;
    // Both sides or neither. The undecidable case is tested before the comparison, because
    // `null !== "eval"` is true and would otherwise read as a move out of a door nothing ever
    // recorded.
    if (was === null || door === null) { change.undecidable.push({ name, door }); continue; }
    if (was === door) change.stayed.push({ name, door });
    else change.moved.push({ name, from: was, to: door });
  }
  for (const [name, door] of [...b].sort()) {
    if (!a.has(name)) change.removed.push({ name, door });
  }
  return change;
}

/** The report, as the lines an operator reads. The headline is the moves; when nothing moved and
 *  nothing could have been known to move, this says which of the two it is rather than printing
 *  the same line for both. */
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
    for (const t of c.added) out.push(`    ${t.name}${t.door ? ` (${t.door})` : ""}`);
    out.push("");
  }
  if (c.removed.length) {
    out.push(`  REMOVED (${c.removed.length}):`);
    for (const t of c.removed) out.push(`    ${t.name}${t.door ? ` (${t.door})` : ""}`);
    out.push("");
  }

  // The honest non-answer, said at the same volume as a finding: "no tool changed door" when
  // half the comparison could not be made is false.
  if (c.undecidable.length) {
    const missing = !c.doorsRecorded.before ? before.version
                  : !c.doorsRecorded.after ? after.version : "one of these versions";
    out.push(`  DOORS NOT COMPARABLE for ${c.undecidable.length} tool(s): ${missing} recorded ` +
             "no door for them, so whether they moved is NOT KNOWN — not 'they did not move'. " +
             "A row written before the door column existed carries none, and none is invented.");
    out.push("");
  } else if (!c.moved.length) {
    out.push(`  No tool changed door. Every one of the ${c.stayed.length} tool(s) on both ` +
             "versions was recorded on the same door in each.");
    out.push("");
  }

  const byDoor = new Map<string, number>();
  for (const t of after.tools) {
    const k = t.door ?? "(door not recorded)";
    byDoor.set(k, (byDoor.get(k) ?? 0) + 1);
  }
  out.push(`  ${after.version} by door: ` +
           [...byDoor].sort().map(([d, n]) => `${d}=${n}`).join(", "));
  return out.join("\n");
}
