// A door introduces itself in the handshake, and the pointer survives for a client that
// never reads it.
//
// This check opens a real client against a real server. `coreServer`, `buildEvalServer` and
// `buildAccessServer` are the functions the services mount; they are imported from dist and
// run, an `InMemoryTransport` pair carries a real `initialize` and `tools/list`, and every
// assertion is made against what that client received. `session_whoami` is called, not read.
//
// The nouns are derived, never listed here: the prefix set comes out of `tools/list` on the
// live door and is compared with the instructions text in both directions — a tool group that
// arrives unannounced is red, and a group named in the text that no longer exists is red.
//
// DELIBERATE: that clause applies only to the noun-first doors, core and evaluation.
// COUPLED: /manage's shape is checks/manage-surface.ts's subject, so its instructions are held
// here to length, a self-contained first 512 naming its orientation skill, and a `NOT FOR:`
// line. Each door's orientation skill is derived and they differ: the core door's from the
// live `how_this_works` payload, the others' from the catalog manifest that mounts them.
//
// This check cannot judge whether the prose is any good. "Says when NOT to reach for this
// door" is asserted as the structural marker `NOT FOR:` and nothing more.
import { existsSync, readFileSync, readdirSync } from "node:fs";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/** A caught value is never typed as an Error — narrow the shape actually being read rather
 *  than assume it. `unknown?.message` narrows to `{}`, which has no properties at all. */
function errMessage(err: unknown): string {
  if (err && typeof err === "object" && "message" in err) {
    const m = (err as Record<string, unknown>).message;
    if (m !== undefined && m !== null) return String(m);
  }
  return String(err);
}

/** The SDK types a tool result's `content` as `unknown` — narrow to the one field this check
 *  reads, the first block's `text`, rather than assume the shape. */
function firstToolText(content: unknown): string {
  if (!Array.isArray(content) || content.length === 0) return "{}";
  const first: unknown = content[0];
  if (first && typeof first === "object" && "text" in first) {
    const t = (first as Record<string, unknown>).text;
    if (typeof t === "string") return t;
  }
  return "{}";
}

const fail: string[] = [];
const blind: string[] = [];

/** Read a path, or record that this scan went blind on it. A check that throws has no failure
 *  path: "nothing found" and "nothing to find" are the same answer unless one of them says
 *  so. */
const read = (p: string) => { try { return readFileSync(p, "utf8"); } catch { blind.push(p); return null; } };
const listDir = (d: string) => { try { return readdirSync(d); } catch { blind.push(d); return []; } };

/** Source with its comments taken out, so a comment describing a property cannot stand in
 *  for the property.
 *
 *  DELIBERATE: a character scanner tracking strings and quotes, not the line-wise stripper
 *  core-surface.ts uses. A line comment ending in a block-comment opener makes the
 *  line-wise one open a block that never closes, blanking the rest of the file and turning
 *  every assertion over that region green. */
const stripComments = (src: string) => {
  let out = "";
  let i = 0;
  while (i < src.length) {
    const c = src[i], d = src[i + 1];
    if (c === "/" && d === "/") { while (i < src.length && src[i] !== "\n") i++; continue; }
    if (c === "/" && d === "*") {
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) { if (src[i] === "\n") out += "\n"; i++; }
      i += 2; continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      out += c; i++;
      while (i < src.length && src[i] !== c) { if (src[i] === "\\") { out += src[i]; i++; } out += src[i]; i++; }
      out += src[i] ?? ""; i++; continue;
    }
    out += c; i++;
  }
  return out;
};

/** A real client, connected to a real server over a linked in-memory transport pair. What it
 *  reports is what the `initialize` result carried — not what the source says it should. */
async function connectTo(server: McpServer) {
  const [forServer, forClient] = InMemoryTransport.createLinkedPair();
  await server.connect(forServer);
  const client = new Client({ name: "checks/orientation.ts", version: "0" });
  await client.connect(forClient);
  return client;
}

