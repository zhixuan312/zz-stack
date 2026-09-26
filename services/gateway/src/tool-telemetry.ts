/** One event per tool call, recording what the call did — not that it happened.
 *
 * Wraps `res` at the gateway, so it catches every door with one implementation: `/core` and
 * `/eval` are proxied and observable only from outside, `/manage` is served here. zz-core stays
 * untouched.
 *
 * Recorded: the tool, accepted or refused, the refusal text, duration, and the names of the
 * arguments.
 *
 * DELIBERATE: argument values are never recorded. They carry the team's own content — a brain
 * dump, a document body, on `/manage` a person's email — and this table is read by people
 * and by tooling. Names alone still answer "was the call shaped right".
 *
 * DELIBERATE: the refusal text is recorded. It is the platform's own sentence saying which
 * rule was broken, and the only mechanical account of why a flow stalled. Capped at
 * REASON_CAP.
 *
 * DELIBERATE: an MCP refusal is HTTP 200 with `ERROR: …` as its text, so a transport status
 * cannot decide the outcome. Nothing here is model-written: the tool name comes off the wire,
 * the outcome off the platform's own answer.
 */
import { createHash } from "node:crypto";
import { StringDecoder } from "node:string_decoder";

import type { NextFunction, Request, Response } from "express";

import { pluginForDoor } from "@zz/catalog";
import { refusalClass } from "@zz/contracts";
import { lastJson } from "@zz/mcp-client";
// COUPLED: `tool_key` must fold onto the same series a reader building one from historical
// `subject` values would, so nothing but this resolver may produce it.
import { resolveToolKey } from "@zz/contracts";

import { logEvent } from "./events.js";
import { ANSWER_NAMES_INITIATIVE, initiativeFrom, stageOwing } from "./call-attribution.js";
import { callerKey, currentStep, doorHandshake, doorVersion, flowFor, initiativeSeen,
         stepLoaded } from "./step-trace.js";

/** The most we hold of one answer. Classified as it streams, so nothing accumulates past this.
 *
 * DELIBERATE: past the cap the head is kept and classified, never dropped. A refusal is
 * `ERROR:` at the start of the text, so the first 64 KB decides it however long the answer
 * runs; dropping it would record a working megabyte answer as `unreadable`. */
const LINE_CAP = 64 * 1024;
/** A refusal is a sentence. Past this it is a document that leaked into one. */
const REASON_CAP = 500;

interface RpcBody {
  id?: string | number;
  method?: string;
  params?: { name?: string; arguments?: Record<string, unknown> };
}

interface ToolOutcome {
  ok: boolean;
  /** The platform's own refusal message, when it refused. */
  reason?: string;
  /** Set when the answer could not be read at all — a transport failure, not a refusal. */
  unreadable?: boolean;
}

/** Read the outcome out of what the caller was actually sent.
 *
 * Two shapes reach here — an SSE frame (`event: message` then `data: {…}`) and a plain JSON
 * response — so this looks for the JSON-RPC envelope rather than for either shape.
 *
 * DELIBERATE: this platform's refusals are text, `{"result":{"content":[{"text":"ERROR: …"}]}}`
 * with no `isError` flag. `isError` is honoured too, for a tool that sets it. */
interface Envelope {
  id?: string | number;
  error?: { message?: string };
  result?: { isError?: boolean; content?: Array<{ text?: string }> };
}

function outcomeOf(env: Envelope): ToolOutcome {
  if (env.error) return { ok: false, reason: cap(env.error.message ?? "jsonrpc error") };
  const text = (env.result?.content ?? []).map((c) => c.text ?? "").join(" ").trim();
  if (env.result?.isError === true) return { ok: false, reason: cap(text || "isError") };
  if (/^ERROR\b/.test(text)) return { ok: false, reason: cap(text) };
  return { ok: true };
}

/** Every answer in what the caller was sent, by the id it answers.
 *
 * DELIBERATE: keyed by id, not "the last one wins". One request can carry several calls —
 * JSON-RPC allows a batch — and a batch arrives as an array with no `body.method`. */
