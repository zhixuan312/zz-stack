// The three verification stages leave a document, and keep their independence.
import { readFileSync } from "node:fs";
const fail = [];
const skills = {
  "sdlc-spec-audit": "spec-audit.md",
  "sdlc-plan-audit": "plan-audit.md",
  "sdlc-review": "review.md",
};
for (const [skill, doc] of Object.entries(skills)) {
  const p = `catalog/sdlc/sdlc-flow/skills/${skill}/SKILL.md`;
  const body = readFileSync(p, "utf8");
  if (!body.includes(doc)) fail.push(`${skill} does not name ${doc}`);
  if (!/document_write/.test(body)) fail.push(`${skill} does not write its document`);
  if (/you write no file|write no file/i.test(body)) fail.push(`${skill} still says it writes no file`);
  // Control: independence must SURVIVE. A rewrite that dropped it would pass the above.
  if (skill === "sdlc-review" && !/did not write/i.test(body)) {
    fail.push("sdlc-review lost the reviewer-did-not-write-this-code discipline");
  }
  if (!/read-only|do not.*(edit|fix)/i.test(body)) {
    fail.push(`${skill} lost its read-only discipline`);
  }
}
if (fail.length) { console.error(fail.join("\n")); process.exit(1); }
console.log("verification stages write: ok");
