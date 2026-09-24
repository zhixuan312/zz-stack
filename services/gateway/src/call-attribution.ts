/**
 * Which stage of a flow a tool call belongs to, read from that flow's manifest. A pure
 * function of the tool's name, its arguments and the manifest; recording the call is
 * `tool-telemetry.ts`'s subject.
 *
 * Not the traced skill. `step-trace.ts` answers which skill the caller had last been served —
 * what the agent was reading — where a stage says what the act completed. The manifest's
 * answer wins where there is one and the trace is the fallback where there is not.
 *
 * COUPLED: `packages/indexing`'s evidence side reads the same manifest fields to decide which
 * step a document or a source evidences. Two derivations of this answer file one act under two
 * different steps.
 */
import { catalogManifest } from "@zz/catalog";
import { lastJson } from "@zz/mcp-client";

/** The arguments as the caller sent them, narrowed to the two fields this reads. */
interface CallArgs {
  readonly path?: unknown;
  readonly supports?: unknown;
}

/** Every call whose subject is a declared document, so the manifest can name its stage.
 *
 *  `document_approve` is here because the manifest answers for an approval exactly as it does
 *  for a write: the stage that owes the document. The control loop records it the same way. */
const ABOUT_A_DOCUMENT = /^(document_write|document_revise|document_patch|document_approve)$/;

/**
 * The stage this call completes, or undefined when the manifest names none — which is the
 * ordinary answer for a call that is not part of any flow's declared procedure.
 *
 * A source is produced by a stage too. sdlc-flow's audit rounds evidence themselves with a
 * source supporting the document they audited rather than a document of their own, so nothing
 * in the manifest's `documents` names them and attribution would fall through to the traced
 * skill.
 *
 * `supports` is the argument that decides it, the same field the evidence side reads. A source
 * supporting several documents is attributed to the first stage that declares it: one row
 * cannot carry two steps.
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

/** The set of calls whose answer, not whose arguments, says which initiative is meant.
 *
 *  `initiative_open` takes a `slug` and composes `<YYYY-MM-DD>-<slug>` from the platform's own
 *  clock, so its argument is not the name. `initiative_status` takes the name but answers
 *  `{"error": "no such initiative"}` for one nobody opened, which is not an MCP error, so the
 *  row is recorded `ok` and the argument names something that does not exist. */
export const ANSWER_NAMES_INITIATIVE = /^initiative_(open|status)$/;

/** One MCP call as it arrived, narrowed to what this file reads. */
interface Call { readonly params?: { readonly name?: unknown; readonly arguments?: unknown } }

/**
 * Which initiative this exchange says is being worked on, or null when it says nothing.
 *
 * Two sources, and the answer outranks the argument. Any call carrying an `initiative`
 * argument names one, except the two in ANSWER_NAMES_INITIATIVE, where the answer is the
 * authority on whether it exists at all. Reading the argument of a failed `initiative_status`
 * takes a slug nobody created and keeps it for the rest of the conversation.
 *
 * `served` is the raw streamed answer, or null when the caller did not capture it, in which
 * case only the argument route can answer.
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
      // An answer carrying an error names nothing, although it echoes the slug it was asked
      // about.
      if (answer.error === undefined && typeof answer.initiative === "string" && answer.initiative) {
        return answer.initiative;
      }
    } catch { /* not the JSON this tool returns */ }
    return null;
  }
  return null;
}
