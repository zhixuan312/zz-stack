/**
 * Which flow governs a document, and therefore which gates apply to it.
 *
 * A chain is derived from a flow's manifest — the documents it declares, in order, which of
 * them carry a gate, and which one closes the initiative. Everything that refuses a write
 * asks this first, so it is resolved once per flow and cached: a team running two flows must
 * get the right answer for each. An initiative that declares no flow is freeform, and nothing
 * is enforced on it.
 *
 * COUPLED: the declaration is read from two ROWS and never from a directory. A document's own
 * `flow:` is the most specific answer, and `zz.initiative.flow` — the flow the initiative was
 * OPENED with — is what answers in the window before its first document exists, which is exactly
 * when a resuming agent calls `initiative_status`. The oldest-document walk that used to be the
 * last resort is gone with the store: it read the team's files, and the row it was imitating is
 * the one this reads directly.
 */
import { type FlowDoc, parseEnvelope } from "@zz/contracts";
import { catalogManifest, isFlow, withHandover } from "@zz/catalog";

import { openRecord, type RecordClient } from "./initiative-record.js";
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
 * envelope has no `flow:` yet — and that is the case `zz.initiative.flow` answers.
 *
 * DELIBERATE: the initiative answers, and nothing else does. A team's installs are not the
 * initiative's declaration. An initiative that declares nothing is freeform.
 *
 * An unresolvable declaration falls through to `EMPTY_CHAIN`, never to another flow's chain. */
export async function chainFor(
  p: RecordClient, team: string | null, relPath: string, content?: string,
): Promise<Chain> {
  const parts = relPath.replace(/^\/+/, "").split("/");
  if (parts.length !== 2) return EMPTY_CHAIN;   // not an initiative document
  const declaredHere = parseEnvelope(content ?? "").flow;
  if (declaredHere) {
    const own = chainForFlow(declaredHere);
    if (own) return own;
  }
  // The declaration made at open time, before any document exists to carry one. Read from
  // `zz.initiative`, which is where `initiative_open` records it.
  //
  // DELIBERATE: after `content`. A document's own declaration is the one thing more specific
  // than the initiative's.
  if (!team) return EMPTY_CHAIN;
  const opened = await openRecord(p, team, parts[0]);
  if (opened?.flow) {
    const own = chainForFlow(opened.flow);
    if (own) return own;
  }
  // `flow: null` on the row is a person saying "nothing governs this", and no record at all is
  // an initiative this deployment cannot place. Neither is a flow, and neither may acquire one:
  // adopting a flow after the fact is what the whole declaration exists to refuse.
  return EMPTY_CHAIN;
}
/** Why `name` cannot be approved under `chain`, or null when it can.
 *
 * DELIBERATE: only a flow can say a document is not its business. A freeform initiative
 * resolves to EMPTY_CHAIN, so whatever is in its folder is approvable; a flow that declared its
 * documents refuses one it never named.
 *
 * Declaring a document is not gating it. An ungated document is finished by being written, and
 * `approved` on one is a verdict the platform has nowhere to put. COUPLED: `stampEnvelope` never
 * writes a status where no gate exists, and `document_approve` refuses through this. Without both,
 * the next approval of an audit report undoes the other. The refusal names the alternative,
 * because the caller is not doing anything wrong.
 *
 * One answer for two askers: `document_approve`, which refuses with it, and the document panel,
 * which offers an Approve button only where this is null. */
export function gateRefusal(chain: Chain, name: string): string | null {
  if (chain.documents.length && !chain.docs.has(name)) {
    return `ERROR: ${name} is not a document this flow declares`;
  }
  const entry = chain.documents.find((d) => d.name === name);
  if (entry && entry.gate !== true) {
    return `ERROR: ${name} carries no gate in ${chain.name ?? "this flow"}, so there is ` +
      "nothing to approve. A status records that a person was asked and answered; this " +
      "document was never put to anyone. It is complete because it was written — say so " +
      "and carry on. Which documents gate is the flow manifest's answer, and it can differ " +
      "between flows: the same name may be gated in one and not in another.";
  }
  return null;
}
/** The status a document's own revision carries, or null when the team holds no such document.
 *
 * COUPLED: `zz.doc.status` is the document's own — a revision sealed at an approval reads
 * `approved` because it was — and this answers for the CURRENT revision alone, which is what
 * every caller of the file reader this replaced asked. */
export async function frontmatterStatus(
  p: RecordClient, team: string | null, initiative: string, name: string,
): Promise<string | null> {
  if (!team) return null;
  const { rows } = await p.query<{ status: string }>(
    `select d.status from zz.doc d
       join zz.initiative i on i.id = d.initiative_id
       join zz.team t on t.id = i.team_id
      where t.slug = $1 and i.slug = $2 and d.path = $3`,
    [team, initiative, name]);
  return rows[0]?.status ?? null;
}
