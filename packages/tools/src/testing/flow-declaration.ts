/**
 * What a flow declares: the documents it governs and the stages that evidence themselves with a
 * source.
 *
 * Reading a manifest and deciding what a flow is made of is one subject; walking a live deployment
 * with MCP calls is another, and stays in chain-check.ts. The probe reads a declaration; this is
 * the reading.
 *
 * Read from the checkout, the way manifest-audit reads it, and through @zz/catalog's reader rather
 * than a cast — a cast would accept a manifest the platform itself refuses, and the probe would
 * then walk a chain the deployment does not enforce and report the difference as a platform fault.
 */
import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { manifestAt } from "@zz/catalog";

/** A stage that leaves a source behind, and the document that source stands behind. An audit
 *  round is one: it writes no document of its own, so a probe looking for an audit document finds
 *  none and reports every audited initiative as un-audited. */
export interface SourceStage { readonly name?: string; readonly produces?: string; readonly supports?: string }

interface FlowDeclaration {
  readonly documents: { name: string; sections?: string[]; gate?: boolean; stage?: string; verifies?: string[] }[];
  /** Only the stages that produce a source, each with the document it supports. */
  readonly sourceStages: SourceStage[];
}

/**
 * The flow's documents and source-stages, from the flow's own manifest.
 *
 * Never a hardcoded opening document: sdlc-flow opens on explore.md and zz-plugin-eval on
 * rulers.md, so a hardcoded name writes a document that flow has never heard of, which no gate
 * governs, and then walks a chain it has already stepped outside of. Which flow a run walks is
 * what CHAIN_FLOW is for.
 *
 * One walk, both answers. A caller that took its documents from the declaration and its audit
 * rounds from a list of its own would pass while skipping a stage the flow added.
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
