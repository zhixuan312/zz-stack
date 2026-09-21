/**
 * THE FIRST RUNTIME ADAPTER: the harness this platform already runs on, expressed through the
 * port rather than assumed by it.
 *
 * WHAT THIS DRIVES, said plainly before anything below is read as more than it is. It spawns
 * nothing. `@zz/contracts` is the leaf of this repository's dependency graph and has no
 * process, no socket and no filesystem; an adapter here that claimed to launch a harness would
 * be claiming something this package cannot do. What it models is the SHAPE of that harness's
 * feed — a line-delimited record of a session, each line carrying its own opaque identifier,
 * its parent's, an ISO timestamp and, on the turns that have one, a consumption block — and it
 * is driven by a scripted feed that advances one tick per {@link observe}. The script stands in
 * for elapsed time. It is the only thing here that is invented; every field name and every
 * relationship below was read off a real session record before it was written down.
 *
 * THE THREE THINGS THIS ADAPTER EXISTS TO GET RIGHT, each of which the platform had previously
 * got wrong somewhere:
 *
 *   · THE LAST LINE IS NOT THE END. A session's record is written as the session goes; the
 *     process outlives its last line by however long the last step takes, and there is no line
 *     that means "and now it is over". So this adapter reports `last_activity_only` from lines
 *     alone and reaches `receipt_confirmed` only when the runtime's own exit record arrives —
 *     which the script deliberately delivers a tick AFTER the feed goes quiet, because that
 *     window is exactly where the mistake lives.
 *   · A STOP REQUEST IS NOT A STOP. Asking costs one signal and confirms nothing. This adapter
 *     answers `confirmed_stopped` only when it is holding the exit record, and names it.
 *   · DELEGATED WORK IS PAID FOR ONCE. A delegating turn's result carries a rollup for the
 *     whole delegated run AND the delegated run's own turns each carry their own block. Both
 *     numbers are correct; adding them is not. The rollup record is marked as containing its
 *     descendants and {@link summariseUsage} does the rest.
 */
import {
  PORT_PROTOCOL, declarationDigest,
  type BoundAsset, type CancelOutcome, type CancelRequest, type CapabilityDeclaration,
  type DispatchAck,
  type DispatchRequest, type EventFormatIdentity, type LoadMethodRequest, type MethodBinding,
  type Observation, type ObservedEvent, type ObserveRequest, type ResumeOutcome,
  type ResumeRequest, type RuntimeAdapter, type RuntimeCapabilities,
} from "./port.js";
import { summariseUsage, type UsageRecord } from "./usage.js";

/** A consumption block, as the runtime writes it. */
interface RawUsage {
  readonly input_tokens: number;
  readonly output_tokens: number;
}

/**
 * One line of the session record.
 *
 * IDENTITY IS AN OPAQUE STRING and parentage is carried on the line; the feed is appended to
 * and read in arrival order; time is an ISO-8601 string. Every one of those is different in
 * the other adapter beside this file, and none of them is a fact about running work.
 *
 * `agentId` is carried here for the delegated turns, which is the one simplification: the real
 * record attributes a delegated run by its own session identifier and an adapter has to join
 * the two. Putting the identifier on the line keeps that attribution visible in one place
 * instead of spreading a join across this file.
 */
interface TranscriptLine {
  readonly uuid: string;
  readonly parentUuid: string | null;
  readonly timestamp: string;
  readonly type: "assistant" | "user";
  readonly isSidechain: boolean;
  readonly sessionId: string;
  readonly agentId?: string;
  readonly message?: { readonly toolName?: string; readonly usage?: RawUsage };
  /** A delegating turn's result: the whole delegated run, rolled up. */
  readonly toolUseResult?: { readonly agentId: string; readonly usage: RawUsage };
}

/**
 * The runtime's own end-of-work record. Arrives on its own channel, not as a line.
 *
 * `reason` is the RUNTIME's word for why the session ended, and the receipt below is built
 * from it alone. The adapter deliberately does not reason from "I asked it to stop, and then
 * it stopped" — a session that was going to end anyway ends the same way, and an adapter that
 * takes credit for it reports its own request back to itself as a result.
 */
