import { catalogManifest, isFlow, skillText, withHandover } from "@zz/catalog";
import type { Request, Response } from "express";

import { platformDbReady } from "../db.js";
import { isSuper } from "../identity.js";
import { resolveScope, type Scope } from "../scope.js";

/** A `Scope` that has already cleared `handler()`'s refusal check — never "refused",
 * because every handler below runs only after that case has already answered the
 * request. Named separately so a handler's own type signature says, correctly, that it
 * can never see a refusal: there would be nothing for it to do with one.
 *
 * Exported for console-write.ts, the one write surface this console has. It reuses this
 * type and `handler()` itself rather than re-resolving a scope its own way, so a write
 * route is bound by the same "team, platform, or refused — nothing falls through" rule
 * this file exists to hold everything else to. */
export type ResolvedScope = Exclude<Scope, { kind: "refused" }>;

/** The ops-flow shape, stated once. The console draws a stepper from it and the
 * API decides `stage` with it, so the two cannot disagree about what step 4 is.
 *
 * NOT A TOOL: the last member is the flow's closing STAGE, which shares a word with
 * `initiative_close` and is not it. A stage is a step a flow declares; the tool is the act
 * that ends the initiative, and renaming this one to match would make the stepper render
 * "initiative_close" as a step nobody wrote. */
const STAGES = ["intent", "spec", "select", "plan", "build", "verify", "close"] as const;

/** May this caller read the console at all?
 *
 * ONE function, and every handler calls it, so "who may see the fleet" is a
 * question with a single answer that can be changed in a single place. See the
 * file header for why the answer is what it is.
 */
export function mayReadConsole(id: { via: string; platformRole: string } | null): boolean {
  if (!id) return false;
  if (id.via === "session") return true;      // signed in through the browser
  return isSuper(id as Parameters<typeof isSuper>[0]);  // or a superadmin PAT, for scripts
}

/** Guard: allowed to read, and a database to answer from.
 *
 * Returns false having ALREADY replied. A handler that forgets to return on
 * false would send twice, so every call site is written `if (!ok(req,res)) return;`.
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
  // Named, not generic. A bare 403 sent a person to check their password when
  // the real answer was that they are signed in correctly and came through a
  // door this one does not accept — a different problem with a different fix.
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
 * ONE call to `resolveScope`, here, because `ok()` already proved every route
 * passes through this function — so this is the one place a scope can be
 * attached for free, instead of twenty separate call sites that could each
 * forget it or resolve it differently. `req.zzIdentity!` is safe: `ok()` above
 * already refused any request with none. A refused scope answers here, before
 * `fn` ever runs, so no handler below invents its own team refusal — see
 * scope.ts for what "refused" can mean and why there is no fourth, unscoped
 * case for a handler to fall into.
 *
 * Every handler here is async and Express 4 does not catch a rejected promise:
 * an unhandled rejection leaves the request hanging until the browser gives up,
 * which is the same spinner-instead-of-a-problem failure /api/kb's requireDb
 * was written for. */
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

/** Wrap a route that has NO team dimension at all.
 *
 * A catalog of blocks, the skills library, the run log, the platform census —
 * these read the same rows for every caller because no row in them belongs to a
 * team. Sending them through `handler` was briefly the tidier thing to do, and
 * it broke a real person: `resolveScope` refuses a caller who is in no team,
 * so somebody who had just signed in for the first time — before the sixty-second
 * onboarding timer gives them a team — got `no team — join a team or pass ?team=`
 * on the blocks catalog, which has nothing to do with teams and would have
 * answered them perfectly well. The same is true of anybody deliberately removed
 * from every team.
 *
 * So a route declares which kind it is, and the gate check refuses a `teamless`
 * body that filters on `team_slug` — the mistake this split could otherwise
 * introduce is a team-scoped query smuggled into a route that never resolves a
 * scope, and that is exactly what the check looks for. */
export function teamless(name: string, fn: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response): void => {
    if (!ok(req, res)) return;
    void fn(req, res).catch((err: unknown) => {
      console.error(`console ${name} failed:`, err);
      if (!res.headersSent) res.status(500).json({ error: `could not read ${name}` });
    });
  };
}

