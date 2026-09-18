/**
 * Which flow governs a document, and therefore which gates apply to it.
 *
 * A chain is derived from a flow's manifest — the documents it declares, in order, which of
 * them carry a gate, and which one closes the initiative. Everything that refuses a write
 * asks this first, so it is resolved once per flow and cached: a team running two flows must
 * get the right answer for each, and an initiative that declared none is refused rather than
 * quietly governed by whatever the team happens to have installed.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { type FlowDoc, parseEnvelope } from "@zz/contracts";
import { catalogManifest, isFlow, withHandover } from "@zz/catalog";

import { openRecord } from "./initiative-record.js";
import { type Chain } from "./write-guards.js";

function deriveChain(list: FlowDoc[], name: string | null = null): Chain {
  // Any flow that gates at least one document owes the platform a closing handover —
  // derived, never configured, so a sixth gating flow inherits it without its author
  // remembering. Appended into a SEPARATE array, never into `list` itself: `closingDoc`
  // below reads `list` directly, and if it instead read this augmented array the append
  // would become the closing document — silently, and only for a flow that marks no
  // `closing` — because the fallback is positional (`list[list.length - 1]`). Idempotent:
  // a manifest that already declares the entry below is left untouched.
  // DERIVED IN @zz/catalog, so zz-core and the console read one answer. It used to be
  // written out here, which is why the console — which has no access to this file — drew a
  // flow the platform does not enforce.
  //
  // Appended into a SEPARATE array, never into `list` itself: `closingDoc` below reads
  // `list` directly, and if it instead read this augmented array the append would become the
  // closing document — silently, and only for a flow that marks no `closing` — because the
  // fallback is positional (`list[list.length - 1]`).
  const documents: FlowDoc[] = withHandover(list);
  return {
    name,
    documents,
    // STAGES COME FROM THE CATALOG — the one source zz-core and the gateway both read.
    stages: name ? (catalogManifest(name.split("@")[0].trim(), true)?.stages ?? []) : [],
    docs: new Set(documents.map((d) => d.name)),
    requires: Object.fromEntries(documents.filter((d) => d.requires).map((d) => [d.name, d.requires as string])),
    // The closing document is whichever the manifest marks `closing`. The
    // fallback is the last declared document, NOT a literal name: a hardcoded
    // "spec.md" here would silently judge a second flow by the first one's
    // shape, which is precisely the thing this engine exists not to do.
    //
    // Reads `list`, NOT `documents` — see the comment above `documents`. This must never
    // change to read the augmented array.
    closingDoc: list.find((d) => d.closing)?.name ?? list[list.length - 1]?.name ?? "",
    closeRequires: list.filter((d) => d.requiredForClose).map((d) => d.name),
    roles: Object.fromEntries(documents.filter((d) => d.role).map((d) => [d.name, d.role as string])),
  };
}
/** No flow could be identified, so no discipline is declared, so none is enforced.
 *
 * This used to be a hardcoded copy of ops-flow's document list — applied to any initiative
 * whose flow could not be resolved. On a team running two flows that is not a fallback but
 * a wrong answer: an sdlc-flow initiative was refused its spec.md because ops-flow's chain
 * demands an intent.md that sdlc-flow never produces, with an error claiming "the flow
 * writes it first". Enforcing nothing is the honest outcome of not knowing; enforcing
 * somebody else's chain is a guardrail pointed at the wrong thing. */