interface ExitRecord {
  readonly at: string;
  readonly reason: "completed" | "interrupted" | "failed";
}

const EVENT_FORMAT: EventFormatIdentity = {
  id: "session-record-lines",
  identity_of_an_event: "opaque_id",
  time_encoding: "iso_8601",
  delivery: "append_only",
  ordering: "arrival_order",
  may_drop_events: false,
};

const DECLARATION: CapabilityDeclaration = {
  adapter: "claude-code",
  event_format: EVENT_FORMAT,
  supported: ["confirm_stop", "request_stop", "resume_after_stop", "live_observation",
              "completion_receipt", "usage_accounting", "subagent_usage_records"],
  unsupported: [],
  cancellation: {
    strongest: "confirmed_stopped",
    // The runtime takes the signal at a step boundary, so a step already in flight finishes
    // first. A bound, not a promise: `settles_within_ms` is how long a caller must keep
    // watching before absence of activity means anything, and it is still not a confirmation.
    settles_within_ms: 30_000,
    lease_expiry_proves_stop: false,
  },
};

/** Identity derived from the declaration above, never typed beside it. Edit what this adapter
 *  supports and the identity moves with it, which is the only way an identity stays true. */
const CAPABILITIES: RuntimeCapabilities = {
  ...DECLARATION,
  protocol: PORT_PROTOCOL,
  declaration_digest: declarationDigest(DECLARATION),
};

// ---------------------------------------------------------------------------------------
// The scripted world

interface Work {
  readonly claim: string;
  readonly session_id: string;
  readonly lines: readonly TranscriptLine[];
  readonly exit: ExitRecord;
  /** How many ticks have been taken. Lines 0..tick-1 are visible; the exit record lands one
   *  tick after the last line, which is the window the honesty rule is about. */
  tick: number;
}

const world = new Map<string, Work>();
let issued = 0;

/** The scripted record for one dispatch: a turn, a delegation, the delegated run's own turns,
 *  the delegating turn's result carrying the rollup, and a closing turn. */
function script(session: string, at: number): readonly TranscriptLine[] {
  const t = (n: number): string => new Date(at + n * 1_000).toISOString();
  return [
    { uuid: `${session}-1`, parentUuid: null, timestamp: t(0), type: "assistant",
      isSidechain: false, sessionId: session,
      message: { toolName: "Read", usage: { input_tokens: 1_200, output_tokens: 80 } } },
    { uuid: `${session}-2`, parentUuid: `${session}-1`, timestamp: t(1), type: "assistant",
      isSidechain: false, sessionId: session,
      message: { toolName: "Task", usage: { input_tokens: 900, output_tokens: 140 } } },
    { uuid: `${session}-s1`, parentUuid: `${session}-2`, timestamp: t(2), type: "assistant",
      isSidechain: true, sessionId: session, agentId: `${session}-agent`,
      message: { toolName: "Grep", usage: { input_tokens: 4_000, output_tokens: 300 } } },
    { uuid: `${session}-s2`, parentUuid: `${session}-s1`, timestamp: t(3), type: "assistant",
      isSidechain: true, sessionId: session, agentId: `${session}-agent`,
      message: { toolName: "Bash", usage: { input_tokens: 5_100, output_tokens: 420 } } },
    { uuid: `${session}-3`, parentUuid: `${session}-2`, timestamp: t(4), type: "user",
      isSidechain: false, sessionId: session,
      toolUseResult: { agentId: `${session}-agent`,
                       usage: { input_tokens: 9_100, output_tokens: 720 } } },
    { uuid: `${session}-4`, parentUuid: `${session}-3`, timestamp: t(5), type: "assistant",
      isSidechain: false, sessionId: session,
      message: { toolName: "Write", usage: { input_tokens: 2_400, output_tokens: 260 } } },
  ];
}

function visible(work: Work): readonly TranscriptLine[] {
  return work.lines.slice(0, Math.min(work.tick, work.lines.length));
}

/** The exit record is held back until one tick past the last line. Deliberate: that tick is a
 *  session whose record has stopped growing and whose process has not stopped running. */
