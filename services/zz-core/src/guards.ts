/**
 * What refuses a write, and why each refusal exists.
 *
 * `documentGuards` is the one entry point: every write path calls it and none of them
 * decides for itself. The checks under it are separate functions because each answers a
 * different question — is this initiative closed, does its flow declare this document, is
 * the gate above it recorded, is this name already taken, does the caller own it.
 *
 * Every one of them returns a sentence, never a boolean, so a refused caller is told which
 * rule they broke.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { admitEntry, documentApplies, OUTCOME_STOPPED, parseEnvelope, PLATFORM_OWNED } from "@zz/contracts";

import { frontmatterStatus } from "./chain.js";
import { closingDocRuledOut, factsFor } from "./initiative-record.js";
import { attributionCheck, type Chain, outcomeCheck, sectionCheck, statusCheck } from "./write-guards.js";

/** Why a stop discharges a close-time requirement, written once because two rules claim it.
 *
 * An initiative that was dropped is precisely one whose gates were never passed, so requiring
 * them at close would leave two options — approve a plan nobody agreed to, or leave the
 * initiative open forever. The same argument covers a `requiredForClose` document: a
 * verification guide is what a finished build owes its stakeholder, and demanding one from
 * work that stopped can only be satisfied by writing a guide for a thing nobody built.
 *
 * Not a general amnesty: the declared closing document's own gate is asked without it, and the
 * word costs an outcome the ledger then carries in public. */
const STOPPED_GROUND =
  `the work stopped rather than finished, and closing it as ${OUTCOME_STOPPED} records that in the team's ledger`;
/** Closing an initiative (writing `outcome:` into the manifest's closing
 * document) requires every document the manifest marks `requiredForClose`. */
