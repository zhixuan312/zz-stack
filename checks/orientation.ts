// A door introduces itself in the handshake, and the pointer survives for a client that
// never reads it.
//
// THIS CHECK OPENS A REAL CLIENT AGAINST A REAL SERVER. The plan's own draft read the two
// doors' source and matched /instructions\s*:\s*(['"`])([\s\S]*?)\1/ — and that draft was
// measured against untouched code before anything here was written. It was red, but red for
// the wrong reason and green for the wrong reasons afterwards:
//
//   - It could not tell a declared field from a delivered one. `instructions` is the SDK's
//     `ServerOptions`, the SECOND argument to `new McpServer(...)`; the first is
//     `Implementation` and carries only name/version/title. An object literal with the field
//     in the wrong place satisfies the grep exactly, and the plan's own contract line —
//     "`new McpServer({ name, version, instructions })`" — puts it in the wrong place. So the
//     source the plan told an implementer to write would have matched the check the plan told
//     them to run and shipped a handshake with no instructions in it.
//   - Its only content assertions were `length >= 80` and /zz-platform/. Eighty characters of
//     anything passes the first. The second named a skill THAT DID NOT EXIST WHEN THIS WAS
//     WRITTEN: `zz-platform` was DESIGN-platform.md's phase-6 rename of the skill then called
//     `zz-backbone` (line 302), this is phase 4, and `ls skills/` had no such directory. A
//     door whose one orientation pointer names an unloadable skill is worse than a door that
//     says nothing, and the plan's check REQUIRED that pointer. Phase 6 (task I-26) has since
//     landed the rename, so the name resolves now — the clauses below assert EXISTENCE rather
//     than a spelling, which is why they kept working across it.
//   - Its identity-tool section asserted that three names appear somewhere in three files.
//     All three already did before this task started. That clause could never have gone red.
//
// So instead: `coreServer`, `buildEvalServer` and `buildAccessServer` are the same functions
// the services mount, they are imported from dist and run, an `InMemoryTransport` pair carries
// a real `initialize` and a real `tools/list` between a real `Client` and them, and every
// assertion below is made against what that client received. `session_whoami` is CALLED, not read, so
// the surviving pointer is asserted in the payload a client gets rather than in a word that
// also appears in the comment explaining why the payload has it.
//
// THE NOUNS ARE DERIVED, NEVER LISTED HERE. The prefix set comes out of `tools/list` on the
// live door and is compared with the instructions text in BOTH directions: a tool group that
// arrives unannounced is red, and a group named in the text that no longer exists is red.
// That is what keeps server.ts's claim about its own surface — "this is not an estimate of
// our surface, it IS our surface, and it cannot drift from what we serve" — true of the
// paragraph that describes it as well as of the row that records it.
//
// THAT CLAUSE IS THE NOUN-FIRST DOORS' — the core door and the evaluation door — and the
// asymmetry is deliberate rather than an
// oversight. /manage WAS not noun-first: it served list_catalog, connect_block,
// set_my_credential and a dozen more verb-first names until Task I-22 renamed them. Holding
// its paragraph to those prefixes would have pinned the exact vocabulary I-22 removed, and the
// clause stays off this door now because manage-surface.mjs owns that door's shape and put a
// second copy of it in that task's path. So its instructions are held to everything else —
// length, a self-contained first 512 naming its own orientation skill, a `NOT FOR:` line —
// and its tool list is left to speak for itself. Each door's orientation skill is DERIVED and
// they are different: the core door's from the live `how_this_works` payload, /manage's from
// the catalog manifest that mounts it.
//
// WHAT THIS CHECK CANNOT DO. It cannot judge whether the prose is any good. "Says when NOT to
// reach for this door" is asserted as a structural marker (`NOT FOR:`) and nothing more,
// because meaning is not greppable; a reviewer reads the paragraph, this file only stops it
// from silently disappearing. Every other clause below drives behaviour.
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

/** Read a path, or record that this scan went blind on it. A CHECK THAT THROWS HAS NO
 *  FAILURE PATH — "nothing found" and "nothing to find" are the same answer unless one of
 *  them says so, and three checks in this initiative have ended in a stack trace instead of
 *  the sentence they were written to print. */
const read = (p: string) => { try { return readFileSync(p, "utf8"); } catch { blind.push(p); return null; } };
const listDir = (d: string) => { try { return readdirSync(d); } catch { blind.push(d); return []; } };

