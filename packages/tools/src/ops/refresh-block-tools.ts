/**
 * refresh-block-tools — what each of somebody else's tools actually costs us, from the calls
 * we already made.
 *
 *   zz-tool refresh-block-tools
 *   zz-tool refresh-block-tools --psql '<command>' --dry-run
 *
 * WHY THIS IS DERIVED AND NOT WRITTEN BY HAND. the block's two DOCUMENTATION tools -- the ones a caller
 * naturally reaches for to learn how to use casebox properly -- return a very large payload bytes on average
 * (read_api_spec, peak larger still) and a very large payload bytes invariably (read_user_guide) —
 * most of a context window to answer "how do I call this correctly".
 *
 * NEITHER IS A REFUSAL. Both SUCCEED. Nothing is logged as an error, the refusal-based score for
 * that block's usage skill reads clean, and the only symptom is that the caller's context is gone
 * and its later reasoning gets worse for reasons that look like model weakness. A loop that
 * measures only refusals optimises the half it can see.
 *
 * The platform has recorded `bytes` on every call all along, so this is a query rather than an
 * instrumentation project -- and it means the same sweep finds the next expensive tool on the
 * next block without anybody remembering an incident.
 *
 * WHAT IT CANNOT DO. Fix any of it. The block is not ours: we cannot page a response, add a
 * filter argument, or make a guide return one section. The only surface we control is the
 * assistant skill written beside the block, and this table is what that skill is generated from.
 */
import { die, parseArgs } from "../lib/cli.js";
import { DEFAULT_PSQL, psqlRows, psqlText } from "../lib/psql.js";

/** THE VOCABULARY, owned here rather than only in a CHECK constraint, so the words in the schema
 *  and the words in the code cannot drift apart. */
const VERDICTS = ["preferred", "use_with_care", "avoid"] as const;
type Verdict = (typeof VERDICTS)[number];

/** WHERE THE LINES SIT, and why they sit there rather than at round numbers.
 *
 *  `avoid` at 100KB: only a block's two documentation tools sat above it, and both are
 *  catastrophic rather than merely large.
 *  `use_with_care` at 20KB: bookit:list_webhooks (44,716) and core:initiative_status (7,623)
 *  sit either side, and that is the right split -- one is worth thinking about before calling in
 *  a loop, the other is ordinary.
 *
 *  A threshold is a judgement, so it is written down where it can be argued with rather than
 *  buried in a comparison. */
const AVOID_BYTES = 100_000;
const CARE_BYTES = 20_000;

const lit = (s: string): string => `'${String(s ?? "").replace(/'/g, "''")}'`;

interface Row {
  block: string; version: string; tool: string;
  calls: string; avg_bytes: string | null; max_bytes: string | null; max_ms: string | null;
}

function verdictFor(avg: number, max: number): Verdict {
  if (avg >= AVOID_BYTES || max >= AVOID_BYTES * 2) return "avoid";
  if (avg >= CARE_BYTES) return "use_with_care";
  return "preferred";
}

function noteFor(v: Verdict, avg: number, max: number, calls: number): string {
  if (v === "avoid") {
    return `Returns ${Math.round(avg / 1024)}KB on average (peak ${Math.round(max / 1024)}KB) over ` +
      `${calls} calls. It SUCCEEDS, so nothing records a failure — the cost is the caller's ` +
      "context. Answer the question from the tool schemas already in the prompt instead.";
  }
  if (v === "use_with_care") {
    return `Returns ${Math.round(avg / 1024)}KB on average over ${calls} calls. Fine once; ` +
      "expensive in a loop or a retry.";
  }
  return `${Math.round(avg / 1024)}KB average over ${calls} calls.`;
}

function main(argv: string[]): number {
  const args = parseArgs(argv, ["dry-run"]);
  const psql = args.flags.get("psql") || DEFAULT_PSQL;

  // Blocks answer through the gateway, so every call is already attributed to a block version.
  const rows = psqlRows<Row>(psql, `
    select b.name as block, bv.version, split_part(e.subject, ':', 2) as tool,
           count(*)::text as calls,
           round(avg(e.response_bytes))::text as avg_bytes,
           max(e.response_bytes)::text as max_bytes,
           max(e.duration_ms)::text as max_ms
      from zz.event e
      join zz.block_version bv on bv.id = e.block_version_id
      join zz.block b on b.id = bv.block_id
     where e.response_bytes is not null and e.ok is not false and e.subject like '%:%'
     group by 1,2,3`);

  if (!rows.length) {
    console.log("\n  No block call has a recorded size yet. Nothing to say about cost — which is");
    console.log("  different from saying every tool is cheap.\n");
    return 0;
  }

  let changed = 0;
  const loud: string[] = [];
  for (const r of rows) {
    const avg = Number(r.avg_bytes ?? 0), max = Number(r.max_bytes ?? 0), calls = Number(r.calls);
    const v = verdictFor(avg, max);
    if (v !== "preferred") {
      loud.push(`  ${v === "avoid" ? "AVOID        " : "use_with_care"}  ${r.block}:${r.tool}  ` +
        `${Math.round(avg / 1024)}KB avg, ${Math.round(max / 1024)}KB peak, ${calls} calls`);
    }
    if (args.flags.has("dry-run")) continue;
    psqlText(psql, `
      insert into zz.block_tool (block_version_id, name, verdict, observed_bytes_avg,
                                 observed_bytes_max, observed_ms_max, calls_observed, note)
      select bv.id, ${lit(r.tool)}, ${lit(v)}, ${avg}, ${max}, ${Number(r.max_ms ?? 0)}, ${calls},
             ${lit(noteFor(v, avg, max, calls))}
        from zz.block_version bv join zz.block b on b.id = bv.block_id
       where b.name = ${lit(r.block)} and bv.version = ${lit(r.version)}
      on conflict (block_version_id, name) do update set
        verdict = excluded.verdict, observed_bytes_avg = excluded.observed_bytes_avg,
        observed_bytes_max = excluded.observed_bytes_max, observed_ms_max = excluded.observed_ms_max,
        calls_observed = excluded.calls_observed, note = excluded.note`);
    changed++;
  }

  console.log(`\n  ${rows.length} tool(s) measured across the blocks we call.`);
  if (loud.length) {
    console.log("\n  Worth knowing before calling:\n");
    for (const l of loud.sort()) console.log(l);
  } else {
    console.log("  Nothing above the care threshold.");
  }
  console.log(args.flags.has("dry-run")
    ? "\n  --dry-run: nothing written.\n"
    : `\n  ${changed} annotation(s) written to zz.block_tool.\n`);
  if (!rows.length) die("unreachable");
  return 0;
}

try {
  process.exit(main(process.argv.slice(2)));
} catch (err) {
  console.error(String((err as Error)?.message ?? err));
  process.exit(2);
}
