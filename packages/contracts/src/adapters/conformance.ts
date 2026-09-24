/**
 * Every runtime adapter this release ships, and the one protocol all of them are driven
 * through.
 *
 * One protocol drives both adapters through the whole sequence — declare, bind, submit, watch,
 * stop, continue, account — asserting the port's rules about the answers rather than the
 * answers themselves. Where the two runtimes differ, it asserts each adapter against its own
 * declaration: one that says it can confirm a stop has to confirm one, and one that says it
 * cannot must never produce the confirmed answer. Neither assertion can be satisfied by
 * imitating the other adapter.
 *
 * The name scan covers two surfaces, and only one fails a run:
 *
 *   · the shared vocabulary — every constant the port publishes. A hit fails the run for every
 *     adapter, because it is the platform's own material that leaked.
 *   · the adapter's own surface — every string it produced during this run, every key of every
 *     object it produced, and the source text of its six operations. A hit is reported in
 *     {@link ConformanceReport.usedClaudeToolNames} and does not fail the run: the first
 *     runtime's adapter is supposed to speak its runtime's language, and running this against
 *     it yields a non-empty list, which is what gives an empty one meaning.
 *
 * The source half reads the six operations' own bodies, not the module-private helpers they
 * call, so a name moved one call deeper is invisible to it. The produced-value half has no
 * such limit.
 */
import { batchQueueAdapter } from "./batch-queue.js";
import { claudeCodeAdapter } from "./claude-code.js";
import {
  ASSET_ROLES, CANCEL_STATES, OBSERVED_COMPLETENESS, PORT_PROTOCOL, RECEIPT_ASSURANCE,
  RUNTIME_CAPABILITIES, RUNTIME_OPERATIONS, STOP_EVIDENCE, admitToRuntime, cancelStrength,
  declarationDigest,
  type CancelOutcome, type CapabilityDeclaration, type Observation, type RuntimeAdapter,
} from "./port.js";

/** Every runtime adapter this release ships. The registry is a plain object keyed by the kind
 *  of thing adapted, so a second kind arrives as a second key rather than as a second import
 *  path every consumer has to learn. */
export const adapters: { readonly runtime: readonly RuntimeAdapter[] } = {
  runtime: [claudeCodeAdapter, batchQueueAdapter],
};

/** What one conformance run found. `steps` is the sequence actually driven, so a failure names
 *  where in the protocol it happened instead of leaving a reader to guess. */
export interface ConformanceReport {
  readonly adapter: string;
  readonly passed: boolean;
  readonly reason: string | null;
  readonly usedClaudeToolNames: readonly string[];
  readonly steps: readonly string[];
}

const FIRST_HARNESS_NAMES: readonly string[] = [
  "Task", "Bash", "BashOutput", "KillShell", "Glob", "Grep", "Read", "Edit", "Write",
  "NotebookEdit", "WebFetch", "WebSearch", "TodoWrite", "SlashCommand", "ExitPlanMode",
  ".jsonl", ".claude/", "parentUuid", "isSidechain", "toolUseResult",
];

/** Word-bounded for the identifier-shaped names, literal for the two that are not identifiers.
 *  Case matters: `Read` is a tool name and `read` is English, and a scan that could not tell
 *  them apart would fire on every sentence and be switched off within a week. */
function marksFirstHarness(text: string): readonly string[] {
  const hits: string[] = [];
  for (const name of FIRST_HARNESS_NAMES) {
    const pattern = /^[A-Za-z]+$/.test(name)
      ? new RegExp(`\\b${name}\\b`)
      : new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    if (pattern.test(text)) hits.push(name);
  }
  return hits;
}

/** Every string reachable in a produced value, keys included — a key is a name the adapter
 *  chose just as much as a value is. Depth-bounded because a cyclic structure would otherwise
 *  turn a scan into a hang, and nothing this port produces is anywhere near that deep. */
function reachableStrings(value: unknown, into: string[], depth: number): void {
  if (depth > 8) return;
  if (typeof value === "string") { into.push(value); return; }
  if (Array.isArray(value)) {
    for (const item of value) reachableStrings(item, into, depth + 1);
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      into.push(key);
      reachableStrings(item, into, depth + 1);
    }
  }
}

