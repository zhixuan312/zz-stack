#!/usr/bin/env node
/**
 * checks/knowledge-search-empty-cause.ts — an empty `knowledge_search` names the cause a caller can
 * act on before the general verdict.
 *
 *   node checks/knowledge-search-empty-cause.ts   # needs Docker and a built tree (`npm run build`)
 *
 * It starts a throwaway PostgreSQL and a real zz-core on it (`withThrowawayCore`), records lessons
 * through the door and asks `knowledge_search` as the seeded team's admin. What it establishes:
 *
 *   - a query matching only a superseded lesson, asked of current lessons, says that superseded
 *     lessons match and how to read them, ahead of the shelf's language note;
 *   - a filter value that names nothing (an initiative, a status) says the filters selected no row,
 *     rather than "No match for <query>";
 *   - a Han query finds a lesson written in Han.
 *
 * The only database it touches is the one it started.
 *
 * Exit 0: every case held — one line per case, then the final line.
 * Exit 1: a case failed — the case and what was found.
 * Exit 2: Docker is not available — the check could not run, and that is not a pass.
 */
import { withThrowawayCore, type Core } from "../scripts/schema/throwaway-core.ts";

const NAME = "knowledge-search-empty-cause";
const DONE = "knowledge-search-empty-cause: an empty knowledge_search names superseded matches and filters that " +
  "select nothing, and a Han query finds a Han lesson: ok";

type Answer = { note?: string; results: { path?: string }[] };

async function search(c: Core, step: string, args: Record<string, unknown>): Promise<Answer> {
  const reply = await c.ok(step, "knowledge_search", args);
  try {
    return JSON.parse(reply) as Answer;
  } catch {
    return c.fail(step, `reply was not JSON: ${reply}`);
  }
}

const idOf = (reply: string): string => /\b(\d{4,})\b/.exec(reply)?.[1] ?? "";

async function run(c: Core): Promise<void> {
  const initiative = await c.open("empty-cause");
  const lesson = (title: string, body: string) => c.ok(`record ${title}`, "knowledge_add", {
    title, type: "decision", scope: "team", evidence: [initiative], body });
  const old = idOf(await lesson("Retry ceiling", "Payment retries stop after the quokka ceiling of five."));
  const replacement = idOf(await lesson("Retry ceiling, revised", "Payment retries stop after three attempts."));
  await c.ok("supersede the first lesson", "knowledge_supersede", { old_id: old, new_id: replacement });
  await lesson("支付重试", "支付重试在三次之后停止。");

  const superseded = await search(c, "a superseded match", { query: "quokka", include_superseded: false });
  if (superseded.results.length || !/^1 superseded row\(s\) match/.test(superseded.note ?? "")
      || !/include_superseded: true/.test(superseded.note ?? "")) {
    c.fail("a superseded match", `answered ${JSON.stringify(superseded).slice(0, 400)}`);
  }
  c.pass("a query matching only a superseded lesson names it before the language note");

  for (const filter of [{ initiative: "no-such-initiative" }, { status: "bogus" }]) {
    const empty = await search(c, `filter ${JSON.stringify(filter)}`, { query: "retries", ...filter });
    if (empty.results.length || !/^The filters .* select no row/.test(empty.note ?? "") || /No match for/.test(empty.note ?? "")) {
      c.fail(`filter ${JSON.stringify(filter)}`, `answered ${JSON.stringify(empty).slice(0, 400)}`);
    }
  }
  c.pass("a filter value that names nothing says the filters selected no row");

  const han = await search(c, "a Han query", { query: "支付重试" });
  if (!han.results.some((r) => /^nodes\/\d+-/.test(String(r.path)))) {
    c.fail("a Han query", `answered ${JSON.stringify(han).slice(0, 400)}`);
  }
  c.pass("a Han query finds a lesson written in Han");
}

process.exitCode = await withThrowawayCore(NAME, DONE, run);
