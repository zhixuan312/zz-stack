// The standard names what the spec fixes: five questions, six classes, twelve numbered rules in
// their own section, both comment templates each carrying every mandatory token, and the one
// inventory. Sections are found by their exact headings, and each template by the line that opens
// with `COMMENT ON <kind>` — the contract fixes both, one template per line, as the spec prints them.
import { readFileSync } from "node:fs";

const doc = readFileSync("SCHEMA.md", "utf8");
const fail: string[] = [];
const section = (heading: string): string => {
  const lines = doc.split("\n");
  const start = lines.findIndex((l) => l.trim() === `## ${heading}`);
  if (start < 0) { fail.push(`no section headed "## ${heading}"`); return ""; }
  const end = lines.findIndex((l, i) => i > start && /^## /.test(l));
  return lines.slice(start + 1, end < 0 ? undefined : end).join("\n");
};
const numbered = (text: string): number[] => [...text.matchAll(/^(\d+)\. /gm)].map((m) => Number(m[1]));

const questions = section("The five questions");
if (numbered(questions).join(",") !== "1,2,3,4,5") fail.push(`the questions are numbered ${numbered(questions).join(",") || "nothing"}, not 1-5`);
for (const q of ["Fact", "Authority", "Class", "Reconstruction", "Asker"]) {
  if (!questions.includes(q)) fail.push(`question ${q} is not named`);
}
const classes = section("The six classes");
for (const cls of ["current_state", "immutable_history", "state_machine", "relation", "ephemeral", "projection"]) {
  if (!classes.includes(`\`${cls}\``)) fail.push(`class ${cls} is not named in the classes section`);
}
const rules = numbered(section("The twelve rules"));
if (rules.join(",") !== "1,2,3,4,5,6,7,8,9,10,11,12") fail.push(`the rules are numbered ${rules.join(",") || "nothing"}, not 1-12`);
const contract = section("The comment contract");
for (const kind of ["TABLE", "COLUMN"]) {
  const template = contract.split("\n").find((l) => l.trimStart().startsWith(`COMMENT ON ${kind}`));
  if (!template) { fail.push(`the comment contract has no COMMENT ON ${kind} template`); continue; }
  for (const t of ["class=", "authority=", "question=", "rebuilt_from="]) {
    if (!template.includes(t)) fail.push(`the COMMENT ON ${kind} template does not carry ${t}`);
  }
}
const table = contract.split("\n").find((l) => l.trimStart().startsWith("COMMENT ON TABLE")) ?? "";
for (const t of ["transitions=", "retention="]) {
  if (!table.includes(t)) fail.push(`the COMMENT ON TABLE template does not carry ${t}`);
}
if (!doc.includes("schema-target.ts")) fail.push("the inventory file is not named");
if (/[一-鿿]/.test(doc)) fail.push("the standard is not English only");
if (fail.length) { console.error(fail.join("\n")); process.exit(1); }
console.log("schema standard: ok");
