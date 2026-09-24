/**
 * The second runtime adapter: a work queue where jobs are submitted, leased to a worker and
 * metered per step. A fixture — it runs nothing, opens nothing and waits for nothing, and its
 * feed is scripted, advancing one tick per {@link observe}.
 *
 * DELIBERATE: it is unlike the first adapter in the two places the port is most likely to
 * have been shaped around the first, so that a second adapter is evidence the port is a port
 * rather than the first one renamed. Each difference is one a caller has to write code for:
 *
 *   · An event is an ordinal, not an opaque identifier. Frames are numbered, ordered by that
 *     number rather than by arrival, and stamped with an integer epoch. A frame has no
 *     parentage, and nothing records a session.
 *   · The feed is a replaced snapshot and it loses entries: each poll returns what the
 *     bounded buffer still holds, and the ordinals show the gaps. Metering is kept
 *     separately and is not dropped, so a lossy feed does not make consumption incomplete.
 *   · Stopping is absent, not weaker. There is no channel to a leased worker, so `cancel`
 *     answers `unsupported` rather than `requested`. The only lever is declining to renew
 *     the lease, and the script keeps producing frames after a lease lapses.
 *   · Continuing is absent too. Work resumes by being submitted again, from nothing.
 *
 * It is stronger than the first in one place: the queue either holds a job or does not, so it
 * issues a completion record the moment the job leaves, with no quiet window.
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

/** One status frame. Identity is the ordinal; time is an integer epoch; there is no parent
 *  and no identifier for the run it belongs to. */
interface StatusFrame {
  readonly seq: number;
  readonly epoch_ms: number;
  readonly phase: "queued" | "leased" | "step_started" | "step_finished"
                | "lease_lapsed" | "job_finished";
  readonly step: number;
  readonly note: string;
}

/** One metering row, in the queue's own units. Kept in the queue's accounting rather than in
 *  its status buffer, which is why it survives a buffer that drops frames. */
interface MeterRow {
  readonly meter_id: string;
  readonly step: number;
  readonly prompt_units: number;
  readonly emitted_units: number;
}

/** The record the queue posts when a job leaves it. Authoritative, and separate from the
 *  status buffer that may have lost half of what the job did. */
interface JobOutcome {
  readonly epoch_ms: number;
  readonly outcome: "succeeded" | "errored";
}

const EVENT_FORMAT: EventFormatIdentity = {
  id: "queue-status-frames",
  identity_of_an_event: "ordinal",
  time_encoding: "epoch_millis",
  delivery: "replaced_snapshot",
  ordering: "by_ordinal",
  may_drop_events: true,
};

/**
 * Three capabilities are declared missing, each with its reason, and `simulated: false` on
 * every one. A caller needing any of them is told before the work starts rather than
 * discovering it from an answer that looked like the one it wanted.
 */
const DECLARATION: CapabilityDeclaration = {
  adapter: "batch-queue",
  event_format: EVENT_FORMAT,
  supported: ["live_observation", "completion_receipt", "usage_accounting"],
  unsupported: [
    { capability: "confirm_stop", simulated: false,
      because: "the queue holds no channel to a leased worker, so no report that one stopped "
             + "can ever reach it" },
    { capability: "request_stop", simulated: false,
      because: "there is no stop channel to send a request down; declining to renew the lease "
             + "is the only lever and it asks the worker for nothing" },
    { capability: "resume_after_stop", simulated: false,
      because: "a job that leaves the queue leaves no state behind; work continues only by "
             + "being submitted again from the beginning" },
  ],
  cancellation: {
    strongest: "unsupported",
    // Null is unknown: with no channel to the worker there is nothing that would settle, so
    // there is no bound to give.
    settles_within_ms: null,
    lease_expiry_proves_stop: false,
  },
};

/** Identity derived from the declaration above, never typed beside it: the three refusals are
 *  part of what this adapter is, so changing one changes its identity. */
const CAPABILITIES: RuntimeCapabilities = {
  ...DECLARATION,
  protocol: PORT_PROTOCOL,
  declaration_digest: declarationDigest(DECLARATION),
};

// ---------------------------------------------------------------------------------------
// The scripted world

/** How many frames the queue's buffer holds. Earlier frames are dropped, which is the whole
 *  reason this runtime's activity feed is declared lossy. */
const BUFFER = 3;

interface Job {
  readonly claim: string;
  readonly frames: readonly StatusFrame[];
  readonly meters: readonly MeterRow[];
  readonly outcome: JobOutcome;
  tick: number;
}

const world = new Map<string, Job>();
let submitted = 0;

/** The scripted frames for one job.
 *
 *  DELIBERATE: the ordinals jump at the fourth entry — a dropped frame leaves a hole rather
 *  than being renumbered — and the job keeps producing frames after the lease lapses. */
function frames(base: number): readonly StatusFrame[] {
  return [
    { seq: 1, epoch_ms: base, phase: "queued", step: 0, note: "accepted into the queue" },
    { seq: 2, epoch_ms: base + 2_000, phase: "leased", step: 0,
      note: "leased to a worker for 6s" },
    { seq: 3, epoch_ms: base + 3_000, phase: "step_started", step: 1, note: "step 1 began" },
    { seq: 6, epoch_ms: base + 7_000, phase: "step_finished", step: 1,
      note: "step 1 ended; frames 4 and 5 were dropped by the buffer" },
    { seq: 7, epoch_ms: base + 8_000, phase: "lease_lapsed", step: 2,
      note: "the lease was not renewed; the worker was never told and is still emitting" },
    { seq: 8, epoch_ms: base + 11_000, phase: "step_finished", step: 2,
      note: "step 2 ended, after the lease had lapsed" },
    { seq: 9, epoch_ms: base + 12_000, phase: "job_finished", step: 2,
      note: "the job left the queue" },
  ];
}

