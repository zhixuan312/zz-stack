/**
 * What refuses a write, and why each refusal exists.
 *
 * `documentGuards` is the one entry point: every write path calls it and none of them
 * decides for itself. The checks under it are separate functions because each answers a
 * different question — is this initiative closed, does its flow declare this document, is
 * the gate above it recorded, is this name already taken, does the caller own it.
 *
 * EVERY ONE OF THEM RETURNS A SENTENCE, never a boolean. A guard that answers false leaves
 * the caller to guess which rule they broke, and an agent that has to guess writes the same
 * document again with a different mistake in it.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { admitEntry, OUTCOME_STOPPED, parseEnvelope, PLATFORM_OWNED } from "@zz/contracts";

import { frontmatterStatus } from "./chain.js";
import { attributionCheck, type Chain, outcomeCheck, sectionCheck, statusCheck } from "./write-guards.js";

/** WHY A STOP DISCHARGES A CLOSE-TIME REQUIREMENT, written once because two rules claim it.
 *
 * An initiative that was dropped is precisely one whose gates were never passed, so requiring
 * them at close would leave two options — approve a plan nobody agreed to, or leave the
 * initiative open forever, which is the very state the close rules were written to end. The
 * same argument covers a `requiredForClose` document: a verification guide is what a FINISHED
 * build owes its stakeholder, and demanding one from work that stopped can only be satisfied
 * by writing a guide for a thing nobody built — the fabrication the rule exists to prevent.
 * Those two used to be a bare `if` round each loop, which is an exemption with nowhere to say
 * why it applied; as a ground it is carried on the admission that granted it.
 *
 * It is NOT a general amnesty. The closing document's own gate is asked without it, and the
 * word costs an outcome the ledger then carries in public — so an agent that takes this route
 * has said out loud that the work stopped. */
const STOPPED_GROUND =
  `the work stopped rather than finished, and closing it as ${OUTCOME_STOPPED} records that in the team's ledger`;
/** Closing an initiative (writing `outcome:` into the manifest's closing
 * document) requires every document the manifest marks `requiredForClose`. */
