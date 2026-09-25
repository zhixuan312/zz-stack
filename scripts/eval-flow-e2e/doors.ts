/**
 * One conversation's doors, the way a client holds them: one MCP session per door, opened with
 * `initialize` under one `x-zz-client`, so the gateway's telemetry stamps each call with the
 * plugin version the door announced and the step the last `skill_read` named — the same fields
 * OBSERVE later reads back.
 *
 * A stage of the walk gets a NEW `Conversation`: nothing carries across but what the caller
 * passes in by hand, which is exactly the initiative and the plugin name. Every id a stage uses
 * has to come back out of a call it made itself.
 */
import { Mcp } from "@zz/mcp-client";

const DOORS = { core: "/core/mcp", eval: "/eval/mcp", manage: "/manage/mcp" } as const;
type Door = keyof typeof DOORS;

/** One line per call, for the transcript the walk prints. */
interface CallRecord { readonly stage: string; readonly tool: string; readonly note: string }
export const transcript: CallRecord[] = [];

/** A tool's text parsed as an object, or `{ text }` when it is prose. */
export type Reply = Record<string, unknown> & { text?: string };

class Refused extends Error {
  readonly tool: string;
  readonly said: string;
  constructor(tool: string, said: string) {
    super(`${tool} refused: ${said.slice(0, 600)}`);
    this.tool = tool;
    this.said = said;
  }
}

export class Conversation {
  readonly #mcp: Record<Door, Mcp>;
  readonly stage: string;
  #n = 0;
  constructor(url: string, pat: string, stage: string, client = "eval-flow-e2e") {
    this.stage = stage;
    const open = (d: Door): Mcp => new Mcp(`${url}${DOORS[d]}`, { pat, client, timeoutMs: 600_000 });
    this.#mcp = { core: open("core"), eval: open("eval"), manage: open("manage") };
  }

  /** A fresh idempotency key for this conversation. Keys never cross a stage boundary: a fresh
   *  conversation has no memory of the keys an earlier one used. */
  key(what: string): string { this.#n += 1; return `${this.stage}-${what}-${this.#n}-${Date.now().toString(36)}`; }

  /** Calls a tool and parses its answer; a refusal throws `Refused` unless `refusal` says the
   *  walk expects one, in which case the text comes back as `{ text }`. */
  async call(door: Door, tool: string, args: Record<string, unknown>, opts: { refusal?: RegExp; note?: (r: Reply) => string } = {}): Promise<Reply> {
    const said = await this.#mcp[door].call(tool, args);
    const refused = /^ERROR[: ]/.test(said.trimStart());
    if (refused && !(opts.refusal && opts.refusal.test(said))) {
      transcript.push({ stage: this.stage, tool, note: `REFUSED ${said.slice(0, 160)}` });
      throw new Refused(tool, said);
    }
    let reply: Reply;
    try {
      const parsed: unknown = JSON.parse(said);
      reply = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Reply : { text: said };
    } catch { reply = { text: said }; }
    const note = refused ? `refused as expected: ${said.slice(0, 120)}` : (opts.note?.(reply) ?? "");
    transcript.push({ stage: this.stage, tool, note });
    return reply;
  }

  /** A shell step the stage ran (a CLI, a launcher), on the same transcript as its calls. */
  note(tool: string, note: string): void { transcript.push({ stage: this.stage, tool, note }); }

  /** The skill a stage starts by loading, through the door the way a client loads it — which is
   *  also what attributes this conversation's later calls to that step. */
  async skill(name: string): Promise<string> {
    const r = await this.call("core", "skill_read", { name });
    return typeof r.text === "string" ? r.text : JSON.stringify(r);
  }
}

/** A field of a reply as a string, or a thrown error naming what was missing — the walk's own
 *  version of "the agent could not obtain this id". */
export function str(r: Reply, field: string, from: string): string {
  const v = r[field];
  if (typeof v !== "string" || !v) throw new Error(`${from} returned no ${field}: ${JSON.stringify(r).slice(0, 400)}`);
  return v;
}

export function obj(r: Reply, field: string, from: string): Reply {
  const v = r[field];
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error(`${from} returned no ${field} object: ${JSON.stringify(r).slice(0, 400)}`);
  return v as Reply;
}