const SHARED_VOCABULARY: readonly string[] = [
  ...RUNTIME_OPERATIONS, ...RUNTIME_CAPABILITIES, ...ASSET_ROLES, ...CANCEL_STATES,
  ...OBSERVED_COMPLETENESS, ...RECEIPT_ASSURANCE, ...STOP_EVIDENCE,
];

/**
 * Drive one adapter through the whole protocol and report what it did.
 *
 * Synchronous, like everything else in this package: the adapters here are fixtures over
 * scripted feeds, and a caller reading a verdict off the result has no promise to unwrap. A
 * real adapter over a real runtime would be asynchronous and this protocol would move with it;
 * what would not move is any of the rules below, which are about honesty rather than timing.
 */
export function runConformance(adapter: RuntimeAdapter): ConformanceReport {
  const steps: string[] = [];
  const produced: unknown[] = [];
  const surface: string[] = [];
  for (const op of RUNTIME_OPERATIONS) surface.push(String(adapter[op]));

  const finish = (reason: string | null): ConformanceReport => {
    for (const value of produced) reachableStrings(value, surface, 0);
    return {
      adapter: adapter.id,
      passed: reason === null,
      reason,
      usedClaudeToolNames: marksFirstHarness(surface.join("\n")),
      steps,
    };
  };
  const track = <T>(step: string, value: T): T => {
    steps.push(step);
    produced.push(value);
    return value;
  };

  const leaked = marksFirstHarness(SHARED_VOCABULARY.join("\n"));
  if (leaked.length) {
    return finish(`the shared port vocabulary carries first-runtime names: ${leaked.join(", ")}`);
  }

  // What it says it is
  for (const op of RUNTIME_OPERATIONS) {
    if (typeof adapter[op] !== "function") return finish(`${op} is not implemented`);
  }
  const caps = track("capabilities", adapter.capabilities());
  if (caps.adapter !== adapter.id) {
    return finish(`capabilities name ${caps.adapter} but the adapter is ${adapter.id}`);
  }
  if (caps.event_format.id !== adapter.eventFormat) {
    return finish("the declared event format and the adapter's own eventFormat have drifted");
  }
  if (caps.protocol !== PORT_PROTOCOL) {
    return finish(`this adapter implements ${caps.protocol}, and this port is ${PORT_PROTOCOL}`);
  }
  // The identity is recomputed, not read: an identity an adapter states is one that survives an
  // edit to the thing it identifies. Rebuilt field by field rather than by stripping two keys,
  // so a field added to the declaration later fails to compile here instead of quietly falling
  // out of the identity.
  const declared: CapabilityDeclaration = {
    adapter: caps.adapter,
    event_format: caps.event_format,
    supported: caps.supported,
    unsupported: caps.unsupported,
    cancellation: caps.cancellation,
  };
  if (caps.declaration_digest !== declarationDigest(declared)) {
    return finish("the capability identity was not derived from what this adapter declares");
  }
  const supported = new Set<string>(caps.supported);
  for (const refusal of caps.unsupported) {
    if (supported.has(refusal.capability)) {
      return finish(`${refusal.capability} is declared both supported and unsupported`);
    }
    if (refusal.simulated !== false) {
      return finish(`${refusal.capability} is declared unsupported and simulated anyway`);
    }
    if (!refusal.because) return finish(`${refusal.capability} is refused with no reason`);
  }
  if (caps.cancellation.lease_expiry_proves_stop !== false) {
    return finish("this adapter claims a lease expiry proves a worker stopped");
  }
  const strongest = caps.cancellation.strongest;
  if (supported.has("confirm_stop") !== (strongest === "confirmed_stopped")
      || supported.has("request_stop") !== (cancelStrength(strongest) >= 1)) {
    return finish(`the declared cancellation capabilities and the strongest state (${strongest}) disagree`);
  }

  // Admission, which is what an unsupported capability is for
  const everything = track("admit_everything",
    admitToRuntime(caps, { task: "conformance", requires: RUNTIME_CAPABILITIES }));
  for (const capability of RUNTIME_CAPABILITIES) {
    if (supported.has(capability)) continue;
    const reported = everything.refused.some((r) => r.capability === capability)
      || everything.undeclared.includes(capability);
    if (!reported) return finish(`${capability} is neither supported nor reported by admission`);
  }
  if (everything.admitted !== (supported.size === RUNTIME_CAPABILITIES.length)) {
    return finish("admission admitted work this adapter cannot carry out");
  }
  const withinReach = track("admit_supported",
    admitToRuntime(caps, { task: "conformance", requires: caps.supported }));
  if (!withinReach.admitted) {
    return finish("admission refused work using only capabilities this adapter declares");
  }

  // Binding, and the identity that makes two runs comparable
  const binding = track("load_method", adapter.load_method({ method: "m1", revision: "r1" }));
  if (binding.method !== "m1" || binding.revision !== "r1") {
    return finish("the binding does not name the method and revision that were asked for");
  }
  if (!binding.assets.length) return finish("the binding bound no assets");
  const digests = new Set<string>();
  for (const asset of binding.assets) {
    if (!ASSET_ROLES.includes(asset.role)) return finish(`unknown asset role ${asset.role}`);
    if (!asset.digest || !asset.locator || asset.bytes <= 0) {
      return finish(`asset ${asset.role} was bound without an exact identity`);
    }
    digests.add(asset.digest);
  }
  if (digests.size !== binding.assets.length) {
    return finish("two bound assets share a digest, so the binding cannot identify either");
  }
  const again = adapter.load_method({ method: "m1", revision: "r1" });
  if (again.assets.map((a) => a.digest).join() !== binding.assets.map((a) => a.digest).join()) {
    return finish("binding the same method twice bound different assets");
  }

  // Submission returns an identifier, and only an identifier
  const first = track("dispatch", adapter.dispatch({ claim: "claim-1", contract: { of: "work" } }));
  if (!first.work_id) return finish("dispatch returned no work id");
  if ("completed" in first || "receipt" in first) {
    return finish("dispatch answered a submission with a result");
  }
  const second = adapter.dispatch({ claim: "claim-2", contract: {} });
  if (second.work_id === first.work_id) return finish("two dispatches share a work id");

  // Watching, where the last thing seen must stay the last thing seen
  let latest: Observation | null = null;
  let sawActivityWithoutReceipt = false;
  let sawRunning = false;
  for (let poll = 0; poll < 24; poll += 1) {
    const seen = adapter.observe({ work_id: first.work_id });
    latest = seen;
    if (!OBSERVED_COMPLETENESS.includes(seen.completeness)) {
      return finish(`observe reported an unknown completeness: ${seen.completeness}`);
    }
    if (seen.completeness === "running") sawRunning = true;
    if (seen.completeness !== "receipt_confirmed") {
      if (seen.receipt !== null) return finish("an unconfirmed observation carried a receipt");
      if (seen.events.length) sawActivityWithoutReceipt = true;
    }
    const stamps = seen.events.map((e) => Date.parse(e.at));
    if (stamps.some((ms) => Number.isNaN(ms))) return finish("an event carries an unparseable time");
    for (let i = 1; i < stamps.length; i += 1) {
      if (stamps[i] < stamps[i - 1]) return finish("observed events are not in observation order");
    }
    const lastStamp = seen.events.length ? seen.events[seen.events.length - 1].at : null;
    if (seen.last_activity_at !== lastStamp) {
      return finish("last_activity_at is not the last event actually observed");
    }
    const floor = stamps.length ? stamps[stamps.length - 1] - stamps[0] : null;
    if (seen.elapsed_at_least_ms !== floor) {
      return finish("elapsed_at_least_ms was not derived from the observed events");
    }
    if (seen.completeness === "receipt_confirmed") {
      const receipt = seen.receipt;
      if (receipt.work_id !== first.work_id) return finish("a receipt names the wrong work");
      if (!RECEIPT_ASSURANCE.includes(receipt.assurance)) {
        return finish(`a receipt carries an unknown assurance: ${receipt.assurance}`);
      }
      if (Number.isNaN(Date.parse(receipt.ended_at))) {
        return finish("a receipt carries an unparseable end time");
      }
      break;
    }
  }
  if (latest === null) return finish("observe was never reached");
  track("observe", latest);
  if (!sawActivityWithoutReceipt) {
    return finish("this adapter never reported activity without also claiming completion");
  }
  if (supported.has("live_observation") !== sawRunning) {
    return finish("live observation is declared and never demonstrated, or the reverse");
  }
  const confirmedEnd = latest.completeness === "receipt_confirmed";
  if (confirmedEnd && !supported.has("completion_receipt")) {
    return finish("a receipt arrived from an adapter that declares it issues none");
  }
  if (!confirmedEnd && supported.has("completion_receipt")) {
    return finish("a completion receipt is declared and was never produced");
  }

  // Stopping: a request is a request
  adapter.observe({ work_id: second.work_id });
  const outcomes: readonly CancelOutcome[] = [
    track("cancel_in_flight", adapter.cancel({ work_id: second.work_id, because: "no longer needed" })),
    track("cancel_after_end", adapter.cancel({ work_id: first.work_id })),
  ];
  for (const outcome of outcomes) {
    if (!CANCEL_STATES.includes(outcome.state)) return finish(`cancel returned ${outcome.state}`);
    if (cancelStrength(outcome.state) > cancelStrength(strongest)) {
      return finish(`cancel answered ${outcome.state} while declaring ${strongest} is its limit`);
    }
    if (outcome.state === "requested" && "treatedAsStopped" in outcome) {
      return finish("a cancellation request was carried as a confirmation");
    }
    if (outcome.state === "confirmed_stopped") {
      if (!STOP_EVIDENCE.includes(outcome.confirmed_by)) {
        return finish(`a stop was confirmed by ${outcome.confirmed_by}, which is not runtime evidence`);
      }
      if (outcome.treatedAsStopped !== true) return finish("a confirmed stop did not say so");
    }
    if (outcome.state === "unsupported" && !outcome.because) {
      return finish("cancel is unsupported and does not say why");
    }
  }
  const states = outcomes.map((o) => o.state);
  if (supported.has("confirm_stop") !== states.includes("confirmed_stopped")) {
    return finish("confirming a stop is declared and never demonstrated, or the reverse");
  }
  if (supported.has("request_stop") !== states.includes("requested")) {
    return finish("requesting a stop is declared and never demonstrated, or the reverse");
  }

  // Continuing
  const resumed = track("resume", adapter.resume({ work_id: first.work_id }));
  if (supported.has("resume_after_stop") !== (resumed.state === "resumed")) {
    return finish("continuing work is declared and never demonstrated, or the reverse");
  }
  if (resumed.state === "resumed") {
    if (resumed.continues !== first.work_id) return finish("a continuation names the wrong work");
    if (resumed.work_id === first.work_id) return finish("a continuation reused the work id");
    if (!resumed.from_event_id) return finish("a continuation names no point to continue from");
  } else if (!resumed.because) {
    return finish("continuing is unsupported and does not say why");
  }

  // Accounting, counted once
  const usage = latest.usage;
  if (supported.has("usage_accounting") && usage === null) {
    return finish("consumption is declared and was never reported");
  }
  if (usage !== null) {
    if (usage.rule !== "no_ancestor_rollup") return finish(`consumption was summed under ${usage.rule}`);
    const seenIds = new Set<string>();
    for (const id of [...usage.counted, ...usage.excluded_as_rolled_up,
                      ...usage.excluded_as_unresolvable]) {
      if (seenIds.has(id)) return finish(`record ${id} appears twice in the accounting`);
      seenIds.add(id);
    }
    if (usage.input_tokens < 0 || usage.output_tokens < 0) {
      return finish("consumption is negative");
    }
    if ((usage.completeness === "floor_only") !== (usage.excluded_as_unresolvable.length > 0)) {
      return finish("the accounting's completeness does not match what it could not resolve");
    }
    // An adapter that sees both a parent's rollup and its children's own records has to have
    // excluded something. Declaring the capability and then counting every record is the
    // double-counting defect, and it is invisible in the total.
    if (supported.has("subagent_usage_records") && !usage.excluded_as_rolled_up.length) {
      return finish("delegated records are declared and nothing was excluded as already counted");
    }
  }

  return finish(null);
}