function readLine(line: string, into: Map<string, ToolOutcome>, truncated = false,
                  fallbackId?: string): void {
  const s = line.startsWith("data:") ? line.slice(5).trim() : line.trim();
  if (!s.startsWith("{") && !s.startsWith("[")) return;
  if (!truncated) {
    let parsed: unknown;
    try { parsed = JSON.parse(s); } catch { return; }   // a partial frame is not an answer
    for (const env of (Array.isArray(parsed) ? parsed : [parsed]) as Envelope[]) {
      if (env && (env.result !== undefined || env.error !== undefined)) {
        into.set(String(env.id ?? ""), outcomeOf(env));
      }
    }
    return;
  }
  // A head, so it cannot be parsed as JSON. Our own convention is what makes it readable
  // anyway: a refusal is `ERROR:` at the start of the result's text.
  const refused = /"text"\s*:\s*"ERROR\b/.test(s) || /"error"\s*:\s*\{/.test(s);
  const outcome: ToolOutcome = refused
    ? { ok: false, reason: "ERROR (answer too large to read in full)" }
    : { ok: true };
  // Which call this was. The envelope serialises as `{"jsonrpc":"2.0","id":N,"result":…}`, so
  // the id is in the head even when the result is truncated away. `fallbackId` covers a server
  // that orders it otherwise, and is only unambiguous while one call is still unanswered.
  // The "" key is read back only when the request held exactly one call.
  const id = /"id"\s*:\s*(\d+|"[^"]*")/.exec(s)?.[1]?.replace(/^"|"$/g, "");
  into.set(id ?? fallbackId ?? "", outcome);
}

/** A refusal, redacted and capped for storage.
 *
 * COUPLED: the redaction list is @zz/contracts', shared with the report that reads these rows
 * back. Order decides the answer, so two lists cannot agree. The cap is this file's.
 *
 * DELIBERATE: redacted at write time, so an address never enters the table. */
function cap(s: string): string {
  const one = refusalClass(s);
  return one.length > REASON_CAP ? `${one.slice(0, REASON_CAP)}…` : one;
}

/** Argument values worth keeping: the identifiers the platform itself names.
 *
 * The line is identifier versus content, not name versus value. A skill name, an initiative, a
 * flow, a document path, an enum identify things the platform publishes. A title, a
 * body, a query, an email, an api_key are the team's own words and stay out.
 *
 * DELIBERATE: `query` is excluded even though it is the sharpest signal about what the corpus
 * is missing. It is a sentence somebody wrote about their own business. A hit count belongs in
 * the tool's own result, not in a guess made here.
 */
const IDENTIFIER_ARGS = new Set([
  "team", "initiative", "flow", "path", "name", "type",
  // DELIBERATE: every entry names what the id is of — `pat_id`, `old_id`, `new_id` — never a
  // bare `id`. An entry no tool declares is unreachable and reads as a considered decision
  // while being debris, so the list is pruned when a tool that declared one goes.
  "old_id", "new_id", "slug", "role",
  "scope", "status", "prefix", "version", "limit",
  "include_superseded",
  // `disposition` — finished or abandoned, on initiative_close(). A two-value enum the
  // platform defines, so the telemetry can answer "how did this end" without the ledger.
  "disposition",
  // DELIBERATE: `confirm` is not here. Every tool defining it defines it as an echo of
  // another argument — person_deactivate echoes the email — so an allowlisted `confirm` would
  // let content in under a name that looks like an enum. Whether it matched is already in `ok`.
  //
  // DELIBERATE: this reads top-level arguments only. A name nested inside an object argument
  // can never reach it and does not belong on the list.
]);
/** An identifier is short. Anything longer is a field that happens to share a safe name. */
const ID_CAP = 200;

function fitted(items: readonly string[]): string {
  const kept: string[] = [];
  for (const [i, item] of items.entries()) {
    const rest = items.length - i - 1;
    const next = [...kept, item].join(",") + (rest ? `,+${rest} more` : "");
    if (next.length > ID_CAP) return kept.length ? `${kept.join(",")},+${items.length - kept.length} more` : "";
    kept.push(item);
  }
  return kept.join(",");
}

function identifiers(args: Record<string, unknown>): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(args)) {
    if (!IDENTIFIER_ARGS.has(k)) continue;
    // A list keeps the entries that fit and counts the rest: joined whole, several long paths ran
    // past the cap and the call was recorded with no target at all, so a trace could not tell
    // one read of five documents from five reads of one.
    const s = Array.isArray(v) ? fitted(v.map(String)) : String(v ?? "");
    if (!s || s.length > ID_CAP) continue;
    out[k] = s;
  }
  return Object.keys(out).length ? out : undefined;
}

