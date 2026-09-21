import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { root } from "../read.ts";
import { check } from "../run.ts";

const REQUIRED = ["outcome", "required evidence", "allowed unknowns", "work roles",
                  "checkpoint", "exit path", "degraded"];
const LEAKS = [/typesafe/i, /\bjev\b/i, /\bnoul\b/i, /ollama/i, /api[._-]?key/i,
               /https?:\/\/[a-z]/i, /TaskStop/, /\bAgent\(/];

check("no sdlc skill names a provider, a credential or a harness-specific call", () => {
  const dir = join(root, "catalog/sdlc/sdlc-flow/skills");
  const skills = readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory());
  if (skills.length !== 13) return `found ${skills.length} sdlc skills, not 13`;
  const bad: string[] = [];
  for (const s of skills) {
    const text = readFileSync(join(dir, s.name, "SKILL.md"), "utf8");
    for (const re of LEAKS) {
      if (re.test(text)) bad.push(`${s.name} matches ${re} — substitution would mean editing this skill`);
    }
    for (const d of REQUIRED) {
      if (!text.toLowerCase().includes(d)) bad.push(`${s.name} declares no ${d}`);
    }
  }
  return bad.length ? bad.slice(0, 10).join("; ") : undefined;
});
