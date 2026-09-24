// The evaluation door is a door: it is mounted, it serves its own tools and not the core door's,
// the gateway routes to it and forwards to it rather than to zz-core's other mount, and the flow
// that owns it declares it.
//
// It opens real clients and imports real constants. `buildEvalServer` is imported from dist and
// run, an `InMemoryTransport` pair carries a real `initialize` and a real `tools/list` between a
// real `Client` and it, and what the door serves is read off that client. `CORE_URL` and `EVAL_URL`
// are imported from the gateway's own module rather than matched in its source, so what is compared
// is the value the running proxy would fetch, and `doorSurface` and `pluginForDoor` are called
// rather than read.
//
// What no clause here speaks to: the /manage door is built in the gateway's process, which has no
// recordingDoor and writes no zz.plugin_tool row, so the recorded surface is this service's two
// doors and not every tool the platform serves.
//
// COUPLED: every door's paragraph — its `instructions`, their length, the skill it points at, its
// `NOT FOR:` line, and the nouns it claims against the nouns it serves — belongs to
// checks/orientation.ts.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

// Before any dynamic import in this file. @zz/catalog reads ZZ_CATALOG_DIR once, at module load,
// and defaults to `/catalog` — a path that exists in the container and not in a checkout. Half the
// dynamic imports below pull it in transitively, so setting it beside the call that needs it is
// too late and `pluginForDoor` then reports that no door has a plugin, reading an empty directory.
process.env.ZZ_CATALOG_DIR ??= join(process.cwd(), "catalog");

/** A caught value is never typed as an Error — narrow the shape actually being read rather
 *  than assume it. `unknown?.message` narrows to `{}`, which has no properties at all. */
function errMessage(err: unknown): string {
  if (err && typeof err === "object" && "message" in err) {
    const m = (err as Record<string, unknown>).message;
    if (m !== undefined && m !== null) return String(m);
  }
  return String(err);
}

const fail: string[] = [];
const blind: string[] = [];

/** Read a path, or record that this scan went blind on it. A check that throws has no failure
 *  path — "nothing found" and "nothing to find" are the same answer unless one of them says so. */
const read = (p: string) => { try { return readFileSync(p, "utf8"); } catch { blind.push(p); return null; } };
const listDir = (d: string) => { try { return readdirSync(d); } catch { blind.push(d); return []; } };

/** Source with its comments taken out, tracking strings so a quoted `/*` cannot open one.
 *
 * A character scanner, not a line-wise stripper: a line comment ending "…/auth/*" opens a block
 * comment a line-wise stripper never closes, blanking the rest of the file — and a stripper that
 * silently empties the region it is asked about turns every assertion over that region green. */
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

/** A real client, connected to a real server over a linked in-memory transport pair. */
async function connectTo(server: McpServer) {
  const [forServer, forClient] = InMemoryTransport.createLinkedPair();
  await server.connect(forServer);
  const client = new Client({ name: "checks/eval-door.ts", version: "0" });
  await client.connect(forClient);
  return client;
}
/** The tools a door actually serves, as a client sees them.
 *
 * Guarded, because the empty door is the case this file exists for. A server with no tool
 * registered never declares the `tools` capability, so the SDK answers `tools/list` with
 * `-32601 Method not found` and the client throws. No tools is an answer, and clause 1 says so. */
const surfaceOf = async (client: Client) => {
  try {
    return new Set((await client.listTools()).tools.map((t) => t.name));
  } catch {
    return new Set<string>();
  }
};

const CORE_SRC_PATH = "services/zz-core/src/server.ts";
const EVAL_SRC_PATH = "services/zz-core/src/eval-door.ts";
const GW_SRC_PATH = "services/gateway/src/server.ts";
const coreSrc = read(CORE_SRC_PATH);
const evalSrc = read(EVAL_SRC_PATH);
const gwSrc = read(GW_SRC_PATH);

// The evaluation door, built by the function the service mounts
let evalClient = null;
try {
  const { buildEvalServer } = await import("../services/zz-core/dist/eval-door.js");
  evalClient = await connectTo(buildEvalServer());
} catch (err) {
  fail.push(`the evaluation door could not be built or connected: ${errMessage(err)}`);
}

