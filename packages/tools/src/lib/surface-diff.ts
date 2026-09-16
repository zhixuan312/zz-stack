/**
 * What changed between two recorded tool surfaces — INCLUDING a tool that stayed and moved.
 *
 * A surface used to be a set of names, and a diff of two sets could answer exactly two things:
 * a name arrived, a name left. That is the whole truth for a block with one door. It stopped
 * being the truth about this platform the day zz-core grew a second door: ten `plugin_*` tools
 * moved from `/core/mcp` to `/eval/mcp` — the largest change this platform's tool surface has
 * had — and NOT ONE NAME CHANGED. A name-set diff answers NO CHANGE, which is not silence: it
 * is a confident wrong answer in the one direction nobody re-checks, because "nothing moved"
 * is what an instrument says when it is working and there was nothing to find.
 *
 * Migration 052 added `zz.block_tool.door`, recorded by `recordingDoor` at the moment each tool
 * is registered. This is the half that READS it.
 *
 * ── NULL IS NOT A DOOR, AND IT IS ESPECIALLY NOT THE CORE DOOR ─────────────────────────────
 *
 * Every row written before 052 has `door` null, and so does every row the old block probe
 * derives for somebody else's block. The tempting shortcut is `door ?? "core"` — it makes the
 * first diff after 052 read beautifully, and it invents ten moves that never happened, because
 * the `plugin_*` tools recorded before 052 would then be claimed to have started on the core
 * door and moved. That is the SAME failure as NO CHANGE with the sign flipped: a fabricated
 * finding rather than a missed one, and this module exists to stop making the first kind.
 *
 * So a name present on both sides with a door known on only one side is UNDECIDABLE and is
 * reported as such. It is not a move, it is not "unchanged", and it is not dropped — the
 * report names the version whose doors were never recorded, which is a fact an operator can
 * act on (wait for the next release) rather than a number they have to trust.
 *
 * PURE, AND SEPARATE FROM THE OP THAT PRINTS IT, for one concrete reason: every op in this
 * package calls `process.exit` at module scope, so importing one to test its logic ends the
 * importing process. checks/eval-door.ts drives the functions below over a synthetic before
 * and after, which is what proves a move is reported AS a move rather than that a query ran.
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
  /** Did that side record a door for ANY of its tools? False means "recorded before 052". */
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
    // BOTH SIDES OR NEITHER. `was === null || door === null` is the undecidable case and it is
    // tested BEFORE the comparison, because `null !== "eval"` is true and would otherwise read
    // as a move out of a door nothing ever recorded.
    if (was === null || door === null) { change.undecidable.push({ name, door }); continue; }
    if (was === door) change.stayed.push({ name, door });
    else change.moved.push({ name, from: was, to: door });
  }
  for (const [name, door] of [...b].sort()) {
    if (!a.has(name)) change.removed.push({ name, door });
  }
  return change;
}

/** The report, as the lines an operator reads.
 *
 * THE HEADLINE IS THE MOVES, because that is the sentence that used to be missing. A diff whose
 * first line is "0 added, 0 removed" over a release that moved ten tools is how this instrument
 * was wrong before, so when nothing moved and nothing could have been known to move, this says
 * which of those two it is rather than printing the same line for both. */
export function renderSurfaceChange(block: string, before: RecordedSurface,
                                    after: RecordedSurface, c: SurfaceChange): string {
  const out: string[] = [];
  out.push(`\n  ${block}: ${before.version} → ${after.version} ` +
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

  // THE HONEST NON-ANSWER, said at the same volume as a finding. An operator who reads "no
  // tool changed door" when half the comparison could not be made has been told something
  // false by a report that was technically silent.
  if (c.undecidable.length) {
    const missing = !c.doorsRecorded.before ? before.version
                  : !c.doorsRecorded.after ? after.version : "one of these versions";
    out.push(`  DOORS NOT COMPARABLE for ${c.undecidable.length} tool(s): ${missing} recorded ` +
             "no door for them, so whether they moved is NOT KNOWN — not 'they did not move'. " +
             "Rows written before migration 052 carry no door and none is invented for them.");
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
