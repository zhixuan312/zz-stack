/**
 * Which flow governs a document, and therefore which gates apply to it.
 *
 * A chain is derived from a flow's manifest — the documents it declares, in order, which of
 * them carry a gate, and which one closes the initiative. Everything that refuses a write
 * asks this first, so it is resolved once per flow and cached: a team running two flows must
 * get the right answer for each. An initiative that declares no flow is freeform, and nothing
 * is enforced on it.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { type FlowDoc, parseEnvelope } from "@zz/contracts";
import { catalogManifest, isFlow, withHandover } from "@zz/catalog";

import { openRecord } from "./initiative-record.js";
import { type Chain } from "./write-guards.js";

function deriveChain(list: FlowDoc[], name: string | null = null): Chain {
  // Any flow that gates at least one document owes the platform a closing handover. Derived in
  // @zz/catalog, never configured, so a new gating flow inherits it and zz-core and the console
  // read one answer. A manifest that already declares the handover is left untouched.
  //
  // DELIBERATE: appended into a separate array, never into `list`. `closingDoc` below falls back
  // positionally (`list[list.length - 1]`), so reading the augmented array would make the
  // handover the closing document — silently, and only for a flow that marks no `closing`.
  const documents: FlowDoc[] = withHandover(list);
  return {
    name,
    documents,
    // Stages come from the catalog, the one source zz-core and the gateway both read.
    stages: name ? (catalogManifest(name.split("@")[0].trim(), true)?.stages ?? []) : [],
    docs: new Set(documents.map((d) => d.name)),
    requires: Object.fromEntries(documents.filter((d) => d.requires).map((d) => [d.name, d.requires as string])),
    // The closing document is whichever the manifest marks `closing`, falling back to the last
    // declared document — never a literal name, which would judge a second flow by the first
    // one's shape.
    //
    // DELIBERATE: reads `list`, not `documents` — see the comment above `documents`.
    closingDoc: list.find((d) => d.closing)?.name ?? list[list.length - 1]?.name ?? "",
    closeRequires: list.filter((d) => d.requiredForClose).map((d) => d.name),
    roles: Object.fromEntries(documents.filter((d) => d.role).map((d) => [d.name, d.role as string])),
  };
}
/** No flow could be identified, so no discipline is declared and none is enforced.
 *
 * DELIBERATE: not a default flow's chain. On a team running two flows, another flow's chain
 * refuses documents this one never produces; enforcing nothing is the honest outcome of not
 * knowing. */
const EMPTY_CHAIN = deriveChain([], null);
const chainCache = new Map<string, { chain: Chain | null; expires: number }>();
function chainForFlow(declared: string): Chain | null {
  // documents declare `flow: sdlc-flow@1` — the envelope carries the flow's
  // version, the catalog is keyed by name alone
  const name = declared.split("@")[0].trim();
  if (!name) return null;
  const hit = chainCache.get(name);
  if (hit && hit.expires > Date.now()) return hit.chain;
  let chain: Chain | null = null;
  // Through @zz/catalog, which validates the manifest. An unchecked parse turns a typo such as
  // `gate: "true"` into a chain that is wrong rather than absent, and a wrong chain refuses the
  // writes the flow depends on, far from the typo.
  //
  // `includePlatform` is true because a platform package may declare a chain of its own, and
  // an initiative that names one is asking for exactly that.
  const m = catalogManifest(name, true);
  // DELIBERATE: `isFlow`, not a truthiness test on `documents`. A chain is a flow's discipline
  // over its documents, so the two questions have one answer. `[]` is truthy, so a manifest
  // declaring an empty list would resolve to a named chain with nothing in it, which
  // initiative_status reads as "a flow governs this" and answers `close` naming no document.
  if (m && isFlow(m)) chain = deriveChain(m.documents, m.name ?? name);
  chainCache.set(name, { chain, expires: Date.now() + 60_000 });
  return chain;
}
/** Which flow's discipline governs this write.
 *
 * `content`, when given, is the document about to be written, and it is consulted first:
 * without it the first document of a new initiative cannot resolve a chain, because the
 * folder is empty, so its `flow:` is never stamped and the second cannot resolve one either.
 *
 * DELIBERATE: the initiative answers, and nothing else does. A team's installs are not the
 * initiative's declaration. An initiative that declares nothing is freeform. */
export function chainFor(root: string, relPath: string, content?: string): Chain {
  const parts = relPath.replace(/^\/+/, "").split("/");
  if (parts.length !== 2) return EMPTY_CHAIN;   // not an initiative document
  const declaredHere = parseEnvelope(content ?? "").flow;
  if (declaredHere) {
    const own = chainForFlow(declaredHere);
    if (own) return own;
  }
  // The declaration made at open time, before any document exists to carry one. Between
  // `initiative_open("x", "sdlc-flow")` and the first document there is no envelope to read a
  // `flow:` off, and that is exactly when an agent picks the work up through
  // `initiative_status`.
  //
  // DELIBERATE: after `content`. A document's own declaration is the one thing more specific
  // than the folder's.
  const opened = openRecord(root, parts[0]);
  if (opened?.flow) {
    const own = chainForFlow(opened.flow);
    if (own) return own;
  }
  // DELIBERATE: a declared freeform outranks the walk below. `flow: null` in the record is a
  // person saying "nothing governs this". The platform does not stamp `flow:` onto a freeform
  // document, so an envelope carrying one here was hand-written or predates the record, and the
  // record is the more explicit of the two. An initiative with no record falls through to both.
  if (opened && !opened.flow) return EMPTY_CHAIN;
  // The oldest document answers, not whichever one readdir hands back first: the first document
  // is what declares the flow, and on ext4 readdir order is a hash of the names.
  //
  // DELIBERATE: by mtime. The platform stamps the flow it resolved onto each governed document,
  // so one wrong resolution becomes a written declaration and two files disagree; the input is
  // older than anything stamped from it.
  try {
    const dir = join(root, parts[0]);
    const dated = readdirSync(dir)
      .filter((f) => f.endsWith(".md") && !f.startsWith("_"))
      .map((f) => ({ f, at: statSync(join(dir, f)).mtimeMs }))
      .sort((a, b) => a.at - b.at);
    for (const { f } of dated) {
      const fl = parseEnvelope(readFileSync(join(dir, f), "utf8")).flow;
      // DELIBERATE: an unresolvable declaration falls through to EMPTY_CHAIN, never to another
      // flow's chain.
      const declared = fl ? chainForFlow(fl) : null;
      if (declared) return declared;
      if (fl) break;
    }
  } catch { /* folder does not exist yet */ }
  return EMPTY_CHAIN;
}
export function frontmatterStatus(file: string): string | null {
  if (!existsSync(file)) return null;
  return parseEnvelope(readFileSync(file, "utf8")).status ?? null;
}
