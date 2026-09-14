// Seven skills move, their commands follow, and none is left behind or duplicated.
import { readFileSync, existsSync, readdirSync } from "node:fs";
const fail = [];
const expect = {
  "catalog/zz/zz-core":        ["zz-platform", "zz-handover", "zz-deck", "zz-tldr", "zz-breakout", "zz-authoring"],
  "catalog/zz/zz-access":      ["zz-access", "zz-admin", "zz-doctor", "zz-update", "zz-migrate"],
};
const gone = {
  "catalog/sdlc/sdlc-flow":    ["sdlc-deck", "sdlc-tldr", "sdlc-breakout", "sdlc-authoring"],
};
const seen = new Map();
for (const [dir, want] of Object.entries(expect)) {
  const have = existsSync(`${dir}/skills`) ? readdirSync(`${dir}/skills`) : [];
  for (const s of want) if (!have.includes(s)) fail.push(`${dir} does not ship ${s}`);
  for (const s of have) {
    if (seen.has(s)) fail.push(`${s} exists in both ${seen.get(s)} and ${dir}`);
    seen.set(s, dir);
  }
}
for (const [dir, must] of Object.entries(gone)) {
  const have = existsSync(`${dir}/skills`) ? readdirSync(`${dir}/skills`) : [];
  for (const s of must) if (have.includes(s)) fail.push(`${dir} still ships ${s}`);
}
// zz-core gains commands; zz-authoring is a library, not one.
const core = JSON.parse(readFileSync("catalog/zz/zz-core/flow.json", "utf8"));
for (const c of ["deck", "tldr", "breakout"]) {
  if (!core.commands?.[c]) fail.push(`zz-core does not declare the ${c} command`);
}
if (core.commands?.authoring) fail.push("zz-authoring is a library and must not be a command");
if (!(core.libraries || []).includes("zz-authoring")) fail.push("zz-authoring is not declared a library");
// Control: the deck's supporting files travelled with it.
for (const f of ["deck-chassis.html", "deck-guidebook.html"]) {
  if (!existsSync(`catalog/zz/zz-core/skills/zz-deck/${f}`)) fail.push(`zz-deck lost ${f}`);
}
if (fail.length) { console.error(fail.join("\n")); process.exit(1); }
console.log("skill homes: ok");
