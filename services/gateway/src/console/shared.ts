import { catalogManifest, isFlow, skillText, withHandover } from "@zz/catalog";
import { documentApplies } from "@zz/contracts";
import type { Request, Response } from "express";

import { platformDbReady } from "../db.js";
import { isSuper } from "../identity.js";
import { resolveScope, type Scope } from "../scope.js";

/** A `Scope` that has already cleared `handler()`'s refusal check — never "refused",
 * because every handler below runs only after that case has answered the request.
 *
 * COUPLED: console-write.ts reuses this type and `handler()` rather than resolving a
 * scope its own way. */
export type ResolvedScope = Exclude<Scope, { kind: "refused" }>;

/** The ops-flow shape, stated once. The console draws a stepper from it and the
 * API decides `stage` with it.
 *
 * NOT A TOOL: the last member is the flow's closing stage, not the `initiative_close`
 * tool. Renaming it to match would make the stepper render "initiative_close" as a step
 * no flow declares. */
const STAGES = ["intent", "spec", "select", "plan", "build", "verify", "close"] as const;

/** May this caller read the console at all? Every handler calls it.
 */
export function mayReadConsole(id: { via: string; platformRole: string } | null): boolean {
  if (!id) return false;
  if (id.via === "session") return true;      // signed in through the browser
  return isSuper(id as Parameters<typeof isSuper>[0]);  // or a superadmin PAT, for scripts
}

/** Guard: allowed to read, and a database to answer from.
 *
 * Returns false having already replied, so every call site is written
 * `if (!ok(req,res)) return;` — falling through would send twice.
 */
export function ok(req: Request, res: Response): boolean {
  if (!platformDbReady()) {
    res.status(503).json({ error: "platform database unavailable" });
    return false;
  }
  const id = req.zzIdentity;
  if (!id) {
    res.status(401).json({ error: "authentication required" });
    return false;
  }
  // The 403 names the door the caller came through: a bare 403 reads as a bad password.
  if (!mayReadConsole(id)) {
    res.status(403).json({
      error: `the console needs a browser sign-in — ${id.email} authenticated by ${id.via}`,
    });
    return false;
  }
  return true;
}

/** Wrap a handler so a thrown error becomes a 500 with a logged cause, and so
 * every handler receives a `Scope` without resolving one itself.
 *
 * The only call to `resolveScope` in this file. A refused scope answers here, before `fn`
 * runs, so no handler below writes its own team refusal.
 *
 * DELIBERATE: `req.zzIdentity!` is not an unchecked assertion — `ok()` above has already
 * refused any request with no identity.
 *
 * The `.catch` is required: every handler is async and Express 4 does not catch a rejected
 * promise, so an unhandled rejection leaves the request hanging. */
export function handler(name: string, fn: (req: Request, res: Response, scope: ResolvedScope) => Promise<void>) {
  return (req: Request, res: Response): void => {
    if (!ok(req, res)) return;
    const scope = resolveScope(req.zzIdentity!, req);
    if (scope.kind === "refused") {
      res.status(scope.status).json({ error: scope.error });
      return;
    }
    void fn(req, res, scope).catch((err: unknown) => {
      console.error(`console ${name} failed:`, err);
      if (!res.headersSent) res.status(500).json({ error: `could not read ${name}` });
    });
  };
}

/** Wrap a route that has no team dimension at all: the plugin catalog, the skills library,
 * the run log, the platform census. No scope is resolved, so a caller who is in no team is
 * answered rather than refused.
 *
 * COUPLED: scripts/gate/checks/console.ts refuses a `teamless` body that filters by team. */
export function teamless(name: string, fn: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response): void => {
    if (!ok(req, res)) return;
    void fn(req, res).catch((err: unknown) => {
      console.error(`console ${name} failed:`, err);
      if (!res.headersSent) res.status(500).json({ error: `could not read ${name}` });
    });
  };
}