/** Flat metering, one row per step, nothing rolled up. The rule that excludes a delegated
 *  run's turns under the other adapter counts every row here exactly once. */
function meters(): readonly MeterRow[] {
  return [
    { meter_id: "m1", step: 1, prompt_units: 3_100, emitted_units: 240 },
    { meter_id: "m2", step: 2, prompt_units: 2_450, emitted_units: 190 },
  ];
}

// ---------------------------------------------------------------------------------------
// Mapping the feed onto the port

function toEvent(frame: StatusFrame): ObservedEvent {
  return {
    event_id: `frame-${frame.seq}`,
    at: new Date(frame.epoch_ms).toISOString(),
    kind: frame.phase,
    summary: frame.note,
  };
}

/** The queue's units, renamed at the boundary and nowhere else. Every row is its own record
 *  with no parent, so nothing here can contain anything else. */
function toUsageRecords(rows: readonly MeterRow[]): readonly UsageRecord[] {
  return rows.map((row) => ({
    record_id: row.meter_id,
    parent_record_id: null,
    includes_descendants: false,
    input_tokens: row.prompt_units,
    output_tokens: row.emitted_units,
  }));
}

const digest = (text: string): string =>
  Array.from(text).reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 0xffff_ffff, 7_919)
    .toString(16).padStart(8, "0");

export const batchQueueAdapter: RuntimeAdapter = {
  id: CAPABILITIES.adapter,
  eventFormat: EVENT_FORMAT.id,

  capabilities(): RuntimeCapabilities {
    return CAPABILITIES;
  },

  /** Assets travel inside the job payload, addressed by slot. There is no path in this
   *  runtime and nothing a caller could open, so the digest is the whole identity. */
  load_method(request: LoadMethodRequest): MethodBinding {
    const revision = request.revision ?? "head";
    const assets: readonly BoundAsset[] = [
      { role: "method_text", locator: "payload[0]",
        digest: digest(`${request.method}/${revision}/text`), bytes: 4_096 },
      { role: "permitted_actions", locator: "payload[1]",
        digest: digest(`${request.method}/${revision}/allowed`), bytes: 512 },
    ];
    return { method: request.method, revision, assets, bound_at: new Date().toISOString() };
  },

  dispatch(request: DispatchRequest): DispatchAck {
    const id = `bq-${++submitted}`;
    const base = Date.UTC(2026, 0, 1, 9, 0, 0) + submitted * 60_000;
    world.set(id, {
      claim: request.claim,
      frames: frames(base),
      meters: meters(),
      outcome: { epoch_ms: base + 12_000, outcome: "succeeded" },
      tick: 0,
    });
    return { work_id: id, accepted_at: new Date().toISOString(), observe_after_ms: 5_000 };
  },

  observe(request: ObserveRequest): Observation {
    const job = world.get(request.work_id);
    const observed_at = new Date().toISOString();
    if (!job) {
      return { work_id: request.work_id, observed_at, events: [],
               completeness: "observation_unavailable", receipt: null, last_activity_at: null,
               elapsed_at_least_ms: null, usage: null };
    }
    job.tick += 1;
    // The buffer holds the last few frames produced; everything earlier is gone. What comes
    // out is a window rather than a history, and the numbers below are about the window.
    const produced = job.frames.slice(0, Math.min(job.tick, job.frames.length));
    const held = produced.slice(-BUFFER);
    const events = held.map(toEvent);
    const first = held[0]?.epoch_ms ?? null;
    const last = held[held.length - 1]?.epoch_ms ?? null;
    const usage = job.tick > 0 ? summariseUsage(toUsageRecords(job.meters)) : null;
    const base = {
      work_id: request.work_id,
      observed_at,
      events,
      last_activity_at: last === null ? null : new Date(last).toISOString(),
      elapsed_at_least_ms: first !== null && last !== null ? last - first : null,
      usage,
    };
    if (job.tick > job.frames.length) {
      return {
        ...base,
        completeness: "receipt_confirmed",
        receipt: {
          work_id: request.work_id,
          ended_at: new Date(job.outcome.epoch_ms).toISOString(),
          exit: job.outcome.outcome === "succeeded" ? "finished" : "failed",
          assurance: "runtime_confirmed",
        },
      };
    }
    return { ...base, completeness: "running", receipt: null };
  },

  /** DELIBERATE: always `unsupported`, never `requested`. There is no channel, so there is
   *  nothing to have asked, and `requested` would make a caller wait out a settling time for
   *  a signal that does not exist. */
  cancel(request: CancelRequest): CancelOutcome {
    return {
      state: "unsupported",
      work_id: request.work_id,
      because: "this runtime has no stop channel; the only lever is declining to renew the "
             + "lease, and a lapsed lease means the queue stopped waiting, not that the "
             + "worker stopped working",
    };
  },

  resume(_request: ResumeRequest): ResumeOutcome {
    return {
      state: "unsupported",
      because: "a job that leaves this queue leaves no state behind; there is nothing to "
             + "continue from and work restarts from the beginning",
    };
  },
};