/** How far back a read looks, from `?period=`, or null for all of it.
 *
 * THE VOCABULARY IS THE CONSOLE'S, spelled here a second time on purpose. The browser
 * cannot import this module and this module cannot import the browser's, so the two
 * copies are the price of one origin serving two build systems — the same reason the
 * console restates every response shape in its own `api.ts`. What keeps them honest is
 * that an unrecognised value falls back to `all` rather than throwing: a console sending
 * a period this gateway has not learned yet gets every row, which is what it would have
 * got before periods existed, instead of an error.
 *
 * NULL MEANS ALL TIME, and unlike a null TEAM that is a safe wildcard rather than a
 * dangerous one — scope.ts's whole argument is about a null that silently widens WHOSE
 * rows you see, and this widens only HOW FAR BACK. The `($n is null or ts >= $n)` shape
 * below is the same one /activity already uses for `?kind=`.
 *
 * Computed here from `now()` rather than in SQL as `now() - interval '30 days'`, so the
 * cutoff is one value shared by every statement in a request. Five statements each
 * evaluating their own `now()` would disagree by microseconds, which is invisible until
 * a chart's last bucket and a tile's total are read side by side and do not add up. */
const PERIOD_DAYS: Record<string, number> = { "1d": 1, "7d": 7, "30d": 30, "90d": 90 };
export function periodCutoff(req: Request): Date | null {
  const days = PERIOD_DAYS[String(req.query.period ?? "")];
  return days ? new Date(Date.now() - days * 24 * 60 * 60 * 1000) : null;
}

type Grain = "hour" | "day" | "week" | "month";

/**
 * THE DEPLOYMENT'S OWN TIMEZONE — the one every date this platform states is local to.
 *
 * Buckets are cut on ITS calendar, not on UTC's. `date_trunc('day', ts)` puts the day
 * boundary at 08:00 in Singapore, so eight hours of a working morning are filed under
 * yesterday: measured on this deployment, 09-15 held 484 tool calls by the UTC calendar
 * and 676 by the local one, and neither number is wrong about anything except which day
 * it is describing. `zz-core`'s write guards already stamp dates through this variable,
 * and their docstring calls it "the same variable the console renders through" — which
 * was aspirational until the trend started using it too.
 *
 * Default and deployed value agree deliberately: a deployment that sets nothing gets the
 * zone this platform is run in rather than UTC, which is nobody's working day.
 */
export const ZZ_TZ = (process.env.ZZ_TZ ?? "").trim() || "Asia/Singapore";

/** How wide one bucket of the trend series is, chosen from how much time the series
 * actually covers.
 *
 * A DAY BUCKET OVER A ONE-DAY WINDOW IS ONE POINT, and a trend through one point is not a
 * trend — the chart drew its "at least two buckets" empty state over 8,566 events, which
 * reads as no data rather than as the wrong ruler. The same mistake runs the other way at
 * the top end: ninety daily buckets is ninety labels in the width of a card, and all-time
 * gets worse every day the platform runs.
 *
 * FROM THE SPAN, NOT FROM THE PERIOD. The obvious version of this maps 1d→hour, 90d→week
 * and so on, and it is wrong whenever the data is thinner than the window asked for: a
 * 90-day window over a platform sixteen days old would draw three weekly points and call
 * it a trend. What decides is how far apart the first and last event in view actually are,
 * which is why this takes a measurement rather than a parameter.
 *
 * The thresholds target roughly 12–60 buckets — enough to have a shape, few enough to
 * label. `all` needs no special case: its span is simply the whole log's.
 *
 * The unit is passed to `date_trunc($n, ts)` as a bound parameter rather than branching
 * the statement four ways, because date_trunc's unit is a text argument — four literal
 * copies of one query to vary a single word is how a file ends up with four queries that
 * must agree and do not. */
export function grainForSpan(days: number): Grain {
  if (days <= 2) return "hour";     // ≤ 48 hourly buckets
  if (days <= 62) return "day";     // ≤ 62 daily buckets
  if (days <= 730) return "week";   // ≤ ~104 weekly buckets
  return "month";
}

/* TIMES GO OUT AS AN INSTANT, never as a pre-formatted local string.
 *
 * Every timestamp with a time in it used to be `to_char(x, 'YYYY-MM-DD HH24:MI')`, which
 * renders in the DATABASE's timezone — UTC — and arrives at the browser as a bare
 * `2026-09-05 04:43` with nothing saying which zone it is. A reader in Singapore read that as
 * 04:43 and it was 12:43 for them: eight hours wrong, on every page, with no way to tell from
 * the screen.
 *
 * Formatting it server-side in Asia/Singapore would fix this deployment and break the next
 * reader who is not there — the same shape of mistake as drawing every flow as ops-flow. So
 * the API sends ISO 8601 in UTC with the Z, and the browser formats it in whatever zone the
 * person is actually in. Dates without a time are left alone: a day needs no zone.
 */

