/** One event per tool call, recording what the call DID — not that it happened.
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
 *
 * There was already a `tool_call` event, written at the block proxy, and its whole detail
 * was `{"status": 200}`. On the UAT host that had produced 2,369 rows, every one of them
 * saying 200, and not one of them able to answer the only question worth asking: did the
 * call work? An MCP tool that refuses returns HTTP 200 with `ERROR: …` as its text — so a
 * transport status is blind to exactly the outcomes we are trying to count.
 *
 * It was also blind to most of the platform. `tool_call` fired only for `/p/<block>/mcp`.
 * Every tool on zz-core — document_write, document_patch, the gates, initiative_status, the whole
 * flow — went through `/core/mcp`, which had no telemetry at all. The tools that do the
 * work were the tools nothing recorded.
 *
 * ── WHY AT THE DOOR, AND NOT IN EACH SERVICE ─────────────────────────────────
 *
 * Everything reaches a person through this gateway: `/core` and `/p/<block>` are proxied,
 * `/manage` and `/admin` are served here. Proxied surfaces can only be observed from
 * outside; local ones would have to be observed from inside, tool by tool. But both write
 * their answer to the same `res`, so wrapping `res` catches all four with one
 * implementation and leaves zz-core untouched.
 *
 * ── WHAT IS RECORDED, AND WHAT DELIBERATELY IS NOT ───────────────────────────
 *
 * Recorded: the tool, whether it was accepted or refused, the refusal text, how long it
 * took, and the NAMES of the arguments.
 *
 * Not recorded: argument VALUES. They carry the team's own content — a stakeholder's brain
 * dump, a document body, in `/manage` a building-block key. This table is read by people
 * and will be read by tooling; it has no business holding either. Argument names alone
 * still answer "was the call even shaped right", which is what a failure analysis needs.
 *
 * The refusal text IS recorded, because it is ours: these messages are written by the
 * platform to say what rule was broken, and they are the only mechanical account of WHY a
 * flow stalled. Capped, because a message is a sentence and anything longer is a document
 * that leaked into one.
 *
 * Principle 6 in STATE.md: telemetry is mechanical — if a model wrote it, it is not
 * evidence. Nothing here is model-written. The tool name comes off the wire, the outcome
 * off the platform's own answer.
 */
import { createHash } from "node:crypto";
import { StringDecoder } from "node:string_decoder";

import type { NextFunction, Request, Response } from "express";

import { catalogManifest } from "@zz/catalog";
import { refusalClass } from "@zz/contracts";
import { lastJson } from "@zz/mcp-client";
// The alias resolver, from @zz/contracts, where the maps it reads also live. It briefly lived
// in @zz/tools instead, which made a service depend on a package carrying pg, @zz/catalog and
// @zz/mcp-client in order to reach a pure function — and split one concept across two packages,
// which is how a second implementation starts. Maps and resolvers now share one door.
// `tool_key` must fold onto the exact same series a reader building one from historical
// `subject` values would, so it cannot be resolved by anything but this.
import { resolveStep, resolveToolKey } from "@zz/contracts";

import { logEvent } from "./events.js";
import { blockHandshake, blockOf, blockVersion, callerKey, currentStep, flowFor, initiativeSeen,
         pluginFor, stepLoaded } from "./step-trace.js";

