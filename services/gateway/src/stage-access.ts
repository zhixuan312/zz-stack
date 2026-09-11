/**
 * WHICH BUILDING BLOCKS A STAGE MAY CALL, decided per call at the proxy.
 *
 * Until this existed the platform had exactly one block boundary and it was the TEAM: a
 * manifest's `tools` granted casebox, n8n and bookit to the whole of ops-flow, so sm-intent —
 * which interviews a person and names no technology at all — had the same reach as sm-build.
 * The event log shows what that cost: 62 casebox calls, 53 n8n and 27 bookit stamped
 * `sm-intent`, one of them `update_case_type`, which is a write. Every stage skill said in
 * prose not to, and prose is not a boundary.
 *
 * WHAT THIS DOES NOT DO is take the tools out of the model's context. A client is handed its
 * MCP server list once, when it fetches its package, and nothing tells it which stage is
 * running — so every tool schema is still in the window. This refuses the call; it does not
 * remove the temptation. Removing it needs a dispatch tool and is a separate decision.
 *
 * THREE RULES, and they are all in the direction of not breaking what already runs:
 *
 *   1. Absent means unenforced. Only a stage that declares `blocks` is constrained, and no
 *      flow in the catalog declares one today — so this refuses nothing at present and is an
 *      opt-in a flow author reaches by writing the field. It is on `FlowStage` in
 *      @zz/contracts with its own documentation, and the gate holds a stage's `blocks` to a
 *      subset of the flow's `tools`, so the opt-in is discoverable rather than folklore.
 *   2. No step known means no enforcement. If the caller has not loaded a skill, they are not
 *      running a flow, and the team grant governs — which is the same shape as the grant check
 *      itself ("a team with no grants recorded still passes freely").
 *   3. Only `tools/call` is ever refused. Refusing `initialize` or `tools/list` would kill the
 *      block's transport for the whole conversation, and a dead MCP transport on this platform
 *      does not surface as an error — the turn makes one call and stops. The block stays
 *      connected and one call comes back refused, with the reason in it.
 */
import type { FlowStage } from "@zz/contracts";
import { catalogManifest } from "@zz/catalog";
import { platformDb, platformDbReady } from "./db.js";
import { currentStep, flowFor } from "./step-trace.js";

/** What a stage declares, or undefined when it declares nothing. */
function declaredBlocks(flow: string, step: string): FlowStage["blocks"] | undefined {
  const stages = catalogManifest(flow, true)?.stages ?? [];
  return stages.find((s) => s.name === step)?.blocks;
}

/** The blocks an initiative's own selection document chose.
 *
 * Read from the document's FRONTMATTER, never from its prose. A selection document explains
 * itself at length, and the one on this deployment names casebox in a heading and then names
 * bookit and n8n in the paragraphs REJECTING them — so a parser reading the body would
 * grant exactly the blocks the document argued against. `blocks:` is written by sm-select
 * through write_file's `fields` and is the flow's own frontmatter key.
 *
 * Cached briefly and per initiative: this runs on every block call, and a selection document
 * changes at most once per initiative.
 */
const selectionCache = new Map<string, { blocks: string[] | null; at: number }>();
const SELECTION_TTL_MS = 60_000;

async function selectedBlocks(team: string, initiative: string): Promise<string[] | null> {
  if (!platformDbReady() || !team || !initiative) return null;
  const key = `${team} ${initiative}`;
  const now = Date.now();
  const hit = selectionCache.get(key);
  if (hit && now - hit.at < SELECTION_TTL_MS) return hit.blocks;
  let blocks: string[] | null = null;
  try {
    // THE COLUMN, not the body. zz.doc stores the body with the envelope already stripped —
    // that is what documentBody exists for — so parsing frontmatter out of it found nothing,
    // every "selected" resolved to unknown, and unknown is unenforced. The field is indexed
    // beside tags and evidence now, for exactly this reader.
    //
    // BY ROLE, not by filename. A flow names its own documents, and `like '%selection.md'`
    // is ops-flow's spelling of one — the role is what the manifest declares and what every
    // other reader here joins on.
    const { rows } = await platformDb().query<{ blocks: string[] }>(
      `select blocks from zz.doc
        where team_slug = $1 and initiative = $2 and type = 'selection'
          and cardinality(blocks) > 0 limit 1`,
      [team, initiative],
    );
    if (rows[0]?.blocks?.length) blocks = rows[0].blocks;
  } catch {
    // A lookup failure must not refuse a call. The same reasoning as flowFor's: an outage in
    // a side lookup taking every block away from everyone is worse than the thing being
    // enforced, and this is an authority the flow chose to declare, not the door itself.
    return null;
  }
  selectionCache.set(key, { blocks, at: now });
  return blocks;
}

/** Why this call is refused, or null to let it through. */
export async function stageDenial(
  caller: string, team: string | null, block: string, method: string,
): Promise<string | null> {
  if (method !== "tools/call") return null;
  const step = currentStep(caller);
  if (!step?.step) return null;
  const flow = await flowFor(team);
  if (!flow) return null;
  const declared = declaredBlocks(flow.flow, step.step);
  if (declared === undefined) return null;

  if (declared === "selected") {
    const chosen = await selectedBlocks(team ?? "", step.initiative);
    // Nothing to resolve THROUGH. An initiative whose selection document does not name its
    // blocks — every one written before that field existed — is unenforced rather than
    // refused, which is rule 1 applied to the one case where the declaration is indirect.
    if (!chosen) return null;
    if (chosen.includes(block)) return null;
    return `'${block}' is refused at ${step.step}. This stage may call the blocks the ` +
      `initiative selected, and ${step.initiative} selected ${chosen.join(", ")}. ` +
      "Calling something outside the approved selection means the selection is no longer " +
      "what is being built — reopen the selection document and get the change approved, " +
      "rather than adding a block the stakeholder never saw.";
  }

  if (declared.includes(block)) return null;
  return declared.length
    ? `'${block}' is refused at ${step.step}. This stage may call ${declared.join(", ")}.`
    : `'${block}' is refused at ${step.step}. This stage declares NO building block: it ` +
      "names no technology and writes nothing outside the platform. If you need a block, " +
      "you are at the wrong stage — load the one that declares it, or work outside a flow.";
}

/** The refusal as the model will read it: a tool RESULT, not a protocol error.
 *
 * `isError` on a result is how MCP says "the call ran and went wrong", and it is what puts
 * the text in front of the model. A JSON-RPC `error` object, or an HTTP status, is a fault in
 * the transport — the client is entitled to treat it as one, and this one would be lying,
 * because nothing is broken.
 */
export const denialResponse = (id: unknown, why: string) => ({
  jsonrpc: "2.0" as const,
  id: id ?? null,
  result: { content: [{ type: "text", text: `REFUSED BY THE FLOW: ${why}` }], isError: true },
});