function closeCheck(chain: Chain, root: string, relPath: string, content: string): string | null {
  const parts = relPath.replace(/^\/+/, "").split("/");
  if (parts.length !== 2) return null;
  const env = parseEnvelope(content);
  if (!env.outcome) return null;
  // FR-58 (Task I-28): `chain.closingDoc` is a static, per-flow answer — a `when`-conditional
  // closing document (`improvement.md`, promotable only) is `not_applicable` on every other
  // branch, and the branch still has to close somewhere. `closingDocRuledOut` is the same
  // question `initiative_close` asks before picking where to write, so the two never disagree
  // about which document a close lands on; the fallback itself trusts `parts[1]` the same way
  // that call already does when a caller names a document explicitly, rather than recomputing
  // "the furthest one" a second way here.
  const stop = env.outcome === OUTCOME_STOPPED;
  const ruledOut = closingDocRuledOut(root, parts[0], chain.documents.find((d) => d.name === chain.closingDoc));
  const missing = stop && !!chain.closingDoc && !existsSync(join(root, parts[0], chain.closingDoc));
  const isClosingWrite = parts[1] === chain.closingDoc
    ? !ruledOut
    : (ruledOut || missing) && chain.docs.has(parts[1]) && parts[1] !== "handover.md";
  if (!isClosingWrite) return null;
  // The closing document's own gate, when it declares one. gateCheck enforces a gate only
  // where another document `requires` it, so the last gated document in a chain — usually the
  // closing one — has its gate enforced by nothing else.
  //
  // `outcome: accepted` is a claim about what a person said, so the close has to name who.
  // The close is an act, and its fields are stamped by that act, never typed here.
  // `initiative_close()` takes what the caller knows — finished or abandoned, and who
  // accepted it if anyone did — and the platform derives the outcome from that. There is no
  // branch in which one field is required because another holds a particular value: a fact
  // you derive cannot be forged by choosing the cheaper word.
  if (!env.closed_by) {
    return (
      `ERROR: ${parts[1]} carries outcome: ${env.outcome} but no closed_by, so it was written ` +
      "by hand rather than recorded by an act. Use `initiative_close(initiative, disposition)` — the " +
      "platform derives the outcome from what you tell it and stamps who closed it. " +
      "`disposition: finished` with an `accepted_by` records an acceptance; without one it " +
      "records a delivery and asks why nobody signed off; `abandoned` says the work stopped."
    );
  }
  // The same rule as gateCheck's, asked three times. Each of the three questions below is
  // "does what is recorded reach the standard this close demands, or is it discharged on a
  // named ground" — the rule `admitEntry` holds.
  //
  // DELIBERATE: three calls and not one. On both flows this platform runs, the closing
  // document is also `requiredForClose` — review.md on sdlc-flow, findings.md on
  // zz-plugin-eval — so a single requirement list would name that document twice, once at
  // `ratified` from the text being written and once at `recorded` from the copy on disk.
  // `admitEntry` takes the strongest holding of a kind, so the disk copy would answer for the
  // text, and a closing document approved yesterday would close on an unapproved draft today.
  // (`stop` is computed once, above, before the branch-aware `isClosingWrite` check.)
  const self = chain.documents.find((d) => d.name === parts[1]);
  // FR-58 (Task I-26): a document whose branch has not resolved yet — a named fact `when`
  // depends on is absent from `_facts.json` — blocks a FINISHED close outright. The platform
  // does not know whether it is required, so it cannot certify that every required gate is
  // recorded; `branch_undetermined` is refused by name, the same way `stale_baseline` names its
  // own refusal elsewhere in this initiative's contract. An ABANDONED close is unaffected: the
  // work stopped, and stopping asks no branch to have been decided — the same exemption
  // STOPPED_GROUND already gives the gates below.
  const facts = factsFor(root, parts[0]);
  if (!stop) {
    const undetermined = chain.documents.find(
      (d) => d.when && documentApplies(d, facts) === "undetermined");
    if (undetermined) {
      const missing = Object.keys(undetermined.when!).filter((f) => !facts[f]);
      return (
        `ERROR: branch_undetermined — ${undetermined.name} declares \`when\` over ` +
        `${missing.join(", ")}, and _facts.json does not record ${missing.length === 1 ? "it" : "them"} ` +
        `yet, so the platform cannot say whether ${undetermined.name} is required before ` +
        `${parts[0]} closes. Run the stage that decides the branch first. If the ` +
        `work stopped rather than finished, initiative_close(initiative, "${OUTCOME_STOPPED}") ` +
        "does not ask for it."
      );
    }
  }
  // Judged from `content` — the text being written — and never from the copy on disk, which
  // this write supersedes. No waiver on the flow's DECLARED closing document: a stop does not
  // discharge the gate of the document the flow says closes it.
  //
  // DELIBERATE: a stop that lands on a FALLBACK document is waived. That document is where the
  // work happened to stop — spec.md in draft on an sdlc initiative abandoned before review.md —
  // not a document the flow asked to close on, and its gate is exactly one of the gates a stop
  // is excused from below. Without the waiver, abandoning mid-draft would demand approving the
  // draft first, which is the dilemma STOPPED_GROUND exists to remove.
  const fallback = parts[1] !== chain.closingDoc;
  const own = admitEntry(
    self?.gate ? [{ kind: parts[1], standard: "ratified" }] : [],
    [{ kind: parts[1], standard: parseEnvelope(content).status === "approved" ? "ratified" : "recorded" }],
    stop && fallback ? [{ kind: parts[1], ground: STOPPED_GROUND }] : [],
  );
  if (!own.admitted) {
    return (
      `ERROR: ${parts[1]} is this flow's closing document AND carries a gate, so it cannot be ` +
      `closed while its own approval is unrecorded. Call document_approve("${parts[0]}/${parts[1]}") first — ` +
      "the platform stamps the approval, and an approval that exists only in the chat does not exist."
    );
  }
  // Every other gate the manifest declares. gateCheck fires only where a later document
  // `requires` the gated one, so a gate on a document nothing requires is inert — sdlc-flow's
  // plan.md is `gate: true` and required by nothing. A gated document that was written must
  // be approved before the initiative closes.
  //
  // Written is the condition, so a gated document that does not exist is not required here at
  // all — that is `requiredForClose`'s business, below — which is why absence filters the
  // list rather than arriving as an unmet requirement.
  //
  // Stop outcomes are exempt, and the error names the exemption so it is a route rather than
  // a loophole.
  const written = chain.documents
    .filter((d) => d.gate && d.name !== parts[1])
    .map((d) => ({ name: d.name, file: join(root, parts[0], d.name) }))
    .filter((d) => existsSync(d.file));
  const gates = admitEntry(
    written.map((d) => ({ kind: d.name, standard: "ratified" })),
    written.map((d) => ({
      kind: d.name,
      standard: frontmatterStatus(d.file) === "approved" ? "ratified" : "recorded",
    })),
    stop ? written.map((d) => ({ kind: d.name, ground: STOPPED_GROUND })) : [],
  );
  if (!gates.admitted) {
    // `chain.documents` order in, the same order out, so the document named is the first the
    // manifest declares.
    const [unmet] = gates.unmet;
    return (
      `ERROR: ${parts[0]}/${unmet.kind} carries a gate this flow declares and is not ` +
      `approved, so this initiative cannot close as ${env.outcome}. Call ` +
      `document_approve("${parts[0]}/${unmet.kind}") once the stakeholder agrees — or, if the work ` +
      `stopped rather than finished, call initiative_close(initiative, "${OUTCOME_STOPPED}"), ` +
      "which says so in the team's ledger. A gate left open is not a gate passed."
    );
  }
  // Required to finish, not required to stop. The loop above tells a caller with unmet gates
  // to close as stopped instead; refusing that same close for a missing document would leave
  // stopped work open in the ledger forever. A verification guide is what a finished build
  // owes its stakeholder, and an initiative that was dropped can only satisfy it by writing a
  // guide for a thing nobody built.
  //
  // Existence, not approval, which is what `recorded` says and why the two loops are separate
  // questions. A `requiredForClose` document written and left in draft satisfies this and is
  // judged — if it is gated — by the gates above.
  //
  // FR-58 (Task I-26): unlike `written` above — which is filtered to gates that exist, so a
  // not_applicable one is excluded from the REQUIRED side by construction — `closeRequires` is
  // required by name regardless of whether it was ever written. Without this filter, a
  // requiredForClose document the branch ruled out would be reported missing forever: it never
  // exists, and there is no other reason to hold it, on a branch where the contract itself
  // says it never applied.
  const requiredClose = chain.closeRequires.filter((need) =>
    documentApplies(chain.documents.find((d) => d.name === need) ?? { name: need }, facts) !== "not_applicable");
  const needed = admitEntry(
    requiredClose.map((need) => ({ kind: need, standard: "recorded" })),
    requiredClose
      .filter((need) => existsSync(join(root, parts[0], need)))
      .map((need) => ({ kind: need, standard: "recorded" })),
    stop ? requiredClose.map((need) => ({ kind: need, ground: STOPPED_GROUND })) : [],
  );
  if (!needed.admitted) {
    const [unmet] = needed.unmet;
    return (
      `ERROR: ${parts[0]}/${unmet.kind} does not exist — this flow's manifest requires it before the ` +
      `initiative can close as finished, under exactly that name. If the work STOPPED ` +
      `rather than finished, initiative_close(initiative, "${OUTCOME_STOPPED}") records that and does ` +
      "not ask for it — a document nobody wrote is not made true by the close needing one."
    );
  }
  return null;
}
/** An approved gated document changes through `document_revise`, or it does not change.
 *
 * `document_revise` bumps the version, returns the document to draft, clears the approval and
 * stores what caused the change. `document_write` and `document_patch` are refused here
 * rather than taught to imitate it, because a signature has to cover the bytes it signed.
 *
 * Gated documents only, and only while approved. A flow may mark an ungated document
 * `approved` as a working state, and editing that is ordinary work, as is editing a draft. */
