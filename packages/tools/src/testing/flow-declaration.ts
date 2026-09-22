/**
 * What a flow DECLARES: the documents it governs and the stages that evidence themselves
 * with a source.
 *
 * SPLIT OUT OF chain-check.ts, which crossed the seven-hundred-line ceiling when it learned
 * to run a flow's audit rounds. The seam is the subject rather than the line count: reading
 * a manifest and deciding what a flow is made of is one thing, and walking a live deployment
 * with MCP calls is another. The probe reads a declaration; this is the reading.
 *
 * READ FROM THE CHECKOUT, the way manifest-audit reads it, and through @zz/catalog's reader
 * rather than a cast — a cast would accept a manifest the platform itself refuses, and the
 * probe would then walk a chain the deployment does not enforce and report the difference as
 * a platform fault.
 */
import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { manifestAt } from "@zz/catalog";

/** A stage that leaves a SOURCE behind, and the document that source stands behind. An audit
 *  round is one: it writes no document of its own, which is why a probe looking for an audit
 *  DOCUMENT finds none and reports every audited initiative as un-audited. */
export interface SourceStage { readonly produces?: string; readonly supports?: string }

interface FlowDeclaration {
  readonly documents: { name: string; sections?: string[]; gate?: boolean }[];
  /** Only the stages that produce a source, each with the document it supports. */
  readonly sourceStages: SourceStage[];
}

/**
 * The flow's documents and source-stages, from the flow's own manifest.
 *
 * chain-check opened on a hardcoded `intent.md` once. ops-flow declares one and sdlc-flow
 * does not — it opens on explore.md — so CHAIN_FLOW=sdlc-flow wrote a document that flow has
 * never heard of, which no gate governs, and then walked a chain it had already stepped
 * outside of. The whole point of CHAIN_FLOW is that this deployment runs both.
 *
 * ONE WALK, BOTH ANSWERS. A caller that took its documents from the declaration and its
 * audit rounds from a list of its own would pass while skipping a stage the flow added.
 */
export function flowDeclaration(flow: string): FlowDeclaration | null {
  const catalog = join(dirname(fileURLToPath(import.meta.url)), "../../../../catalog");
  if (!existsSync(catalog)) return null;
  for (const owner of readdirSync(catalog)) {
    const manifest = join(catalog, owner, flow, "flow.json");
    if (!existsSync(manifest)) continue;
    const read = manifestAt(manifest);
    if (!read.manifest) {
      console.error(`  (${owner}/${flow}/flow.json ${read.why} — looking elsewhere)`);
      continue;
    }
    const documents = read.manifest.documents ?? [];
    if (!documents[0]?.name) continue;
    const sourceStages = ((read.manifest as { stages?: SourceStage[] }).stages ?? [])
      .filter((st) => st.produces === "source" && st.supports);
    return { documents, sourceStages };
  }
  return null;
}
