/**
 * plugin-surface — what a plugin's tool surface did between its last two recorded versions.
 *
 *   zz-tool plugin-surface                 # zz-core, the baseline
 *   zz-tool plugin-surface zz-plugin-eval
 *   zz-tool plugin-surface --psql '<command>'
 *
 * What it answers that a name diff cannot: zz-core serves two doors out of one process, so a tool
 * can move without the set of names changing by a single element. `zz.plugin_tool.door` records
 * the door beside the name, and `diffSurfaces` compares both halves.
 *
 * It will not guess. A version whose doors were never recorded has none on any row, and this says
 * so rather than defaulting those rows to the core door, which would turn every `plugin_*` tool into a
 * fabricated move on the first run. See surface-diff.ts.
 *
 * Not a judgement: it reports what moved, and there is no verdict field.
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
  // zz-core is the baseline every account carries, so it is the default subject: it is the surface
  // this repository changes, and the one an operator is asking about when they type this with no
  // argument.
  const plugin = args.positional[0] || "zz-core";

  // The two newest versions that actually recorded a surface. A zz.plugin_version row exists for
  // every released version, and an older one may have no zz.plugin_tool rows at all — comparing
  // against one of those reports a whole surface deleted. The join is what makes "the version
  // before" mean "the version before that we measured".
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
    // `RecordedTool` is the row shape, not a local copy of it: a second interface with the same two
    // fields is where `door` eventually goes missing from one of them.
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