// The core door, built the way the service builds it
//
// The register* functions are read out of server.ts rather than listed here, so a door that
// grows another tool module is opened by this check with that module on it.
let coreClient: Client | null = null;
const coreSrc = read("services/zz-core/src/server.ts");
try {
  const { coreServer } = await import("../services/zz-core/dist/orientation.js");
  const server = coreServer("0.0.0-orientation-check");
  // Every name in the import, not the first: a tool module that exports two registrars would
  // otherwise be skipped whole, and the door under test would silently lose its tools.
  const mods = [...(coreSrc ?? "").matchAll(/import \{ ([^}]+) \} from "(\.\/tools\/[\w-]+)\.js"/g)];
  if (!mods.length) blind.push("no tool modules found imported by services/zz-core/src/server.ts");
  for (const [, names, rel] of mods) {
    const mod = await import(`../services/zz-core/dist/${rel.replace(/^\.\//, "")}.js`);
    for (const raw of names.split(",")) {
      const fn = raw.trim();
      if (!/^register\w+$/.test(fn)) continue;      // a type import is not a registrar
      // `true` where a registrar takes a role: the door under test is the whole surface, so a
      // paragraph is checked against everything it can serve, not what one caller sees.
      (mod[fn] as (s: unknown, sup?: boolean) => void)(server, true);
    }
  }
  coreClient = await connectTo(server);
} catch (err) {
  fail.push(`the core door could not be built or connected: ${errMessage(err)}`);
}

// The evaluation door, built the way zz-core mounts it
//
// One import and no module scan, unlike the core door above: eval-door.ts exports the whole
// builder, so the function this runs is the function `serveMcp` is handed. COUPLED: what that
// door serves is checks/eval-door.ts's subject; what it says is this file's.
let evalClient: Client | null = null;
try {
  const { buildEvalServer } = await import("../services/zz-core/dist/eval-door.js");
  evalClient = await connectTo(buildEvalServer());
} catch (err) {
  fail.push(`the evaluation door could not be built or connected: ${errMessage(err)}`);
}

// The access door, built the way the gateway mounts it
let manageClient: Client | null = null;
try {
  const { buildAccessServer } = await import("../services/gateway/dist/access-door.js");
  manageClient = await connectTo(await buildAccessServer());
} catch (err) {
  fail.push(`the access door could not be built or connected: ${errMessage(err)}`);
}

/** The tools a door actually serves, name -> description, as a client sees them.
 *
 * Guarded: a server with no tool registered never declares the `tools` capability, so the SDK
 * answers `tools/list` with `-32601 Method not found` and the client throws. The empty map
 * routes that state into the "served no tools — this scan is blind" line below. */
async function surfaceOf(client: Client): Promise<Map<string, string>> {
  try {
    const { tools } = await client.listTools();
    return new Map(tools.map((t) => [t.name, t.description ?? ""]));
  } catch {
    return new Map();
  }
}
const coreTools = coreClient ? await surfaceOf(coreClient) : new Map<string, string>();
const evalTools = evalClient ? await surfaceOf(evalClient) : new Map<string, string>();
const manageTools = manageClient ? await surfaceOf(manageClient) : new Map<string, string>();
// The control: every assertion below reads as satisfied against a door that serves nothing,
// which is what a broken import produces.
if (coreClient && coreTools.size === 0) fail.push("the core door served no tools — this scan is blind");
if (evalClient && evalTools.size === 0) fail.push("the evaluation door served no tools — this scan is blind");
if (manageClient && manageTools.size === 0) fail.push("the access door served no tools — this scan is blind");

