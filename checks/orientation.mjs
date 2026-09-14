// Every door introduces itself, and the pointer survives for a client that never reads it.
import { readFileSync } from "node:fs";
const fail = [];
const core = readFileSync("services/zz-core/src/server.ts", "utf8");
const door = readFileSync("services/gateway/src/access-door.ts", "utf8");

for (const [name, src] of [["zz-core", core], ["access-door", door]]) {
  const m = src.match(/instructions\s*:\s*([`"'])([\s\S]*?)\1/);
  if (!m) { fail.push(`${name} declares no instructions`); continue; }
  const text = m[2];
  if (Buffer.byteLength(text) > 2000) fail.push(`${name} instructions exceed 2KB`);
  if (text.trim().length < 80) fail.push(`${name} instructions are too thin to orient anyone`);
  if (!/zz-platform/.test(text)) fail.push(`${name} instructions do not name zz-platform`);
}
// Control: the payload pointer must SURVIVE. instructions is an addition, not a replacement,
// because a binding target never reads it.
const skills = readFileSync("services/zz-core/src/tools/skills.ts", "utf8");
if (!/how_this_works/.test(skills)) {
  fail.push("how_this_works was removed; Claude Desktop never reads instructions");
}
// The three identity tools each say what only they answer.
const admin = readFileSync("services/gateway/src/admin.ts", "utf8");
if (!/session_whoami/.test(skills)) fail.push("session_whoami is not registered");
for (const [src, tool] of [[admin, "whoami"], [door, "my_teams"]]) {
  if (!src.includes(`"${tool}"`)) fail.push(`${tool} is missing from its door`);
}
if (fail.length) { console.error(fail.join("\n")); process.exit(1); }
console.log("orientation: ok");