/** The shape of each argument — type and size, never content. An empty string, a value ten
 * times longer than the one that worked, an object where a string was wanted: each is visible
 * as a type and a length, and none is the value.
 *
 * DELIBERATE: recorded on refusal only. A call that worked has nothing to diagnose.
 */
function shapes(args: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(args)) {
    if (v === null) out[k] = "null";
    else if (Array.isArray(v)) out[k] = `array(${v.length})`;
    else if (typeof v === "object") out[k] = `object(${Object.keys(v).length} keys)`;
    else if (typeof v === "string") out[k] = `string(${v.length})`;
    else out[k] = typeof v;
  }
  return out;
}

/** Which door a request came through, from the URL it arrived on. Decides the subject a row is
 * filed under (`<surface>:<tool>`) and, as the key into @zz/contracts' `SURFACE_ALIAS`,
 * which alias map the tool name folds through.
 *
 * COUPLED: it falls through to `core`, so every new door must be named here as well as in the
 * mount list. A door named only there has its calls recorded as core — nothing fails and the
 * numbers are wrong. Exported so `checks/eval-door.ts` calls it per door.
 *
 * DELIBERATE: `originalUrl`, never `baseUrl`. Under `app.use` with a path array `baseUrl` is
 * not the matched entry. */
export function doorSurface(url: string): string {
  if (url.startsWith("/eval")) return "eval";
  if (url.startsWith("/manage")) return "manage";
  return "core";
}

/** Express middleware. Mount after identity (it reads the resolved caller) and before the
 * MCP routes (it wraps the response they write to).
 *
 * `surface` names which door this is — `core`, `eval` or `manage` — so one subject format,
 * `<surface>:<tool>`, spans all of them. */