/** How far back a read looks, from `?period=`. Null means all time.
 *
 * COUPLED: the console spells the same period vocabulary in its own source; the browser
 * cannot import this module. An unrecognised value falls back to all time rather than
 * throwing, so a console sending a period this gateway does not know gets every row.
 *
 * DELIBERATE: the cutoff is computed from `Date.now()` here, not as `now() - interval` in
 * SQL, so every statement in one request shares one instant. Per-statement `now()` makes a
 * chart's last bucket and a tile's total disagree. */
const PERIOD_DAYS: Record<string, number> = { "1d": 1, "7d": 7, "30d": 30, "90d": 90 };
export function periodCutoff(req: Request): Date | null {
  const days = PERIOD_DAYS[String(req.query.period ?? "")];
  return days ? new Date(Date.now() - days * 24 * 60 * 60 * 1000) : null;
}

type Grain = "hour" | "day" | "week" | "month";

/**
 * The deployment's own timezone: every date this platform states is local to it, and
 * buckets are cut on its calendar rather than UTC's.
 *
 * DELIBERATE: the fallback is Asia/Singapore, not UTC.
 *
 * COUPLED: zz-core's write guards stamp dates through this same variable.
 */
export const ZZ_TZ = (process.env.ZZ_TZ ?? "").trim() || "Asia/Singapore";

/** How wide one bucket of the trend series is.
 *
 * DELIBERATE: the argument is the span between the first and last event in view, not the
 * requested period. A 90-day window over sixteen days of data would otherwise draw three
 * weekly points. `all` needs no special case — its span is the whole log's.
 *
 * Thresholds target roughly 12–60 buckets. The result is passed to `date_trunc($n, ts)` as
 * a bound parameter, not by branching the statement four ways. */
export function grainForSpan(days: number): Grain {
  if (days <= 2) return "hour";     // ≤ 48 hourly buckets
  if (days <= 62) return "day";     // ≤ 62 daily buckets
  if (days <= 730) return "week";   // ≤ ~104 weekly buckets
  return "month";
}

/* Times go out as an instant, never as a pre-formatted local string: ISO 8601 in UTC with
 * the Z, formatted by the browser in the reader's own zone. Dates without a time carry no
 * zone and are sent as they are.
 */

/** What `stageOf` reads: four of the eight columns DocRow carries.
 *
 * DELIBERATE: separate from DocRow, and narrower. Selecting `bytes` makes Postgres detoast
 * every document body, which the list route does not need. DocRow is structurally
 * assignable to this, so the detail route passes unchanged.
 *
 * `type` is read by the no-manifest fallback in `stageOf`. */
export interface StageDoc {
  path: string; type: string; status: string | null; outcome: string | null;
  /** Which documents this one bears on, comma-joined — a source's own declaration. It
   *  evidences a stage that produces evidence rather than a deliverable. */
  supports?: string | null;
}

/** How far an initiative got, from the documents that exist and their approvals.
 *
 * Derived, never stored: no `stage` column exists to drift from the documents. */
export interface DocRow {
  path: string; type: string; status: string | null; outcome: string | null;
  approved_by: string | null; updated_at: string; bytes: number; title: string | null;
}
/** What the flow says about each of its documents: which are gated, which is the closing
 * one, which are required to close.
 *
 * Read from the manifest, never listed here — a list in the console would be right for one
 * flow and wrong for the rest.
 */
export function flowShape(flow: string | null): Map<string, { gate: boolean; closing: boolean; requiredForClose: boolean; role?: string }> {
  const out = new Map<string, { gate: boolean; closing: boolean; requiredForClose: boolean; role?: string }>();
  if (!flow) return out;
  // Through withHandover: the flow as the platform enforces it. The raw manifest has no
  // entry for handover.md, and the platform gates it.
  for (const d of withHandover(catalogManifest(flow, true)?.documents ?? [])) {
    out.set(d.name, {
      gate: d.gate === true,
      closing: d.closing === true,
      requiredForClose: d.requiredForClose === true,
      // Tells the platform's own closing step apart from the flow's documents. The
      // handover.md withHandover appends is written after the close, so a reader asking
      // about an open initiative uses the role to leave it out.
      role: d.role,
    });
  }
  return out;
}

