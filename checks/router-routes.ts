#!/usr/bin/env node
/**
 * zz-router loads a flow the router is meant to load, and names how a person opens one they open.
 *
 * The router is generated per person from the shelf (`routerSkill(shelfFlows())`). It told the
 * model to `skill_read` every installed flow's entry, zz-plugin-eval included — a flow a person
 * opens themselves, by name. A manifest now says so with `routed: false`, and the router names
 * how to open it in each client instead of loading the skill.
 *
 * Driven over the real catalog:
 *   1. sdlc-flow, routed, is loaded: `skill_read` passing its entry;
 *   2. zz-plugin-eval, `routed: false`, is not: its section names `/zz-plugin-eval:eval` for
 *      Claude Code and `$zz-plugin-eval:eval` for Codex, and asks for no `skill_read` of its entry.
 *
 * Run: node checks/router-routes.ts   (also run by scripts/gate.ts)
 */
import { join } from "node:path";
import { pathToFileURL } from "node:url";

process.env.ZZ_CATALOG_DIR = join(process.cwd(), "catalog");

const fail: string[] = [];
const is = (cond: unknown, why: string) => { if (!cond) fail.push(why); };

const { routerSkill, shelfFlows } = await import(
  pathToFileURL(join(process.cwd(), "services/gateway/dist/package/skills.js")).href);
const flows = shelfFlows() as { flow: string; routed: boolean; command: string | null }[];
const md: string = routerSkill(flows);
/** One flow's section of the router, from its heading to the next. */
const section = (flow: string): string => {
  const at = md.indexOf(`### ${flow}`);
  if (at < 0) return "";
  const next = md.indexOf("\n### ", at + 1);
  const end = md.indexOf("\n## ", at + 1);
  const stop = [next, end].filter((x) => x > 0).sort((a, b) => a - b)[0] ?? md.length;
  return md.slice(at, stop);
};

const sdlc = section("sdlc-flow");
is(flows.find((f) => f.flow === "sdlc-flow")?.routed === true, "sdlc-flow is not routed");
is(/skill_read/.test(sdlc) && /passing `sdlc-flow`/.test(sdlc),
   `the router does not load sdlc-flow: ${JSON.stringify(sdlc.slice(0, 300))}`);

const evalFlow = flows.find((f) => f.flow === "zz-plugin-eval");
const ev = section("zz-plugin-eval");
is(evalFlow?.routed === false && evalFlow?.command === "eval",
   `zz-plugin-eval is ${JSON.stringify(evalFlow)} — it is opened by name, not routed`);
is(ev.includes("`/zz-plugin-eval:eval` in Claude Code") && ev.includes("`$zz-plugin-eval:eval` in Codex")
   && !/passing `zz-plugin-eval`/.test(ev),
   `the router loads zz-plugin-eval instead of naming how to open it: ${JSON.stringify(ev.slice(0, 400))}`);

if (fail.length) { console.error(fail.join("\n")); process.exit(1); }
console.log("ok router-routes");
