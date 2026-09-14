// Opening is explicit, dated by the platform, and freeform is a first-class answer.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
const fail = [];
const acts = readFileSync("services/zz-core/src/tools/initiative-acts.ts", "utf8");
const status = readFileSync("services/zz-core/src/tools/initiative-status.ts", "utf8");

if (!/registerTool\(\s*\n?\s*"initiative_open"/.test(acts)) fail.push("initiative_open is not registered");
// The date comes from the platform.
if (!/isoToday|today/.test(acts)) fail.push("initiative_open does not stamp the platform's date");
// A missing flow must NOT be refused — freeform is a choice, not an omission.
if (/flow[^\n]*required|must provide a flow|refus[^\n]*missing flow/i.test(acts)) {
  fail.push("initiative_open refuses a missing flow; freeform is first-class");
}
// Freeform status answers null rather than guessing.
if (!/next_move[^\n]*null|null[^\n]*next_move/.test(status)) {
  fail.push("initiative_status does not return next_move: null for a freeform initiative");
}
// The three guards moved off the write path rather than being duplicated onto both.
const arts = readFileSync("services/zz-core/src/tools/artifacts.ts", "utf8");
if (/initiativeNameShape|initiativeNameTaken/.test(arts)) {
  fail.push("artifacts.ts still creates initiatives; opening must be the only path");
}
// Control: document_write must still REFUSE an unopened initiative, or the guard was
// simply deleted rather than moved.
if (!/not been opened|never opened|initiative_open/.test(arts)) {
  fail.push("document_write does not refuse an unopened initiative");
}
// No adopt-a-flow tool exists.
const walk = (d) => readdirSync(d).flatMap((f) => {
  const p = join(d, f);
  return statSync(p).isDirectory() ? (f === "dist" ? [] : walk(p)) : [p];
});
for (const p of walk("services/zz-core/src")) {
  if (/registerTool\(\s*\n?\s*"initiative_adopt"/.test(readFileSync(p, "utf8"))) {
    fail.push("an adopt-a-flow tool exists; FR-30 forbids one");
  }
}
if (fail.length) { console.error(fail.join("\n")); process.exit(1); }
console.log("initiative_open: ok");