/** What `stageOf` actually reads: four of the eight columns DocRow carries.
 *
 * SEPARATE FROM DocRow ON PURPOSE. The initiatives LIST route typed its rows as DocRow, so
 * it selected every column DocRow declares — including `length(coalesce(body,'')) as bytes`
 * and `title`, neither of which is read anywhere in the summary it builds. Postgres
 * detoasts every document body to answer that: measured on this deployment's 832 rows,
 * 195.8 ms with those columns and 1.7 ms without. A type that demands more than its reader
 * needs is how a query ends up paying for columns nobody asked for, so this one demands
 * exactly what it reads. DocRow is structurally assignable to it, so the DETAIL route —
 * which genuinely shows a document's size — passes unchanged.
 *
 * `type` is here because the compiler said so: the no-manifest fallback in `stageOf`
 * classifies untyped documents by it when the initiative names a flow the catalog cannot
 * resolve. It is a short column and it is genuinely read; `bytes` and `title` were neither. */
export interface StageDoc {
  path: string; type: string; status: string | null; outcome: string | null;
  /** Which documents this one bears on, comma-joined — a SOURCE's own declaration. It is what
   *  evidences a stage that produces evidence rather than a deliverable. */
  supports?: string | null;
}

/** How far an initiative got, from the documents that exist and their approvals.
 *
 * Derived, never stored — which is the point. The platform already records the
 * only facts that matter (a document exists; `document_approve()` stamped it), and a
 * `stage` column would be a second copy of that able to drift from it. */
export interface DocRow {
  path: string; type: string; status: string | null; outcome: string | null;
  approved_by: string | null; updated_at: string; bytes: number; title: string | null;
}
/** What the FLOW says about each of its documents.
 *
 * `draft` on a document the flow never gates is a lie the console was telling:
 * it reads as "waiting for approval" when no approval is coming. ops-flow gates
 * intent, spec and plan; selection and guide are ungated by declaration, and
 * guide is merely `requiredForClose`.
 *
 * Read from the manifest rather than listed here, because WHICH documents a
 * flow gates is the flow's business — a list in the console would be a second
 * copy of it, and would be wrong for every flow but the one it was written for.
 */
export function flowShape(flow: string | null): Map<string, { gate: boolean; closing: boolean; requiredForClose: boolean; role?: string }> {
  const out = new Map<string, { gate: boolean; closing: boolean; requiredForClose: boolean; role?: string }>();
  if (!flow) return out;
  // THROUGH withHandover, which is the flow AS THE PLATFORM ENFORCES IT. Read raw, this map
  // had no entry for handover.md, so `gateRuleFor` answered "we do not know" and the console
  // rendered a gated document's `status: draft` as an unexplained state.
  for (const d of withHandover(catalogManifest(flow, true)?.documents ?? [])) {
    out.set(d.name, {
      gate: d.gate === true,
      closing: d.closing === true,
      requiredForClose: d.requiredForClose === true,
      // THE PLATFORM'S OWN CLOSING STEP, told apart from the flow's documents. `withHandover`
      // appends a gated handover.md to every gating flow, which is what the platform
      // enforces and what this map must therefore contain — but it is written AFTER the
      // close, so a reader asking about an OPEN initiative has to leave it out. Carrying the
      // role is what lets each reader place it; without it the derived gate counted as a
      // signature owed on work nobody had finished.
      role: d.role,
    });
  }
  return out;
}

