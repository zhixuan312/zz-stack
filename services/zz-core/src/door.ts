/**
 * What is true of every tool on every door this service serves: two doors, one process, two
 * tool sets, and neither may have its own version of this. A builder that constructed its
 * server without it would serve tools whose refusals arrive in a different shape and whose
 * names are missing from the surface we record about ourselves, both silently.
 *
 * Our own surface is recorded per door, so a tool moving from one door to the other is a
 * surface change rather than nothing happening.
 *
 * The door is passed in rather than sniffed out: nothing on an `McpServer` says which path it
 * will be mounted at, the mount happening in server.ts long after the tools are registered.
 *
 * COUPLED: `core` and `eval` are what the gateway's `doorSurface()` answers for `/core/mcp`
 * and `/eval/mcp`, which is also the left half of `zz.event.tool_key`, so the recorded surface
 * and the recorded calls line up with no translation. checks/eval-door.ts compares what a real
 * build records here against what that function returns.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { text } from "@zz/mcp-http";

import { Refusal } from "./refusal.js";

/** Every tool name either door has registered in this process, and which door registered it.
 *
 * Accumulated across doors and across builds: the doors are stateless, so a server is built
 * per request and this map is filled again each time, keyed by name, so the record does not
 * depend on which door was asked first.
 *
 * DELIBERATE: a second registration of a name overwrites the first rather than accumulating a
 * list. COUPLED: checks/eval-door.ts fails on any name in both doors' tool lists, so the case
 * this would have to disambiguate cannot reach a green gate. */
export const OWN_TOOLS = new Map<string, string>();

/**
 * A door that records what it registers and turns a thrown `Refusal` into `text(message)`, for
 * every tool, in one place.
 *
 * This is not a rescue from a crash: the SDK already answers `isError: true` with the raw
 * `Error#message`. COUPLED: the gateway's refusal-counting matches `/^ERROR\b/`, which is the
 * shape every other refusal returns.
 *
 * DELIBERATE: patched on the instance, not renamed at each call site. A gate check splits tool
 * source on the literal string `server.registerTool(` to find each tool's body, so every
 * registration has to keep reading exactly that. The cast is confined to this one assignment;
 * each call is still checked against the SDK's generic signature, TypeScript resolving it
 * against the property's declared type rather than the value assigned at runtime.
 */
export function recordingDoor(server: McpServer, door: string): McpServer {
  type RegisterTool = typeof server.registerTool;
  const rawRegisterTool: RegisterTool = server.registerTool.bind(server);
  (server as unknown as { registerTool: RegisterTool }).registerTool = ((
    name: string, config: unknown, cb: (...a: unknown[]) => unknown,
  ) => {
    // Our own surface, recorded as it is declared, with the door it is declared on. This is
    // the only moment both facts are in one place: after the mount, nothing knows which
    // registrations belonged to which server.
    OWN_TOOLS.set(name, door);
    return rawRegisterTool(name, config as never, (async (...args: unknown[]) => {
      try {
        return await cb(...args);
      } catch (err) {
        if (err instanceof Refusal) return text(err.message);
        throw err; // not ours to soften — a genuine bug stays as loud as it is
      }
    }) as never);
  }) as RegisterTool;
  namesUnknownArguments(server);
  return server;
}

/** The argument names a tool's input schema declares. */
function declaredArguments(schema: unknown): string[] {
  const shape = (schema as { shape?: unknown } | undefined)?.shape;
  return shape && typeof shape === "object" ? Object.keys(shape) : [];
}

/**
 * An argument a tool does not take is dropped before its schema is checked, so a caller who wrote
 * `doc_path` hears "Invalid input at path" and never learns which name it used — a refusal the
 * zz-core evaluation read as one that does not explain itself. Where the SDK's validation refuses
 * a call that also carried names the tool does not declare, the refusal names them and the
 * arguments the tool does take. A call the schema accepts is untouched, extra names and all.
 *
 * DELIBERATE: patched on the instance, like `registerTool` above — `validateToolInput` is the
 * SDK's one validation path and has no hook. checks/door-unknown-arguments.ts pins it to the
 * installed SDK.
 */
function namesUnknownArguments(server: McpServer): void {
  type Validate = (tool: { inputSchema?: unknown }, args: unknown, name: string) => Promise<unknown>;
  const inner = server as unknown as { validateToolInput: Validate };
  const rawValidate: Validate = inner.validateToolInput.bind(server);
  inner.validateToolInput = async (tool, args, name) => {
    try {
      return await rawValidate(tool, args, name);
    } catch (err) {
      if (!(err instanceof McpError) || err.code !== ErrorCode.InvalidParams) throw err;
      const takes = declaredArguments(tool.inputSchema);
      const unknown = args && typeof args === "object" ? Object.keys(args).filter((k) => !takes.includes(k)) : [];
      if (!unknown.length) throw err;
      const said = err.message.replace(/^MCP error -?\d+: /, "");
      throw new McpError(ErrorCode.InvalidParams,
        `${said} — ${name} takes no ${unknown.map((k) => `\`${k}\``).join(", ")}; its arguments are ` +
        `${takes.map((k) => `\`${k}\``).join(", ")}`);
    }
  };
}