/** The most we will hold of ONE answer. Answers are classified as they stream, so nothing
 * accumulates past this.
 *
 * Past it we keep the HEAD and classify from that rather than dropping the line. A real tool
 * answer ran to megabytes — a documentation tool returning a whole spec — and dropping it
 * recorded a call that had plainly worked as `unreadable`, which is the one verdict this
 * table must not hand out when it can tell. The head is enough: a refusal is `ERROR:` at the
 * START of the text, so the first 64 KB decides it however long the answer runs. */
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
 * Two shapes reach here. Streamable HTTP answers a tools/call as an SSE frame —
 * `event: message` then `data: {…}` — and a plain JSON response is the same object without
 * the frame. Both carry one JSON-RPC envelope, so this looks for the envelope rather than
 * for either shape.
 *
 * Our refusals are TEXT, not protocol errors: `{"result":{"content":[{"text":"ERROR: …"}]}}`
 * with no `isError` flag anywhere. That convention is what makes this readable at all, and
 * it is also why `{"status": 200}` could never have worked. `isError` is honoured too, for
 * a tool that starts setting it. */
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
 * Keyed by id rather than "the last one wins", because ONE request can carry several calls:
 * JSON-RPC allows a batch, and a batch of two tool calls used to be recorded as nothing at
 * all — the body was an array, `body.method` was undefined, and the middleware skipped the
 * whole request. Proven live: two calls executed and the event count did not move. An
 * instrument that under-reports silently is worse than none, and this one was reporting a
 * clean run while dropping eleven calls out of a hundred and forty-one. */
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
  // WHICH call this was. The head used to be filed under "", and "" is only ever read back
  // when the request held exactly one call and produced exactly one answer. So in a batch —
  // the one place an id is load-bearing — a large answer was classified correctly and then
  // recorded as `unreadable`, because its own id never matched the key it was stored under.
  // The envelope is serialised `{"jsonrpc":"2.0","id":N,"result":…}`, so the id is in the
  // head even when the result is not; `fallbackId` covers a server that orders it otherwise
  // and is only unambiguous when one call is still unanswered.
  const id = /"id"\s*:\s*(\d+|"[^"]*")/.exec(s)?.[1]?.replace(/^"|"$/g, "");
  into.set(id ?? fallbackId ?? "", outcome);
}

/** A refusal, redacted and capped for storage.
 *
 * The redaction is @zz/contracts' — one list, shared with the report that reads these rows
 * back, because two copies of it in different orders classified the same refusal two ways.
 * The CAP is this file's: a refusal is a sentence, and past this it is a document that
 * leaked into one.
 *
 * Redacting HERE rather than at read time is what keeps an address out of the table at all.
 * It also covers the case redacting there never could: a block's own refusal text, from a
 * server this repository does not own. */
function cap(s: string): string {
  const one = refusalClass(s);
  return one.length > REASON_CAP ? `${one.slice(0, REASON_CAP)}…` : one;
}

/** Argument values worth keeping: the IDENTIFIERS the platform itself names.
 *
 * The rule was "names, never values", and it is right for what it was written against — a
 * stakeholder's brain dump, a document body, a building-block key. Applied to every argument
 * it also threw away the one signal this whole record exists to produce. `skill_read` was
 * logged as `args: ["name"]`: a skill was read, and nothing about WHICH. So "does this skill
 * earn its place", "was the preload actually read", "which skills does a winning run load
 * that a stalling one does not" were all unanswerable, from a record taken specifically to
 * answer them.
 *
 * The line is not name-versus-value. It is IDENTIFIER versus CONTENT. A skill name, an
 * initiative, a flow, a block, a document path, an enum — the platform publishes all of
 * these; they identify things rather than say anything. A title, a body, a query, an email,
 * an api_key are the team's own words about their own work, and those stay out however
 * useful they would be.
 *
 * `query` is the deliberate omission that hurts: what people search for is the sharpest
 * signal there is about what the corpus is missing. It is also a sentence an agent wrote
 * about somebody's business, so it is content. The hit COUNT would carry most of the signal
 * without the words, and that belongs in the tool's own result, not in a guess made here.
 */