// The core door, built the way zz-core builds it
//
// Its tool modules are read out of server.ts's own imports rather than listed here, so this opens
// the door as it is today.
let coreClient = null;
// The word buildServer passes to recordingDoor, read off the source and not typed here.
// server.ts binds :8000 at module scope, so buildServer cannot be imported and this file
// reconstructs it. Supplying the word here would report a correctly recorded door for a service
// that records none, so a buildServer that stops wrapping, or wraps without naming a door, leaves
// this null and fails below.
const coreDoorWord =
  /recordingDoor\(\s*coreServer\([\s\S]*?\)\s*,\s*"([^"]+)"\s*\)/.exec(stripComments(coreSrc ?? ""))?.[1] ?? null;
if (coreSrc && coreDoorWord === null) {
  fail.push(`${CORE_SRC_PATH}'s buildServer does not wrap its server in recordingDoor with a ` +
            "door name — the core door's tools would then be absent from the surface this " +
            "platform records about itself, or present with no door against them, and its " +
            "refusals would arrive in a shape nothing here expects");
}
try {
  const { coreServer } = await import("../services/zz-core/dist/orientation.js");
  const { recordingDoor } = await import("../services/zz-core/dist/door.js");
  const server = coreDoorWord === null
    ? coreServer("0.0.0-eval-door-check")
    : recordingDoor(coreServer("0.0.0-eval-door-check"), coreDoorWord);
  const mods = [...(coreSrc ?? "").matchAll(/import \{ (register\w+) \} from "(\.\/tools\/[\w-]+)\.js"/g)];
  if (!mods.length) blind.push(`no tool modules found imported by ${CORE_SRC_PATH}`);
  for (const [, fn, rel] of mods) {
    const mod = await import(`../services/zz-core/dist/${rel.replace(/^\.\//, "")}.js`);
    mod[fn](server);
  }
  coreClient = await connectTo(server);
} catch (err) {
  fail.push(`the core door could not be built or connected: ${errMessage(err)}`);
}

const evalTools = evalClient ? await surfaceOf(evalClient) : new Set<string>();
const coreTools = coreClient ? await surfaceOf(coreClient) : new Set<string>();

// 1. A door that is mounted and serves nothing is not a door
//
// The mount is the half that greps green. An empty factory answers `initialize` perfectly and
// `tools/list` with `[]`, which is indistinguishable from outside from a door whose tools failed
// to register.
if (evalClient && evalTools.size === 0) {
  fail.push("the evaluation door is mounted and serves NO tools — it answers initialize and " +
            "offers nothing, which is what a dropped register call looks like from outside");
}
// The same control on the other side: every disjointness clause below reads as satisfied
// against a core door that serves nothing at all.
if (coreClient && coreTools.size === 0) fail.push("the core door served no tools — this scan is blind");