function closeCheck(chain: Chain, root: string, relPath: string, content: string): string | null {
  const parts = relPath.replace(/^\/+/, "").split("/");
  if (parts.length !== 2 || parts[1] !== chain.closingDoc) return null;
  if (!parseEnvelope(content).outcome) return null;
  // The closing document's OWN gate, when it declares one. gateCheck enforces a gate only
  // where another document `requires` it, so the LAST gated document in a chain — which is
  // usually the closing one — had its gate enforced by nothing at all. zz-flow-builder's spec
  // is exactly that shape: gated, closing, required by nothing, so `outcome: accepted` could
  // be written into a draft. ops-flow escapes it only transitively, because guide.md requires
  // an approved plan which requires an approved spec.
  // `outcome: accepted` is a claim about what a PERSON said, and it was the only such claim
  // on the platform with no field to hold who said it. Approvals carry approved_by; acceptance
  // carried a date and nothing else, so closeCheck could not tell a stakeholder's verdict from
  // an agent's own summary of one.
  //
  // It is not hypothetical. The first live smoke run closed an initiative with
  // `outcome: accepted` and a ledger row while the scripted stakeholder — which answers gates
  // with "approved" and questions with "your recommendation" — had never accepted anything.
  // Naming who accepted is what makes the sentence checkable.
  const env = parseEnvelope(content);
  // The close is an ACT, and its fields are stamped by that act — never typed here.
  //
  // Requiring a name whenever `outcome` was present was the first repair, and it removed the
  // cheaper branch. It also demanded `accepted_by` on an abandoned initiative, where the field
  // is the wrong noun: nobody accepted anything, somebody decided to stop. Naming a field
  // wrongly is how the next reader learns the wrong model.
  //
  // So the guard inverts. `initiative_close()` takes what the caller KNOWS — finished or abandoned, and
  // who accepted it if anyone did — and the platform DERIVES the outcome from that. There is
  // no branch in which one field is required because another holds a particular value,
  // because there is no validation left to branch on: a fact you derive cannot be forged by
  // choosing the cheaper word.
  //
  // The original defect stands behind all of it: the first live smoke run closed an initiative
  // with `outcome: accepted` while the scripted stakeholder — which answers gates with
  // "approved" and questions with "your recommendation" — had never accepted anything.
  if (!env.closed_by) {
    return (
      `ERROR: ${parts[1]} carries outcome: ${env.outcome} but no closed_by, so it was written ` +
      "by hand rather than recorded by an act. Use `initiative_close(initiative, disposition)` — the " +
      "platform derives the outcome from what you tell it and stamps who closed it. " +
      "`disposition: finished` with an `accepted_by` records an acceptance; without one it " +
      "records a delivery and asks why nobody signed off; `abandoned` says the work stopped."
    );
  }
  // THE SAME RULE AS gateCheck's, ASKED THREE TIMES. Each of the three questions below is
  // "does what is recorded reach the standard this close demands, or is it discharged on a
  // named ground" — the rule `admitEntry` holds. It used to be written out three more times
  // here, once per question, with the stop exemption as a bare `if` wrapped round two of the
  // loops; the platform then had four copies of one rule in one file, and the only thing
  // keeping them in agreement was that nobody had edited three of them lately.
  //
  // THREE CALLS AND NOT ONE, and the reason is load-bearing. On both flows this platform runs
  // the closing document is ALSO `requiredForClose` — review.md on sdlc-flow, findings.md on
  // zz-plugin-eval — so a single requirement list would name that document twice, once at
  // `ratified` from the text being written and once at `recorded` from the copy on disk.
  // `admitEntry` takes the strongest holding of a kind, so the disk copy would answer for the
  // text, and a closing document approved yesterday would close on an unapproved draft today.
  // Three questions are three calls.
  const stop = env.outcome === OUTCOME_STOPPED;
  const self = chain.documents.find((d) => d.name === parts[1]);
  // Judged from `content` — the text being written — and never from the copy on disk, which is
  // the version this write supersedes. NO WAIVER: a stop does not discharge this one, and the
  // loop below says why the other two are different.
  const own = admitEntry(
    self?.gate ? [{ kind: parts[1], standard: "ratified" }] : [],
    [{ kind: parts[1], standard: parseEnvelope(content).status === "approved" ? "ratified" : "recorded" }],
    [],
  );
  if (!own.admitted) {
    return (
      `ERROR: ${parts[1]} is this flow's closing document AND carries a gate, so it cannot be ` +
      `closed while its own approval is unrecorded. Call document_approve("${parts[0]}/${parts[1]}") first — ` +
      "the platform stamps the approval, and an approval that exists only in the chat does not exist."
    );
  }
  // Every OTHER gate the manifest declares. gateCheck fires only where a later document
  // `requires` the gated one, so a gate on a document nothing requires is inert — and the
  // closing document's own gate, handled just above, was only the most visible case.
  // sdlc-flow has the other one live: plan.md is `gate: true` and no document requires it,
  // so its approval was declared discipline that no code applied. Rather than adding a
  // `requires` edge to one manifest, close the class: a gated document that was written
  // must be approved before the initiative closes. Written is the condition — a gated
  // document that does not exist is `requiredForClose`'s business, not this check's.
  //
  // STOP OUTCOMES ARE EXEMPT, and they have to be. An initiative that was dropped is
  // precisely one whose gates were never passed, so requiring them here would leave two
  // options — approve a plan nobody agreed to, or leave the initiative open forever, which
  // is the very state this check was written to end. Naming the exemption in the error is
  // what makes it a route rather than a loophole: it costs an outcome word that the ledger
  // then carries in public, so an agent that takes it has said out loud that the work
  // stopped.
  //
  // WRITTEN is the condition, so a gated document that does not exist is not required here at
  // all — it is `requiredForClose`'s business, below — and that is why absence filters the
  // list rather than arriving as an unmet requirement.
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
    // manifest declares — which is the one the old loop reported.
    const [unmet] = gates.unmet;
    return (
      `ERROR: ${parts[0]}/${unmet.kind} carries a gate this flow declares and is not ` +
      `approved, so this initiative cannot close as ${env.outcome}. Call ` +
      `document_approve("${parts[0]}/${unmet.kind}") once the stakeholder agrees — or, if the work ` +
      `stopped rather than finished, call initiative_close(initiative, "${OUTCOME_STOPPED}"), ` +
      "which says so in the team's ledger. A gate left open is not a gate passed."
    );
  }
  // REQUIRED TO FINISH, NOT REQUIRED TO STOP. The loop above exempts stopped work from its
  // gates and tells the caller, in as many words, to close it as stopped instead. This loop
  // then refused that same close for a missing document — so the escape the platform offered
  // led straight into a wall, and work that stopped could not be recorded as stopped at all.
  // It stayed open in the ledger for ever, which is the one thing the ledger must not do.
  //
  // A verification guide is what a FINISHED build owes its stakeholder. An initiative that
  // was dropped never got that far by definition, and demanding it can only be satisfied by
  // writing a guide for a thing nobody built — the fabrication this rule exists to prevent.
  //
  // EXISTENCE, NOT APPROVAL, which is what `recorded` says and why the two loops are separate
  // questions rather than one stricter one. A `requiredForClose` document that was written and
  // left in draft satisfies this and is judged — if it is gated — by the gates above.
  const needed = admitEntry(
    chain.closeRequires.map((need) => ({ kind: need, standard: "recorded" })),
    chain.closeRequires
      .filter((need) => existsSync(join(root, parts[0], need)))
      .map((need) => ({ kind: need, standard: "recorded" })),
    stop ? chain.closeRequires.map((need) => ({ kind: need, ground: STOPPED_GROUND })) : [],
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
// `flowDeclarationCheck` and `initiativeNameTaken` were here, and both went with the
// creation guards when `initiative_open` took over creating. Each asked a question about an
// initiative COMING INTO EXISTENCE — is a flow declared, is this name already somebody's —
// on a path that could not tell a creating write from any other, so both ran on every write
// of every document and could only fire once the document had already been composed.
// Opening asks each of them once, before there is a folder, where the answer can still be
// acted on. Neither is kept as a second line of defence: a guard on a path that no longer
// creates is a rule two places can disagree about, which is the failure documentGuards'
// own header comment exists to name.
/** An approved gated document changes through `document_revise`, or it does not change.
 *
 * There were two paths and they disagreed. `document_revise` bumps the version, returns the
 * document to draft, clears the approval and stores what caused the change. `document_patch` ran
 * the same content guards and then simply wrote, leaving `status: approved` and the signature
 * standing over bytes the approver never read — and `document_write` did the same. So the rule
 * "never overwrite an approved document" was prose in zz-platform that nothing enforced, and
 * the cheaper path was the one that skipped the record.
 *
 * A signature has to cover the bytes it signed. `approved_by: X` on a document X never saw is
 * a false statement, and no judgement about whether an edit was "small enough" can make it a
 * true one — that judgement is exactly what a model must not be given.
 *
 * So the second path is refused rather than taught to imitate the first. Teaching it to reset
 * the status would be a second, partial copy of document_revise, and the whole reason this
 * platform has acts is that there is one way to do each thing.
 *
 * GATED documents only, and only while APPROVED. A flow may mark an ungated document
 * `approved` as a working state — ops-flow's selection.md does — and editing that is ordinary
 * work. Drafts are ordinary work too: this is how a spec is written, one section at a time. */
function approvedDocumentGuard(chain: Chain, root: string, relPath: string,
                               via: string | null): string | null {
  if (via) return null;                       // document_approve(), initiative_close() and document_revise own their writes
  const parts = relPath.replace(/^\/+/, "").split("/");
  if (parts.length !== 2) return null;
  const f = join(root, parts[0], parts[1]);
  if (!existsSync(f) || frontmatterStatus(f) !== "approved") return null;
  // A SIGNATURE ON DISK, NOT A LINE IN A MANIFEST.
  //
  // This required `chain.documents.some(d => d.name === parts[1] && d.gate)`, so it abstained
  // for every document of a FREEFORM initiative — where `document_approve` deliberately
  // accepts any document in the folder, because "a gate is a person saying yes, not a
  // manifest". Approve a freeform decision.md, then patch a paragraph of it: ownershipCheck
  // sees no envelope change, this guard sees no manifest, and the approver's name is left
  // standing on bytes they never read, which is the one thing this function exists to stop.
  //
  // The narrowing it replaces was written for a different platform: an ungated document
  // "marked approved as a working state" cannot exist any more — stampEnvelope writes a
  // status only where a gate is declared, and document_approve refuses a declared document
  // that carries none — so for a governed chain this reads exactly as the old test did. What
  // changes is the case the old test could not see.
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
/** A document an initiative CLOSED ON changes only through `document_revise`.
 *
 * WHY IT IS ITS OWN GUARD. `ownershipCheck` used to refuse this by accident: `document_write`
 * built a fresh envelope with no `outcome`, and removing a platform-owned field is refused —
 * so the rule held for a reason that had nothing to do with closing. The envelope is now
 * carried forward (a gated DRAFT has to be rewritable), `outcome` matches, and that accident
 * is gone. `approvedDocumentGuard` does not cover the gap: an ABANDONED close lands on the
 * furthest document that exists, which on sdlc-flow is usually the ungated `explore.md` —
 * approved by nobody, so that guard abstains.
 *
 * What is left is the rule the platform actually means: a closed record may be corrected, and
 * a correction says what caused it. `document_revise` freezes the signed text, bumps the
 * version, carries the outcome forward and REQUIRES a source or `source_content`;
 * `document_write` does none of that. A document does not change without evidence. */
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
/** A CLOSED INITIATIVE HAS SETTLED ITS PREREQUISITE, WHICHEVER DOCUMENT IT LANDED ON.
 *
 * handover.md requires review.md, and an initiative ABANDONED at the plan stage has no
 * review.md and never will — initiative_close already knows that and records the outcome on
 * the furthest document the work reached. So the chain demanded a document the close had
 * deliberately skipped, and `initiative_status` went on answering `action: "handover"`
 * forever: the platform instructing an act its own gate refuses. That is the same shape as
 * the close-with-no-documents trap fixed in 0.54.1, one document further along.
 *
 * An outcome ANYWHERE in the folder is the proof. It is written by initiative_close and by
 * nothing else, the ledger row is already appended, and what the prerequisite exists to
 * establish — that the work before this document is settled — is exactly what a close
 * asserts. The narrower rule still applies to every OPEN initiative, which is all of them
 * until somebody closes one.
 *
 * It reads the folder, so it is called ONLY where the prerequisite is absent — there is no
 * second reading of every document in an initiative on the ordinary path, and an initiative
 * whose folder does not exist raises rather than being reported closed. */
function closedOnSomeDocument(root: string, initiative: string): boolean {
  return readdirSync(join(root, initiative))
    .some((f: string) => f.endsWith(".md") &&
                 !!parseEnvelope(readFileSync(join(root, initiative, f), "utf8")).outcome);
}
/** May this document be written, given what the document before it has reached.
 *
 * THE DECISION IS `admitEntry`'s, from @zz/contracts, and the sentence is this function's. The
 * rule — a requirement is met when what is held reaches the standard demanded, or discharged
 * on a named ground — is the same rule the stage controller applies to a step's entry
 * evidence, and it was written twice: once there over evidence kinds, once here over a
 * document's prerequisite. Two copies of "may this be entered, given what has been recorded"
 * is one copy more than the platform can keep in agreement, and the half nobody was reading
 * would be the half that drifted.
 *
 * What stays here is what the kernel must not know: that a prerequisite is a FILE, that
 * `gate: true` is what ratifies one, and what to tell an agent that has been refused. */
function gateCheck(chain: Chain, root: string, relPath: string): string | null {
  const clean = relPath.replace(/^\/+/, "");
  const parts = clean.split("/");
  if (parts.length !== 2) return null;
  const dep = chain.requires[parts[1]];
  if (!dep) return null;
  // A NON-GATED PREREQUISITE IS SATISFIED BY EXISTING. `gate: false` says no approval is
  // required, so nothing ever approves such a document and its status stays `draft` for the
  // life of the initiative — demanding `approved` here makes the next document permanently
  // unwritable. sdlc-flow is exactly that shape (explore.md is role `ground`, ungated, and
  // spec.md requires it), and this refused the spec write on the very run that found it.
  //
  // The same mistake lived in initiative_status' next-move search, fixed in 0.16.2. The two
  // must agree: one told the agent to write spec.md while the other refused the write, which
  // is worse than either being wrong alone. `requires` means "settled first", and what
  // settles a document is approval when it is gated and existence when it is not.
  //
  // That sentence is now the kernel's `EvidenceStandard`: a gated prerequisite is required
  // `ratified` and an ungated one `recorded`, and the comparison is made there rather than by
  // an early return here.
  const depGate = chain.documents.find((d) => d.name === dep)?.gate === true;
  const depFile = join(root, parts[0], dep);
  const exists = existsSync(depFile);
  const status = exists ? frontmatterStatus(depFile) : null;
  const admission = admitEntry(
    [{ kind: dep, standard: depGate ? "ratified" : "recorded" }],
    // A document that EXISTS is recorded; one carrying a recorded approval is ratified. What
    // is held is stated as it stands and never trimmed to what is demanded — an ungated
    // prerequisite that somehow carries `status: approved` is reported as ratified, because
    // that is what is true of it, and the requirement it meets is a separate question.
    exists ? [{ kind: dep, standard: status === "approved" ? "ratified" : "recorded" }] : [],
    // THE GROUND, AND ONLY WHERE THE DOCUMENT IS ABSENT. A close settles a prerequisite
    // nobody will now write; it says nothing about one that was written and left in draft,
    // and discharging that too would let a closed initiative write over a gate that a person
    // was still owed a say in.
    !exists && closedOnSomeDocument(root, parts[0])
      ? [{ kind: dep, ground: `this initiative is closed, and the close settled ${dep} by landing its outcome elsewhere` }]
      : [],
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
 * The count is not written here. It said "four" while the set held five, which is the same
 * drift the outcome refusal had when it said "a fifth word" for a vocabulary of three: a
 * number in prose beside a list in code is a number that stops being true without anything
 * failing.
 *
 * Of 93 approved documents on this deployment, 4 carried no `approved_at` and 2 no
 * `approved_by` — one of each written by an agent that had just passed a gate. Two
 * consecutive smoke runs put a team slug in the approver. Every one of those is a model
 * typing a field the platform already knew the answer to, and no amount of prose in a skill
 * makes a model reliably type a date it can only guess.
 *
 * So the fields stop being writable. `document_approve()` and `initiative_close()` stamp them from the session
 * and the clock, and they pass `via` to say so. Everything else that touches a document —
 * document_write, document_patch, document_revise — reaches this function with `via` unset, and is
 * refused the moment it tries to introduce or change any of them.
 *
 * CHANGE is the test, not presence: a document that already carries an approval is patched
 * for a typo in its body every day, and re-sending the same approval line unchanged is not
 * an attempt to forge one. Comparing against what is on disk is what tells those apart. */
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
        // AN APPROVED DOCUMENT BEING REWRITTEN NEEDS document_revise, NOT document_approve.
        // This said "use document_approve the moment the person agrees" whatever the caller
        // was doing — advice that is right for a draft and useless for the case that reaches
        // it most: somebody editing a document that was already approved. They HAVE approved
        // it; what they are asking for is a new version, and the tool for that is
        // document_revise, which keeps the approval history and records what caused the change.
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
/** Everything that must be true BEFORE a mutation is allowed, in one place.
 *
 * The symmetric half of persistDocument, and it exists for the same reason that one does.
 * These checks were listed at each call site instead, so every new write path started with
 * none of them and got whichever ones its author remembered: document_revise had zero, and
 * a selection document's required section could be deleted in a revision without a refusal.
 * Three of them are inert for a revision — it forces `status: draft` and clears the approval
 * and the outcome, so statusCheck, attributionCheck and closeCheck have nothing to fire on —
 * which is exactly why the gap read as harmless and stayed. Running them all everywhere costs
 * nothing and removes the judgement call.
 *
 * The count is deliberately not written down. It said "three of the five" while the chain
 * below runs eight, which is the third place in this file where a number in prose had
 * outlived the list beside it.
 *
 * `initiativeNameTaken` is not here: it is about creating a name, not about the content of a
 * write, and only one path creates. */
export function documentGuards(chain: Chain, root: string, relPath: string, content: string,
                        team: string | null, via: string | null = null): string | null {
  return ownershipCheck(root, relPath, content, via)
    ?? closedDocumentGuard(root, relPath, via)
    ?? approvedDocumentGuard(chain, root, relPath, via)
    ?? gateCheck(chain, root, relPath)
    ?? closeCheck(chain, root, relPath, content)
    ?? statusCheck(chain, relPath, content)
    ?? outcomeCheck(chain, relPath, content)
    ?? attributionCheck(chain, relPath, content, team)
    ?? sectionCheck(chain, relPath, content);
}