const IDENTIFIER_ARGS = new Set([
  "team", "initiative", "flow", "platform", "block", "path", "name", "type",
  // `harness` left with render_harness_config, then `client` and `clients` left with Codex
  // and Hermes: client_setup takes no client any more, because there is one, and
  // flow_install no longer asks a team to choose between them.
  // `id` LEFT WITH revoke_my_access_token, which was the only tool on the platform that ever
  // declared it — a bare `id` at the top level, where every survivor names what the id is OF
  // (`pat_id`, `old_id`, `new_id`). That tool was a duplicate of pat_revoke and was deleted,
  // so the entry became unreachable in the same change.
  "old_id", "new_id", "slug", "role",
  "scope", "status", "prefix", "version", "agent_name", "limit",
  "include_superseded",
  // `direction` LEFT WITH encode_base64, the only tool that ever declared it — encode or
  // decode, and nothing else on any door takes the name. An allowlist entry that cannot be
  // reached is a decision that reads as considered and is only debris.
  // `disposition` — finished or abandoned, on initiative_close(), which is the most consequential act
  // this platform has. It is a two-value enum the platform itself defines, and it answers
  // "how did this end" from the telemetry rather than only from the ledger. It was being
  // thrown away for the same reason `skill_read`'s `name` was: the rule read as
  // name-versus-value rather than identifier-versus-content.
  "disposition",
  // REMOVED, because no tool declares them and none can: `open_only` is named by nothing
  // anywhere in this repository, and `kr` exists only nested inside okr_grade's `scores`,
  // which this function never sees — it reads the top-level arguments. An allowlist entry
  // that cannot be reached is a decision that reads as considered and is only debris.
  // `confirm` was here, and it was the one entry that let content in through the front door.
  // Every tool that takes it defines it as an ECHO of another argument, and admin's
  // person_deactivate defines it as an echo of the email: `if (confirm !== email) return ...`.
  // So the one value the list most deliberately excludes arrived under a name that looked
  // like an enum. A confirmation is a yes; whether it matched is already in `ok`.
]);
/** An identifier is short. Anything longer is a field that happens to share a safe name. */
const ID_CAP = 200;

function identifiers(args: Record<string, unknown>): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(args)) {
    if (!IDENTIFIER_ARGS.has(k)) continue;
    const s = Array.isArray(v) ? v.join(",") : String(v ?? "");
    if (!s || s.length > ID_CAP) continue;
    out[k] = s;
  }
  return Object.keys(out).length ? out : undefined;
}

/** The SHAPE of each argument — type and size, never content.
 *
 * Argument names alone answered "was the call even shaped right", and on a real run that
 * turned out to be one question short. one block's write tool was refused repeatedly and then
 * succeeded twice, and every one of those nine calls carried the same three argument
 * NAMES. Whatever the agent changed to get through, the record could not show it, so the
 * usage skill could not be told and the next run makes the same seven calls.
 *
 * Shapes close that without holding the team's content: an empty string, a value ten times
 * longer than the one that worked, an object where a string was wanted — each is visible as
 * a type and a length, and none of them is the value itself. Recorded on REFUSAL only,
 * because a call that worked has nothing to diagnose.
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

/** Which door a request came through, from the URL it arrived on.
 *
 * A FUNCTION WITH A NAME, and that is the whole reason it is not the inline lambda it used to
 * be. Its answer decides three things a wrong label does not begin to describe: the subject a
 * row is filed under (`<surface>:<tool>`), whether `blockOf` in step-trace calls this the
 * platform's own traffic or a BUILDING BLOCK's, and which map a tool name resolves through —
 * `TOOL_ALIAS` is keyed by surface, so a call labelled with the wrong door has its name folded
 * through the wrong door's aliases and lands in a different series.
 *
 * IT FALLS THROUGH TO `core`, WHICH IS WHY EVERY NEW DOOR HAS TO BE NAMED HERE. That default
 * is safe for exactly one reason — the mount list beside it is short and every entry appears
 * below. Add a door to that list and not to this function and its calls are recorded as core:
 * nothing fails, nothing is empty, and the numbers are wrong in a way no report can show.
 * Written as an exported function of the URL so `checks/eval-door.ts` CALLS it, per door,
 * rather than reading a lambda out of server.ts and hoping the branch it found is the one that
 * runs.
 *
 * `originalUrl`, not `baseUrl`: under `app.use` with a path array `baseUrl` is not the matched
 * entry, and every surface was once recorded as "core" for precisely that reason. */
export function doorSurface(url: string): string {
  const block = /^\/p\/([^/]+)\/mcp/.exec(url)?.[1];
  if (block) return block;
  if (url.startsWith("/eval")) return "eval";
  if (url.startsWith("/manage")) return "manage";
  return "core";
}

/** Express middleware. Mount AFTER identity (it reads the resolved caller) and BEFORE the
 * MCP routes (it wraps the response they write to).
 *
 * `surface` names which door this is — `core`, `eval`, `manage`, `admin`, or the block's own
 * name — so one subject format, `<surface>:<tool>`, spans all of them. */