/** Source with its comments taken out. Every file here legitimately carries prose about what
 *  the code used to do, and a comment describing a property must never be able to stand in
 *  for the property.
 *
 *  A CHARACTER SCANNER, not the line-wise stripper core-surface-19.mjs uses, and the
 *  difference is not fussiness. That one looks for `/*` before it removes `//`, so
 *  services/gateway/src/server.ts:266 — a LINE comment ending "…/auth/*" — opened a block
 *  comment that never closed and blanked the last 28 lines of the file, including the
 *  `serveMcp(app, "/manage/mcp", buildAccessServer)` this check asserts. Measured: the clause
 *  reported the gateway had stopped mounting the door while the line sat there untouched. A
 *  stripper that silently empties the region it is asked about turns every assertion over
 *  that region green, which is the failure mode this whole file was rewritten to avoid, so it
 *  tracks strings and quotes rather than guessing per line. */
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

// ── The core door, built the way the service builds it ───────────────────────────────────
//
// The register* functions are read out of server.ts rather than listed here, so a door that
// grows a ninth tool module is opened by this check with that module on it. Task I-14 is
// adding one while this is being written; hard-coding the eight would have made this check
// describe yesterday's door.
let coreClient: Client | null = null;
const coreSrc = read("services/zz-core/src/server.ts");
try {
  const { coreServer } = await import("../services/zz-core/dist/orientation.js");
  const server = coreServer("0.0.0-orientation-check");
  const mods = [...(coreSrc ?? "").matchAll(/import \{ (register\w+) \} from "(\.\/tools\/[\w-]+)\.js"/g)];
  if (!mods.length) blind.push("no tool modules found imported by services/zz-core/src/server.ts");
  for (const [, fn, rel] of mods) {
    const mod = await import(`../services/zz-core/dist/${rel.replace(/^\.\//, "")}.js`);
    mod[fn](server);
  }
  coreClient = await connectTo(server);
} catch (err) {
  fail.push(`the core door could not be built or connected: ${errMessage(err)}`);
}

// ── The evaluation door, built the way zz-core mounts it ─────────────────────────────────
//
// ONE IMPORT AND NO MODULE SCAN, unlike the core door above, because eval-door.ts exports the
// whole builder: it constructs its server, declares its own instructions and registers its own
// tools, so the function this runs is the function `serveMcp` is handed. What that door SERVES
// is checks/eval-door.mjs's subject; what it SAYS is this file's.
let evalClient: Client | null = null;
try {
  const { buildEvalServer } = await import("../services/zz-core/dist/eval-door.js");
  evalClient = await connectTo(buildEvalServer());
} catch (err) {
  fail.push(`the evaluation door could not be built or connected: ${errMessage(err)}`);
}

// ── The access door, built the way the gateway mounts it ─────────────────────────────────
let manageClient: Client | null = null;
try {
  const { buildAccessServer } = await import("../services/gateway/dist/access-door.js");
  manageClient = await connectTo(await buildAccessServer());
} catch (err) {
  fail.push(`the access door could not be built or connected: ${errMessage(err)}`);
}

/** The tools a door actually serves, name -> description, as a client sees them.
 *
 * GUARDED, BECAUSE A DOOR THAT SERVES NOTHING IS A STATE THIS FILE HAS A CONTROL FOR. A server
 * with no tool registered never declares the `tools` capability, so the SDK answers
 * `tools/list` with `-32601 Method not found` and the client THROWS — ending this check in a
 * stack trace out of module scope instead of in the "served no tools — this scan is blind"
 * line written for exactly that case. Measured while mutation-testing the evaluation door. */
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
// THE CONTROL. Every assertion below reads as satisfied against a door that serves nothing,
// which is exactly the state a broken import produces.
if (coreClient && coreTools.size === 0) fail.push("the core door served no tools — this scan is blind");
if (evalClient && evalTools.size === 0) fail.push("the evaluation door served no tools — this scan is blind");
if (manageClient && manageTools.size === 0) fail.push("the access door served no tools — this scan is blind");