export function toolCallTelemetry(surface: (req: Request) => string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const body = req.body as RpcBody | RpcBody[] | undefined;
    const wanted = (Array.isArray(body) ? body : [body])
      .filter((m): m is RpcBody => m?.method === "tools/call");

    // The handshake is watched too, and writes no row. Every MCP server states its name and
    // version at `initialize` — the door's own account of what it is, in a protocol field it
    // already sends. It arrives on a different request from the calls it describes, so it is
    // remembered per door and stamped on those.
    if (!wanted.length) {
      const handshake = (Array.isArray(body) ? body : [body]).some((m) => m?.method === "initialize");
      const forDoor = handshake ? surface(req) : undefined;
      if (forDoor) {
        let seen = "";
        const w = res.write.bind(res);
        const e = res.end.bind(res);
        const sip = (c: unknown): void => {
          if (seen.length > 8192) return;      // serverInfo is in the first frame or nowhere
          if (typeof c === "string") seen += c;
          else if (ArrayBuffer.isView(c)) seen += Buffer.from(c.buffer, c.byteOffset, c.byteLength).toString("utf8");
        };
        res.write = function (this: Response, ...a: Parameters<Response["write"]>) {
          sip(a[0]); return w(...a);
        } as Response["write"];
        res.end = function (this: Response, ...a: Parameters<Response["end"]>) {
          if (typeof a[0] !== "function") sip(a[0]);
          if (seen) doorHandshake(forDoor, seen);
          return e(...a);
        } as Response["end"];
      }
      next();
      return;
    }
    const started = Date.now();

    // DELIBERATE: classified as it streams, one complete line at a time, never kept and read at
    // the end. A total cap on what was kept would truncate the later answers in a batch — and a
    // batch is exactly where several answers share one response — so the calls at the end of a
    // big turn would report `unreadable` for no reason but their position.
    const answers = new Map<string, ToolOutcome>();
    const decoder = new StringDecoder("utf8");
    let pending = "";
    let bytes = 0;
    // The skill text as served, accumulated only while a skill is being loaded, so every call
    // attributed to a step carries the hash of the bytes the model was handed. Every other
    // call pays nothing.
    //
    // `skill_read(name, file: …)` serves a supporting file beside the SKILL.md, whose
    // frontmatter is not the skill's version — see stepLoaded.
    //
    // RAW NAME: the name the CLIENT sent, so this is the REGISTERED spelling and
    // `resolveToolKey` would be wrong here; `toolKey` below answers a different question.
    // COUPLED: this literal and the tool's registration must be renamed in the same commit.
    // Nothing goes red if they diverge — every call silently loses `step_version` and
    // `step_sha`, which is attribution, not display.
    const loading = wanted.filter((m) => m.params?.name === "skill_read")
      .map((m) => {
        const a = m.params?.arguments as Record<string, unknown> | undefined;
        return { name: String(a?.name ?? ""), whole: a?.file === undefined || a?.file === "" };
      })
      .filter((l) => l.name);
    // Capture the answer for the two calls whose answer names the initiative, not only when a
    // skill is being loaded — `initiative_open` names it in its answer, never its arguments,
    // and the block below that reads it sits behind `served !== null`.
    //
    // DELIBERATE: the argument scan below learns a slug from any call that names one,
    // including an `initiative_status` on a slug that does not exist, which answers an error
    // and is recorded `ok`. That is why the answer is read at all.
    let served = (loading.length
      || wanted.some((c) => ANSWER_NAMES_INITIATIVE.test(String(c.params?.name ?? "")))) ? "" : null;
    let skipping = false;   // inside the tail of an answer already classified from its head
    const take = (chunk: unknown): void => {
      let s: string;
      if (typeof chunk === "string") s = chunk;
      // DELIBERATE: ArrayBuffer.isView, not Buffer.isBuffer. The doors deliver different things
      // — proxied ones go through Readable.fromWeb().pipe(res), which yields Buffers; locally
      // served ones through @hono/node-server, which writes raw Uint8Arrays. Buffer.isBuffer of a
      // Uint8Array is false; a Buffer is itself an ArrayBuffer view, so this covers both.
      else if (!ArrayBuffer.isView(chunk)) return;
      // DELIBERATE: through a StringDecoder, which holds an incomplete multi-byte sequence until
      // the next chunk completes it. Decoding each chunk on its own replaces any character that
      // straddles a write boundary with U+FFFD, silently: the JSON structure around it is ASCII
      // and still parses.
      else s = decoder.write(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength));
      // DELIBERATE: bytes, not characters. `s.length` is the same number only for ASCII, and this
      // is the one column that says how much an answer costs to carry.
      bytes += typeof chunk === "string"
        ? Buffer.byteLength(chunk, "utf8")
        : (chunk as ArrayBufferView).byteLength;
      // Capped for the same reason everything else here is: a served answer is a document,
      // and holding an unbounded one in memory to hash it trades a measurement for a leak.
      // A skill is far smaller than this; anything that is not is not a skill.
      if (served !== null && served.length < 4 * LINE_CAP) served += s;
      pending += s;
      let nl = pending.indexOf("\n");
      while (nl !== -1) {
        if (!skipping) readLine(pending.slice(0, nl), answers);
        skipping = false;
        pending = pending.slice(nl + 1);
        nl = pending.indexOf("\n");
      }
      if (pending.length > LINE_CAP) {
        const unanswered = wanted.map((m) => String(m.id ?? "")).filter((i) => !answers.has(i));
        readLine(pending.slice(0, LINE_CAP), answers, true,
                 unanswered.length === 1 ? unanswered[0] : undefined);
        pending = "";
        skipping = true;                 // the rest of this line tells us nothing new
      }
    };

    // Wrapped, never replaced: the original is called with the arguments it was given and
    // its return value handed back untouched. A telemetry layer that changes what the
    // caller receives has stopped being telemetry.
    const write = res.write.bind(res);
    const end = res.end.bind(res);
    res.write = function (this: Response, ...a: Parameters<Response["write"]>) {
      take(a[0]);
      return write(...a);
    } as Response["write"];
    res.end = function (this: Response, ...a: Parameters<Response["end"]>) {
      if (typeof a[0] !== "function") take(a[0]);
      return end(...a);
    } as Response["end"];

    // DELIBERATE: both "finish" and "close" are wired. "finish" is the response ending
    // normally; "close" is the socket going away — a client that hung up, an upstream that died
    // mid-stream, a request past its timeout. On "finish" alone a call that never came back
    // writes no row at all, and the record reads as a flow that stopped making calls.
    let done = false;
    // Async, so the row carries the flow the initiative runs rather than leaving every reader to
    // look it up. `done` is set synchronously on the first line, so both events firing still
    // writes exactly one row — the guard never awaits before it closes.
    const record = async (): Promise<void> => {
      if (done) return;
      done = true;
      if (!skipping) readLine(pending, answers);   // a last line with no trailing newline
      // DELIBERATE: a transport failure is a refusal with a reason, not an unreadable answer.
      // "We could not tell" is the one verdict this table must not hand out when it can tell.
      const transport = res.statusCode >= 400
        ? { ok: false, reason: `http ${res.statusCode}` } as ToolOutcome
        : null;
      // One duration for the whole request, which is all this door can measure. In a batch it is
      // the batch's, not any single call's — `batched` says so, and tool-report leaves those rows
      // out of its latency percentiles. `bytes` is the same: one response, one size.
      const ms = Date.now() - started;
      // From Content-Length. The body is already parsed into `req.body` by the time this runs,
      // so re-serializing it would measure our own JSON.stringify, not what the caller put on the
      // wire. No Content-Length (chunked, or none) is written null, never a guessed zero.
      const rawLength = req.headers["content-length"];
      const requestBytes = rawLength !== undefined && /^\d+$/.test(rawLength) ? Number(rawLength) : null;
      const where = surface(req);

      // Which flow and which step — answered here rather than left for each reader to re-derive.
      // `caller` correlates a skill load with the calls that follow it and is never written: what
      // lands on the row is a flow, a step and a version.
      const caller = callerKey(req.headers as Record<string, unknown>);
      // Only the hash is written. The correlation key above never leaves this process.
      const callerHash = createHash("sha256").update(caller).digest("hex").slice(0, 12);
      // DELIBERATE: registered before the row is written, so the skill_read call is itself
      // attributed to the step it loaded. A load is a step's first act, not the previous
      // step's last.
      //
      // DELIBERATE: the skill text, never the frame. `served` is SSE lines wrapping a JSON-RPC
      // envelope holding the markdown as an escaped string; the frontmatter parser finds no
      // `---` in that, and hashing the frame would move the version whenever the transport
      // changed its framing. `lastJson` is the one reader of the envelope.
      if (served !== null && loading.length === 1 && !transport) {
        const env = lastJson(served);
        const text = (env?.result?.content ?? [])
          .map((c) => (c as { text?: string })?.text ?? "").filter(Boolean).join("\n");
        stepLoaded(caller, loading[0].name, text || served, loading[0].whole);
      }
      // What this exchange taught us about which initiative is being worked on —
      // `call-attribution.ts`, beside the question of which stage an act completes.
      //
      // COUPLED: the active team goes into the trace, not only into the flow lookup below. An
      // initiative carried forward on the caller alone keeps a slug learned from a cross-team
      // read on the next call's rows, whatever team that call was made under.
      const team = req.zzIdentity?.activeTeam ?? undefined;
      const learned = initiativeFrom(wanted, served);
      if (learned) initiativeSeen(caller, learned, team);
      const step = currentStep(caller, team);
      const flow = await flowFor(team ?? null, step?.initiative);

      for (const call of wanted) {
        const given = call.params?.arguments ?? {};
        const ids = identifiers(given);
        // A write to a declared document is stamped with the stage the manifest says owes it,
        // whatever skill was loaded last. `currentStep` is the last skill served, which is
        // wrong the moment an agent consults something mid-flow.
        //
        // COUPLED: `call-attribution.ts` is also what the evidence side reads, so one act
        // cannot be filed under two steps depending on which table you ask.
        //
        // RAW NAME: the names the CLIENT sent, again, and these are REGEX literals —
        // `checks/pre-rename-literals.ts` reads quoted strings only, so it cannot see them.
        // Rename the tool and these in the same commit.
        const owedBy = stageOwing(flow?.flow, String(call.params?.name ?? ""),
                                  given as Record<string, unknown>);
        const stepName = owedBy ?? step?.step;
        // DELIBERATE: the version and the hash follow the NAME, or are not written at all.
        // When the manifest overrides the traced step it knows which stage owes the document
        // and not which version of that stage's skill this caller has, so absent is the honest
        // answer.
        //
        // `step` and `step_version` together name one version of one skill, so a name carrying
        // another skill's bytes names a version that never existed.
        const owedElsewhere = !!owedBy && owedBy !== step?.step;
        const stepVersion = owedElsewhere ? undefined : step?.step_version;
        const stepSha = owedElsewhere ? undefined : step?.step_sha;
        // DELIBERATE: from the door, never from the skill the caller last read. A door is a
        // plugin's declared server, so the plugin is fixed by where the call arrived; the skill
        // answers "what were they reading", which drifts mid-flow. A surface no manifest claims
        // comes back null and is written as null, never guessed at.
        const plugin = pluginForDoor(where);
        // Alias-resolved, so `tool_key` reads as one series across a rename and no future reader
        // has to resolve `subject` itself.
        const toolKey = resolveToolKey(`${where}:${call.params?.name ?? ""}`);
        // An id that answered nothing is unreadable, not refused — the same distinction the
        // report depends on to keep its accepted rate from being a guess.
        const outcome = transport
          ?? answers.get(String(call.id ?? ""))
          ?? (answers.size === 1 && wanted.length === 1
                ? [...answers.values()][0]
                : { ok: false, unreadable: true });
        logEvent({
          // DELIBERATE: empty. `actor` carries the provenance of an admin act; a measurement
          // carries no address. `caller` in the detail is a hash, kept only so calls made in one
          // conversation can be told from another's.
          actor: "",
          kind: "tool_call",
          // COUPLED: watch-results builds "a team has gone quiet" from the distinct teams in the
          // window, so a null here reads as a quiet platform.
          teamSlug: req.zzIdentity?.activeTeam ?? null,
          subject: `${where}:${call.params?.name ?? ""}`,

          // Columns: what somebody groups by.
          // Which skill, which revision of it, and whether it worked. `step_sha` is
          // the hash of the skill text actually served, which is what makes the declared version
          // true. The initiative is carried forward the same way the step is, rather than read
          // off the arguments, so a refusal can still be joined to the document it was made for.
          initiative: step?.initiative,
          flow: flow?.flow,
          step: stepName,
          stepVersion,
          // Which plugin, and which release of it. Not `flow` (the initiative's flow, not a
          // skill's owner) and not `x-zz-client` in `detail` below (which program made the call,
          // not which plugin's skill it was following).
          plugin: plugin ?? undefined,
          // The door's own account of its version, from the `initialize` handshake it already
          // sends. Absent until that door has been handshaken in this process: a version nobody
          // stated is not one to invent.
          pluginVersion: doorVersion(where),
          toolKey,
          ok: outcome.ok,
          // The platform's own sentence saying which rule was broken — the one thing a skill
          // can actually be edited from.
          refusal: outcome.reason,
          // What the call cost, as columns rather than in the bag, so a latency or payload-size
          // percentile is a WHERE/GROUP BY. `batched` says whether this row's duration and
          // response size belong to it alone or were shared with the rest of `wanted`.
          durationMs: ms,
          requestBytes,
          responseBytes: bytes,
          batched: wanted.length > 1,

          // The bag: read, never filtered on.
          detail: {
            caller: callerHash,
            // Which of our own tools made the call — `zz-plugin` for a person's chat session,
            // `zz-doctor`, `zz-update`, `zz-migrate` for the commands, `provision`/`smoke` for the
            // harnesses. It is already half of `caller`, hashed in with the address and therefore
            // unreadable; on its own it names no person.
            //
            // DELIBERATE: not a second capture path. A tool becomes measurable by sending the
            // header it already sends, never by reporting itself.
            ...(req.headers["x-zz-client"] ? { client: String(req.headers["x-zz-client"]) } : {}),
            run: step?.run,
            // The hash of the skill text actually served. Not a column: the gate refuses a
            // changed skill that kept its version, so authoring drift is caught in the repo
            // and what is left here is the narrower case of a host running text the repo does
            // not claim. Kept, because that case is invisible without it.
            step_sha: stepSha,
            // Argument names, never values: the values carry the team's own content, and the
            // names alone still answer "was the call even shaped right".
            args: Object.keys(given).sort(),
            ...(ids ? { ids } : {}),
            // Shapes on refusal only — a call that worked has nothing to diagnose.
            ...(outcome.reason ? { shapes: shapes(given) } : {}),
            ...(outcome.unreadable ? { unreadable: true } : {}),
            ...(res.writableFinished ? {} : { aborted: true }),
          },
        });
      }
    };
    // DELIBERATE: swallows. An async listener that rejects is an unhandled rejection, and node's
    // default for those is to end the process — a failed measurement must not take the gateway
    // down with it.
    const safely = (): void => { void record().catch(() => {}); };
    res.on("finish", safely);
    res.on("close", safely);

    next();
  };
}
