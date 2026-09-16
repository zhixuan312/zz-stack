/**
 * plugin-surface — what a plugin's tool surface did between its last two recorded versions.
 *
 *   zz-tool plugin-surface                 # zz-core, the baseline
 *   zz-tool plugin-surface zz-plugin-eval
 *   zz-tool plugin-surface --psql '<command>'
 *
 * WHY THIS EXISTS AT ALL. `eval_block_surface` was one of six `eval_*` tools on zz-core and
 * went with `zz-skill-eval` and `zz-block-eval` when those flows were removed — so for a while
 * the platform recorded a surface per version that NOTHING read back. A record with no reader
 * is a record nobody can be wrong about, which is comfortable and useless: the surface has been
 * written on every boot and no one could ask it a question.
 *
 * WHAT IT ANSWERS THAT A NAME DIFF CANNOT. zz-core serves two doors out of one process, so a
 * tool can move without the set of names changing by a single element. Ten `plugin_*` tools
 * moved from `/core/mcp` to `/eval/mcp` in this initiative and a name-set diff reports NO
 * CHANGE — the largest surface change this platform has had, reported as nothing at all.
 * Migration 052 records the door beside the name and `diffSurfaces` compares both halves.
 *
 * WHAT IT WILL NOT DO IS GUESS. A version recorded before 052 has no door on any row, and this
 * says so in as many words rather than defaulting those rows to the core door — which would
 * turn every `plugin_*` tool into a fabricated move on the first run. See surface-diff.ts.
 *
 * NOT A JUDGEMENT. It reports what moved; whether a move was right is a question for whoever
 * made it. There is no verdict field here and there should not be one.
 */
import { parseArgs } from "../lib/cli.js";
import { DEFAULT_PSQL, psqlRows } from "../lib/psql.js";
import { diffSurfaces, renderSurfaceChange,
         type RecordedSurface, type RecordedTool, type SurfaceChange } from "../lib/surface-diff.js";

interface VersionRow { version: string; id: string }

const lit = (s: string): string => `'${String(s ?? "").replace(/'/g, "''")}'`;

function main(argv: string[]): number {
  const args = parseArgs(argv);
  const psql = args.flags.get("psql") || DEFAULT_PSQL;
  // zz-core is the baseline every account carries, so it is the default subject. It is the
  // default because it is the surface this repository changes, and the one an operator is
  // asking about when they type this with no argument.
  const plugin = args.positional[0] || "zz-core";

  // THE TWO NEWEST VERSIONS THAT ACTUALLY RECORDED A SURFACE. A zz.plugin_version row exists
  // for every released version, and an older one may have no zz.plugin_tool
  // rows at all — comparing against one of those would report a whole surface DELETED. The
  // join is what makes "the version before" mean "the version before that we measured".
  const versions = psqlRows<VersionRow>(psql, `
    select bv.version, bv.id::text as id
      from zz.plugin_version bv
      join zz.plugin b on b.id = bv.plugin_id
     where b.name = ${lit(plugin)}
       and exists (select 1 from zz.plugin_tool t where t.plugin_version_id = bv.id)
     order by bv.first_seen_at desc
     limit 2`);

  if (!versions.length) {
    console.log(`\n  No recorded surface for ${plugin}. That is "nobody measured it", not`);
    console.log("  \"it serves nothing\" — the two look identical from here and only one of them");
    console.log("  is a fact about the plugin.\n");
    return 0;
  }

  const surfaceOf = (v: VersionRow): RecordedSurface => ({
    version: v.version,
    // `RecordedTool` IS THE ROW SHAPE, not a local copy of it. A second interface with the
    // same two fields is where `door` eventually goes missing from one of them.
    tools: psqlRows<RecordedTool>(psql, `
      select name, door from zz.plugin_tool
       where plugin_version_id = ${lit(v.id)}::uuid
       order by name`),
  });

  const after = surfaceOf(versions[0]);
  if (versions.length === 1) {
    const doors = new Map<string, number>();
    for (const t of after.tools) doors.set(t.door ?? "(door not recorded)",
                                           (doors.get(t.door ?? "(door not recorded)") ?? 0) + 1);
    console.log(`\n  ${plugin} ${after.version}: ${after.tools.length} tool(s), ` +
                `${[...doors].sort().map(([d, n]) => `${d}=${n}`).join(", ")}`);
    console.log("\n  Only one version has a recorded surface, so there is nothing to diff it");
    console.log("  against. The next recorded version is the first one this can answer for.\n");
    return 0;
  }

  const before = surfaceOf(versions[1]);
  const change: SurfaceChange = diffSurfaces(before, after);
  console.log(renderSurfaceChange(plugin, before, after, change));
  console.log("");
  return 0;
}

try {
  process.exit(main(process.argv.slice(2)));
} catch (err) {
  console.error(String((err as Error)?.message ?? err));
  process.exit(2);
}
