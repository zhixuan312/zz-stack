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
 * OUR OWN SURFACE IS ONE SET ACROSS BOTH DOORS, and that is a deliberate limitation rather
 * than an oversight. `zz.block_tool` records `(block_version_id, name)` — it has no column for
 * which door a tool was served on — so what `eval_block_surface('platform')` can answer is
 * "these are the tools this version of the platform served", which stays TRUE with two doors,
 * and not "this one is on the evaluation door", which it could not answer before either. The
 * day that distinction is worth having is the day it needs a migration, and that is a
 * different change from this one.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { text } from "@zz/mcp-http";

import { Refusal } from "./refusal.js";

/** Every tool name either door has registered, in this process, since it started.
 *
 * ACCUMULATED ACROSS DOORS AND ACROSS BUILDS. The doors are stateless, so a server is built
 * per request and this set is filled again on every one of them — a Set of names, so that
 * costs nothing and means the record does not depend on which door was asked first. */
export const OWN_TOOLS = new Set<string>();

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
export function recordingDoor(server: McpServer): McpServer {
  type RegisterTool = typeof server.registerTool;
  const rawRegisterTool: RegisterTool = server.registerTool.bind(server);
  (server as unknown as { registerTool: RegisterTool }).registerTool = ((
    name: string, config: unknown, cb: (...a: unknown[]) => unknown,
  ) => {
    // OUR OWN SURFACE, RECORDED AS IT IS DECLARED. Every other block is measured by probing
    // it — we do not have to guess at ours, because this is the line that creates it.
    OWN_TOOLS.add(name);
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