function approvedDocumentGuard(chain: Chain, root: string, relPath: string,
                               via: string | null): string | null {
  if (via) return null;                       // document_approve(), initiative_close() and document_revise own their writes
  const parts = relPath.replace(/^\/+/, "").split("/");
  if (parts.length !== 2) return null;
  const f = join(root, parts[0], parts[1]);
  if (!existsSync(f) || frontmatterStatus(f) !== "approved") return null;
  // A signature on disk, not a line in a manifest. Testing the manifest's `gate` instead
  // would abstain for every document of a freeform initiative, where `document_approve`
  // accepts any document in the folder — so a freeform approved document could be patched
  // with the approver's name left standing on bytes they never read.
  //
  // For a governed chain the two tests agree: stampEnvelope writes a status only where a gate
  // is declared, and document_approve refuses a declared document that carries none.
  if (!parseEnvelope(readFileSync(f, "utf8")).approved_by) return null;
  const gated = chain.documents.some((d) => d.name === parts[1] && d.gate);
  return (
    `ERROR: ${relPath} is approved${gated ? " and carries a gate" : ""}, so it changes through ` +
    `document_revise(path: "${relPath}", content: …) — not document_write or document_patch. ` +
    "That call bumps the version, returns the document to draft, clears the approval and " +
    "keeps the approved copy in _versions/. Writing over it here would leave the approver's " +
    "name standing on bytes they never read. If somebody's words are what changed it, pass " +
    "them as `source_content` in the same call and the record explains itself."
  );
}
/** A document an initiative closed on changes only through `document_revise`.
 *
 * Its own guard, because neither of the other two covers it. `ownershipCheck` passes: the
 * envelope is carried forward, so `outcome` matches. `approvedDocumentGuard` abstains: an
 * abandoned close lands on the furthest document that exists, which on sdlc-flow is usually
 * the ungated `explore.md`, approved by nobody.
 *
 * `document_revise` freezes the signed text, bumps the version, carries the outcome forward
 * and requires a source or `source_content`; `document_write` does none of that. A closed
 * record may be corrected, and a correction says what caused it. */
