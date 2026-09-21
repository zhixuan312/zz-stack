import { readFileSync } from "node:fs";
import { join } from "node:path";
import { root } from "../read.ts";
import { check } from "../run.ts";

const CLASSES = new Set(["platform", "flow_controller", "convention", "analytical_review"]);

check("every enforcement claim in the rule registry names a handler and a behavioural test", () => {
  const p = join(root, "catalog/sdlc/sdlc-flow/rules.json");
  let entries: Array<Record<string, string>>;
  try { entries = JSON.parse(readFileSync(p, "utf8")).rules; }
  catch { return "catalog/sdlc/sdlc-flow/rules.json is missing — every guarantee the skills claim rests on prose"; }
  const bad: string[] = [];
  for (const e of entries) {
    if (!CLASSES.has(e.enforcement_class)) { bad.push(`${e.rule_id} has enforcement_class ${e.enforcement_class}`); continue; }
    if (e.enforcement_class === "convention" || e.enforcement_class === "analytical_review") {
      if (!e.verified_by) bad.push(`${e.rule_id} is a ${e.enforcement_class} and names no reader who owns verification`);
      continue;
    }
    if (!e.handler) bad.push(`${e.rule_id} claims ${e.enforcement_class} enforcement and names no handler`);
    if (!e.behavioural_test) bad.push(`${e.rule_id} claims ${e.enforcement_class} enforcement and names no behavioural test`);
  }
  const nodes = entries.find((e) => e.rule_id === "handover.proposed_team_nodes");
  if (nodes && nodes.enforcement_class !== "convention") {
    bad.push("handover.proposed_team_nodes is classed as enforced, but nothing reads the field back");
  }
  return bad.length ? bad.slice(0, 10).join("; ") : undefined;
});