const EMPTY_CHAIN = deriveChain([], null);
const chainCache = new Map<string, { chain: Chain | null; expires: number }>();
function chainForFlow(declared: string): Chain | null {
  // documents declare `flow: ops-flow@1` — the envelope carries the flow's
  // version, the catalog is keyed by name alone
  const name = declared.split("@")[0].trim();
  if (!name) return null;
  const hit = chainCache.get(name);
  if (hit && hit.expires > Date.now()) return hit.chain;
  let chain: Chain | null = null;
  // THROUGH @zz/catalog, which is the module that exists to hold this walk. This service had
  // its own — an unsorted readdir that took whichever owner the filesystem returned first,
  // and `JSON.parse(...) as CatalogManifest`, an assertion about a shape nobody checked.
  //
  // That cast is the one @zz/catalog's own comment argues against: "a manifest with
  // `gate: \"true\"` or a misspelled `documents` key produced a chain that was wrong rather
  // than absent — and a wrong chain refuses the writes the flow depends on, at the stage that
  // depends on them, far from the typo". This function IS that chain: it decides which
  // documents gate, which order they come in and which writes are refused. The gateway
  // validated the same file and this did not.
  //
  // `includePlatform` is true because a platform package may declare a chain of its own, and
  // an initiative that names one is asking for exactly that.
  const m = catalogManifest(name, true);
  // isFlow, NOT a truthiness test on `documents`. These are one question, not two: a chain
  // IS a flow's discipline over its documents, so "is there a chain to derive" and "is this
  // a flow" have the same answer by construction, and deriving one for a package that is not
  // a flow is the bug rather than a tolerated edge.
  //
  // `if (m?.documents)` was that bug. `[]` is truthy, so a manifest declaring an empty list
  // resolved to a NAMED chain with nothing in it — and a named chain is exactly what
  // initiative_status takes as "a flow governs this", so it walked an empty document list and
  // answered `action: "close", document: ""`. The honest answer is no chain, which is what an
  // unresolvable flow already gets.
  if (m && isFlow(m)) chain = deriveChain(m.documents, m.name ?? name);
  chainCache.set(name, { chain, expires: Date.now() + 60_000 });
  return chain;
}
/** Which flow's discipline governs this write.
 *
 * `content`, when given, is the document ABOUT to be written, and it is consulted first.
 * Without that there is a chicken-and-egg on every new initiative: the first document
 * cannot resolve a chain because the folder is empty, so the platform cannot stamp its
 * `flow:`, so the second document cannot resolve one either.
 *
 * THE INITIATIVE ANSWERS, AND NOTHING ELSE DOES. There was a last fallback to the team's single
 * installed flow; the platform keeps no install registry any more, and a team's installs were
 * never the initiative's declaration anyway. An initiative that declares nothing is freeform. */
export function chainFor(root: string, relPath: string, content?: string): Chain {
  const parts = relPath.replace(/^\/+/, "").split("/");
  if (parts.length !== 2) return EMPTY_CHAIN;   // not an initiative document
  const declaredHere = parseEnvelope(content ?? "").flow;
  if (declaredHere) {
    const own = chainForFlow(declaredHere);
    if (own) return own;
  }
  // THE DECLARATION MADE AT OPEN TIME, before any document exists to carry one.
  //
  // Between `initiative_open("x", "sdlc-flow")` and that initiative's first document there is
  // no envelope to read a `flow:` off — so without this the initiative a person opened WITH a
  // flow resolves to EMPTY_CHAIN and `initiative_status` reports it freeform. That window is
  // not an edge case: it is exactly when an agent picks the work up, because picking it up is
  // what `initiative_status` is called for.
  //
  // AFTER `content`, deliberately. `content` is the document about to be written, and a
  // document's own declaration is the one thing more specific than the folder's.
  const opened = openRecord(root, parts[0]);
  if (opened?.flow) {
    const own = chainForFlow(opened.flow);
    if (own) return own;
  }
  // A DECLARED FREEFORM IS AN ANSWER, AND IT OUTRANKS THE WALK BELOW.
  //
  // `flow: null` in the record is a person saying "nothing governs this".
  //
  // The oldest-document walk is skipped too, deliberately: the platform does not stamp `flow:`
  // onto a freeform document, so an envelope carrying one here was either hand-written or left
  // from before the record existed, and the record is the more recent and more explicit of the
  // two. An initiative with NO record at all falls through to both, exactly as it did before —
  // nothing written before this file existed is reinterpreted.
  if (opened && !opened.flow) return EMPTY_CHAIN;
  // THE OLDEST DOCUMENT ANSWERS, not whichever one readdir hands back first.
  //
  // This walked the directory in readdir order and took the first `flow:` it met, while
  // every comment around it — and zz-platform's own instruction — says the FIRST document
  // is what declares the flow. Those are the same thing only by luck. On ext4 the order is
  // a hash of the names, and in `2026-09-05-blockeval-casebox` it was `findings.md surface.md
  // target.md usage.md`: the initiative opened with `target.md` declaring zz-block-eval,
  // and every later write resolved off `surface.md` instead and was governed by another flow.
  //
  // That is self-reinforcing, which is what makes it worth the sort. The platform STAMPS
  // the flow it resolved onto each governed document, so one wrong fallback becomes a
  // written declaration, and the next write finds two files disagreeing with no way to
  // tell which was the input and which was the echo. mtime tells it: the input is older
  // than anything stamped from it.
  try {
    const dir = join(root, parts[0]);
    const dated = readdirSync(dir)
      .filter((f) => f.endsWith(".md") && !f.startsWith("_"))
      .map((f) => ({ f, at: statSync(join(dir, f)).mtimeMs }))
      .sort((a, b) => a.at - b.at);
    for (const { f } of dated) {
      const fl = parseEnvelope(readFileSync(join(dir, f), "utf8")).flow;
      // An unresolvable declaration must NOT masquerade as a resolution: fall through to
      // EMPTY_CHAIN — never to another flow's chain.
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
