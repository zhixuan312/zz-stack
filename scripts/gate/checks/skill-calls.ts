/**
 * A skill's written tool call against the tool's real contract. skill-tools.ts proves the tool
 * exists; this proves the call a skill teaches would be accepted: every argument it names is in
 * that tool's zod `inputSchema`, and every argument the schema requires is named.
 *
 * The failure it exists for: a skill that tells an agent to pass an argument no tool returns, or
 * leaves out one the tool refuses without, reads as a complete instruction and fails as a
 * validation error mid-stage — the agent then improvises the missing value.
 *
 * Only this platform's tools are judged — zz-core's two doors and the gateway's /manage — read
 * from source the way skill-tools.ts reads registrations, because the gate runs before `tsc -b`
 * has necessarily produced anything.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { firstOf, root, sourceFiles, toolsIn } from "../read.ts";
import { check, note } from "../run.ts";

/** One tool's arguments as its source declares them: name -> required. `open` is a schema this
 *  cannot enumerate (a spread or a shape built elsewhere), whose argument names are not judged. */
interface ToolSchema { fields: Map<string, boolean>; open: boolean }

const OPENERS: Record<string, string> = { "(": ")", "[": "]", "{": "}" };

/** Source strings take all three quotes and comments are skipped. A skill's prose takes only
 *  `"`: an apostrophe in a placeholder (`<the plugin's id>`) is not a string, and a backtick
 *  closes the inline code the call sits in. */
type Lang = "ts" | "md";

/** If a string or a comment starts at `i`, the index of its last character; otherwise `i`. */
function skipped(text: string, i: number, lang: Lang): number {
  const c = text[i];
  if (lang === "ts" && c === "/" && text[i + 1] === "/") {
    const nl = text.indexOf("\n", i);
    return nl < 0 ? text.length : nl - 1;
  }
  if (lang === "ts" && c === "/" && text[i + 1] === "*") {
    const close = text.indexOf("*/", i + 2);
    return close < 0 ? text.length : close + 1;
  }
  if (c === '"' || (lang === "ts" && (c === "'" || c === "`"))) {
    let j = i + 1;
    for (; j < text.length && text[j] !== c; j++) if (text[j] === "\\") j++;
    return j;
  }
  return i;
}

/** The index of the bracket closing the one at `at`, or -1. */
function closeOf(src: string, at: number, lang: Lang): number {
  const stack: string[] = [];
  for (let i = at; i < src.length; i++) {
    const past = skipped(src, i, lang);
    if (past !== i) { i = past; continue; }
    const c = src[i];
    if (OPENERS[c]) stack.push(OPENERS[c]);
    else if (c === ")" || c === "]" || c === "}") {
      if (stack.pop() !== c) return -1;
      if (!stack.length) return i;
    }
  }
  return -1;
}