function exitVisible(work: Work): ExitRecord | null {
  return work.tick > work.lines.length + 1 ? work.exit : null;
}

// ---------------------------------------------------------------------------------------
// Mapping the feed onto the port

function toEvent(line: TranscriptLine): ObservedEvent {
  const kind = line.message?.toolName ?? (line.toolUseResult ? "delegated_result" : line.type);
  return {
    event_id: line.uuid,
    at: line.timestamp,
    kind,
    summary: line.isSidechain ? `delegated turn (${kind})` : `turn (${kind})`,
  };
}

/**
 * The consumption records, with the one relationship that decides double counting.
 *
 * A delegating turn's result is marked `includes_descendants` and every delegated turn of that
 * agent is parented to it. The rule in `usage.ts` then counts the rollup and excludes the
 * delegated turns by name — so the delegated work appears in the total exactly once, and the
 * total says which records it left out rather than leaving a reader to wonder.
 *
 * `parent_record_id` IS CONTAINMENT AND NOTHING ELSE, which is the one thing this function got
 * wrong the first time it was written and the reason the mistake is worth a paragraph. The
 * line's own `parentUuid` is a CONVERSATIONAL link: it says which turn came before, and the
 * turn after a delegation points at the delegation's result. Exporting that link as a
 * containment edge put every subsequent turn of the main session inside the rollup, and the
 * rule then excluded them all as already counted — a total that was quietly nine thousand
 * tokens light and looked exactly like a correct one. So nothing but a delegated turn gets a
 * parent here: a main-session turn is contained in nothing, and says so.
 */
function toUsageRecords(lines: readonly TranscriptLine[]): readonly UsageRecord[] {
  const rollupOf = new Map<string, string>();
  for (const line of lines) {
    if (line.toolUseResult) rollupOf.set(line.toolUseResult.agentId, line.uuid);
  }
  const out: UsageRecord[] = [];
  for (const line of lines) {
    if (line.toolUseResult) {
      out.push({
        record_id: line.uuid,
        parent_record_id: null,
        includes_descendants: true,
        input_tokens: line.toolUseResult.usage.input_tokens,
        output_tokens: line.toolUseResult.usage.output_tokens,
      });
      continue;
    }
    const usage = line.message?.usage;
    if (!usage) continue;
    const rollup = line.agentId ? rollupOf.get(line.agentId) : undefined;
    out.push({
      record_id: line.uuid,
      // A delegated turn hangs off the rollup that contains it; nothing else hangs off
      // anything. Where the rollup has not been observed yet, the delegated turn is a root and
      // is counted — the honest answer at that moment — and it moves under the rollup as soon
      // as the result line arrives.
      parent_record_id: rollup ?? null,
      includes_descendants: false,
      input_tokens: usage.input_tokens,
      output_tokens: usage.output_tokens,
    });
  }
  return out;
}

const digest = (text: string): string =>
  Array.from(text).reduce((h, c) => (h * 33 + c.charCodeAt(0)) % 0xffff_ffff, 5_381)
    .toString(16).padStart(8, "0");

