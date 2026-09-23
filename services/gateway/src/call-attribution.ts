/**
 * Which STAGE of a flow a tool call belongs to, read from that flow's manifest.
 *
 * SEPARATE FROM RECORDING THE CALL, which is `tool-telemetry.ts`'s subject. This one answers a
 * question about the FLOW — "the manifest declares seven stages; which of them owes this act" —
 * and it is a pure function of the tool's name, its arguments and the manifest. The telemetry
 * writer knows about connections, redaction, allowlists and a dozen columns; none of that bears
 * on this, and it had grown past the size where one file has reliably held one subject.
 *
 * WHY THIS IS NOT THE TRACED SKILL. `step-trace.ts` answers a different question — which skill
 * the caller had last been served — and that is a real fact this is not. A traced skill says
 * what the agent was READING; a stage says what the act COMPLETED. They usually agree and the
 * cases where they do not are exactly the interesting ones, which is why the manifest's answer
 * wins where there is one and the trace is the fallback where there is not.
 *
 * ONE VOCABULARY FOR THE WHOLE FLOW. `packages/indexing`'s evidence side reads the same
 * manifest fields to decide which step a document or a source evidences. Two derivations of one
 * answer is how the control loop and the telemetry came to file one act under two different
 * steps — which is the defect this file exists to stop recurring.
 */
import { catalogManifest } from "@zz/catalog";
import { lastJson } from "@zz/mcp-client";

/** The arguments as the caller sent them, narrowed to the two fields this reads. Not exported:
 *  every caller hands over whatever the tool was given, and a second name for that shape would
 *  be one more thing to keep in step with nothing asking for it. */
interface CallArgs {
  readonly path?: unknown;
  readonly supports?: unknown;
}

/** Every call whose subject is a DECLARED DOCUMENT, so the manifest can name its stage.
 *
 *  `document_approve` belongs here and was missing. The control loop records an approval
 *  against the stage that produces the document — `sdlc-spec | approval` — while the telemetry
 *  attributed it to whatever skill the caller had last read, so one act was filed under two
 *  different steps depending on which table you asked. The manifest answers for an approval
 *  exactly as it does for a write: it is the stage that owes that document. */
const ABOUT_A_DOCUMENT = /^(document_write|document_revise|document_patch|document_approve)$/;

/**
 * The stage this call completes, or undefined when the manifest names none — which is the
 * ordinary answer for a call that is not part of any flow's declared procedure.
 *
 * A SOURCE IS PRODUCED BY A STAGE TOO, and `source_add` was the one act with no stage at all.
 * sdlc-flow's audit rounds evidence themselves with a SOURCE supporting the document they
 * audited rather than a document of their own, so nothing in the manifest's `documents` names
 * them and attribution fell through to the traced skill. Measured while driving the flow end to
 * end: a spec-audit round recorded through `source_add` was filed as `zz-platform` — the skill
 * the agent happened to have read last — while `zz.control_evidence` filed the same act as
 * `sdlc-spec-audit`. Same act, two answers, and neither table says the other exists.
 *
 * `supports` is the argument that decides it, the same field the evidence side reads. A source
 * supporting several documents is attributed to the FIRST stage that declares it: one row
 * cannot carry two steps, and the alternative is carrying none.
 */
export function stageOwing(
  flow: string | undefined, tool: string, args: CallArgs,
): string | undefined {
  if (!flow) return undefined;
  const manifest = catalogManifest(flow, true);
  if (!manifest) return undefined;

  if (ABOUT_A_DOCUMENT.test(tool)) {
    const docName = String(args.path ?? "").split("/").pop() ?? "";
    if (!docName) return undefined;
    return (manifest.documents ?? []).find((d) => d.name === docName)?.stage;
  }

  if (tool === "source_add") {
    const supported = Array.isArray(args.supports) ? args.supports.map(String) : [];
    if (!supported.length) return undefined;
    return (manifest.stages ?? [])
      .filter((st): st is Extract<typeof st, { produces: "source" }> => st.produces === "source")
      .find((st) => supported.includes(st.supports))?.name;
  }

  return undefined;
}

/** The set of calls whose ANSWER, not whose arguments, says which initiative is meant.
 *
 *  `initiative_open` takes a `slug` and composes `<YYYY-MM-DD>-<slug>` from the platform's own
 *  clock, so its argument is not the name at all. `initiative_status` takes the name but
 *  answers `{"error": "no such initiative"}` for one nobody opened — which is not an MCP error,
 *  so the row is recorded `ok`, and reading the argument took a name that does not exist. */
export const ANSWER_NAMES_INITIATIVE = /^initiative_(open|status)$/;

/** One MCP call as it arrived, narrowed to what this file reads. */
interface Call { readonly params?: { readonly name?: unknown; readonly arguments?: unknown } }

/**
 * Which initiative this exchange says is being worked on, or null when it says nothing.
 *
 * TWO SOURCES, AND THE ANSWER OUTRANKS THE ARGUMENT. Any call carrying an `initiative`
 * argument names one — except the two above, where the answer is the authority on whether it
 * exists at all.
 *
 * Measured before this was separated out: 110 `initiative_open` events on this deployment, 20
 * carrying an initiative and 17 of those naming one that exists; and 436 events across the
 * whole store filed against an initiative that was never created. The second number is the
 * argument scan taking the slug from a failed `initiative_status` and keeping it for the rest
 * of the conversation.
 *
 * `served` is the raw streamed answer, or null when the caller did not capture it — in which
 * case only the argument route can answer, which is the honest degradation.
 */
export function initiativeFrom(wanted: readonly Call[], served: string | null): string | null {
  for (const c of wanted) {
    if (ANSWER_NAMES_INITIATIVE.test(String(c.params?.name ?? ""))) continue;
    const named = (c.params?.arguments as Record<string, unknown> | undefined)?.initiative;
    if (typeof named === "string" && named) return named;
  }
  if (served === null) return null;
  for (const c of wanted) {
    if (!ANSWER_NAMES_INITIATIVE.test(String(c.params?.name ?? ""))) continue;
    const body = (lastJson(served)?.result?.content ?? [])
      .map((x) => (x as { text?: string })?.text ?? "").join("");
    try {
      const answer = JSON.parse(body) as { initiative?: unknown; error?: unknown };
      // AN ANSWER CARRYING AN ERROR NAMES NOTHING, even though it echoes the slug it was asked
      // about. That echo is what taught the trace an initiative nobody opened.
      if (answer.error === undefined && typeof answer.initiative === "string" && answer.initiative) {
        return answer.initiative;
      }
    } catch { /* not the JSON this tool returns; this exchange simply teaches nothing */ }
    return null;
  }
  return null;
}