function closedDocumentGuard(root: string, relPath: string, via: string | null): string | null {
  if (via) return null;                       // initiative_close and document_revise own their writes
  const parts = relPath.replace(/^\/+/, "").split("/");
  if (parts.length !== 2) return null;
  const f = join(root, parts[0], parts[1]);
  if (!existsSync(f)) return null;
  const outcome = parseEnvelope(readFileSync(f, "utf8")).outcome;
  if (!outcome) return null;
  return (
    `ERROR: ${relPath} is the document this initiative CLOSED on (outcome: ${outcome}), so it ` +
    `changes through document_revise(path: "${relPath}", content: …) — not document_write or ` +
    "document_patch. The close itself is untouched either way: the platform carries the " +
    "outcome forward and the ledger row stands. What document_revise adds is the part that " +
    "matters here — it " +
    "freezes the text somebody signed in _versions/, bumps the version, and requires you to " +
    "say what caused the change, as `sources` or `source_content`. A closed record may be " +
    "corrected; it may not be quietly overwritten."
  );
}
/** Whether a closed initiative has settled its prerequisite, whichever document it landed on.
 *
 * handover.md requires review.md, and an initiative abandoned at the plan stage has no
 * review.md and never will — initiative_close records the outcome on the furthest document
 * the work reached. An outcome anywhere in the folder is the proof: it is written by
 * initiative_close and by nothing else, and a close asserts exactly what the prerequisite
 * exists to establish. The narrower rule still applies to every open initiative.
 *
 * It reads the folder, so it is called only where the prerequisite is absent. An initiative
 * whose folder does not exist raises rather than being reported closed. */
function closedOnSomeDocument(root: string, initiative: string): boolean {
  return readdirSync(join(root, initiative))
    .some((f: string) => f.endsWith(".md") &&
                 !!parseEnvelope(readFileSync(join(root, initiative, f), "utf8")).outcome);
}
/** May this document be written at all, given the branch the initiative is on (FR-58, Task
 *  I-26) — distinct from `gateCheck` below, which asks whether an EARLIER document's gate has
 *  passed. A document with no `when` is unaffected: this returns null for it, the same silence
 *  it has always gotten.
 *
 *  `not_applicable`: the branch has ruled this document out, and a document ruled out is never
 *  written — there is nothing to revise it into either, so this refuses `document_revise` the
 *  same as `document_write`.
 *  `undetermined`: the branch has not resolved yet; the contract calls this "not writable yet",
 *  not a refusal about approval or ownership. */