// 1. The pointer survives, in the payload rather than in the prose
//
// Called, not read. `how_this_works` exists because `instructions` does not reach the model
// on every client — Claude Desktop parses the field and never shows it — so the assertion has
// to be made where the model receives it, which is a tool result.
let pointsAt: string | null = null;     // the orientation skill, taken from the live payload
if (coreClient && coreTools.has("session_whoami")) {
  try {
    const res = await coreClient.callTool({ name: "session_whoami", arguments: {} });
    const payload = JSON.parse(firstToolText(res.content));
    const pointer = (payload.how_this_works ?? "").trim();
    if (!pointer) {
      fail.push("session_whoami's payload carries no how_this_works. `instructions` is an " +
                "addition and never a replacement: Claude Desktop never reads it, so a rule " +
                "that lives only in the handshake does not apply there.");
    }
    // The skill the pointer names has to be one that can be loaded. The clause asks whether
    // the named skill exists, not what it is called.
    const named = /skill_read\(\s*["']([\w-]+)["']\s*\)/.exec(pointer);
    if (pointer && !named) {
      fail.push(`how_this_works does not name a skill as skill_read("…"): ${JSON.stringify(pointer)}`);
    } else if (named) {
      pointsAt = named[1];
      if (!existsSync(`skills/${pointsAt}/SKILL.md`)) {
        fail.push(`how_this_works points at "${pointsAt}", and skills/${pointsAt}/SKILL.md ` +
                  "does not exist — the one pointer a flowless session gets names nothing.");
      }
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(payload.today ?? "")) {
      fail.push(`session_whoami returned no ISO today (${JSON.stringify(payload.today)}) — ` +
                "it is the only tool that answers the date, and its description says so.");
    }
  } catch (err) {
    fail.push(`session_whoami could not be called: ${errMessage(err)}`);
  }
} else if (coreClient) {
  fail.push("the core door serves no session_whoami");
}

// 2. Every door introduces itself, and the introduction orients
//
// Length has two real bounds and they come from two clients: a practitioner report that
// Claude Code truncates the field at about 2KB, and Codex's guidance that the first 512
// characters be self-contained. So the skill to read has to land inside the first 512 — the
// part every client keeps — and the whole thing has to fit in 2,000 bytes.
//
// Each door's orientation skill is derived, not listed here, and they are not the same skill.
// The core door's comes from the live `how_this_works` payload above; the access door's from
// the catalog manifest that mounts it — the flow whose `servers[].path` is `/manage/mcp`
// declares an `entry` skill. Both must then exist on disk, which needs two paths: a shelved
// flow's skills live under `catalog/<pkg>/<flow>/skills/`, the platform's own under `skills/`.
const HEAD = 512;

/** Every flow manifest in the catalog, as [directory, parsed] pairs.
 *
 * Guarded the whole way down: a catalog that has moved makes this return nothing, and "no flow
 * declares that path" is then reported as this scan being blind rather than as the door being
 * fine. */
function catalogFlows() {
  const out = [];
  for (const pkg of listDir("catalog")) {
    for (const flow of listDir(`catalog/${pkg}`)) {
      const dir = `catalog/${pkg}/${flow}`;
      if (!existsSync(`${dir}/flow.json`)) continue;
      const raw = read(`${dir}/flow.json`);
      if (raw === null) continue;
      try { out.push([dir, JSON.parse(raw)]); } catch { blind.push(`${dir}/flow.json (unparseable)`); }
    }
  }
  if (!out.length) blind.push("catalog/*/*/flow.json — no flow manifests found at all");
  return out;
}
const FLOWS = catalogFlows();

/** The entry skill of the flow that mounts this MCP path, derived from the manifest, so a
 *  flow that is renamed takes its door's orientation pointer with it. */
function entrySkillFor(mountPath: string): string | null {
  for (const [, manifest] of FLOWS) {
    if ((manifest.servers ?? []).some((s: { path: string }) => s.path === mountPath)) return manifest.entry ?? null;
  }
  return null;
}

/** Where a catalog flow's own skill would live. A shelved flow's skills are not in `skills/`,
 *  which holds the platform's own, so both roots are searched. */
function catalogSkillPaths(skill: string): string[] {
  const paths = FLOWS.map(([dir]) => `${dir}/skills/${skill}/SKILL.md`);
  paths.push(`skills/${skill}/SKILL.md`);
  return paths;
}

const DOORS = [
  { name: "core (/core/mcp)", client: coreClient, tools: coreTools,
    // Noun-first, and its paragraph is held to the surface in both directions below.
    nouns: true, skill: pointsAt, skillAt: (s: string) => [`skills/${s}/SKILL.md`],
    mustName: ["session_whoami"] },
  { name: "evaluation (/eval/mcp)", client: evalClient, tools: evalTools,
    // Noun-first, like the core door: it serves one noun today, so the day a tool arrives
    // under a second prefix this paragraph goes red rather than describing an older door.
    nouns: true, skill: entrySkillFor("/eval/mcp"),
    // This door's orientation skill ships inside the catalog entry of the flow that declares
    // the door, not in `skills/`.
    skillAt: (s: string) => catalogSkillPaths(s),
    // Its own mount path, so the paragraph cannot be read as any door's; the other door, so
    // "not here" has somewhere to send the caller; and the tool that answers who is asking.
    mustName: ["/eval", "/core", "session_whoami"] },
  { name: "access (/manage/mcp)", client: manageClient, tools: manageTools,
    // COUPLED: this door's tool vocabulary is checks/manage-surface.ts's subject, so its
    // paragraph is not held to the prefixes it serves.
    nouns: false, skill: entrySkillFor("/manage/mcp"),
    skillAt: (s: string) => catalogSkillPaths(s),
    mustName: ["whoami", "/core", "/manage"] },
];

for (const { name: door, client, tools, nouns, skill, skillAt, mustName } of DOORS) {
  if (!client) continue;
  const t = client.getInstructions();
  if (!t || !t.trim()) {
    fail.push(`the ${door} door's initialize carried no instructions — a client that reads ` +
              "nothing else is told nothing at all");
    continue;
  }
  const bytes = Buffer.byteLength(t);
  if (bytes > 2000) fail.push(`the ${door} door's instructions are ${bytes} bytes; Claude Code truncates near 2000`);
  if (!skill) {
    fail.push(`could not work out which skill orients the ${door} door, so the clause that ` +
              "its instructions name one asserted nothing");
  } else {
    // Naming it only after the first 512 characters loses it on the client that keeps only
    // those, which is the client this whole field exists for.
    if (!t.slice(0, HEAD).includes(skill)) {
      fail.push(`the ${door} door's first ${HEAD} characters do not name ${skill}, the skill ` +
                "that orients it — a client that keeps only those is told where nothing is");
    }
    // And the skill has to exist: the clause is about existence, not about the spelling.
    const where = skillAt(skill);
    if (!where.some((p) => existsSync(p))) {
      fail.push(`the ${door} door points at "${skill}", and no SKILL.md for it exists ` +
                `(looked in ${where.join(", ")}) — its one orientation pointer names nothing`);
    }
  }
  // Says when not to reach for this door. A structural marker and nothing more: no check can
  // judge whether the sentence after it is true or useful.
  if (!/^NOT FOR:/m.test(t)) {
    fail.push(`the ${door} door's instructions never say when NOT to reach for it ` +
              "(no line beginning `NOT FOR:`)");
  }
  // The few anchors that make the paragraph about this door and not any door: the tool a
  // caller starts with, the other door so "not for this" has somewhere to send them, and its
  // own mount path so the two paragraphs are not interchangeable. Everything above this
  // passes on prose that orients nobody.
  for (const anchor of mustName) {
    if (!t.includes(anchor)) {
      fail.push(`the ${door} door's instructions never mention ${anchor}. A paragraph that ` +
                "would read the same on the other door has not oriented anybody.");
    }
  }
  if (!nouns) continue;
  // The nouns, derived from the live surface and compared both ways: a tool group that
  // arrives unannounced is red, and a group named in the text that no longer exists is red.
  const served = new Set([...tools.keys()].filter((n) => n.includes("_")).map((n) => n.split("_")[0]));
  const claimed = new Set([...t.matchAll(/\b([a-z][a-z0-9]*)_\*/g)].map((m) => m[1]));
  for (const noun of served) {
    if (!claimed.has(noun)) {
      fail.push(`the ${door} door serves ${noun}_* tools and its instructions never mention ` +
                `\`${noun}_*\` — the paragraph has drifted from the surface`);
    }
  }
  for (const noun of claimed) {
    if (!served.has(noun)) {
      fail.push(`the ${door} door's instructions describe \`${noun}_*\`, which it does not ` +
                "serve — say what is there, not what used to be");
    }
  }
}

// 3. The doors are built by the functions this check built
//
// The one seam a handshake cannot close: everything above ran `coreServer` and
// `buildAccessServer`, and nothing above proves the services run them. Swapping either mount
// back to a bare `new McpServer(...)` would leave every assertion here green and every real
// client with no instructions, so it is asserted on comment-stripped source — server.ts binds
// :8000 at module scope and cannot be imported.
//
// COUPLED: the evaluation door's half of this seam is checks/eval-door.ts's, not repeated
// here.
const coreCode = stripComments(coreSrc ?? "");
if (coreSrc) {
  if (!/coreServer\(/.test(coreCode)) {
    fail.push("services/zz-core/src/server.ts does not build its door with coreServer() — " +
              "this check's handshake is then about a server nothing serves");
  }
  if (/new McpServer\(/.test(coreCode)) {
    fail.push("services/zz-core/src/server.ts constructs an McpServer directly; the door's " +
              "identity belongs in orientation.ts, where it can be read back");
  }
  if (!/serveMcp\(app, "\/mcp", buildServer\)/.test(coreCode)) {
    fail.push("services/zz-core/src/server.ts no longer mounts buildServer at /mcp");
  }
}
const gatewayCode = stripComments(read("services/gateway/src/server.ts") ?? "");
if (gatewayCode && !/serveMcp\(app, "\/manage\/mcp", buildAccessServer\)/.test(gatewayCode)) {
  fail.push("the gateway no longer mounts buildAccessServer at /manage/mcp");
}

// 4. The three identity tools each say what only they answer
//
// DELIBERATE: three tools answer some form of "who am I" and they are not merged — see the
// note over `whoami` in services/gateway/src/admin.ts. A model chooses between them by
// description alone, so each has to name the other two and say what it alone returns, and each
// has to exist on its own door. Asserted against the descriptions a client was served.
const TRIO: [string, Map<string, string>, string[]][] = [
  ["session_whoami", coreTools, ["whoami", "team_mine", "today"]],
  ["whoami", manageTools, ["session_whoami", "team_mine"]],
  ["team_mine", manageTools, ["session_whoami", "whoami"]],
];
const descriptions = new Map<string, string>();
for (const [tool, tools, mustName] of TRIO) {
  if (!tools.size) continue;                       // that door is already reported blind
  if (!tools.has(tool)) { fail.push(`${tool} is not served by its door`); continue; }
  const desc = tools.get(tool)!;
  descriptions.set(tool, desc.replace(/\s+/g, " ").trim());
  for (const other of mustName) {
    // `whoami` is a substring of `session_whoami`, so the match is on a word boundary that
    // treats `_` as part of the word.
    if (!new RegExp(`(^|[^A-Za-z0-9_])${other}([^A-Za-z0-9_]|$)`).test(desc)) {
      fail.push(`${tool}'s description never names ${other}. A model picking between three ` +
                "identity tools has the descriptions and nothing else.");
    }
  }
}
// Control: three descriptions that have converged on the same words are three tools a model
// cannot tell apart, whichever names they contain.
const seen = new Map<string, string>();
for (const [tool, desc] of descriptions) {
  if (seen.has(desc)) fail.push(`${tool} and ${seen.get(desc)} have the same description`);
  seen.set(desc, tool);
}

// A path this check reads that has moved is this scan going blind, and it is said first:
// every assertion about that file passed on nothing.
for (const p of new Set(blind)) {
  fail.unshift(`${p} could not be read — this check asserts over it, so those assertions ` +
               "passed on nothing. Point it at where it went.");
}

for (const c of [coreClient, evalClient, manageClient]) { try { await c?.close(); } catch { /* closing is not the assertion */ } }

if (fail.length) { console.error([...new Set(fail)].join("\n")); process.exit(1); }
// The green line carries what was asserted: the tool counts a client saw and the three
// orientation skills by name.
console.log(`orientation: ok — all three doors introduce themselves at initialize: /core ` +
            `(${coreTools.size} tools, names every noun it serves, points at ${pointsAt}), ` +
            `/eval (${evalTools.size} tools, names every noun it serves, points at ` +
            `${entrySkillFor("/eval/mcp")}) and ` +
            `/manage (${manageTools.size} tools, points at ${entrySkillFor("/manage/mcp")}); ` +
            "the pointer survives in session_whoami's payload; and session_whoami, whoami " +
            "and team_mine each name the other two.");