// 2. The door serves exactly what its own modules register
//
// Derived from eval-door.ts's own imports, never listed here, so a door that grows a tool is
// opened by this check with that tool on it. What it catches is a module imported and
// never registered, or a name served that nothing declares.
if (evalSrc && evalClient) {
  // Any relative path, not just `./tools/`, so relocating these modules does not turn this red.
  // `register\w+` is what selects a tool module — `./door.js` imports `recordingDoor` and is
  // correctly not one.
  const mods = [...evalSrc.matchAll(/import \{ register\w+ \} from "(\.\/[\w/-]+)\.js"/g)]
    .map((m) => m[1].replace(/^\.\//, ""));
  if (!mods.length) {
    // Not "blind": this one is an answer. A door file that imports no tool module is a door with
    // nothing to register.
    fail.push(`${EVAL_SRC_PATH} imports no tool module at all, so there is nothing for the ` +
              "evaluation door to register — whatever is mounted there serves an empty list");
  } else {
    const declared = new Set<string>();
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

// 2b. The door's tools reach the surface this platform records about itself
//
// `recordingDoor` records each name in OWN_TOOLS against the door it is declared on and turns a
// thrown `Refusal` into this platform's refusal shape. A door built without it serves a working
// tool list while its tools are missing from the surface record. The builder above has already run,
// so OWN_TOOLS holds what that run declared; this is not a grep for the word.
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
              `checked: ${errMessage(err)}`);
  }
}

// 3. Two doors, two tool sets
//
// `/core/mcp` is in the client package's required baseline plugin, so a tool served there is on
// every account on the platform; a tool served on both is on every account and counted twice by
// anything that reads a door's surface.
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

// 4. The flow's own skills can reach the tools they instruct
//
// Complete and unreachable: the tool exists, the skill is well written, and the call is not on a
// surface that agent carries. Clause 2 alone cannot catch it — deleting a module's import and its
// registration shrinks what that clause expects by exactly as much as it shrinks what the door
// serves. The flow's skills are the outside witness.
const FLOW_DIR = "catalog/zz/zz-plugin-eval";
const skillsDir = `${FLOW_DIR}/skills`;
const instructed = new Set<string>();
for (const sk of listDir(skillsDir)) {
  const md = join(skillsDir, sk, "SKILL.md");
  if (!existsSync(md)) continue;
  // Named as a call — `tool(` or `tool` in backticks — not merely mentioned in prose.
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

// 5. The mount, and the URL the gateway fetches, are the same path
//
// Imported, not matched. `EVAL_URL` is the value the running proxy passes to `fetch`, so this
// compares zz-core's mount against what the gateway would actually request. A mount at
// `/eval-mcp` behind a gateway fetching `/eval` is two correct-looking lines and a door that
// answers 404 to every call.
let EVAL_URL: string | null = null;
try {
  ({ EVAL_URL } = await import("../services/gateway/dist/relay.js"));
} catch (err) {
  fail.push(`the gateway's relay module could not be imported, so the door's upstream was ` +
            `never compared with its mount: ${errMessage(err)}`);
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

// 6. The gateway routes the door, and forwards it to the right upstream
//
// Comment-stripped, so a route described in prose cannot stand in for a route. Each door's handler
// is required to name its own upstream and not the other's: `/eval/mcp` wired to `CORE_URL` serves
// the core door's tools under the evaluation door's name.
const gwCode = stripComments(gwSrc ?? "");
/** The text of one `app.all("<path>", …)` registration, to the start of the next one. */
const routeFor = (path: string) => {
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

// 7. The door is announced, and the flow that owns it declares it
//
// DOORS is unauthenticated and is how anyone reaching this gateway learns what it offers; the
// manifest is what puts the door into the `.mcp.json` of the plugin that ships the flow. DOORS is a
// record keyed by the express path each door is mounted at, and a regex that no longer matches it
// is reported as this scan going blind rather than shrugged at.
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
    const paths = (mf.servers ?? []).map((s: { path: string }) => s.path);
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

// 8. The door's traffic is recorded as ours
//
// `doorSurface` is called, not read. The gateway files one telemetry row per tool call under a
// surface name, and anything it does not recognise falls through to `core`, so a door whose name
// was never added has every call recorded as the core door's. The telemetry mount takes its paths
// from DOORS rather than a second list of the same paths, so every door added after this one is
// covered.
if (!/app\.use\(Object\.keys\(DOORS\),/.test(gwCode)) {
  fail.push("the telemetry mount does not take its paths from DOORS, so what this gateway " +
            "serves and what it records are two lists again — and a door in the first and not " +
            "the second has every call through it filed under the core door's name");
}
// And the name is called for, not read. The middleware asks a function which door a request came
// through, and that function falls through to "core", so a door in the mount list and absent from
// the function has every call recorded under the core door's name — and `TOOL_ALIAS` is keyed by
// surface, so those names then resolve through the core map. `doorSurface` is an exported function
// of the URL rather than a lambda inside server.ts, because reading a branch out of source proves
// it is written, never that it is the one that runs.
let doorSurfaceOfEval = "(never asked)";
try {
  const { doorSurface } = await import("../services/gateway/dist/tool-telemetry.js");
  const { pluginForDoor } = await import("../packages/catalog/dist/index.js");
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
  for (const [url, want] of [["/core/mcp", "core"], ["/manage/mcp", "manage"]]) {
    if (doorSurface(url) !== want) {
      fail.push(`doorSurface(${url}) is ${JSON.stringify(doorSurface(url))} and not ` +
                `${JSON.stringify(want)} — the clause above then passes on a namer that ` +
                "answers the same thing to every door");
    }
  }
  // And whose calls they are. A door is a plugin's declared server, so this door's traffic belongs
  // to the plugin whose manifest declares `/eval/mcp`, and to no other.
  if (pluginForDoor(surface) !== "zz-plugin-eval") {
    fail.push(`pluginForDoor(${JSON.stringify(surface)}) is ` +
              `${JSON.stringify(pluginForDoor(surface))} and not "zz-plugin-eval" — every call ` +
              "through this door is attributed to the wrong plugin, or to none");
  }
  // The control: a function answering "zz-plugin-eval" to everything would satisfy that.
  if (pluginForDoor("core") !== "zz-core") {
    fail.push("pluginForDoor no longer names the core door's plugin — the clause above then " +
              "passes on a function that answers the same thing to every door");
  }
  // And it must not invent one. `admin` is not a door; no manifest claims it.
  if (pluginForDoor("admin") !== null) {
    fail.push("pluginForDoor names a plugin for a surface no manifest declares — attribution " +
              "has to come back null rather than guess");
  }
} catch (err) {
  fail.push(`the gateway's telemetry modules could not be imported, so nothing about how this ` +
            `door's calls are recorded was checked: ${errMessage(err)}`);
}

// 9. Which door a tool is on reaches the surface record, and a reader can see it
//
// `zz.plugin_tool` carries a `door` column, `recordingDoor` writes it, and
// `zz-tool plugin-surface` reads it back. Without that column the recorded surface is a set of
// names, so moving tools between doors leaves it identical.
//
// The three clauses below are those three halves, and each fails on its own:
//
//   a. The write. `OWN_TOOLS` is filled by the registration itself, so this is what the two real
//      doors just recorded about themselves in this process.
//   b. The vocabulary. The word recorded has to be the gateway's own word for that door, or the
//      recorded surface cannot be read against the recorded calls: `zz.event.tool_key` is
//      `<surface>:<tool>` written from `doorSurface()`.
//   c. The read. `diffSurfaces` is driven over the same names moved between doors and required to
//      report the moves.
if (evalTools.size && coreTools.size) {
  try {
    const { OWN_TOOLS } = await import("../services/zz-core/dist/door.js");
    const { doorSurface } = await import("../services/gateway/dist/tool-telemetry.js");
    const { diffSurfaces } = await import("../packages/tools/dist/lib/surface-diff.js");

    // (a) + (b): every tool the client saw, with the door the registration recorded for it,
    // against the gateway's own name for the door that serves it.
    const doorPairs: [Set<string>, string][] = [[evalTools, "/eval/mcp"], [coreTools, "/core/mcp"]];
    for (const [tools, path] of doorPairs) {
      const want = doorSurface(path);
      const wrong = [...tools].filter((t) => OWN_TOOLS.get(t) !== want).sort();
      if (wrong.length) {
        fail.push(`the surface record says ${wrong.map((t) => `${t}=${JSON.stringify(OWN_TOOLS.get(t) ?? null)}`).join(", ")} ` +
                  `for tools served at ${path}, and the gateway files that door's calls under ` +
                  `"${want}" — a recorded surface in a private vocabulary cannot be read ` +
                  "against the calls recorded for it, and null means the door was never " +
                  "recorded at all, which is the state that answered NO CHANGE to the move");
      }
    }

    // (c) The exact case, not a synthetic one: `before` is every name this service serves today
    // with all of them on the core door, which is the surface recorded before the plugin tools
    // moved. `after` is what the two builders recorded a moment ago.
    const after = [...OWN_TOOLS].map(([name, door]) => ({ name, door }));
    const before = after.map(({ name }) => ({ name, door: doorSurface("/core/mcp") }));
    const names = (xs: { name: string }[]) => xs.map((t) => t.name).sort().join(",");
    if (names(before) !== names(after)) {
      fail.push("this clause's before and after do not carry the same tool names, so it is no " +
                "longer the case it was written for — a diff that reports a change here proves " +
                "nothing, because the names changed too");
    }
    const moved = diffSurfaces({ version: "before", tools: before },
                               { version: "after", tools: after });
    const wantMoved = [...evalTools].sort().join(",");
    if (moved.moved.map((m) => m.name).sort().join(",") !== wantMoved) {
      fail.push(`the surface reader was given the same ${before.length} names before and after, ` +
                `with ${evalTools.size} of them served on a different door, and it reports ` +
                `${moved.moved.length} moved rather than ${evalTools.size} — that is the NO ` +
                "CHANGE this task exists to remove, back in the one place that reads the record");
    }
    if (moved.added.length || moved.removed.length) {
      fail.push("the surface reader invents an addition or a removal where every name is on " +
                "both sides — a fabricated finding is worse than a missed one");
    }

    // The control, and the half a green reader can still get wrong. A row whose door was never
    // recorded carries null, and `door ?? "core"` would report every eval tool as having moved out
    // of a door nothing ever recorded. The reader is required to answer "not comparable" here.
    const blind = diffSurfaces({ version: "pre-052", tools: after.map(({ name }) => ({ name, door: null })) },
                               { version: "after", tools: after });
    if (blind.moved.length) {
      fail.push(`the surface reader reports ${blind.moved.length} tool(s) as having changed door ` +
                "against a version that recorded no door at all — it is defaulting a null to a " +
                "door somebody guessed, and every tool that was already on the other door reads " +
                "as a move that never happened");
    }
    if (blind.undecidable.length !== after.length) {
      fail.push("the surface reader does not report a version with no recorded doors as " +
                "undecidable — an operator reading \"no tool changed door\" there has been told " +
                "something the record cannot support");
    }
  } catch (err) {
    fail.push(`what the platform records about which door a tool is on could not be checked: ` +
              `${errMessage(err)}`);
  }
}

// A path this check reads that has moved is this scan going blind, and it is said first: every
// assertion about that file passed on nothing.
for (const p of new Set(blind)) {
  fail.unshift(`${p} could not be read — this check asserts over it, so those assertions ` +
               "passed on nothing. Point it at where it went.");
}

for (const c of [evalClient, coreClient]) { try { await c?.close(); } catch { /* closing is not the assertion */ } }

if (fail.length) { console.error([...new Set(fail)].join("\n")); process.exit(1); }
// What was actually asserted, on the green line — the two doors by the tool counts a client saw,
// so a reader can tell at a glance whether this ran against the surface they think it did.
console.log(`eval door: ok — zz-core serves two doors a client can open: /mcp ` +
            `(${coreTools.size} tools, none of them plugin_*) and ${new URL(EVAL_URL!).pathname} ` +
            `(${evalTools.size} tools, every one declared by a module it imports, every one in ` +
            `OWN_TOOLS), no tool on both; the gateway routes /eval/mcp to EVAL_URL and ` +
            `/core/mcp to CORE_URL, announces both in DOORS, records its calls under surface ` +
            `"${doorSurfaceOfEval}" as the platform's own, and zz-plugin-eval declares ` +
            `/eval/mcp.\n` +
            `           AND THE RECORD SAYS WHICH DOOR: building both doors recorded every one ` +
            `of those names against the door that registered it, in the same words doorSurface ` +
            `answers, and the reader behind zz-tool plugin-surface reports all ${evalTools.size} ` +
            `as MOVED when the same name set is served from the other door — the NO CHANGE this ` +
            `used to say was not covered. What it still cannot see: the /manage door is the ` +
            `gateway's own process and records no surface at all, so the platform's recorded ` +
            `surface is this service's ${coreTools.size + evalTools.size} tools and not every ` +
            `tool the platform serves.`);
