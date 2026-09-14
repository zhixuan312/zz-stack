import { catalogManifest, isFlow, skillText } from "@zz/catalog";
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
export function flowShape(flow: string | null): Map<string, { gate: boolean; closing: boolean; requiredForClose: boolean }> {
  const out = new Map<string, { gate: boolean; closing: boolean; requiredForClose: boolean }>();
  if (!flow) return out;
  for (const d of catalogManifest(flow, true)?.documents ?? []) {
    out.set(d.name, {
      gate: d.gate === true,
      closing: d.closing === true,
      requiredForClose: d.requiredForClose === true,
    });
  }
  return out;
}

export function stageOf(docs: DocRow[], flow: string | null): {
  at: number; of: number; stage: string; steps: { name: string; what: string; produces: string }[];
  gates: { name: string; passed: boolean; after: number }[]; accepted: boolean;
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
    const declared = manifest.documents;
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
                     passed: byName.get(d.name)?.status === "approved",
                     after: stageIndex(d.stage) }));
    const closing = declared.find((d) => d.closing === true);
    // THE OUTCOME, not just whether it was accepted. `initiative_close()` records one of three words and
    // all three mean closed: `accepted` is a person saying it is what they wanted,
    // `delivered` is work that finished without that signature, `abandoned` is work that
    // stopped. The console carried only a boolean, so a delivered initiative and one still
    // being written were the same value — and the state column filled the gap with the stage
    // name, which answers a different question from the one the column asks.
    const outcome = closing ? (byName.get(closing.name)?.outcome ?? null) : null;
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
    // CLOSED IS THE END, whichever of the three words closed it. An initiative that stopped
    // is not sitting at the stage after its last document — it is finished, and drawing it
    // mid-flow invites somebody to go and continue it.
    const closed = outcome !== null;
    const at = closed ? stages.length : Math.min(stages.length, Math.max(1, reached + 1));
    return {
      at, of: stages.length, stage: label(String(stages[at - 1] ?? "")), gates, accepted,
      closed, outcome,
      steps: stages.map((n) => ({
        name: label(String(n)),
        // What this stage writes, from the manifest. A stage that writes nothing says so.
        produces: declared.filter((d) => d.stage === n).map((d) => d.name).join(", "),
        // The stage skill's own first sentence, and only the first. A skill that ships no
        // description leaves the caption empty rather than being given one the console made
        // up. The leading "Stage N of <flow>." is stripped if a skill still carries one: the
        // node already shows the number, and a second copy in prose drifts — two of these
        // said the wrong stage before the numbers were taken out of the descriptions.
        what: (/^description:\s*(.+)$/m.exec(skillText(flow as string, String(n)) ?? "")?.[1] ?? "")
          .replace(/^["']|["']$/g, "")
          .replace(/^Stage \d+[^.]*\.\s*/i, "")
          .split(/(?<=\.)\s/)[0].trim().slice(0, 120),
      })),
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
  if (closed) at = 7;
  else if (ver) at = 6;
  else if (g3) at = 5;
  else if (plan) at = 4;
  else if (sel || g2) at = 3;
  else if (spec || g1) at = 2;
  return {
    at, of: STAGES.length, stage: STAGES[at - 1], accepted, closed,
    outcome: spec?.outcome ?? null,
    steps: STAGES.map((n) => ({ name: n, what: "", produces: "" })),
    gates: [
      { name: "approve intent", passed: !!g1, after: 1 },
      { name: "approve spec", passed: !!g2, after: 2 },
      { name: "approve plan", passed: !!g3, after: 4 },
      { name: "accept", passed: accepted, after: 6 },
    ],
  };
}
