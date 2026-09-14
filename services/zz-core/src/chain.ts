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

import { type CatalogManifest, type FlowDoc, parseEnvelope } from "@zz/contracts";
import { catalogManifest, isFlow } from "@zz/catalog";

import { openRecord } from "./initiative-record.js";
import { db } from "./platform-db.js";
import { type Chain } from "./write-guards.js";

function deriveChain(list: FlowDoc[], name: string | null = null): Chain {
  // Any flow that gates at least one document owes the platform a closing handover —
  // derived, never configured, so a sixth gating flow inherits it without its author
  // remembering. Appended into a SEPARATE array, never into `list` itself: `closingDoc`
  // below reads `list` directly, and if it instead read this augmented array the append
  // would become the closing document — silently, and only for a flow that marks no
  // `closing` — because the fallback is positional (`list[list.length - 1]`). Idempotent:
  // a manifest that already declares the entry below is left untouched.
  const documents: FlowDoc[] =
    list.some((d) => d.gate) && !list.some((d) => d.name === "handover.md")
      ? [
          ...list,
          {
            name: "handover.md",
            role: "handover",
            stage: "zz-knowledge",
            // Gated so somebody signs it, but never `closing` or `requiredForClose`: the
            // flow's own closing document still closes the flow, and documentGuards skips a
            // gated document that does not exist yet, which is what lets handover.md be
            // written AFTER that close.
            gate: true,
            requires: list.find((d) => d.closing)?.name ?? list[list.length - 1]?.name ?? "",
            sections: ["What this initiative taught", "Recorded for the platform", "Proposed for the team"],
          },
        ]
      : list;
  return {
    name,
    documents,
    // STAGES COME FROM THE CATALOG, never from the manifest stored at install time.
    //
    // The two disagree, and the disagreement is silent. zz.flow_install keeps the manifest a
    // team installed, which is right for a team's DOCUMENT chain — that is the shape of work
    // they agreed to — and wrong for a stage's block authority, because a team that has not
    // reinstalled since the field was added would carry a manifest with no `blocks` anywhere
    // and the write guard would simply never fire. A guard switched off by an install date is
    // one nobody can say was applied, and it fails in the direction that looks like success.
    //
    // It is also what makes zz-core and the gateway agree: the proxy's stage check reads the
    // catalog, so if this read the registry the same rule would have two sources.
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
/** The team's installed flow, from the registry (zz.flow_install stores each install's
 * manifest). Used when an initiative declares no flow of its own.
 *
 * ONE install, or nothing. A team running several has no answer here — which of them
 * governs is the document's to declare — and the honest outcome of not knowing is
 * EMPTY_CHAIN, not somebody else's chain. (This used to add "plus flowDeclarationCheck's
 * refusal"; that guard is gone — the question it asked is asked once, by initiative_open.)
 *
 * This said "must not be judged by another flow's chain merely because that other one is
 * the mounted default". There is no mounted default: EMPTY_CHAIN replaced the hardcoded
 * copy of ops-flow's documents, and its own comment says why. */
const installCache = new Map<string, { chain: Chain | null; expires: number }>();
async function chainForTeam(team: string | null): Promise<Chain | null> {
  const p = db();
  if (!team || !p) return null;
  const hit = installCache.get(team);
  if (hit && hit.expires > Date.now()) return hit.chain;
  let chain: Chain | null = null;
  try {
    const { rows } = await p.query<{ flow: string; manifest: CatalogManifest | null }>(
      `SELECT f.flow, f.manifest FROM zz.flow_install f
       JOIN zz.team t ON t.id = f.team_id WHERE t.slug = $1`,
      [team],
    );
    // Exactly one installed flow -> it governs. With several, the document must name its
    // own; an undeclared one resolves to nothing here and chainFor returns EMPTY_CHAIN.
    //
    // REACHED ONLY WITHOUT AN OPEN RECORD. An initiative opened freeform short-circuits above,
    // because "one install" is not consent — it is the only thing there was to guess with.
    if (rows.length === 1) {
      const m = rows[0].manifest;
      // THE CATALOG FIRST, the stored manifest only when the catalog cannot resolve the flow.
      //
      // This was the other way round, and the snapshot is old. team-one's stored ops-flow
      // manifest carries neither `stage` nor `sections` on any document — both were added to
      // flow.json after that install and no reinstall has happened since — so sectionCheck
      // had nothing to require and the stage guards had nothing to place. Two guards silently
      // off for a live team, with nothing anywhere saying so.
      //
      // Keeping the snapshot sounds like the safer half of the trade, and it is not: what it
      // preserves is the shape of a flow as it was on the day somebody ran install_flow, and
      // what it costs is every rule added since. The registry row still records what was
      // installed and when; it is simply not the thing a write is judged against.
      // isFlow here too, and for the same reason as chainForFlow: an installed manifest
      // carrying `documents: []` is a package with no chain, not a chain with no documents.
      chain = chainForFlow(rows[0].flow) ?? (m && isFlow(m) ? deriveChain(m.documents, rows[0].flow) : null);
    }
  } catch { /* registry unreachable or absent: no chain, so no discipline is enforced */ }
  installCache.set(team, { chain, expires: Date.now() + 60_000 });
  return chain;
}
/** Which flow's discipline governs this write.
 *
 * `content`, when given, is the document ABOUT to be written, and it is consulted first.
 * Without that there is a chicken-and-egg on every new initiative: the first document
 * cannot resolve a chain because the folder is empty, so the platform cannot stamp its
 * `flow:`, so the second document cannot resolve one either. It only ever worked because
 * a team with exactly ONE installed flow resolves from the registry — and stopped working
 * the day a team installed a second, which is not a condition anyone would connect to a
 * refused write. */
export async function chainFor(root: string, relPath: string, team: string | null, content?: string): Promise<Chain> {
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
  // no envelope to read a `flow:` off, and on a team running two flows there is no single
  // install to fall back to either — so without this the initiative a person opened WITH a
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
  // A DECLARED FREEFORM IS AN ANSWER, AND IT OUTRANKS EVERY FALLBACK BELOW.
  //
  // `flow: null` in the record is a person saying "nothing governs this", and without this
  // return the team fallback at the bottom of the function would overrule them: a team with
  // exactly ONE installed flow resolves to that flow for any initiative that names none, so
  // a deliberately freeform initiative would have been governed by it — every write judged
  // against a chain nobody asked for, and initiative_status naming stages off a manifest the
  // person declined. That is a flow adopted at open time against a stated wish, which FR-30
  // forbids doing afterwards and which the comment on EMPTY_CHAIN calls a wrong answer rather
  // than a fallback.
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
  // every comment around it — and zz-backbone's own instruction — says the FIRST document
  // is what declares the flow. Those are the same thing only by luck. On ext4 the order is
  // a hash of the names, and in `2026-09-05-blockeval-casebox` it was `findings.md surface.md
  // target.md usage.md`: the initiative opened with `target.md` declaring zz-block-eval,
  // and every later write resolved off `surface.md` instead and was governed by ops-flow —
  // the team's single install, reached as a fallback three steps further down.
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
      // the team's install, and past that to EMPTY_CHAIN — never to another flow's chain.
      const declared = fl ? chainForFlow(fl) : null;
      if (declared) return declared;
      if (fl) break;
    }
  } catch { /* folder does not exist yet */ }
  return (await chainForTeam(team)) ?? EMPTY_CHAIN;
}
export function frontmatterStatus(file: string): string | null {
  if (!existsSync(file)) return null;
  return parseEnvelope(readFileSync(file, "utf8")).status ?? null;
}