export function toolCallTelemetry(surface: (req: Request) => string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const body = req.body as RpcBody | RpcBody[] | undefined;
    const wanted = (Array.isArray(body) ? body : [body])
      .filter((m): m is RpcBody => m?.method === "tools/call");

    // THE HANDSHAKE IS WATCHED TOO, and it writes no row. Every MCP server states its name and
    // version at `initialize`, which is the block's own account of what it is, in a protocol
    // field it already has to send — so a block version costs no new contract and nothing for
    // a block team to adopt. It arrives on a different request from the calls it describes, so
    // it is remembered per block and stamped on those.
    if (!wanted.length) {
      const handshake = (Array.isArray(body) ? body : [body]).some((m) => m?.method === "initialize");
      const forBlock = handshake ? blockOf(surface(req)) : undefined;
      if (forBlock) {
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
          if (seen) blockHandshake(forBlock, seen);
          return e(...a);
        } as Response["end"];
      }
      next();
      return;
    }
    const started = Date.now();

    // Classified as it streams, one complete line at a time, rather than kept and read at
    // the end. A total cap on what was kept would truncate the LATER answers in a batch —
    // and a batch is exactly where several answers share one response — so the calls at the
    // end of a big turn would have reported `unreadable` for no reason but their position.
    // One run already had a turn with sixty-two tool calls in it.
    const answers = new Map<string, ToolOutcome>();
    const decoder = new StringDecoder("utf8");
    let pending = "";
    let bytes = 0;
    // THE SKILL TEXT AS SERVED, accumulated only when a skill is actually being loaded.
    // Every call attributed to a step carries the hash of the bytes the model was handed, so
    // "this step refused eight times" can become "this VERSION of this step did" — which is
    // the difference between measuring a step and proving a change to it. Every other call
    // pays nothing: the flag is false and this branch never runs.
    // THE SKILL AND WHETHER THE SKILL ITSELF WAS ASKED FOR. `skill_read(name, file: …)` serves
    // a supporting file beside the SKILL.md — reference material the skill's own instructions
    // point at — and that file's frontmatter is not the skill's version. Reading one out of it
    // wrote an empty step_version onto every call that followed, or a document template's
    // version, under the skill's name. See stepLoaded.
    // RAW NAME: this is the tool name the CLIENT sent, before any resolution, so the
    // REGISTERED spelling is the correct one here and `resolveToolKey` would be wrong —
    // the `toolKey` assignment further down puts the same field through the resolver, because
    // that answers a different question. (A line number here would be the third stale one in
    // this comment's history; the identifier does not drift.) The hazard is not hypothetical: this line said
    // `skill_view` until the registration became `skill_read`, and the two moved together
    // in one commit precisely because nothing would have gone red if they had not. The
    // next rename of this tool has the same obligation — change it HERE and at the
    // registration in the same commit, or every call silently loses `step_version` and
    // `step_sha`, which is attribution rather than display. No resolver can do it for us.
    const loading = wanted.filter((m) => m.params?.name === "skill_read")
      .map((m) => {
        const a = m.params?.arguments as Record<string, unknown> | undefined;
        return { name: String(a?.name ?? ""), whole: a?.file === undefined || a?.file === "" };
      })
      .filter((l) => l.name);
    let served = loading.length ? "" : null;
    let skipping = false;   // inside the tail of an answer already classified from its head
    const take = (chunk: unknown): void => {
      let s: string;
      if (typeof chunk === "string") s = chunk;
      // ArrayBuffer.isView, not Buffer.isBuffer. The two doors deliver different things:
      // the proxied ones go through Readable.fromWeb().pipe(res), which yields Buffers, and
      // the locally-served ones through @hono/node-server, which reads a Web ReadableStream
      // and writes raw Uint8Arrays. Buffer.isBuffer(uint8array) is false, so /manage and
      // /admin recorded `unreadable: true` on calls that had in fact succeeded — the
      // telemetry was mis-reporting the platform because of its own type check. Buffer is
      // itself an ArrayBuffer view, so this covers both.
      else if (!ArrayBuffer.isView(chunk)) return;
      // Through a StringDecoder, which holds an incomplete multi-byte sequence until the
      // next chunk completes it. Decoding each chunk on its own replaced any character that
      // straddled a write boundary with U+FFFD — silently, since the JSON structure around
      // it is ASCII and still parses. A refusal naming a document in Chinese would have been
      // recorded with the damage and nothing would have looked wrong.
      else s = decoder.write(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength));
      // BYTES, not characters. This counted `s.length` into a field called `bytes`, which is
      // the same number only for ASCII — a refusal or a document in Chinese was recorded as
      // roughly a third of its real size, in the one column that says how much an answer
      // costs to carry.
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

    // "finish" is the response ending normally. "close" is the socket going away — a client
    // that hung up, an upstream that died mid-stream, a request that ran past its timeout.
    // Listening only for "finish" left exactly the worst failures unrecorded: a tool call
    // that never came back produced no row at all, so the record showed a flow that simply
    // stopped making calls. Both are wired, and `done` makes sure one call writes one row.
    let done = false;
    // ASYNC, because the flow a team is running is a fact in the database and the row should
    // carry it rather than leave every reader to look it up against a team's CURRENT install.
    // `done` is set synchronously on the first line, so "finish" and "close" both firing still
    // writes exactly one row — the guard never awaits anything before it closes.
    const record = async (): Promise<void> => {
      if (done) return;
      done = true;
      if (!skipping) readLine(pending, answers);   // a last line with no trailing newline
      // A transport failure is a refusal with a reason, not an unreadable answer. Clearing
      // the map here instead would have recorded every call in the request as "we could not
      // tell", which is the one verdict this table must not hand out when it can tell.
      const transport = res.statusCode >= 400
        ? { ok: false, reason: `http ${res.statusCode}` } as ToolOutcome
        : null;
      // ONE duration for the whole REQUEST, which is all this door can measure. In a batch
      // it is the batch's, not any single call's — `batched` says so, and tool-report leaves
      // those rows out of its latency percentiles rather than averaging a batch total in
      // sixty-two times. `bytes` is the same: one response, one size.
      const ms = Date.now() - started;
      // REQUEST BYTES, from Content-Length — the one honest measure available here. The body
      // is already parsed into `req.body` by the time this middleware runs, and
      // re-serializing it would measure our own JSON.stringify of it, not what the caller
      // actually put on the wire. A request with no Content-Length (chunked, or none at all)
      // is not measured, and null says so rather than a guessed zero.
      const rawLength = req.headers["content-length"];
      const requestBytes = rawLength !== undefined && /^\d+$/.test(rawLength) ? Number(rawLength) : null;
      const where = surface(req);

      // WHICH FLOW, WHICH STEP, WHICH BLOCK — the three questions an improvement loop asks,
      // answered here rather than left for each reader to re-derive. `caller` correlates a
      // skill load with the calls that follow it and is not written anywhere: what lands on
      // the row is a flow, a step, a version and a block. Knowing which skill to edit never
      // required knowing who was running it.
      const caller = callerKey(req.headers as Record<string, unknown>);
      // What is WRITTEN is the hash. The correlation key above never leaves this process.
      const callerHash = createHash("sha256").update(caller).digest("hex").slice(0, 12);
      // Registered BEFORE the row is written, so the skill_read call is itself attributed to
      // the step it loaded. A load is the first act of a step, not the last act of the one
      // before it.
      // THE SKILL TEXT, NOT THE FRAME AROUND IT. `served` is the raw streamed answer — SSE
      // lines wrapping a JSON-RPC envelope whose result holds the markdown as an escaped
      // string. Handing that to the frontmatter parser found no `---` at the start and
      // returned no version at all, which is how step_version arrived empty on every row
      // while looking wired.
      //
      // It also makes the hash mean the right thing. Hashing the frame would move the version
      // whenever the transport changed its framing, and a skill that had not been touched
      // would read as a new version — the exact false signal this whole scheme exists to
      // prevent. lastJson is the shared reader, so the envelope is understood in one place.
      if (served !== null && loading.length === 1 && !transport) {
        const env = lastJson(served);
        const text = (env?.result?.content ?? [])
          .map((c) => (c as { text?: string })?.text ?? "").filter(Boolean).join("\n");
        stepLoaded(caller, loading[0].name, text || served, loading[0].whole);
      }
      // ANY call that names an initiative teaches the trace which one is being worked on.
      for (const c of wanted) {
        const named = (c.params?.arguments as Record<string, unknown> | undefined)?.initiative;
        if (typeof named === "string" && named) { initiativeSeen(caller, named); break; }
      }
      const step = currentStep(caller);
      const block = blockOf(where);
      const flow = await flowFor(req.zzIdentity?.activeTeam ?? null);

      for (const call of wanted) {
        const given = call.params?.arguments ?? {};
        const ids = identifiers(given);
        // A DOCUMENT WRITE SAYS WHICH STAGE IS RUNNING, and it says it better than the trace.
        //
        // `currentStep` is the last skill SERVED, which is right until an agent consults
        // something mid-flow — and then everything after belongs to that consultation. On
        // 2026-09-06 twenty intent.md documents were written and TWO document_write calls were
        // stamped ops-intent; the rest landed under ops-verify, zz-knowledge and ops-build,
        // which had been loaded later in the same conversation. Every one of those documents
        // is unattributable, because attribution needs a run of the stage that owes the
        // document and no such run exists.
        //
        // The flow already declares who owes what: `stage` on a manifest document. So a write
        // to a declared document is stamped with the stage that writes it, whatever was
        // loaded last. This is not a heuristic — it is the manifest answering a question the
        // trace was guessing at.
        // RAW NAME: the same reason as the `loading` predicate above — `call.params.name` is
        // what the CLIENT sent, so these are the registered spellings and not resolver output.
        // A regex literal is invisible to `checks/pre-rename-literals.ts`, which only reads
        // quoted strings, so this marker is the only thing standing between the next rename
        // and three document writes that stop being stamped with the stage that owes them.
        const wroteDoc = /^(document_write|document_revise|document_patch)$/.test(String(call.params?.name ?? ""));
        const docName = wroteDoc
          ? String((given as Record<string, unknown>).path ?? "").split("/").pop() ?? "" : "";
        const owedBy = docName && flow
          ? (catalogManifest(flow.flow, true)?.documents ?? [])
              .find((d) => d.name === docName)?.stage
          : undefined;
        const stepName = owedBy ?? step?.step;
        // WHICH PLUGIN — from `currentStep()`'s own trace, per the contract's Inputs clause,
        // and DELIBERATELY NOT from `stepName` above. `stepName` can be `owedBy`, the
        // manifest's declared owner of a document being written, which is a statement about
        // which STAGE owes a document, not about which skill the caller actually loaded — and
        // routing plugin attribution through it would still be one hop from `zz.flow_install`
        // (owedBy comes from `catalogManifest(flow.flow, ...)`), which AC-1.6 rules out.
        // Resolved through SKILL_ALIAS first, so a renamed skill still matches the plugin that
        // owns it today, then through the same zz.plugin_version_skill join plugin-profile.ts
        // already prefers (see pluginFor's own comment for why it cannot start from a zz.run
        // row the way that one does). A caller with no step loaded, or one naming no known
        // skill, comes back undefined and is written as null — never guessed at.
        const plugin = await pluginFor(step?.step ? resolveStep(step.step) : undefined);
        // THE ALIAS-RESOLVED TOOL NAME, Task I-2's resolver, so `tool_key` already reads as
        // one series across a rename rather than needing every future reader to resolve
        // `subject` itself.
        const toolKey = resolveToolKey(`${where}:${call.params?.name ?? ""}`);
        // An id that answered nothing is unreadable, not refused — the same distinction the
        // report depends on to keep its accepted rate from being a guess.
        const outcome = transport
          ?? answers.get(String(call.id ?? ""))
          ?? (answers.size === 1 && wanted.length === 1
                ? [...answers.values()][0]
                : { ok: false, unreadable: true });
        logEvent({
          // NO ADDRESS ON A MEASUREMENT. `actor` carries the provenance of an admin act,
          // which is the entire point of one; a tool call's provenance is not what anybody
          // asks of it. `caller` in the detail is a hash, kept only so calls made in one
          // conversation can be told from another's. Improvement needs to know which skill to
          // edit and never who was running it.
          actor: "",
          kind: "tool_call",
          // THE TEAM THE CALL WAS MADE FOR. Every row was once written with none — 2,610 of
          // them on the production store, all null — and the team is not decoration:
          // flow-compare joins a call to an initiative by (team, initiative) and counts a row
          // without one as UNATTRIBUTED, and watch-results builds "a team has gone quiet" from
          // the distinct teams in the window. Two of the three reports that close the
          // improvement loop had a leg that could not work, and neither said so — an absent
          // team reads exactly like a quiet platform.
          teamSlug: req.zzIdentity?.activeTeam ?? null,
          subject: `${where}:${call.params?.name ?? ""}`,

          // ── COLUMNS: what somebody groups by ────────────────────────────────
          // Which skill, which revision of it, which block, and whether it worked. `step_sha`
          // is the hash of the skill text actually served, which is what makes the declared
          // version true — every skill here said `1.0` while three were edited five times in
          // one day.
          // WHICH INITIATIVE, carried forward the same way the step is. It reached only 129
          // of 6,225 rows as an argument — so a refusal could not be joined to the document it
          // was made for, and the reconciliation between what a step PREDICTED and what
          // actually happened had almost nothing to read.
          initiative: step?.initiative,
          flow: flow?.flow,
          step: stepName,
          stepVersion: step?.step_version,
          // WHICH PLUGIN, AND WHICH RELEASE OF IT — the answer this task adds. Never `flow`
          // (a team's last install, not a skill's owner) and never `x-zz-client` in `detail`
          // below (which program made the call, not which plugin's skill it was following).
          plugin: plugin?.plugin,
          pluginVersion: plugin?.plugin_version,
          toolKey,
          block,
          blockVersion: block ? blockVersion(block) : undefined,
          ok: outcome.ok,
          // The platform's own sentence saying which rule was broken — the one thing a skill
          // can actually be edited from.
          refusal: outcome.reason,
          // WHAT THE CALL COST — duration_ms, request_bytes and response_bytes, so a latency
          // or a payload-size percentile is a WHERE/GROUP BY rather than a detail->>'' reach.
          // `batched` says whether this row's duration and response size belong to it alone
          // or were shared with the rest of `wanted`; tool-report now reads the column
          // instead of inferring it from an entry that used to live in the bag below.
          durationMs: ms,
          requestBytes,
          responseBytes: bytes,
          batched: wanted.length > 1,

          // ── THE BAG: read, never filtered on ────────────────────────────────
          detail: {
            caller: callerHash,
            // WHICH OF OUR OWN TOOLS MADE THE CALL — `zz-plugin` for a person's chat session,
            // `zz-doctor`, `zz-update`, `zz-migrate` for the commands, `provision`/`smoke` for
            // the harnesses. It is already half of `caller`, hashed in with the address and
            // therefore unreadable; on its own it names no person and answers the question the
            // hash cannot: which of the things we ship do people actually run.
            //
            // NOT a second capture path. Everything that reaches a door is recorded here, by
            // this one mount, as a by-product of the call — so a tool becomes measurable by
            // sending the header it already has to send, and never by reporting itself.
            ...(req.headers["x-zz-client"] ? { client: String(req.headers["x-zz-client"]) } : {}),
            run: step?.run,
            // The hash of the skill text actually SERVED. Not a column: the gate refuses a
            // changed skill that kept its version, so authoring drift is caught in the repo
            // and what is left here is the narrower case of a host running text the repo does
            // not claim. Kept, because that case is invisible without it.
            step_sha: step?.step_sha,
            // Argument NAMES, never values: the values carry the team's own content, and the
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
    // An async listener that rejects is an UNHANDLED REJECTION, and node's default for those
    // is to end the process. This file's first principle is that a telemetry layer must not
    // change what the caller receives; taking the gateway down over a failed measurement is
    // the loudest possible version of breaking that.
    const safely = (): void => { void record().catch(() => {}); };
    res.on("finish", safely);
    res.on("close", safely);

    next();
  };
}
