/**
 * What is true of EVERY tool on EVERY door this service serves.
 *
 * There are two doors now — `/mcp` and `/eval-mcp`, one process, two tool sets — and this is
 * the part neither of them may have its own version of. It was written inside `buildServer`,
 * which was the only builder there was; a second builder that constructed its server without
 * it would serve tools whose refusals arrive in a different shape and whose names are missing
 * from the surface we record about ourselves, and nothing would have said so. Both failures
 * are silent, which is why this is a module and not a paragraph telling the next author to
 * remember.
 *
 * OUR OWN SURFACE IS RECORDED PER DOOR, and the door is passed IN rather than sniffed out.
 * This was one flat set of names for as long as `zz.block_tool` had no column for a door, and
 * that made a surface diff answer NO CHANGE when ten tools moved from one door to the other —
 * the largest surface change this platform has had, reported as nothing happening. Migration
 * 052 adds the column; this map is what fills it.
 *
 * THE DOOR IS THE BUILDER'S TO STATE. There is nothing on an `McpServer` that says which path
 * it will be mounted at — the mount happens in server.ts, long after the tools are registered —
 * so the only honest source is the builder that is about to hand it over. A `door` argument is
 * a thing TypeScript makes you supply; a heuristic over the server's `name` is a thing that
 * quietly answers "core" for the door it has never heard of.
 *
 * THE WORDS ARE THE GATEWAY'S, NOT A SECOND VOCABULARY. `core` and `eval` are what
 * `doorSurface()` answers for `/core/mcp` and `/eval/mcp`, which is also the left half of
 * `zz.event.tool_key` — so the recorded surface and the recorded calls line up with no
 * translation. checks/eval-door.mjs asserts that by comparing what a real build recorded here
 * against what that function returns, so the two cannot drift on a rename.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { text } from "@zz/mcp-http";

import { Refusal } from "./refusal.js";

/** Every tool name either door has registered, in this process, since it started, and WHICH
 *  DOOR registered it.
 *
 * ACCUMULATED ACROSS DOORS AND ACROSS BUILDS. The doors are stateless, so a server is built
 * per request and this map is filled again on every one of them — keyed by name, so that costs
 * nothing and means the record does not depend on which door was asked first.
 *
 * A NAME BELONGS TO ONE DOOR, and a second registration of it overwrites the first rather than
 * accumulating a list. That is not a guess about which door wins: a tool served by both doors
 * is a defect this repository already refuses — checks/eval-door.mjs fails on any name in both
 * tool lists, because the core door is in the required baseline plugin and a tool on both is a
 * tool everybody has after a move that was supposed to take it away. So the case this would
 * have to disambiguate cannot reach a green gate, and inventing a representation for it here
 * would be a second answer to a question one check already settles. */
export const OWN_TOOLS = new Map<string, string>();

/**
 * A door that RECORDS what it registers and softens a thrown `Refusal` into our refusal shape.
 *
 * A THROWN `Refusal` BECOMES `text(message)`, FOR EVERY TOOL, IN ONE PLACE.
 *
 * The SDK already catches whatever a handler throws and answers `isError: true` with the raw
 * `Error#message` — so this is not a rescue from a crash, it is the difference between that
 * generic shape and this platform's own "ERROR: …" refusal shape, which is what every other
 * refusal returns and what the gateway's own refusal-counting (tool-telemetry's `/^ERROR\b/`
 * check, knowledge_reconcile()'s comment about counting by refusal TEXT) already expects to
 * see.
 *
 * Patched on the INSTANCE, not renamed at each call site: a gate check (`a path is resolved
 * before the document at it is judged`, scripts/gate.mjs) splits tool source on the literal
 * string `server.registerTool(` to find each tool's body, so every registration has to keep
 * reading exactly that. The cast is confined to this one assignment; every
 * `server.registerTool(name, config, cb)` call is still checked against the SDK's own generic
 * signature, because TypeScript resolves the call against the declared type of the property,
 * not the value assigned to it at runtime.
 */
export function recordingDoor(server: McpServer, door: string): McpServer {
  type RegisterTool = typeof server.registerTool;
  const rawRegisterTool: RegisterTool = server.registerTool.bind(server);
  (server as unknown as { registerTool: RegisterTool }).registerTool = ((
    name: string, config: unknown, cb: (...a: unknown[]) => unknown,
  ) => {
    // OUR OWN SURFACE, RECORDED AS IT IS DECLARED, WITH THE DOOR IT IS DECLARED ON. Every
    // other block is measured by probing it — we do not have to guess at ours, because this is
    // the line that creates it. The door comes from the builder because this is the only
    // moment both facts are in one place: after the mount, nothing knows which registrations
    // belonged to which server.
    OWN_TOOLS.set(name, door);
    return rawRegisterTool(name, config as never, (async (...args: unknown[]) => {
      try {
        return await cb(...args);
      } catch (err) {
        if (err instanceof Refusal) return text(err.message);
        throw err; // not ours to soften — a genuine bug stays exactly as loud as it is today
      }
    }) as never);
  }) as RegisterTool;
  return server;
}