// ── 1. The pointer survives, in the payload rather than in the prose ─────────────────────
//
// CALLED, NOT READ. `how_this_works` exists because `instructions` does not reach the model
// on a binding target — Claude Desktop parses the field and never shows it — so the assertion
// that the pointer survives has to be made where the model receives it, which is a tool
// result. A grep for the word passes on the comment that explains why the word is there.
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
    // The skill the pointer names has to be one that can be loaded. This is where the plan's
    // `zz-platform` would have been caught when this was written: it was a phase-6 rename of
    // `zz-backbone` and no such skill was on disk then. Phase 6 has since landed it, and the
    // clause is unchanged — it asks whether the named skill exists, not what it is called.
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

// ── 2. Every door introduces itself, and the introduction orients ────────────────────────
//
// Length has two real bounds and they come from two clients: a practitioner report that
// Claude Code truncates the field at about 2KB, and Codex's guidance that the first 512
// characters be self-contained. So the skill to read has to land inside the first 512 — the
// part every client keeps — and the whole thing has to fit in 2,000 bytes.
//
// EACH DOOR'S ORIENTATION SKILL IS DERIVED, NOT LISTED HERE, and they are not the same skill.
// The core door's comes from the live `how_this_works` payload above. The access door's comes
// from the catalog manifest that mounts it: the flow whose `servers[].path` is `/manage/mcp`
// declares an `entry` skill, and that is the one its paragraph must name. Both are then
// required to EXIST on disk — which is the clause that would have caught the plan's
// `zz-platform`, and which needs two different paths, because a shelved flow's skills live
// under `catalog/<pkg>/<flow>/skills/` and the platform's own live under `skills/`.
const HEAD = 512;

/** Every flow manifest in the catalog, as [directory, parsed] pairs.
 *
 * Guarded the whole way down, like the read above: a catalog that has moved makes this return
 * nothing, and "no flow declares that path" is then reported as this scan being blind rather
 * than as the door being fine. */
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

/** The entry skill of the flow that mounts this MCP path. DERIVED FROM THE MANIFEST, so a
 *  flow that is renamed takes its door's orientation pointer with it. */
function entrySkillFor(mountPath: string): string | null {
  for (const [, manifest] of FLOWS) {
    if ((manifest.servers ?? []).some((s: { path: string }) => s.path === mountPath)) return manifest.entry ?? null;
  }
  return null;
}

/** Where a catalog flow's own skill would live. A SHELVED FLOW'S SKILLS ARE NOT IN `skills/`
 *  — that directory holds the platform's own — so looking only there reports a skill that
 *  exists as missing, which is a check calling correct code broken. */
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
    // Noun-first, like the core door and unlike /manage: every tool on it is `plugin_*`, so
    // holding its paragraph to the prefixes it serves pins nothing that Task I-22's rename
    // touches. It serves ONE noun today, which is exactly why the clause is worth keeping —
    // the day an eleventh tool arrives under a second prefix, this paragraph goes red rather
    // than quietly describing the door it used to be.
    nouns: true, skill: entrySkillFor("/eval/mcp"),
    // A SHELVED FLOW'S SKILLS ARE NOT IN `skills/`: this door's orientation skill ships inside
    // the catalog entry of the flow that declares the door.
    skillAt: (s: string) => catalogSkillPaths(s),
    // Its own mount path, so the paragraph cannot be read as any door's; the OTHER door, since
    // everyone holding this one also holds that one and "not here" needs somewhere to send
    // them; and the tool that answers who is asking, which lives over there.
    mustName: ["/eval", "/core", "session_whoami"] },
  { name: "access (/manage/mcp)", client: manageClient, tools: manageTools,
    // NOT noun-first when this clause was written: it served list_catalog, connect_block,
    // set_my_credential and a dozen more verb-first names until Task I-22 renamed them.
    // Demanding its paragraph name `list_*` and `connect_*` would have pinned exactly the
    // vocabulary that task removed; manage-surface.mjs owns this door's shape, and would put
    // a second copy of every one of those names in its path.
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
    // AND THE SKILL HAS TO EXIST. This is the clause the plan's own wording failed: it
    // required the text to name `zz-platform`, which was DESIGN-platform.md's phase-6 rename
    // of `zz-backbone` and was on disk nowhere at phase 4. Phase 6 landed it; the clause is
    // still about existence and not about the spelling.
    const where = skillAt(skill);
    if (!where.some((p) => existsSync(p))) {
      fail.push(`the ${door} door points at "${skill}", and no SKILL.md for it exists ` +
                `(looked in ${where.join(", ")}) — its one orientation pointer names nothing`);
    }
  }
  // Says when NOT to reach for this door. A STRUCTURAL MARKER AND NOTHING MORE: no check can
  // judge whether the sentence after it is true or useful. It is here so the clause cannot
  // vanish in silence, not because matching it proves anything. See the header.
  if (!/^NOT FOR:/m.test(t)) {
    fail.push(`the ${door} door's instructions never say when NOT to reach for it ` +
              "(no line beginning `NOT FOR:`)");
  }
  // THE FEW ANCHORS THAT MAKE THE PARAGRAPH ABOUT THIS DOOR AND NOT ANY DOOR.
  //
  // MEASURED, NOT GUESSED AT. Everything above passed a deliberately useless paragraph
  // written for the mutation test — "The /manage door. It is a useful door for managing your
  // access to this platform and you should use it when you need to. See zz-access for
  // details. NOT FOR: other things." That is under 2KB, names its orientation skill in the
  // first 512, and carries a `NOT FOR:` line, so the whole of section 2 was green on prose
  // that orients nobody. The core door was saved by the noun clause below; /manage has no
  // noun clause and had nothing.
  //
  // So each door names a small number of things a useful paragraph cannot omit, and every one
  // is chosen to SURVIVE Task I-22's rename rather than fight it: the tool a caller starts
  // with (`whoami` is that door's one exception to the noun-first shape — checks/
  // manage-surface.mjs asserts it is kept under exactly that name), the OTHER door, so
  // "not for this" has somewhere to send you, and its own mount path, so the two paragraphs
  // are not interchangeable.
  for (const anchor of mustName) {
    if (!t.includes(anchor)) {
      fail.push(`the ${door} door's instructions never mention ${anchor}. A paragraph that ` +
                "would read the same on the other door has not oriented anybody.");
    }
  }
  if (!nouns) continue;
  // THE NOUNS, DERIVED FROM THE LIVE SURFACE AND COMPARED BOTH WAYS. This is the clause that
  // makes the paragraph part of the surface rather than a description of it: a tool group
  // that arrives unannounced is red, and a group named here that no longer exists is red.
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