export const claudeCodeAdapter: RuntimeAdapter = {
  id: CAPABILITIES.adapter,
  eventFormat: EVENT_FORMAT.id,

  capabilities(): RuntimeCapabilities {
    return CAPABILITIES;
  },

  /** Assets are files this runtime reads from a directory, so the locator is a path and the
   *  identity is the digest beside it. A caller comparing two runs compares digests. */
  load_method(request: LoadMethodRequest): MethodBinding {
    const revision = request.revision ?? "current";
    const assets: readonly BoundAsset[] = [
      { role: "method_text", locator: `methods/${request.method}/instructions.md`,
        digest: digest(`${request.method}@${revision}:text`), bytes: 4_096 },
      { role: "reference_material", locator: `methods/${request.method}/reference.md`,
        digest: digest(`${request.method}@${revision}:reference`), bytes: 2_048 },
      { role: "permitted_actions", locator: `methods/${request.method}/allowed.json`,
        digest: digest(`${request.method}@${revision}:allowed`), bytes: 512 },
    ];
    return { method: request.method, revision, assets, bound_at: new Date().toISOString() };
  },

  /** A work id, and nothing that could be mistaken for a result. The session identifier and
   *  the start time come back at submission and are spawn metadata: they say a session was
   *  opened, which is not a statement about what it did or whether it is still open. */
  dispatch(request: DispatchRequest): DispatchAck {
    const id = `cc-${++issued}`;
    const session = `sess-${issued}`;
    const at = Date.UTC(2026, 0, 1, 12, 0, 0) + issued * 60_000;
    world.set(id, {
      claim: request.claim,
      session_id: session,
      lines: script(session, at),
      exit: { at: new Date(at + 12_000).toISOString(), reason: "completed" },
      tick: 0,
    });
    return { work_id: id, accepted_at: new Date().toISOString(), observe_after_ms: 1_000 };
  },

  observe(request: ObserveRequest): Observation {
    const work = world.get(request.work_id);
    const observed_at = new Date().toISOString();
    if (!work) {
      return { work_id: request.work_id, observed_at, events: [], completeness:
        "observation_unavailable", receipt: null, last_activity_at: null,
        elapsed_at_least_ms: null, usage: null };
    }
    work.tick += 1;
    const lines = visible(work);
    const events = lines.map(toEvent);
    // FROM THE FEED, NEVER FROM THE CLOCK. Both of these are statements about what the runtime
    // recorded; reading them off the adapter's own clock would make the platform's latency
    // look like the work's duration.
    const first = lines[0]?.timestamp ?? null;
    const last = lines[lines.length - 1]?.timestamp ?? null;
    const elapsed = first !== null && last !== null
      ? Date.parse(last) - Date.parse(first) : null;
    const usage = lines.length ? summariseUsage(toUsageRecords(lines)) : null;
    const base = { work_id: request.work_id, observed_at, events, last_activity_at: last,
                   elapsed_at_least_ms: elapsed, usage };
    const exit = exitVisible(work);
    if (exit) {
      return {
        ...base,
        completeness: "receipt_confirmed",
        receipt: { work_id: request.work_id, ended_at: exit.at,
                   exit: exit.reason === "completed" ? "finished"
                       : exit.reason === "interrupted" ? "stopped" : "failed",
                   assurance: "runtime_confirmed" },
      };
    }
    return {
      ...base,
      // Still producing lines means running. Out of lines with no exit record means the feed
      // went quiet, which is all it means.
      completeness: work.tick <= work.lines.length ? "running" : "last_activity_only",
      receipt: null,
    };
  },

  cancel(request: CancelRequest): CancelOutcome {
    const work = world.get(request.work_id);
    if (!work) {
      return { state: "unsupported", work_id: request.work_id,
               because: "no such work is known to this adapter, so nothing was asked to stop" };
    }
    const exit = exitVisible(work);
    if (exit) {
      return { state: "confirmed_stopped", work_id: request.work_id, stopped_at: exit.at,
               confirmed_by: "runtime_exit_record", treatedAsStopped: true };
    }
    return {
      state: "requested",
      work_id: request.work_id,
      requested_at: new Date().toISOString(),
      // The signal is taken at a step boundary, so a step already under way finishes and
      // writes its line. How long that takes is the runtime's published bound and nothing
      // more; whether this particular worker is still writing is answered by observing it,
      // not by the adapter that just sent the signal.
      settles_within_ms: CAPABILITIES.cancellation.settles_within_ms,
    };
  },

  /** This runtime can continue a session it still holds, which is why the capability is
   *  declared rather than refused. The continuation is a new work id against the same claim,
   *  anchored to the last thing actually observed — or, before anything has been observed, to
   *  the session the submission opened. */
  resume(request: ResumeRequest): ResumeOutcome {
    const work = world.get(request.work_id);
    if (!work) {
      return { state: "unsupported",
               because: "no such work is known to this adapter, so there is nothing to continue" };
    }
    const lines = visible(work);
    const id = `cc-${++issued}`;
    world.set(id, { ...work, tick: 0 });
    return { state: "resumed", work_id: id, continues: request.work_id,
             from_event_id: lines[lines.length - 1]?.uuid ?? work.session_id };
  },
};