/** An initiative's durable branch facts (FR-58), read from `zz.initiative_fact` (migration
 *  002) — the console's own mirror of `<initiative>/_facts.json`, since it reads `zz.doc`
 *  alone and never the filesystem `writeBranchFacts` (services/zz-core/src/eval/protocol.ts)
 *  writes to. `{}` — no facts recorded, or the flow declares no `when` at all — is `stageOf`'s
 *  own default and behaves exactly as it did before Task I-27: `documentApplies` answers
 *  `applies` for every document that carries no `when`.
 *  DELIBERATE: not exported — `stageOf` below is the one signature that names it; a caller
 *  passes a plain `Record<string, string>` it structurally matches. */
type InitiativeFacts = Record<string, string>;

export function stageOf(docs: StageDoc[], flow: string | null, facts: InitiativeFacts = {}): {
  at: number; of: number; stage: string;
  /** Every step of the diagram in order, bookends included. `open` and `closed` are acts of
   * every initiative and no manifest declares them; between them are the flow's stages.
   *
   * `state` is derived from the manifest and the record, never stored:
   *   done      every document this step declares exists and every gated one is approved — or
   *             it declares none and a later step produced something, so it was passed through
   *   partial   its documents exist, but a gate on one is still open
   *   empty     nothing shows it happened
   *   skipped   (FR-58) every document this step declares is `not_applicable` on this
   *             initiative's own branch — the branch already answered it; it never blocks
   *   waiting   (FR-58) a document this step declares is `undetermined` — the branch has not
   *             been decided yet, which is not the same sentence as "nothing written"
   * `current` marks where an open initiative is now. */
  steps: {
    name: string; what: string; produces: string;
    /** `untracked` is a stage that cannot leave a document — it produces a record or
     *  nothing — with no later stage to prove it ran. `empty` is a stage that owes a
     *  document and has not written one. The console draws them differently. */
    state: "done" | "partial" | "empty" | "untracked" | "skipped" | "waiting"; current: boolean;
  }[];
  /** Placed by index into `steps`, bookends included, so the console places nothing itself. */
  gates: { name: string; passed: boolean; after: number }[]; accepted: boolean;
  /** Everything the flow asks for was there at the close: every gate approved, every document
   *  it requires to close present. False on a close that stopped short. */
  complete: boolean;
  /** Whether it is finished, which is not whether a person signed it: all three outcomes
   *  mean closed, so a `delivered` initiative is as finished as an `accepted` one. */
  closed: boolean;
  /** One of `accepted` | `delivered` | `abandoned`, or null while the initiative is open.
   *  All three mean closed — see @zz/contracts OUTCOMES for what each says. */
  outcome: string | null;
} {
  // `_versions/` holds snapshots carrying the same type as the document they snapshot, so
  // they are dropped before anything counts documents.
  const live = docs.filter((d) => !d.path.startsWith("_versions/"));

  // The flow's own stages and gates, read from its manifest, so a flow that adds a stage is
  // described correctly with no change here.
  const manifest = flow ? catalogManifest(flow, true) : null;
  // isFlow: a stepper, a gate list and a position only mean anything for a package that
  // governs documents. It also narrows `documents` to a real list, which `declared` reads.
  if (manifest && isFlow(manifest)) {
    // The stage list travels with the answer: the console cannot know it, and both the node
    // name and its caption come from the manifest and the stage skill's own description.
    const label = (n: string) => n.replace(/^[a-z]+-/, "").replace(/-/g, " ");
    // withHandover here too, so the gate count, the stepper and `complete` are computed over
    // the documents zz-core actually gates, handover.md included.
    const declared = withHandover(manifest.documents);
    const byName = new Map(live.map((d) => [d.path, d]));
    // FR-58 (Task I-27): whether this initiative's own branch facts rule a document in, out or
    // undecided — computed once, read everywhere below. A document with no `when` at all
    // answers `applies` from `documentApplies` itself, so this map needs no separate "does it
    // declare when" branch anywhere it is read.
    const applic = new Map(declared.map((d) => [d.name, documentApplies(d, facts)]));
    // Where each gate sits, from the manifest's own `stage` on the gated document. `after`
    // is 0 when the manifest does not say, and the console renders that as unplaced rather
    // than guessing a position.
    const stageIndex = (n: string | undefined) =>
      n ? (manifest.stages ?? []).findIndex((x) => x.name === n) + 1 : 0;
    // `not_applicable` is excluded outright, the same filter guards.ts's own `closeRequires`
    // applies (services/zz-core/src/guards.ts): a gate the branch has ruled out is not a gate
    // this initiative owes, and leaving it in would draw it pending forever — nothing writes a
    // document that documentGuards refuses.
    const gates = declared.filter((d) => d.gate === true && applic.get(d.name) !== "not_applicable")
      .map((d) => ({ name: `approve ${d.name.replace(/\.md$/, "")}`,
                     // Carried for the same reason flowShape carries it.
                     role: d.role,
                     passed: byName.get(d.name)?.status === "approved",
                     // Whether there is anything to sign yet, which `passed: false` cannot
                     // say on its own: an undrafted document waits on the agent, a written
                     // and unapproved one waits on a person.
                     written: byName.has(d.name),
                     after: stageIndex(d.stage) }));
    const closing = declared.find((d) => d.closing === true);
    // The outcome, not just whether it was accepted: `initiative_close()` records `accepted`,
    // `delivered` or `abandoned`, and all three mean closed.
    //
    // Read from the manifest's closing document, then from whichever document carries an
    // outcome at all — a flow can move its close, and an initiative closed under the older
    // manifest carries its outcome on the document that was closing then. Only
    // initiative_close writes an outcome, so any document carrying one is the record.
    const outcome = (closing ? byName.get(closing.name)?.outcome : null)
      ?? live.find((d) => d.outcome)?.outcome ?? null;
    const accepted = outcome === "accepted";
    // The stage list is the flow's if it declares one; otherwise the documents stand in for
    // it, which is the same shape and never a different flow's vocabulary.
    const stages = manifest.stages?.length ? manifest.stages.map((x) => x.name)
      : declared.map((d) => d.name.replace(/\.md$/, ""));
    // Where it got to, from which stages have written, not from how many documents exist —
    // those agree only in a flow where every stage writes exactly one document. `stage` on
    // each declared document says which stage writes it, so the furthest stage that has
    // produced its document is the furthest the initiative got.
    let reached = 0;
    for (const d of declared) {
      if (!byName.has(d.name)) continue;
      const i = d.stage ? stages.indexOf(d.stage) : -1;
      // A document the manifest does not place cannot move the position, so a flow that does
      // not say where its documents are written falls back to counting them.
      reached = Math.max(reached, i >= 0 ? i + 1 : declared.filter((x) => byName.has(x.name)).length);
    }
    // A close is an act, not a position: being closed is its own step at the end, and it does
    // not tick the stages before it. Opening is the same act at the other end. No manifest
    // declares either.
    const closed = outcome !== null;
    const at = closed
      ? Math.max(1, reached)
      : Math.min(stages.length, Math.max(1, reached + 1));
    // Was everything the flow asks for there when it closed: every gate approved, every
    // document required to close present. Independent of `closed`. FR-58: a requiredForClose
    // document the branch ruled out is discharged, the same `documentApplies` reading
    // `initiative_status` and `initiative_close` both give it (services/zz-core/src/guards.ts).
    const complete = gates.every((g) => g.passed)
      && declared.filter((d) => d.requiredForClose === true && applic.get(d.name) !== "not_applicable")
           .every((d) => byName.has(d.name));
    // Each stage's state from what the manifest says it leaves behind, in three kinds:
    //
    //   a document  the flow declares it; done when it exists and any gate on it is
    //               approved — written but unapproved is `partial`, the one state that
    //               means waiting on a person
    //   a source    supporting material, not a deliverable. Done when a source in the
    //               initiative declares it `supports` that document. Never gated.
    //   nothing     no artifact at all; the order pass below reads it from what came after
    const meta = new Map((manifest.stages ?? []).map((x) => [x.name, x]));
    const sources = live.filter((d) => d.type === "source");
    const stageState = (n: string): "done" | "partial" | "empty" | "skipped" | "waiting" => {
      const produces = meta.get(n)?.produces;
      if (produces === "source") {
        // `supports` exists only on the source shape of a stage — the contract is a union —
        // so it is read only after `produces` has said which shape this is.
        const st = meta.get(n);
        const target = st && "supports" in st ? st.supports : undefined;
        const found = !!target && sources.some((d) => (d.supports ?? "").split(",")
          .map((x) => x.trim()).includes(target));
        return found ? "done" : "empty";
      }
      const mine = declared.filter((d) => d.stage === n);
      if (!mine.length) return "empty";
      // FR-58 (Task I-27): a document this stage owes that the branch ruled `not_applicable`
      // is not counted against it — if every one of them was ruled out, the stage is `skipped`
      // rather than `empty`, which would draw it pending forever. One still `undetermined`
      // reads as `waiting`: the platform has not yet decided whether this is required, which is
      // a different sentence from "nothing written" (and `documentGuards` refuses writing an
      // undetermined document anyway, so `written` never disagrees with this).
      const applicable = mine.filter((d) => applic.get(d.name) !== "not_applicable");
      if (!applicable.length) return "skipped";
      if (applicable.some((d) => applic.get(d.name) === "undetermined")) return "waiting";
      const written = applicable.filter((d) => byName.has(d.name));
      if (!written.length) return "empty";
      const gatesOpen = applicable.some((d) => d.gate === true && byName.get(d.name)?.status !== "approved");
      return written.length === applicable.length && !gatesOpen ? "done" : "partial";
    };
    const flowSteps = stages.map((n) => ({
      name: label(String(n)),
      // What this stage writes, from the manifest. A stage that writes nothing says so.
      produces: ((): string => {
        const st = meta.get(String(n));
        if (st && st.produces === "source" && "supports" in st) return `a source supporting ${st.supports}`;
        return declared.filter((d) => d.stage === n).map((d) => d.name).join(", ");
      })(),
      // The stage skill's own first sentence, and only the first. A skill with no
      // description leaves the caption empty rather than being given an invented one. A
      // leading "Stage N of <flow>." is stripped — the node already shows the number.
      what: (/^description:\s*(.+)$/m.exec(skillText(flow as string, String(n)) ?? "")?.[1] ?? "")
        .replace(/^["']|["']$/g, "")
        .replace(/^Stage \d+[^.]*\.\s*/i, "")
        .split(/(?<=\.)\s/)[0].trim().slice(0, 120),
      state: stageState(String(n)) as "done" | "partial" | "empty" | "untracked" | "skipped" | "waiting",
      current: false,
    }));
    // A stage that writes nothing was passed through when something after it exists: order is
    // the only evidence such a stage leaves. `skipped` counts as "something happened" here too
    // — a stage the branch ruled out entirely is not a gap the stepper should still be waiting on.
    for (let i = flowSteps.length - 1; i >= 0; i--) {
      const produces = meta.get(String(stages[i]))?.produces;
      const writesNothing = produces === "nothing" || produces === "record"
        || (!produces && !declared.some((d) => d.stage === stages[i]));
      const somethingAfter = flowSteps.slice(i + 1)
        .some((st) => st.state === "done" || st.state === "partial" || st.state === "skipped");
      if (!writesNothing) continue;
      // `untracked`, not `empty`, when there is no later stage to prove it ran: the console
      // draws `empty` as "nothing written", which such a stage never could have.
      flowSteps[i].state = somethingAfter ? "done" : "untracked";
    }
    // Where it is now: the first stage that is not done, and only while it is open. A closed
    // initiative is not anywhere. `skipped` reads as passed through here too — the branch
    // already decided it, so it must not be where the stepper says work is waiting.
    const currentAt = flowSteps.findIndex((st) => st.state !== "done" && st.state !== "skipped");
    if (!closed && currentAt >= 0) flowSteps[currentAt].current = true;
    const steps = [
      { name: "open", what: "the initiative exists: its folder was created and it was opened",
        produces: "", state: "done" as const, current: false },
      ...flowSteps,
      { name: "closed", what: "initiative_close recorded an outcome",
        produces: "", state: (closed ? "done" : "empty") as "done" | "empty", current: false },
    ];
    return {
      at, of: stages.length, stage: label(String(stages[at - 1] ?? "")), accepted,
      closed, outcome, complete, steps,
      // +1 for the `open` bookend: a gate declared after stage 2 sits after the third step.
      gates: gates.map((g) => ({ ...g, after: g.after > 0 ? g.after + 1 : steps.length - 1 })),
    };
  }

  // No manifest: the initiative declares a flow the catalog cannot resolve, or none at all.
  // ops-flow's shape is the fallback, because it is what the untyped documents below were
  // written for.
  const first = (t: string) => live.find((d) => d.type === t);
  const intent = first("intent");
  const spec = first("agreement") ?? first("spec");
  const sel = first("selection");
  const plan = first("plan");
  const ver = first("verification") ?? first("guide");
  const g1 = intent?.status === "approved";
  const g2 = spec?.status === "approved";
  const g3 = plan?.status === "approved";
  const accepted = spec?.outcome === "accepted";
  // Closed on any of the three outcomes, not on acceptance alone.
  const closed = (spec?.outcome ?? null) !== null;
  let at = 1;
  if (ver) at = 6;
  else if (g3) at = 5;
  else if (plan) at = 4;
  else if (sel || g2) at = 3;
  else if (spec || g1) at = 2;
  // Which of these untyped documents exist, stage by stage — the manifest branch's evidence
  // rule over the only document kinds this fallback knows.
  const stateOf: Record<string, "done" | "partial" | "empty"> = {
    intent: intent ? (g1 ? "done" : "partial") : "empty",
    spec: spec ? (g2 ? "done" : "partial") : "empty",
    select: sel ? "done" : "empty",
    plan: plan ? (g3 ? "done" : "partial") : "empty",
    build: ver || closed ? "done" : "empty",   // writes nothing; a later stage is the evidence
    verify: ver ? "done" : "empty",
    close: closed ? "done" : "empty",
  };
  const fallbackSteps = STAGES.map((n) => ({
    name: n, what: "", produces: "", state: stateOf[n] ?? "empty", current: false,
  }));
  const currentAt = fallbackSteps.findIndex((st) => st.state !== "done");
  if (!closed && currentAt >= 0) fallbackSteps[currentAt].current = true;
  return {
    at, of: STAGES.length, stage: STAGES[at - 1], accepted, closed,
    outcome: spec?.outcome ?? null,
    complete: !!g1 && !!g2 && !!g3 && accepted,
    steps: [
      { name: "open", what: "the initiative exists: its folder was created and it was opened",
        produces: "", state: "done" as const, current: false },
      ...fallbackSteps,
      { name: "closed", what: "initiative_close recorded an outcome",
        produces: "", state: (closed ? "done" : "empty") as "done" | "empty", current: false },
    ],
    gates: [
      { name: "approve intent", passed: !!g1, after: 2 },
      { name: "approve spec", passed: !!g2, after: 3 },
      { name: "approve plan", passed: !!g3, after: 5 },
      { name: "accept", passed: accepted, after: 7 },
    ],
  };
}