// ── 3. The doors are built by the functions this check built ─────────────────────────────
//
// The one seam a handshake cannot close. Everything above ran `coreServer` and
// `buildAccessServer`; nothing above proves the SERVICES run them.
//
// THE EVALUATION DOOR'S HALF OF THIS SEAM IS checks/eval-door.mjs's, and deliberately not
// repeated here: that file already compares zz-core's `serveMcp(app, "…", buildEvalServer)`
// mount against the path the gateway's own `EVAL_URL` fetches, which is the same assertion
// with a second half this file has no use for. Two files red for one cause teaches nothing. Swapping either mount back
// to a bare `new McpServer(...)` would leave every assertion here green and every real client
// with no instructions, so it is asserted on comment-stripped source — the whole reason
// orientation.ts exists is that server.ts binds :8000 at module scope and cannot be imported.
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

// ── 4. The three identity tools each say what only they answer ───────────────────────────
//
// NOT MERGED, DELIBERATELY — see the note over `whoami` in services/gateway/src/admin.ts.
// Three tools answer some form of "who am I" and a model chooses between them by description
// and by nothing else, so each one has to name the other two and say what it alone returns.
// Asserted against the descriptions a client was actually served.
//
// EACH NAMES THE OTHER TWO, and each is required to EXIST on its own door — "the three are
// not merged" is the half of this criterion that can be lost by accident, by a later task
// tidying away what looks like a duplicate.
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
    // treats `_` as part of the word. Without it, every description that names session_whoami
    // was credited with naming whoami too, and the clause could not fail.
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
// WHAT WAS ACTUALLY ASSERTED, ON THE GREEN LINE — the doors by the tool counts a client saw,
// and the three orientation skills by name, so a reader can tell at a glance whether this ran
// against the surface they think it did.
console.log(`orientation: ok — all three doors introduce themselves at initialize: /core ` +
            `(${coreTools.size} tools, names every noun it serves, points at ${pointsAt}), ` +
            `/eval (${evalTools.size} tools, names every noun it serves, points at ` +
            `${entrySkillFor("/eval/mcp")}) and ` +
            `/manage (${manageTools.size} tools, points at ${entrySkillFor("/manage/mcp")}); ` +
            "the pointer survives in session_whoami's payload; and session_whoami, whoami " +
            "and team_mine each name the other two.");