function applicabilityCheck(chain: Chain, root: string, relPath: string): string | null {
  const parts = relPath.replace(/^\/+/, "").split("/");
  if (parts.length !== 2) return null;
  const doc = chain.documents.find((d) => d.name === parts[1]);
  if (!doc?.when) return null;
  const facts = factsFor(root, parts[0]);
  const applic = documentApplies(doc, facts);
  if (applic === "applies") return null;
  if (applic === "not_applicable") {
    return (
      `ERROR: ${parts[1]} does not apply on this branch — its \`when\` (${JSON.stringify(doc.when)}) ` +
      `does not match the facts recorded in _facts.json (${JSON.stringify(facts)}). A document a ` +
      "branch rules out is never written, on this branch."
    );
  }
  const missing = Object.keys(doc.when).filter((f) => !facts[f]);
  return (
    `ERROR: ${parts[1]} is not writable yet — its \`when\` names ${missing.join(", ")}, and ` +
    `_facts.json does not record ${missing.length === 1 ? "it" : "them"} yet, so the platform ` +
    `cannot say whether ${parts[1]} applies. Run the stage that decides the branch first.`
  );
}
/** May this document be written, given what the document before it has reached.
 *
 * COUPLED: the decision is `admitEntry`'s, from @zz/contracts — a requirement is met when
 * what is held reaches the standard demanded, or discharged on a named ground — and the
 * stage controller applies that same rule to a step's entry evidence.
 *
 * What stays here is what the kernel must not know: that a prerequisite is a file, that
 * `gate: true` is what ratifies one, and what to tell an agent that has been refused. */
function gateCheck(chain: Chain, root: string, relPath: string): string | null {
  const clean = relPath.replace(/^\/+/, "");
  const parts = clean.split("/");
  if (parts.length !== 2) return null;
  const dep = chain.requires[parts[1]];
  if (!dep) return null;
  // FR-58 (Task I-26): a dependency the branch has ruled out is discharged, not missing — the
  // ground below is what lets a document downstream of a not_applicable one still be written.
  const depDoc = chain.documents.find((d) => d.name === dep);
  const depApplic = depDoc?.when ? documentApplies(depDoc, factsFor(root, parts[0])) : "applies";
  // A non-gated prerequisite is satisfied by existing. `gate: false` says no approval is
  // required, so nothing ever approves such a document and its status stays `draft` for the
  // life of the initiative — demanding `approved` here would make the next document
  // permanently unwritable. sdlc-flow is that shape: explore.md is ungated and spec.md
  // requires it.
  //
  // COUPLED: initiative_status' next-move search applies the same rule — `requires` means
  // settled first, and what settles a document is approval when it is gated and existence
  // when it is not. The kernel states it as `EvidenceStandard`: a gated prerequisite is
  // required `ratified`, an ungated one `recorded`.
  const depGate = chain.documents.find((d) => d.name === dep)?.gate === true;
  const depFile = join(root, parts[0], dep);
  const exists = existsSync(depFile);
  const status = exists ? frontmatterStatus(depFile) : null;
  const admission = admitEntry(
    [{ kind: dep, standard: depGate ? "ratified" : "recorded" }],
    // A document that exists is recorded; one carrying a recorded approval is ratified. What
    // is held is stated as it stands and never trimmed to what is demanded — an ungated
    // prerequisite that somehow carries `status: approved` is reported as ratified.
    exists ? [{ kind: dep, standard: status === "approved" ? "ratified" : "recorded" }] : [],
    // The ground, and only where the document is absent. A close settles a prerequisite
    // nobody will now write; it says nothing about one written and left in draft, and
    // discharging that too would let a closed initiative write over a gate a person was
    // still owed a say in.
    [
      ...(!exists && closedOnSomeDocument(root, parts[0])
        ? [{ kind: dep, ground: `this initiative is closed, and the close settled ${dep} by landing its outcome elsewhere` }]
        : []),
      // FR-58 (Task I-26): a dependency the branch has ruled out is never going to exist, on
      // this branch — without this ground every document downstream of it would be
      // permanently unwritable, on the one branch where the contract says it never applied.
      ...(depApplic === "not_applicable"
        ? [{ kind: dep, ground: `${dep} does not apply on this branch (\`when\`: ${JSON.stringify(depDoc!.when)})` }]
        : []),
    ],
  );
  if (admission.admitted) return null;
  // One requirement went in, so at most one comes back. Absent and unratified are the two
  // situations the refusal has to tell apart, and `held` is what tells them apart.
  const [unmet] = admission.unmet;
  if (unmet.held === null) {
    return `ERROR: ${parts[0]}/${dep} does not exist yet — the flow writes it first, and its gate must pass before ${parts[1]} is written.`;
  }
  return (
    `ERROR: ${parts[0]}/${dep} is status: ${status ?? "missing"} — its approval gate has not been recorded. ` +
    `Once the stakeholder agrees, call document_approve("${parts[0]}/${dep}") in that same turn; the platform ` +
    `stamps the approval from who you are and what time it is, and a hand-written one is refused. ` +
    `Only then can ${parts[1]} be written. An approval that exists only in the chat does not exist.`
  );
}
/** The fields the platform owns — PLATFORM_OWNED, from @zz/contracts. Writing any of them
 * by hand is refused.
 *
 * DELIBERATE: the count is not written here. A number in prose beside a list in code stops
 * being true without anything failing.
 *
 * `document_approve()` and `initiative_close()` stamp these fields from the session and the
 * clock, and pass `via` to say so. document_write, document_patch and document_revise reach
 * this function with `via` unset and are refused the moment they introduce or change one.
 *
 * Change is the test, not presence: re-sending an unchanged approval line while patching a
 * typo is not an attempt to forge one, and comparing against disk is what tells those
 * apart. */
