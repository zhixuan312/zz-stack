// The evaluation door is a DOOR: it is mounted, it serves its own tools and not the core
// door's, the gateway routes to it and forwards to IT rather than to zz-core's other mount,
// and the flow that owns it declares it.
//
// THIS CHECK OPENS REAL CLIENTS AND IMPORTS REAL CONSTANTS. The plan's own draft of this file
// was measured against untouched code before a line of this was written: 7 of its 8 clauses
// were red and the 8th was its `/core/mcp` control, so it could tell that the door was ABSENT.
// It could not tell anything else, and the gaps were the ones that matter:
//
//   - It read raw source with the comments in. `app.all("/eval/mcp"` inside a comment — inside
//     THIS sentence, had it been in server.ts — satisfied it. The sibling check
//     `eval-tools-moved.mjs` fails exactly this way today: its `coreFactory.includes("plugin-eval")`
//     matches the words "zz-plugin-eval" in a comment saying those tools have LEFT the core door.
//   - Its whole test of what the door serves was that two `serveMcp` calls named two different
//     identifiers. `function buildEvalServer() { return new McpServer(...) }` — a door mounted
//     and serving nothing — passed every clause it had.
//   - It never asked where the gateway's new route FORWARDS. Pointing `/eval/mcp` at `CORE_URL`
//     gives every caller the core door's tools under the evaluation door's name, and the whole
//     point of the door is that those two lists differ. That passed too.
//
// So: `buildEvalServer` is imported from dist and run, an `InMemoryTransport` pair carries a
// real `initialize` and a real `tools/list` between a real `Client` and it, and what the door
// serves is read off that client. `CORE_URL` and `EVAL_URL` are IMPORTED from the gateway's
// own module rather than matched in its source, so what this compares is the value the running
// proxy would fetch. `blockOf` is CALLED, because the surface name the gateway records for this
// door decides whether its traffic is filed as the platform's own or as a building block
// nobody has ever granted.
//
// WHAT IT CANNOT SEE, AND WHOSE TASK THAT IS. The platform records its own tool surface per
// service version (`zz.block_version` + `zz.block_tool`), and `zz.block_tool` is
// `(id, block_version_id, name, verdict, …)` — there is no column for a door. Both doors are
// built at boot and both fill OWN_TOOLS, so the RECORD is complete; what it cannot express is
// which door a name is on. The consequence is sharper than it sounds:
// `eval_block_surface('platform')` diffs a version's surface against the one before, and when
// ten tools move from /core to /eval the recorded name set is IDENTICAL — so the one
// instrument this platform has for judging a tool surface reports NO CHANGE across the largest
// surface change it has ever had. That is not a gap, it is a wrong answer that looks like a
// right one. It needs a migration and a change to how the surface is recorded, it must land
// after the doors stop moving, and it is TASK I-39. Nothing below covers it, and the green
// line says so, so that a passing check is not read as the all-clear.
//
// WHAT IT LEAVES TO checks/orientation.mjs. That file owns every door's PARAGRAPH — the
// `instructions` a client is handed at `initialize`, its length, the skill it points at, its
// `NOT FOR:` line, and the nouns it claims against the nouns it serves. The eval door is a row
// in its table. Asserting the same property in two files means two go red for one cause and
// the second one teaches nothing.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

const fail = [];
const blind = [];

/** Read a path, or record that this scan went blind on it. A CHECK THAT THROWS HAS NO FAILURE
 *  PATH — "nothing found" and "nothing to find" are the same answer unless one of them says
 *  so, and several checks in this initiative have ended in a stack trace instead of the
 *  sentence they were written to print. */
const read = (p) => { try { return readFileSync(p, "utf8"); } catch { blind.push(p); return null; } };
const listDir = (d) => { try { return readdirSync(d); } catch { blind.push(d); return []; } };

/** Source with its comments taken out, tracking strings so a quoted `/*` cannot open one.
 *
 * A CHARACTER SCANNER, not a line-wise stripper, and the difference has already cost this
 * repository a false green: `services/gateway/src/server.ts` carries a LINE comment ending
 * "…/auth/*", which opens a block comment a line-wise stripper never closes — blanking the end
 * of the file, including the mounts a check was asserting over. A stripper that silently
 * empties the region it is asked about turns every assertion over that region green. */