export function stageOf(docs: StageDoc[], flow: string | null): {
  at: number; of: number; stage: string;
  /** EVERY STEP OF THE DIAGRAM, bookends included, in order.
   *
   * `open` and `closed` are steps of every flow because they are acts of every initiative —
   * the folder was created, and `initiative_close` ended it — and no manifest declares them.
   * Between them are the flow's own stages, whatever they are.
   *
   * `state` is DERIVED, never stored: the manifest says which documents a stage writes and
   * which of those carry a gate, and the record says which exist and which were approved.
   *   done      every document this step declares exists and every gated one is approved — or
   *             it declares none and a later step produced something, so it was passed through
   *   partial   its documents exist, but a gate on one is still open
   *   empty     nothing shows it happened
   * `current` marks where an open initiative is now. */
  steps: {
    name: string; what: string; produces: string;
    /** `untracked` is a stage that CANNOT leave a document — it produces a record or
     *  nothing — with no later stage to prove it ran. It is not the same fact as `empty`,
     *  which is a stage that owes a document and has not written one, and the console draws
     *  them differently; sending only three states made the two indistinguishable. */
    state: "done" | "partial" | "empty" | "untracked"; current: boolean;
  }[];
  /** Placed by INDEX INTO `steps`, bookends included, so the console places nothing itself. */
  gates: { name: string; passed: boolean; after: number }[]; accepted: boolean;
  /** Everything the flow asks for was there at the close: every gate approved, every document
   *  it requires to close present. False on a close that stopped short. */
  complete: boolean;
  /** WHETHER IT IS FINISHED, which is a different question from whether a person signed it.
   *  All three outcomes mean closed, so a `delivered` initiative is as finished as an
   *  `accepted` one — the stepper drew only `accepted` as done, so a delivered initiative's
   *  last stage was left open on the diagram forever. */
  closed: boolean;
  /** One of `accepted` | `delivered` | `abandoned`, or null while the initiative is open.
   *  All three mean closed — see @zz/contracts OUTCOMES for what each says. */
  outcome: string | null;
} {
  // The first document of each type wins. `_versions/` holds snapshots of the
  // same document and they carry the same type, so counting them as separate
  // documents made a two-document initiative look like six.
  const live = docs.filter((d) => !d.path.startsWith("_versions/"));

  // THE FLOW'S OWN STAGES AND GATES, when the flow is known.
  //
  // This function used to describe every initiative as if it were running ops-flow: seven
  // stages named intent/spec/select/plan/build/verify/close, and exactly four gates. So a
  // zz-skill-eval initiative — five stages, two gates, documents called rulers.md and
  // findings.md — was displayed at "S6 · Verify", "Awaiting acceptance", "1 of 4", every word
  // of which is about a different flow. The dashboard was not slightly wrong about those
  // rows; it was describing work nobody did.
  //
  // The manifest already carries both, and flowShape already reads it. A position is how
  // many of the flow's declared documents exist, and the gates are the documents the flow
  // declares as gates — so a flow that adds a stage tomorrow is described correctly with no
  // change here.
  const manifest = flow ? catalogManifest(flow, true) : null;
  // isFlow, because this is the flow question and not a second one: a stepper, a gate list
  // and a position only mean anything for a package that governs documents. Asking the
  // classifier rather than re-deriving it also narrows `documents` to a real list, which is
  // what `declared` below reads.
  if (manifest && isFlow(manifest)) {
    // THE STAGE LIST TRAVELS WITH THE ANSWER, because the console cannot know it. The
    // detail view draws a stepper with a name and a line of prose under every node, and both
    // were a constant in the front end — "Intent / what they want", "Select / which blocks" —
    // printed over whatever flow the initiative was actually running. The manifest names the
    // stages; the stage skill's own description says what happens there, in the words its
    // author chose, which is a better caption than anything the console could invent.
    const label = (n: string) => n.replace(/^[a-z]+-/, "").replace(/-/g, " ");
    // AND THE SAME LIST HERE, so the gate count, the stepper and `complete` are computed
    // over the documents zz-core actually gates. Without it the console reported
    // `complete: true` on an initiative whose handover nobody had signed — the one step that
    // exists precisely because delivery ending is not the cycle ending.
    const declared = withHandover(manifest.documents);
    const byName = new Map(live.map((d) => [d.path, d]));
    // WHERE EACH GATE SITS, from the manifest's own `stage` on the gated document. Without it
    // a diagram can only distribute gates evenly and hope, which is what the console did with
    // ops-flow's four positions on every flow. `after` is 0 when the manifest does not say,
    // and the console renders that as "the manifest does not place this gate" rather than
    // putting it somewhere plausible.
    const stageIndex = (n: string | undefined) =>
      n ? (manifest.stages ?? []).findIndex((x) => x.name === n) + 1 : 0;
    const gates = declared.filter((d) => d.gate === true)
      .map((d) => ({ name: `approve ${d.name.replace(/\.md$/, "")}`,
                     // Carried for the same reason flowShape carries it.
                     role: d.role,
                     passed: byName.get(d.name)?.status === "approved",
                     // WHETHER THERE IS ANYTHING TO SIGN YET, which `passed: false` cannot
                     // say on its own. A gate whose document nobody has drafted is waiting on
                     // the AGENT; a gate whose document is written and unapproved is waiting
                     // on a PERSON, and those are opposite instructions to the reader.
                     // Without this the console's "Waiting on you" counted three unwritten
                     // documents as three signatures owed, while the Overview tile — which
                     // already draws the distinction — said none were.
                     written: byName.has(d.name),
                     after: stageIndex(d.stage) }));
    const closing = declared.find((d) => d.closing === true);
    // THE OUTCOME, not just whether it was accepted. `initiative_close()` records one of three words and
    // all three mean closed: `accepted` is a person saying it is what they wanted,
    // `delivered` is work that finished without that signature, `abandoned` is work that
    // stopped. The console carried only a boolean, so a delivered initiative and one still
    // being written were the same value — and the state column filled the gap with the stage
    // name, which answers a different question from the one the column asks.
    //
    // AND ON WHICHEVER DOCUMENT CARRIES IT. The closing document is today's manifest's, and a
    // flow can move its close: sdlc-flow closed on spec.md before it closed on review.md, so an
    // initiative closed back then carries its outcome on spec.md and read here as open forever.
    // Only initiative_close writes an outcome, so any document carrying one is the record.
    const outcome = (closing ? byName.get(closing.name)?.outcome : null)
      ?? live.find((d) => d.outcome)?.outcome ?? null;
    const accepted = outcome === "accepted";
    // The stage list is the flow's if it declares one; otherwise the documents stand in for
    // it, which is the same shape and never a different flow's vocabulary.
    const stages = manifest.stages?.length ? manifest.stages.map((x) => x.name)
      : declared.map((d) => d.name.replace(/\.md$/, ""));
    // WHERE IT GOT TO, from WHICH STAGES have written, not from HOW MANY documents exist.
    //
    // This counted documents: `written + (accepted ? 1 : 0)`. That is only the stage number
    // in a flow where every stage writes exactly one document, and ops-flow is the only one
    // that does. A zz-skill-eval round has five stages and two documents, so a round that had
    // FINISHED — both gates approved, closed and accepted — reported stage 3 of 5, and the
    // stepper then drew nodes 1, 2 and 5 as done with the current position sitting on 3.
    // Every number on that diagram was individually defensible and the picture was nonsense.
    //
    // `stage` on each declared document says which stage writes it, so the furthest stage
    // that has produced its document is the furthest the initiative got. The one after it is
    // where the work is now.
    let reached = 0;
    for (const d of declared) {
      if (!byName.has(d.name)) continue;
      const i = d.stage ? stages.indexOf(d.stage) : -1;
      // A document the manifest does not place cannot move the position, so it falls back to
      // counting — which is what the whole flow used to do, kept for the flow that has not
      // said where its documents are written.
      reached = Math.max(reached, i >= 0 ? i + 1 : declared.filter((x) => byName.has(x.name)).length);
    }
    // A CLOSE IS AN ACT, NOT A POSITION. `initiative_close` is the only thing that closes an
    // initiative, so being closed is its own step at the end rather than a filling-in of the
    // stages — a diagram that shows a close by ticking everything before it claims work nobody
    // did. OPENING is the same act at the other end: the folder exists, which is what `open`
    // means, and no manifest declares either.
    const closed = outcome !== null;
    const at = closed
      ? Math.max(1, reached)
      : Math.min(stages.length, Math.max(1, reached + 1));
    // WAS EVERYTHING THE FLOW ASKS FOR THERE WHEN IT CLOSED? Every gate approved and every
    // document required to close present. Both closes are closes and the diagram says so
    // either way; this is what tells a reader whether it ran the whole way.
    const complete = gates.every((g) => g.passed)
      && declared.filter((d) => d.requiredForClose === true).every((d) => byName.has(d.name));
    // EACH STAGE FROM WHAT IT DECLARES, mechanically. A stage that writes nothing leaves nothing
    // to find, and the pass below reads it from ORDER instead: work that reached a later stage
    // went through this one. Everything else follows from the manifest.
    // WHAT A STAGE LEAVES BEHIND IS THE MANIFEST'S ANSWER, and there are three kinds of it.
    //
    //   a document  the flow declares it; done when it exists, and when a gate on it is
    //               approved — written but unapproved is `partial`, which is the one state
    //               that means "waiting on a person"
    //   a source    supporting material, not a deliverable: an audit round is evidence about
    //               the document it read. Done when a source in the initiative declares it
    //               `supports` that document. Never gated — evidence is not agreed to.
    //   nothing     no artifact at all; the order pass below reads it from what came after
    const meta = new Map((manifest.stages ?? []).map((x) => [x.name, x]));
    const sources = live.filter((d) => d.type === "source");
    const stageState = (n: string): "done" | "partial" | "empty" => {
      const produces = meta.get(n)?.produces;
      if (produces === "source") {
        // `supports` exists on the source shape of a stage and on no other — the contract is a
        // union of the two — so it is read off the entry only after `produces` has said which
        // shape this is.
        const st = meta.get(n);
        const target = st && "supports" in st ? st.supports : undefined;
        const found = !!target && sources.some((d) => (d.supports ?? "").split(",")
          .map((x) => x.trim()).includes(target));
        return found ? "done" : "empty";
      }
      const mine = declared.filter((d) => d.stage === n);
      if (!mine.length) return "empty";
      const written = mine.filter((d) => byName.has(d.name));
      if (!written.length) return "empty";
      const gatesOpen = mine.some((d) => d.gate === true && byName.get(d.name)?.status !== "approved");
      return written.length === mine.length && !gatesOpen ? "done" : "partial";
    };
    const flowSteps = stages.map((n) => ({
      name: label(String(n)),
      // What this stage writes, from the manifest. A stage that writes nothing says so.
      produces: ((): string => {
        const st = meta.get(String(n));
        if (st && st.produces === "source" && "supports" in st) return `a source supporting ${st.supports}`;
        return declared.filter((d) => d.stage === n).map((d) => d.name).join(", ");
      })(),
      // The stage skill's own first sentence, and only the first. A skill that ships no
      // description leaves the caption empty rather than being given one the console made
      // up. The leading "Stage N of <flow>." is stripped if a skill still carries one: the
      // node already shows the number, and a second copy in prose drifts — two of these
      // said the wrong stage before the numbers were taken out of the descriptions.
      what: (/^description:\s*(.+)$/m.exec(skillText(flow as string, String(n)) ?? "")?.[1] ?? "")
        .replace(/^["']|["']$/g, "")
        .replace(/^Stage \d+[^.]*\.\s*/i, "")
        .split(/(?<=\.)\s/)[0].trim().slice(0, 120),
      state: stageState(String(n)) as "done" | "partial" | "empty" | "untracked",
      current: false,
    }));
    // A STAGE THAT WRITES NOTHING WAS PASSED THROUGH, when something after it exists. `execute`
    // declares no document, so nothing it leaves behind can be looked for — but a review written
    // after it could not have been written without it. Order is the evidence, and it is the same
    // kind of derivation as the rest: read off the manifest and the record, never assumed.
    for (let i = flowSteps.length - 1; i >= 0; i--) {
      const produces = meta.get(String(stages[i]))?.produces;
      const writesNothing = produces === "nothing" || produces === "record"
        || (!produces && !declared.some((d) => d.stage === stages[i]));
      const somethingAfter = flowSteps.slice(i + 1).some((st) => st.state === "done" || st.state === "partial");
      if (!writesNothing) continue;
      // AND `untracked` WHEN THERE IS NO LATER STAGE TO PROVE IT. Falling through left such
      // a stage `empty`, which the console draws as "nothing written" — a claim about a
      // stage that could never have written anything. The console has always had a fourth
      // node style for this and the API never sent the word that selects it.
      flowSteps[i].state = somethingAfter ? "done" : "untracked";
    }
    // WHERE IT IS NOW is the first stage that is not done, and only while it is open. A closed
    // initiative is not anywhere.
    const currentAt = flowSteps.findIndex((st) => st.state !== "done");
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

  // NO MANIFEST: the initiative declares a flow the catalog cannot resolve, or none at all.
  // ops-flow's shape is the fallback because it is what the untyped documents below were
  // written for — and it is now reached only when nothing better is known, rather than
  // applied to everything.
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
  // Closed on ANY of the three outcomes, not on acceptance alone. Same reason as above.
  const closed = (spec?.outcome ?? null) !== null;
  let at = 1;
  if (ver) at = 6;
  else if (g3) at = 5;
  else if (plan) at = 4;
  else if (sel || g2) at = 3;
  else if (spec || g1) at = 2;
  // WHICH OF THESE UNTYPED DOCUMENTS EXIST, stage by stage — the same evidence rule the
  // manifest branch applies, over the only document kinds this fallback knows. `build` writes
  // nothing here either, so it is untracked rather than assumed.
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