function ownershipCheck(root: string, relPath: string, content: string,
                        via: string | null): string | null {
  if (via) return null;
  const parts = relPath.replace(/^\/+/, "").split("/");
  if (parts.length !== 2) return null;
  let prev: Record<string, string> = {};
  try {
    const f = join(root, parts[0], parts[1]);
    if (existsSync(f)) prev = parseEnvelope(readFileSync(f, "utf8"));
  } catch { /* unreadable: treat as new, which is the stricter reading */ }
  const next = parseEnvelope(content);
  for (const field of PLATFORM_OWNED) {
    const a = (prev[field] ?? "").trim();
    const b = (next[field] ?? "").trim();
    if (a === b) continue;
    return (
      `ERROR: ${field} is written by the platform, not by hand — this write would ` +
      (a ? `change it from \`${a}\` to \`${b || "(removed)"}\`` : `set it to \`${b}\``) + ". " +
      (field === "outcome" || field === "closed_by"
        ? "Use `initiative_close(initiative, disposition)`: you say finished or abandoned and who accepted it, and the outcome follows from that."
        // An approved document being rewritten needs document_revise, not document_approve:
        // the caller has already approved it, and what they are asking for is a new version.
        : a === "approved"
          ? "That document is approved. Use `document_revise(path, content, because|source)` to " +
            "supersede it — it opens a new version, records what caused it, and returns the " +
            "document to draft so it can be approved again. `document_write` is for a document " +
            "nobody has approved yet."
          : "Use `document_approve(path)` the moment the person agrees: it stamps status, approved_by and approved_at from who you are and what time it is.") +
      " A field the platform can fill is never a field you should be asked to."
    );
  }
  return null;
}
/** Everything that must be true before a mutation is allowed, in one place.
 *
 * The symmetric half of persistDocument. Every write path runs every check: three of them are
 * inert for a revision — it forces `status: draft` and clears the approval and the outcome,
 * so statusCheck, attributionCheck and closeCheck have nothing to fire on — and running them
 * anyway costs nothing and removes the judgement call.
 *
 * DELIBERATE: the count of checks is not written down; a number in prose outlives the list
 * beside it.
 *
 * `initiativeNameTaken` is not here: it is about creating a name, not about the content of a
 * write, and only `initiative_open` creates. */
export function documentGuards(chain: Chain, root: string, relPath: string, content: string,
                        team: string | null, via: string | null = null): string | null {
  return ownershipCheck(root, relPath, content, via)
    ?? closedDocumentGuard(root, relPath, via)
    ?? approvedDocumentGuard(chain, root, relPath, via)
    ?? applicabilityCheck(chain, root, relPath)
    ?? gateCheck(chain, root, relPath)
    ?? closeCheck(chain, root, relPath, content)
    ?? statusCheck(chain, relPath, content)
    ?? outcomeCheck(chain, relPath, content)
    ?? attributionCheck(chain, relPath, content, team)
    ?? sectionCheck(chain, relPath, content);
}