const stripComments = (src) => {
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

/** A real client, connected to a real server over a linked in-memory transport pair. */
async function connectTo(server) {
  const [forServer, forClient] = InMemoryTransport.createLinkedPair();
  await server.connect(forServer);
  const client = new Client({ name: "checks/eval-door.mjs", version: "0" });
  await client.connect(forClient);
  return client;
}
/** The tools a door actually serves, as a client sees them.
 *
 * GUARDED, BECAUSE THE EMPTY DOOR IS THE CASE THIS FILE EXISTS FOR. A server with no tool
 * registered never declares the `tools` capability, so the SDK answers `tools/list` with
 * `-32601 Method not found` and the client THROWS. Measured: mounting the evaluation door and
 * registering nothing ended this check in a stack trace out of module scope rather than in the
 * sentence below — red, but red in the shape that reads as a broken check, which is how a
 * reader learns to distrust the one clause that mattered. No tools is an ANSWER, and clause 1
 * is what says so. */
const surfaceOf = async (client) => {
  try {
    return new Set((await client.listTools()).tools.map((t) => t.name));
  } catch {
    return new Set();
  }
};

const CORE_SRC_PATH = "services/zz-core/src/server.ts";
const EVAL_SRC_PATH = "services/zz-core/src/eval-door.ts";
const GW_SRC_PATH = "services/gateway/src/server.ts";
const coreSrc = read(CORE_SRC_PATH);
const evalSrc = read(EVAL_SRC_PATH);
const gwSrc = read(GW_SRC_PATH);

// ── The evaluation door, built by the function the service mounts ─────────────────────────
let evalClient = null;
try {
  const { buildEvalServer } = await import("../services/zz-core/dist/eval-door.js");
  evalClient = await connectTo(buildEvalServer());
} catch (err) {
  fail.push(`the evaluation door could not be built or connected: ${err?.message ?? err}`);
}

// ── The core door, built the way zz-core builds it ────────────────────────────────────────
//
// Its tool modules are read out of server.ts's own imports rather than listed here, so this
// opens the door as it is today and not as it was when this was written.
let coreClient = null;
try {
  const { coreServer } = await import("../services/zz-core/dist/orientation.js");
  const server = coreServer("0.0.0-eval-door-check");
  const mods = [...(coreSrc ?? "").matchAll(/import \{ (register\w+) \} from "(\.\/tools\/[\w-]+)\.js"/g)];
  if (!mods.length) blind.push(`no tool modules found imported by ${CORE_SRC_PATH}`);
  for (const [, fn, rel] of mods) {
    const mod = await import(`../services/zz-core/dist/${rel.replace(/^\.\//, "")}.js`);
    mod[fn](server);
  }
  coreClient = await connectTo(server);
} catch (err) {
  fail.push(`the core door could not be built or connected: ${err?.message ?? err}`);
}

const evalTools = evalClient ? await surfaceOf(evalClient) : new Set();
const coreTools = coreClient ? await surfaceOf(coreClient) : new Set();

// ── 1. A door that is mounted and serves nothing is not a door ────────────────────────────
//
// THE CLAUSE THE PLAN'S VERSION DID NOT HAVE, and the one failure this task is most likely to
// ship: the mount is the easy half and it is the half that greps green. An empty factory
// answers `initialize` perfectly and `tools/list` with `[]`, so every caller sees a door that
// connects and offers nothing — which is indistinguishable, from the outside, from a door
// whose tools failed to register.
if (evalClient && evalTools.size === 0) {
  fail.push("the evaluation door is mounted and serves NO tools — it answers initialize and " +
            "offers nothing, which is what a dropped register call looks like from outside");
}
// The same control on the other side: every disjointness clause below reads as satisfied
// against a core door that serves nothing at all.
if (coreClient && coreTools.size === 0) fail.push("the core door served no tools — this scan is blind");

// ── 2. The door serves exactly what its own modules register ──────────────────────────────
//
// DERIVED FROM eval-door.ts's OWN IMPORTS, never listed here: a door that grows an eleventh
// tool is opened by this check with that tool on it. What this catches is the half of a move
// that is easy to leave undone — a module imported and never registered, or registered and
// serving a name nothing declares.
if (evalSrc && evalClient) {
  // ANY relative path, not just `./tools/`: Task I-20 relocates these three modules, and a
  // check that pinned the directory they live in today would go red on a move that changes
  // nothing about the door. `register\w+` is what selects a tool module — `./door.js` imports
  // `recordingDoor` and is correctly not one.
  const mods = [...evalSrc.matchAll(/import \{ register\w+ \} from "(\.\/[\w/-]+)\.js"/g)]
    .map((m) => m[1].replace(/^\.\//, ""));
  if (!mods.length) {
    // NOT "blind": this one is an answer. A door file that imports no tool module is a door
    // with nothing to register, and saying "this check could not read something" about it
    // would describe a broken check instead of an empty door.
    fail.push(`${EVAL_SRC_PATH} imports no tool module at all, so there is nothing for the ` +
              "evaluation door to register — whatever is mounted there serves an empty list");
  } else {
    const declared = new Set();
    for (const rel of mods) {
      const src = read(`services/zz-core/src/${rel}.ts`) ?? "";
      for (const m of src.matchAll(/registerTool\(\s*\n?\s*"([a-z0-9_]+)"/g)) declared.add(m[1]);
    }
    for (const want of declared) {
      if (!evalTools.has(want)) {
        fail.push(`${want} is declared by a module the evaluation door imports and the door ` +
                  "does not serve it — the module is imported and never registered");
      }
    }
    for (const got of evalTools) {
      if (!declared.has(got)) {
        fail.push(`the evaluation door serves ${got}, which none of the modules it imports ` +
                  "declares — this check cannot see where that tool came from");
      }
    }
  }
}

// ── 2b. The door's tools reach the surface this platform records about itself ─────────────
//
// `recordingDoor` is what every door wraps its server in, and it does two things no caller can
// see: it adds each name to OWN_TOOLS as that tool is declared, and it turns a thrown `Refusal`
// into this platform's refusal shape. A door built WITHOUT it serves a perfectly working tool
// list — this file's clauses 1 to 3 all stay green — while its tools are missing from the row
// `eval_block_surface('platform')` reads and its refusals arrive in a different shape from
// every other refusal here. Both failures are silent, which is why this clause is not a grep
// for the word: the builder above has already run, so OWN_TOOLS holds what that run declared.
if (evalTools.size) {
  try {
    const { OWN_TOOLS } = await import("../services/zz-core/dist/door.js");
    const unrecorded = [...evalTools].filter((t) => !OWN_TOOLS.has(t));
    if (unrecorded.length) {
      fail.push(`the evaluation door serves ${unrecorded.sort().join(", ")} and building it ` +
                "recorded nothing about them — that door is not wrapped in recordingDoor, so " +
                "its tools are absent from the surface the platform records about itself and " +
                "their refusals arrive in a shape nothing here expects");
    }
  } catch (err) {
    fail.push(`door.ts could not be imported, so nothing about what the door records was ` +
              `checked: ${err?.message ?? err}`);
  }
}

// ── 3. Two doors, two tool sets ───────────────────────────────────────────────────────────
//
// The reason the second door exists. `/core/mcp` is in the client package's REQUIRED baseline
// plugin, so a tool served there is on every account on the platform; a tool served on both is
// on every account AND counted twice by anything that reads a door's surface.
const both = [...evalTools].filter((t) => coreTools.has(t));
if (both.length) {
  fail.push(`served by BOTH doors: ${both.sort().join(", ")} — the core door is in the required ` +
            "baseline plugin, so a tool on both is a tool everybody has after the move too");
}
if (coreClient && evalClient && evalTools.size && coreTools.size) {
  const leftBehind = [...coreTools].filter((t) => t.startsWith("plugin_"));
  if (leftBehind.length) {
    fail.push(`the core door still serves ${leftBehind.sort().join(", ")} — the evaluation ` +
              "tools are the eval door's, and a person who never installed that flow should " +
              "not be offered them");
  }
}

// ── 4. The flow's own skills can reach the tools they instruct ────────────────────────────
//
// COMPLETE AND UNREACHABLE is this platform's most expensive shape, because nothing fails: the
// tool exists, the skill is well written, and the call is simply not on a surface that agent
// carries. It is also the mutation clause 2 alone cannot catch — deleting a module's import
// AND its registration shrinks what this check expects by exactly as much as it shrinks what
// the door serves, and clause 2 stays green. The flow's skills are the outside witness.
const FLOW_DIR = "catalog/zz/zz-plugin-eval";
const skillsDir = `${FLOW_DIR}/skills`;
const instructed = new Set();
for (const sk of listDir(skillsDir)) {
  const md = join(skillsDir, sk, "SKILL.md");
  if (!existsSync(md)) continue;
  // Named as a CALL — `tool(` or `tool` in backticks — not merely mentioned in prose.
  for (const m of (read(md) ?? "").matchAll(/`(plugin_[a-z0-9_]+)[(`]/g)) instructed.add(m[1]);
}
if (!instructed.size) {
  blind.push(`${skillsDir}/*/SKILL.md — no plugin_* tool is instructed as a call by any skill ` +
             "of the flow that owns this door, so the reachability clause asserted nothing");
} else {
  for (const tool of instructed) {
    if (!evalTools.has(tool) && !coreTools.has(tool)) {
      fail.push(`the zz-plugin-eval flow instructs ${tool} and NO door serves it — the skill ` +
                "is complete, the agent is provisioned, and the call it depends on is on no surface");
    }
  }
  if (evalClient && ![...instructed].some((t) => evalTools.has(t))) {
    fail.push("not one tool the zz-plugin-eval flow instructs is on the door that flow declares " +
              "— whatever is mounted at the eval path, it is not that flow's instrument");
  }
}

// ── 5. The mount, and the URL the gateway fetches, are the same path ──────────────────────
//
// IMPORTED, NOT MATCHED. `EVAL_URL` is the value the running proxy passes to `fetch`, so this
// compares zz-core's mount against what the gateway would actually request. A mount at
// `/eval-mcp` behind a gateway fetching `/eval` is two correct-looking lines and a door that
// answers 404 to every call, with nothing in either file that looks wrong.
let EVAL_URL = null, CORE_URL = null;
try {
  ({ EVAL_URL, CORE_URL } = await import("../services/gateway/dist/relay.js"));
} catch (err) {
  fail.push(`the gateway's relay module could not be imported, so the door's upstream was ` +
            `never compared with its mount: ${err?.message ?? err}`);
}
const coreCode = stripComments(coreSrc ?? "");
const mounts = new Map([...coreCode.matchAll(/serveMcp\(app,\s*"([^"]+)",\s*(\w+)\)/g)]
  .map((m) => [m[2], m[1]]));
if (coreSrc && !mounts.size) {
  blind.push(`${CORE_SRC_PATH} — no serveMcp(app, "path", factory) call found, so every ` +
             "assertion about what this service mounts passed on nothing");
}
if (coreSrc && !mounts.has("buildEvalServer")) {
  fail.push(`${CORE_SRC_PATH} does not mount buildEvalServer — this check's whole handshake is ` +
            "then about a door the service does not serve");
} else if (EVAL_URL) {
  const mounted = mounts.get("buildEvalServer");
  const wanted = new URL(EVAL_URL).pathname;
  if (mounted !== wanted) {
    fail.push(`zz-core mounts the evaluation door at ${mounted} and the gateway fetches ` +
              `${wanted} (EVAL_URL is ${EVAL_URL}) — every call through that door would 404`);
  }
}
// The control: the core door is still mounted, by its own factory, at its own path.
if (coreSrc && mounts.get("buildServer") !== "/mcp") {
  fail.push(`the core door is no longer mounted by buildServer at /mcp (found ` +
            `${JSON.stringify(mounts.get("buildServer") ?? null)})`);
}

// ── 6. The gateway routes the door, and forwards it to the right upstream ─────────────────
//
// COMMENT-STRIPPED, so a route described in prose cannot stand in for a route. And each door's
// handler is required to name its OWN upstream and not the other's: `/eval/mcp` wired to
// `CORE_URL` serves the core door's tools under the evaluation door's name, which is the one
// outcome this whole task exists to prevent and which every clause about mounting is blind to.
const gwCode = stripComments(gwSrc ?? "");
/** The text of one `app.all("<path>", …)` registration, to the start of the next one. */
const routeFor = (path) => {
  const at = gwCode.indexOf(`app.all("${path}"`);
  if (at < 0) return null;
  const next = gwCode.indexOf("app.all(", at + 1);
  return gwCode.slice(at, next < 0 ? gwCode.length : next);
};
for (const [path, own, other] of [["/eval/mcp", "EVAL_URL", "CORE_URL"],
                                  ["/core/mcp", "CORE_URL", "EVAL_URL"]]) {
  const route = routeFor(path);
  if (!route) { fail.push(`the gateway does not route ${path}`); continue; }
  if (!route.includes(own)) {
    fail.push(`the gateway routes ${path} and its handler never names ${own} — a door that ` +
              "does not reach its own upstream is a name with nothing behind it");
  }
  if (route.includes(other)) {
    fail.push(`the gateway routes ${path} through ${other} — that door would serve the other ` +
              "door's tools under this door's name");
  }
}

// ── 7. The door is announced, and the flow that owns it declares it ───────────────────────
//
// DOORS is unauthenticated and is how anyone who reaches this gateway learns what it offers;
// the manifest is what puts the door into the `.mcp.json` of the plugin that ships the flow.
// A door nobody can find and nobody installs is a door only this check knows about.
// SHAPE CHANGED AT TASK I-33: DOORS was an array of `{ path: … }` a person typed, and is now a
// record keyed by the express path each door is MOUNTED at, with `doorIndex()` reading the
// mounted paths off the router. A regex still looking for the old shape would find nothing, so
// not finding it is reported as this scan going BLIND rather than shrugged at.
const doorsBlock = /const DOORS: Record<[\s\S]*?> = \{([\s\S]*?)\n\};/.exec(gwCode)?.[1] ?? null;
if (gwSrc && !doorsBlock) {
  blind.push(`${GW_SRC_PATH} — DOORS could not be located, so nothing about what the gateway ` +
             "announces was checked");
} else if (doorsBlock) {
  const announced = new Set([...doorsBlock.matchAll(/^ {2}"([^"]+)":/gm)].map((m) => m[1]));
  for (const p of ["/eval/mcp", "/core/mcp"]) {          // the second is the control
    if (!announced.has(p)) fail.push(`DOORS does not announce ${p}`);
  }
}
const mfRaw = read(`${FLOW_DIR}/flow.json`);
if (mfRaw !== null) {
  let mf = null;
  try { mf = JSON.parse(mfRaw); } catch { blind.push(`${FLOW_DIR}/flow.json (unparseable)`); }
  if (mf) {
    const paths = (mf.servers ?? []).map((s) => s.path);
    if (!paths.includes("/eval/mcp")) {
      fail.push("zz-plugin-eval does not declare /eval/mcp in its manifest's servers, so the " +
                "plugin that ships this flow would not carry the door its tools are on");
    }
    if (paths.includes("/core/mcp")) {
      fail.push("zz-plugin-eval still declares /core/mcp — a door every account already has, " +
                "which makes the declaration true and useless");
    }
  }
}

// ── 8. The door's traffic is recorded as ours ─────────────────────────────────────────────
//
// `blockOf` is CALLED, not read. The gateway files one telemetry row per tool call under a
// surface name, and anything it does not recognise as the platform's own IS a building block —
// the surface name is how `/p/<block>/mcp` is routed. So a new door whose name was never added
// to that set does not merely get a wrong label: every evaluation call is recorded as traffic
// to a third-party block nobody granted and no registry has heard of.
// AND IT TAKES ITS PATHS FROM DOORS, NOT FROM A LIST OF ITS OWN. It was a literal array of the
// same four paths written a second time — which is how a door gets added to the routes and not
// to the telemetry: nothing fails, nothing is empty, and every call through it is filed under
// `core`. Asserting "/eval/mcp appears in that array" only ever caught the door this task
// added; asserting the array IS DOORS catches every door anybody adds after it.
if (!/app\.use\(Object\.keys\(DOORS\),/.test(gwCode)) {
  fail.push("the telemetry mount does not take its paths from DOORS, so what this gateway " +
            "serves and what it records are two lists again — and a door in the first and not " +
            "the second has every call through it filed under the core door's name");
}
// AND THE NAME IS CALLED FOR, NOT READ. Being in the mount list above is half of it: the
// middleware asks a function which door a request came through, and that function falls
// through to "core". A door in the list and absent from the function has every call recorded
// under the core door's name — and `TOOL_ALIAS` is keyed by surface, so those names are then
// resolved through the CORE map and land in a different series. Nothing fails, nothing is
// empty, and every number about this door is quietly somebody else's. That is why
// `doorSurface` is an exported function of the URL rather than a lambda inside server.ts:
// reading a branch out of source proves the branch is written, never that it is the one that
// runs.
let doorSurfaceOfEval = "(never asked)";
try {
  const { doorSurface } = await import("../services/gateway/dist/tool-telemetry.js");
  const { blockOf } = await import("../services/gateway/dist/step-trace.js");
  const surface = doorSurface("/eval/mcp");
  doorSurfaceOfEval = surface;
  if (surface === "core") {
    fail.push("a call through /eval/mcp is recorded under surface \"core\" — the telemetry " +
              "namer never learned this door, so its calls are filed as the core door's and " +
              "their tool names resolve through the core door's alias map");
  } else if (!surface) {
    fail.push("a call through /eval/mcp is recorded under no surface at all");
  }
  // The controls: the same function must still name the doors it already knew. A namer that
  // answered "eval" to everything would satisfy the clause above.
  for (const [url, want] of [["/core/mcp", "core"], ["/manage/mcp", "manage"],
                             ["/p/casebox/mcp", "casebox"]]) {
    if (doorSurface(url) !== want) {
      fail.push(`doorSurface(${url}) is ${JSON.stringify(doorSurface(url))} and not ` +
                `${JSON.stringify(want)} — the clause above then passes on a namer that ` +
                "answers the same thing to every door");
    }
  }
  if (blockOf(surface) !== undefined) {
    fail.push(`blockOf(${JSON.stringify(surface)}) answers that the evaluation door is a ` +
              "BUILDING BLOCK — its surface name belongs in step-trace's PLATFORM_SURFACES, " +
              "or every call through it is filed as a third party's");
  }
  // The same control on the other function: one that answered `undefined` to everything would
  // satisfy the clause above without recognising anything.
  if (blockOf("casebox") !== "casebox") {
    fail.push("blockOf no longer recognises a building block by its surface name — the clause " +
              "above then passes on a function that answers `undefined` to everything");
  }
} catch (err) {
  fail.push(`the gateway's telemetry modules could not be imported, so nothing about how this ` +
            `door's calls are recorded was checked: ${err?.message ?? err}`);
}

// A path this check reads that has moved is this scan going blind, and it is said FIRST: every
// assertion about that file passed on nothing.
for (const p of new Set(blind)) {
  fail.unshift(`${p} could not be read — this check asserts over it, so those assertions ` +
               "passed on nothing. Point it at where it went.");
}

for (const c of [evalClient, coreClient]) { try { await c?.close(); } catch { /* closing is not the assertion */ } }

if (fail.length) { console.error([...new Set(fail)].join("\n")); process.exit(1); }
// WHAT WAS ACTUALLY ASSERTED, ON THE GREEN LINE — the two doors by the tool counts a client
// saw, so a reader can tell at a glance whether this ran against the surface they think it did.
console.log(`eval door: ok — zz-core serves two doors a client can open: /mcp ` +
            `(${coreTools.size} tools, none of them plugin_*) and ${new URL(EVAL_URL).pathname} ` +
            `(${evalTools.size} tools, every one declared by a module it imports, every one in ` +
            `OWN_TOOLS), no tool on both; the gateway routes /eval/mcp to EVAL_URL and ` +
            `/core/mcp to CORE_URL, announces both in DOORS, records its calls under surface ` +
            `"${doorSurfaceOfEval}" as the platform's own, and zz-plugin-eval declares ` +
            `/eval/mcp.\n` +
            `           NOT COVERED: which door a tool is on is absent from the surface record ` +
            `— zz.block_tool has no door column, so eval_block_surface('platform') will report ` +
            `NO CHANGE when the ${evalTools.size} tools on that door move. That is Task I-39, and this check passing ` +
            `does not speak to it.`);
