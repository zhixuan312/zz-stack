/**
 * `platform_status`, `release_list`, `activity_refusals`, `run_summary` and `record_read` — the
 * console's reads, on the door every caller carries, a member's token included.
 *
 * The values are the gateway's: each page is answered by a function of its caller and its arguments
 * (services/gateway/src/console/agent-reads.ts), and zz-core, which may not import a service, asks the
 * gateway's agent door for that function's answer (`POST /internal/agent-read/<tool>`). The request
 * carries the tool's arguments as the caller sent them, once this door's schema has dropped any it does
 * not declare, and the `x-zz-*` identity headers exactly as this request received them from the
 * gateway; never a credential, which never reaches zz-core. The gateway rebuilds the person from those
 * headers as every other tool's team is decided, so no tool here takes a team or a scope.
 *
 * Each answer is one object twice: as structured content, and as a text part that is its JSON, so a
 * client that shows only one half shows the same values. `platform_status` leaves out each door's
 * day-by-day array from both and keeps its totals, run and finding.
 *
 * An input error is the read's own sentence, as `ERROR: …`; the gateway unreachable, or answering
 * anything but its DTO, is an `ERROR` saying the read is unavailable.
 *
 * COUPLED: the arguments are AGENT_READS', and the door is services/gateway/src/agent-door.ts, which
 * answers only the peer its CORE_PEERS resolves to. checks/core-agent-reads.ts drives both halves.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { READS, requestHeaders, text } from "@zz/mcp-http";
import { z } from "zod";

/** The gateway on the compose network, never its public address: the door answers zz-core alone. */
const GATEWAY = (process.env.GATEWAY_INTERNAL_URL || "http://cred-proxy:8000").replace(/\/+$/, "");
/** How long a read may take before it is answered as unavailable. */
const TIMEOUT_MS = 60_000;

type Read = "platform_status" | "release_list" | "activity_refusals" | "run_summary" | "record_read";
type Obj = Record<string, unknown>;

const unavailable = (tool: Read): ReturnType<typeof text> =>
  text(`ERROR: ${tool} is unavailable right now — the platform's reads could not be reached. Nothing ` +
       "was changed and nothing needs reconnecting: retry the call.");

/** Status without each door's days: the totals, run and finding stay. */
function withoutDays(status: Obj): Obj {
  const doors = status.doors as { state?: string; data?: Obj[] } | undefined;
  if (doors?.state !== "ok" || !Array.isArray(doors.data)) return status;
  return { ...status, doors: { ...doors, data: doors.data.map(({ days: _days, ...door }) => door) } };
}

/** One read through the gateway's agent door, as the tool's answer. */
async function agentRead(tool: Read, args: Obj) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  for (const [k, v] of Object.entries(requestHeaders())) {
    if (k.startsWith("x-zz-") && v !== undefined) headers[k] = Array.isArray(v) ? v.join(", ") : v;
  }
  let status: number, body: unknown;
  try {
    const res = await fetch(`${GATEWAY}/internal/agent-read/${tool}`, {
      method: "POST", headers, body: JSON.stringify({ arguments: args }), signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    status = res.status;
    body = await res.json().catch(() => null);
  } catch (err) {
    console.error(`${tool}: the gateway's agent door could not be reached:`, err instanceof Error ? err.message : err);
    return unavailable(tool);
  }
  const error = (body as { error?: unknown } | null)?.error;
  if (status === 400 && typeof error === "string") return text(`ERROR: ${error}`);
  if (status !== 200 || body === null || typeof body !== "object" || Array.isArray(body)) {
    console.error(`${tool}: the gateway's agent door answered ${status}${typeof error === "string" ? `: ${error}` : ""}`);
    return unavailable(tool);
  }
  const structuredContent = tool === "platform_status" ? withoutDays(body as Obj) : body as Obj;
  return { structuredContent, content: [{ type: "text" as const, text: JSON.stringify(structuredContent) }] };
}

export function registerAgentReadTools(server: McpServer): void {
  server.registerTool(
    "platform_status",
    {
      annotations: READS,
      description:
        "The platform's status as the console's Status page reads it to you: what needs attention, " +
        "the measures week by week, each door's totals and run of clear days, the records, what is " +
        "running and the counts of your own reports, each part with its coverage. With `tool` (a tool " +
        "one of the doors registers, or a door: core, manage, eval or console) it also answers that " +
        "tool's open bug reports as their public summaries, with their count and coverage. One object, " +
        "as structured content and as its JSON text; each door's day-by-day array is left out of both.",
      inputSchema: { tool: z.string().optional() },
    },
    async ({ tool }) => agentRead("platform_status", { tool }),
  );

  server.registerTool(
    "release_list",
    {
      annotations: READS,
      description:
        "The platform's releases as the console's Releases page reads them, newest first: each " +
        "release's summary, its upgrade notes, what a client must do after it, and the window the " +
        "platform has observed it over. `limit` is how many (5 unless asked, at most 50); `since` names " +
        "a release's version and answers only the releases recorded after it, in recorded order. An " +
        "unknown version is refused, never read as every release. Not the evaluation door's release_* " +
        "tools, which promote a plugin's candidate. One object, as structured content and as its JSON text.",
      inputSchema: { limit: z.number().optional(), since: z.string().optional() },
    },
    async ({ limit, since }) => agentRead("release_list", { limit, since }),
  );

  server.registerTool(
    "activity_refusals",
    {
      annotations: READS,
      description:
        "The refused calls of the team you act for (session_whoami says which), as the console's " +
        "Activity page reads them: calls and refusals by week, whose each refusal is, the refusals by " +
        "tool and the ten most frequent messages with their counts and when each was last seen. " +
        "`since` is a date, YYYY-MM-DD, seven days before today unless asked; `initiative` narrows it " +
        "to one of your team's initiatives. Takes no team. One object, as structured content and as " +
        "its JSON text.",
      inputSchema: { since: z.string().optional(), initiative: z.string().optional() },
    },
    async ({ since, initiative }) => agentRead("activity_refusals", { since, initiative }),
  );

  server.registerTool(
    "run_summary",
    {
      annotations: READS,
      description:
        "The observed skill runs of the team you act for (session_whoami says which), as the console's " +
        "Runs page reads them: how many, their calls and output bytes, by skill, the most recent runs " +
        "and the read's coverage. `since` is a date, YYYY-MM-DD, seven days before today unless asked; " +
        "`skill` narrows it to one skill. Takes no team. One object, as structured content and as its " +
        "JSON text.",
      inputSchema: { since: z.string().optional(), skill: z.string().optional() },
    },
    async ({ since, skill }) => agentRead("run_summary", { since, skill }),
  );

  server.registerTool(
    "record_read",
    {
      annotations: READS,
      description:
        "The record of the team you act for (session_whoami says which), as the console's Record page " +
        "reads it: what was delivered and approved, the approvals in your name, and the estimate's " +
        "basis and pace, each with its coverage. `period` is quarter, year or all (all unless asked). " +
        "Takes no team. One object, as structured content and as its JSON text.",
      // A string, not an enum: a period outside the vocabulary is the read's own refusal, in this
      // door's ERROR form, rather than the SDK's validation message.
      inputSchema: { period: z.string().optional() },
    },
    async ({ period }) => agentRead("record_read", { period }),
  );
}