/** `text` cut at its top-level commas. A skill's also groups `<...>`, its placeholder. */
function topLevel(text: string, lang: Lang): string[] {
  const parts: string[] = [];
  let depth = 0, from = 0;
  const angle = lang === "md";
  for (let i = 0; i < text.length; i++) {
    const past = skipped(text, i, lang);
    if (past !== i) { i = past; continue; }
    const c = text[i];
    if (c === "(" || c === "[" || c === "{" || (angle && c === "<" && /[A-Za-z{/]/.test(text[i + 1] ?? ""))) depth++;
    else if (c === ")" || c === "]" || c === "}" || (angle && c === ">" && depth > 0)) depth--;
    else if (c === "," && depth === 0) { parts.push(text.slice(from, i)); from = i + 1; }
  }
  parts.push(text.slice(from));
  return parts.map((p) => p.trim()).filter(Boolean);
}

/** An argument's text before its top-level `:` — the whole of it when it has none. */
function nameOf(arg: string): string {
  let depth = 0;
  for (let i = 0; i < arg.length; i++) {
    const c = arg[i];
    if ("([{<".includes(c)) depth++;
    else if (")]}>".includes(c)) depth--;
    else if (c === ":" && depth === 0) return arg.slice(0, i);
  }
  return arg;
}

/** The text of `entry` with everything inside brackets removed, so `.optional()` read here is
 *  the field's own and never a nested object's. */
function surface(entry: string): string {
  let out = "", depth = 0;
  for (let i = 0; i < entry.length; i++) {
    const past = skipped(entry, i, "ts");
    if (past !== i) { i = past; continue; }
    const c = entry[i];
    if (c === "(" || c === "[" || c === "{") { if (depth++ === 0) out += c; continue; }
    if (c === ")" || c === "]" || c === "}") { if (--depth === 0) out += c; continue; }
    if (depth === 0) out += c;
  }
  return out;
}

let occurrences = 0, closed = 0;
const schemas = new Map<string, ToolSchema>();
for (const rel of [...sourceFiles(["services/zz-core/src"], [".ts"]), ...sourceFiles(["services/gateway/src"], [".ts"])]) {
  for (const tool of toolsIn(readFileSync(join(root, rel), "utf8"))) {
    const at = /inputSchema:\s*/.exec(tool.body);
    if (!at) { schemas.set(tool.name, { fields: new Map(), open: false }); continue; }
    occurrences++;
    const open = at.index + at[0].length;
    if (tool.body[open] !== "{") { closed++; schemas.set(tool.name, { fields: new Map(), open: true }); continue; }
    const end = closeOf(tool.body, open, "ts");
    if (end < 0) continue;   // counted as not closed, reported by the check
    closed++;
    const schema: ToolSchema = { fields: new Map(), open: false };
    for (const raw of topLevel(tool.body.slice(open + 1, end), "ts")) {
      // A field's leading comment is not part of its name.
      const entry = raw.replace(/^(?:\s*(?:\/\/[^\n]*\n|\/\*[\s\S]*?\*\/))*\s*/, "");
      const m = /^([a-z][a-z0-9_]*)\s*(:?)/.exec(entry);
      if (!m || !m[2]) { schema.open = true; continue; }   // a spread or a shorthand: not enumerable here
      schema.fields.set(m[1], !/\.optional\(|\.default\(|\.nullish\(|z\.optional\(/.test(surface(entry)));
    }
    schemas.set(tool.name, schema);
  }
}

check("every tool call a skill writes names only the tool's arguments, and every one it requires", () => {
  if (schemas.size < 60) return `only ${schemas.size} tool registrations were read — the extraction is broken`;
  if (closed < occurrences) {
    return `${occurrences - closed} of ${occurrences} inputSchema blocks could not be read, so their ` +
           "arguments are unknown and every call to those tools would be misjudged";
  }
  const bad: string[] = [];
  let calls = 0, full = 0;
  for (const rel of sourceFiles(["catalog", "skills"], ["SKILL.md"])) {
    const txt = readFileSync(join(root, rel), "utf8");
    // A call is the tool's name immediately followed by `(` — `tool (` and `tool` alone are prose.
    for (const m of txt.matchAll(/\b([a-z][a-z0-9]*(?:_[a-z0-9]+)+)\(/g)) {
      const schema = schemas.get(m[1]);
      if (!schema) continue;
      const line = txt.slice(0, m.index).split("\n").length;
      const where = `${rel}:${line} ${m[1]}()`;
      const open = m.index + m[0].length - 1;
      const end = closeOf(txt, open, "md");
      if (end < 0 || end - open > 1200) { bad.push(`${where} opens a call that never closes`); continue; }
      // `tool()` is how a skill names a tool in a sentence ("one `initiative_close()` call"),
      // not a call it teaches; a call that means "the rest" writes `tool(skip: true, ...)`.
      if (!txt.slice(open + 1, end).trim()) continue;
      calls++;
      // Each argument is a name, `name: value`, `name?` (optional), `name[]`, or `a | b` (one of);
      // a quoted or `<placeholder>` value is positional and `...` stands for the rest, so either
      // one leaves the required set unjudged — the names that are written are still checked.
      let partial = false;
      const named: { names: string[]; optional: boolean }[] = [];
      for (const arg of topLevel(txt.slice(open + 1, end), "md")) {
        if (/^(\.\.\.|…)$/.test(arg)) { partial = true; continue; }
        const names = nameOf(arg).split("|").map((n) => n.trim().replace(/\[\]$/, ""));
        if (!names.every((n) => /^[a-z][a-z0-9_]*\??$/.test(n))) { partial = true; continue; }
        named.push({ names: names.map((n) => n.replace(/\?$/, "")), optional: names.some((n) => n.endsWith("?")) });
      }
      if (!schema.open) {
        for (const n of named.flatMap((g) => g.names)) {
          if (!schema.fields.has(n)) bad.push(`${where} passes \`${n}\`, which ${m[1]} does not take`);
        }
      }
      for (const g of named) {
        if (g.optional && g.names.length === 1 && schema.fields.get(g.names[0])) {
          bad.push(`${where} marks \`${g.names[0]}\` optional, and ${m[1]} requires it`);
        }
      }
      if (partial) continue;
      full++;
      const given = new Set(named.flatMap((g) => g.names));
      for (const [field, required] of schema.fields) {
        if (required && !given.has(field)) bad.push(`${where} leaves out \`${field}\`, which ${m[1]} requires`);
      }
    }
  }
  note(`      ${calls} tool calls in skills checked against ${schemas.size} registrations; ` +
       `${full} named every argument, ${calls - full} are positional or end in ... and had their names checked`);
  return firstOf(bad, 40);
});
