/**
 * What refuses a write, and why each refusal exists.
 *
 * `documentGuards` is the one entry point: every write path calls it and none of them
 * decides for itself. The checks under it are separate functions because each answers a
 * different question — is this initiative closed, does its flow declare this document, is
 * the gate above it recorded, is this name already taken, does the caller own it, are the
 * blocks it selected ones the flow carries, is the vocabulary it used the platform's.
 *
 * EVERY ONE OF THEM RETURNS A SENTENCE, never a boolean. A guard that answers false leaves
 * the caller to guess which rule they broke, and an agent that has to guess writes the same
 * document again with a different mistake in it.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { documentBody, OUTCOME_STOPPED, parseCaller, parseEnvelope, PLATFORM_OWNED } from "@zz/contracts";
import { requestHeaders } from "@zz/mcp-http";

import { frontmatterStatus } from "./chain.js";
import { db } from "./platform-db.js";
import { governingFlows } from "./skill-roots.js";
import { attributionCheck, type Chain, outcomeCheck, sectionCheck, statusCheck } from "./write-guards.js";

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
  // So the guard inverts. `close()` takes what the caller KNOWS — finished or abandoned, and
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
      "by hand rather than recorded by an act. Use `close(initiative, disposition)` — the " +
      "platform derives the outcome from what you tell it and stamps who closed it. " +
      "`disposition: finished` with an `accepted_by` records an acceptance; without one it " +
      "records a delivery and asks why nobody signed off; `abandoned` says the work stopped."
    );
  }
  const self = chain.documents.find((d) => d.name === parts[1]);
  if (self?.gate && parseEnvelope(content).status !== "approved") {
    return (
      `ERROR: ${parts[1]} is this flow's closing document AND carries a gate, so it cannot be ` +
      `closed while its own approval is unrecorded. Call approve("${parts[0]}/${parts[1]}") first — ` +
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
  if (env.outcome !== OUTCOME_STOPPED) {
    for (const d of chain.documents) {
      if (!d.gate || d.name === parts[1]) continue;
      const f = join(root, parts[0], d.name);
      if (!existsSync(f)) continue;
      if (frontmatterStatus(f) !== "approved") {
        return (
          `ERROR: ${parts[0]}/${d.name} carries a gate this flow declares and is not ` +
          `approved, so this initiative cannot close as ${env.outcome}. Call ` +
          `approve("${parts[0]}/${d.name}") once the stakeholder agrees — or, if the work ` +
          `stopped rather than finished, call close(initiative, "${OUTCOME_STOPPED}"), ` +
          "which says so in the team's ledger. A gate left open is not a gate passed."
        );
      }
    }
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
  if (env.outcome !== OUTCOME_STOPPED) {
    for (const need of chain.closeRequires) {
      if (!existsSync(join(root, parts[0], need))) {
        return (
          `ERROR: ${parts[0]}/${need} does not exist — this flow's manifest requires it before the ` +
          `initiative can close as finished, under exactly that name. If the work STOPPED ` +
          `rather than finished, close(initiative, "${OUTCOME_STOPPED}") records that and does ` +
          "not ask for it — a document nobody wrote is not made true by the close needing one."
        );
      }
    }
  }
  return null;
}
/** An initiative nothing governs, on a team that runs more than one flow.
 *
 * zz-backbone has always said it: "`flow:` is the one that must be right. Write it on the
 * FIRST document — the platform stamps it onto later ones, but it can only stamp a flow it
 * has been told." It gets skipped, and when it does the platform enforces NOTHING on that
 * initiative — no gate, no required document, no closing rule — and says so only if someone
 * calls initiative_status and reads the answer. One such initiative is on this deployment
 * right now, with an approved intent and an approved spec, neither of which passed a gate.
 *
 * WHO IS ASKED is every team, now. It used to be only a team with two or more installs, on
 * the reasoning that one install answers for itself — but the platform flows ship to every
 * team without an install row, so "one install" never meant "one flow it can run". The teams
 * that reasoning excused are exactly the two it went wrong on: team-one, one install and a
 * zz-block-eval initiative governed by ops-flow throughout; zz-platform, no installs at all
 * and every eval it runs governed by nothing. governingFlows() is the corrected question.
 */
export async function flowDeclarationCheck(
  chain: Chain, relPath: string, team: string | null, content: string,
): Promise<string | null> {
  if (chain.name) return null;
  const parts = relPath.replace(/^\/+/, "").split("/");
  if (parts.length !== 2 || !parts[1].endsWith(".md")) return null;
  let flows: Set<string> | null;
  try {
    flows = await governingFlows(team);
  } catch {
    // NOT skipped. The platform stamps every later document's flow from the first one, so a
    // first document written with no `flow:` now is an initiative governed by nothing for as
    // long as it exists — and an outage is the worst moment to create one silently. Refusing
    // does not block the work: declaring the flow is one argument, and the caller knows which
    // flow they are running even when the registry cannot be asked.
    return parseEnvelope(content).flow
      ? null
      : "ERROR: the platform database is unreachable, so which flows your team runs cannot be " +
        "read — and an initiative that declares none is governed by nothing, permanently, " +
        "because the platform stamps every later document from the first. Write this document " +
        'again with `flow: "<name>"` as an argument to write_file and it will be accepted.';
  }
  if (!flows || flows.size < 2) return null;
  const declared = parseEnvelope(content).flow;
  const known = [...flows].sort().join(", ");
  // WHICH of the two ways a declared flow fails to govern. This function only runs when the
  // chain could not be resolved, and that has two causes: the name is not one the team
  // installed, or it IS installed and the catalog cannot produce its manifest — removed, or
  // refused by the schema. The message assumed the first and said "no flow named 'ops-flow'
  // is installed for your team. Installed: sdlc-flow, ops-flow", contradicting itself in the
  // same breath and sending the reader to install what they already have.
  if (declared && flows.has(declared.split("@")[0].trim())) {
    return (
      `ERROR: '${declared}' IS installed for your team, and the catalog cannot produce its ` +
      "manifest — it has been removed, or it no longer satisfies the manifest schema, and " +
      "either way nothing can say which gates apply here. This is a platform-side fault " +
      "rather than something to fix in this document: tell an admin, and check " +
      `/schemas/manifest.json against catalog/<owner>/${declared.split("@")[0].trim()}/flow.json.`
    );
  }
  return declared
    ? `ERROR: no flow named '${declared}' is installed for your team. Installed: ${known}. ` +
      "The flow's manifest is what says which gates apply, so a name nothing resolves leaves " +
      "this initiative governed by nothing."
    : "ERROR: this initiative declares no flow, and your team runs more than one " +
      `(${known}), so nothing can say which gates apply to it. Write the initiative's FIRST ` +
      `document again with \`flow: "<name>"\` as an argument to write_file — that argument is ` +
      "where the flow is declared, and the platform stamps every later document from it. " +
      "Until it is there, no gate, no required document and no closing rule is enforced here.";
}
/** A name already taken is a QUESTION, and the person answers it.
 *
 * The folder IS the initiative, and nothing stopped a second one landing in a folder that
 * already held work. Two people on a team can name the same work the same thing — likelier
 * than it sounds when the name comes from the date and the subject — and the failure was
 * silent: the opening document overwritten, two unrelated pieces of work interleaved under a
 * gate chain that made sense for neither.
 *
 * Both readings are legitimate and the store cannot tell them apart. Someone may be joining
 * work a colleague started, or starting their own and reaching for the obvious name. Guessing
 * either way is wrong in half the cases, and both wrong halves are expensive: silently merge
 * two initiatives, or silently split one a person meant to join.
 *
 * So this refuses, states who opened the existing one, and names both options concretely —
 * including the free index — for the person to choose between. The agent asks; it does not
 * decide. This is the same shape as every gate in this platform: the machine reports, and a
 * human moves it.
 *
 * Only the chain's FIRST document opens an initiative. Continuing one writes a LATER document
 * and never reaches here, so resumption across harnesses is untouched.
 *
 * And ITERATION is not a collision. An agent writes intent.md, the stakeholder asks for a
 * change, the agent writes it again — that is the flow working, and refusing it broke every
 * scenario on the first revision. So the question is not "does this document exist" but
 * "whose is it, and has it been agreed": your own draft is yours to rewrite. */
export function initiativeNameTaken(chain: Chain, root: string, relPath: string): string | null {
  const parts = relPath.replace(/^\/+/, "").split("/");
  if (parts.length < 2) return null;
  const initiative = parts[0];
  const first = chain.documents[0]?.name;
  if (!first || parts[parts.length - 1] !== first) return null;
  const existing = join(root, initiative, first);
  if (!existsSync(existing)) return null;                        // free: this IS the creation

  const me = parseCaller(requestHeaders()).email;
  let opener = "";
  try {
    for (const line of readFileSync(join(root, initiative, "activity.jsonl"), "utf8").split("\n")) {
      if (!line.trim()) continue;
      const e = JSON.parse(line) as { user?: string; path?: string };
      if (e.path && e.path.endsWith(first) && e.user) { opener = e.user.trim(); break; }
    }
  } catch { /* no readable activity log — fall through to the document's own state */ }

  // Yours, and not yet agreed: iteration. The commonest write in the whole flow.
  let settled = false;
  try {
    settled = parseEnvelope(readFileSync(existing, "utf8")).status === "approved";
  } catch { /* unreadable: treat as unsettled rather than block a repair */ }
  if (!settled) {
    try {
      const closing = join(root, initiative, chain.closingDoc);
      settled = existsSync(closing) && !!parseEnvelope(readFileSync(closing, "utf8")).outcome;
    } catch { /* same */ }
  }
  if (opener && opener === me && !settled) return null;

  let n = 2;
  while (existsSync(join(root, `${initiative}-${n}`, first))) n += 1;
  const free = `${initiative}-${n}`;

  // THREE cases, not two. This read "opened by X" or else "it is past its opening gate", and
  // the else is reached two ways: the document IS settled, or the activity log could not be
  // read and the opener is unknown. In the second, an unsettled draft was described as past a
  // gate it has not reached — a false statement in a refusal, which is the one place this
  // platform cannot afford one, because the reader acts on it.
  const whose = opener && opener !== me
    ? `, opened by ${opener}`
    : settled
      ? ", and it is past its opening gate"
      : ", and this store does not record who opened it";
  return `ERROR: '${initiative}' already holds an initiative${whose}. ` +
    `Two things could be meant here and it is THEIR call, not yours — ask, then act:\n\n` +
    `  CONTINUE it — this is the same work. Call initiative_status('${initiative}') and carry ` +
    `on from where it stands. Do not rewrite ${first}; the work already has one.\n` +
    `  NEW work    — it only shares a name. Write ${first} to '${free}' instead, which is free, ` +
    `and use that name for every later document.\n\n` +
    `Do not choose for them, and do not overwrite ${first} to find out.`;
}
/** An approved gated document changes through `revise_document`, or it does not change.
 *
 * There were two paths and they disagreed. `revise_document` bumps the version, returns the
 * document to draft, clears the approval and stores what caused the change. `patch_file` ran
 * the same content guards and then simply wrote, leaving `status: approved` and the signature
 * standing over bytes the approver never read — and `write_file` did the same. So the rule
 * "never overwrite an approved document" was prose in zz-backbone that nothing enforced, and
 * the cheaper path was the one that skipped the record.
 *
 * A signature has to cover the bytes it signed. `approved_by: X` on a document X never saw is
 * a false statement, and no judgement about whether an edit was "small enough" can make it a
 * true one — that judgement is exactly what a model must not be given.
 *
 * So the second path is refused rather than taught to imitate the first. Teaching it to reset
 * the status would be a second, partial copy of revise_document, and the whole reason this
 * platform has acts is that there is one way to do each thing.
 *
 * GATED documents only, and only while APPROVED. A flow may mark an ungated document
 * `approved` as a working state — ops-flow's selection.md does — and editing that is ordinary
 * work. Drafts are ordinary work too: this is how a spec is written, one section at a time. */
function approvedDocumentGuard(chain: Chain, root: string, relPath: string,
                               via: string | null): string | null {
  if (via) return null;                       // approve(), close() and revise_document own their writes
  const parts = relPath.replace(/^\/+/, "").split("/");
  if (parts.length !== 2) return null;
  if (!chain.documents.some((d) => d.name === parts[1] && d.gate)) return null;
  const f = join(root, parts[0], parts[1]);
  if (!existsSync(f) || frontmatterStatus(f) !== "approved") return null;
  return (
    `ERROR: ${relPath} is approved and carries a gate, so it changes through ` +
    `revise_document(path: "${relPath}", content: …) — not write_file or patch_file. ` +
    "That call bumps the version, returns the document to draft, clears the approval and " +
    "keeps the approved copy in _versions/. Writing over it here would leave the approver's " +
    "name standing on bytes they never read. If somebody's words are what changed it, pass " +
    "them as `source_content` in the same call and the record explains itself."
  );
}
function gateCheck(chain: Chain, root: string, relPath: string): string | null {
  const clean = relPath.replace(/^\/+/, "");
  const parts = clean.split("/");
  if (parts.length !== 2) return null;
  const dep = chain.requires[parts[1]];
  if (!dep) return null;
  const depFile = join(root, parts[0], dep);
  if (!existsSync(depFile)) {
    return `ERROR: ${parts[0]}/${dep} does not exist yet — the flow writes it first, and its gate must pass before ${parts[1]} is written.`;
  }
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
  const depGate = chain.documents.find((d) => d.name === dep)?.gate === true;
  if (!depGate) return null;
  const status = frontmatterStatus(depFile);
  if (status !== "approved") {
    return (
      `ERROR: ${parts[0]}/${dep} is status: ${status ?? "missing"} — its approval gate has not been recorded. ` +
      `Once the stakeholder agrees, call approve("${parts[0]}/${dep}") in that same turn; the platform ` +
      `stamps the approval from who you are and what time it is, and a hand-written one is refused. ` +
      `Only then can ${parts[1]} be written. An approval that exists only in the chat does not exist.`
    );
  }
  return null;
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
 * So the fields stop being writable. `approve()` and `close()` stamp them from the session
 * and the clock, and they pass `via` to say so. Everything else that touches a document —
 * write_file, patch_file, revise_document — reaches this function with `via` unset, and is
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
        ? "Use `close(initiative, disposition)`: you say finished or abandoned and who accepted it, and the outcome follows from that."
        : "Use `approve(path)` the moment the person agrees: it stamps status, approved_by and approved_at from who you are and what time it is.") +
      " A field the platform can fill is never a field you should be asked to."
    );
  }
  return null;
}
/** A SELECTION NAMES ITS BLOCKS, MACHINE-READABLY, AND THERE ARE FEW OF THEM.
 *
 * Two rules on one document, because they are the same rule seen from two sides: a selection
 * is a decision, and a decision that cannot be counted or read back is not one.
 *
 * `blocks:` in the frontmatter. The selection document argues its case at length — the live
 * one on this deployment names casebox in its heading and then names bookit and RuleMill in the
 * paragraphs REJECTING them — so nothing downstream can learn the answer by reading the
 * prose. A stage declaring `blocks: "selected"` resolves through this field, so without it
 * the flow's own authority declaration has nothing to resolve to.
 *
 * FIVE. The limit is a convention and it is stated so it can be argued with: past that,
 * every extra block is another seam, another credential, another team to ask, and this store
 * already records two initiatives that failed at a seam and nowhere else. A build that
 * genuinely needs more says so in the document and the person approving it sees the number.
 */
const MAX_SELECTED_BLOCKS = 5;
async function selectionCheck(chain: Chain, relPath: string, content: string): Promise<string | null> {
  const parts = relPath.replace(/^\/+/, "").split("/");
  if (parts.length !== 2) return null;
  if (chain.documents.find((d) => d.name === parts[1])?.role !== "selection") return null;
  const named = (parseEnvelope(content).blocks ?? "")
    .replace(/^\[|\]$/g, "").split(",").map((b) => b.trim().replace(/^["']|["']$/g, ""))
    .filter(Boolean);
  if (!named.length) {
    return (
      `ERROR: ${parts[1]} does not say which building blocks were chosen. Pass them as ` +
      "write_file's own `blocks` argument — `blocks: [\"casebox\"]` — and ONLY the ones being " +
      "built on, never the ones considered and rejected. It is an argument rather than one " +
      "of the flow's `fields` because the platform reads it: the stages after this one may " +
      "call these blocks and nothing else. The prose is for the reasoning; this is the " +
      "decision. block_skills() names the blocks you can reach."
    );
  }
  const known = await blockVocabulary();
  const names = new Set(known);
  const unknown = named.filter((b) => !names.has(b));
  if (unknown.length && known.length) {
    return (
      `ERROR: ${parts[1]} selects ${unknown.map((u) => `\`${u}\``).join(", ")}, which ` +
      "this platform does not route. `blocks` takes block ids as the gateway knows them — " +
      "the short name, not the product's title. block_skills() names the ones there are."
    );
  }
  if (named.length > MAX_SELECTED_BLOCKS) {
    return (
      `ERROR: ${parts[1]} selects ${named.length} building blocks and the limit is ` +
      `${MAX_SELECTED_BLOCKS}. Every additional block is another seam between systems, and ` +
      "the seam is where this platform's builds actually fail. Choose the smallest set that " +
      "meets the acceptance criteria, and say in the fit ledger what the ones you dropped " +
      "would have done."
    );
  }
  return null;
}
/** THE REGISTERED BLOCKS, name and title, cached.
 *
 * From zz.block, so there is no list to keep — the same registry the console reads and the
 * same one that would generate a shelf index. A hardcoded set here would go stale the day a
 * block is added, and it would go stale QUIETLY, which for a guard means it stops guarding
 * and nothing says so. */
let vocabulary: { words: string[]; at: number } = { words: [], at: 0 };
const VOCAB_TTL_MS = 300_000;
async function blockVocabulary(): Promise<string[]> {
  const now = Date.now();
  if (vocabulary.at && now - vocabulary.at < VOCAB_TTL_MS) return vocabulary.words;
  const p = db();
  if (!p) return vocabulary.words;
  try {
    const { rows } = await p.query<{ name: string; title: string }>(
      // NOT the platform's own block. `zz` is this platform, every flow uses it, and no
      // document is naming a technology by mentioning the place its own documents live.
      "select name, title from zz.block where origin <> 'platform'",
    );
    const words = new Set<string>();
    for (const r of rows) {
      if (r.name) words.add(r.name);
      // Titles of four characters or more. A person writing a spec does not write `casebox`, they
      // write "CaseBox" or "BookIt" — the product's name is how the technology
      // actually gets into a business document. Short titles are skipped because a two- or
      // three-letter word is a word, and refusing a spec for containing one would be a
      // guardrail people learn to write around.
      if (r.title && r.title.trim().length >= 4) words.add(r.title.trim());
    }
    vocabulary = { words: [...words], at: now };
  } catch {
    // Unreachable registry: keep whatever was last known rather than emptying the vocabulary.
    // An empty list silently disables the guard, and a guard that switches off during an
    // outage is one nobody can rely on having been applied.
  }
  return vocabulary.words;
}
/** A stage that may call no building block may not NAME one either.
 *
 * The rule is ops-intent's and ops-spec's, and both skills state it at length: "No technology
 * anywhere. No product names, no tool names." It stayed prose, and prose does not hold — the
 * same lesson attributionCheck records above, where a rule stated in every stage skill was
 * broken twice in consecutive smoke runs.
 *
 * Removing the TOOLS from a stage does not cover this. An agent at ops-spec has read the
 * intent and is writing a document; it can put a product name into spec.md without calling
 * anything at all. So the same declaration drives both: the manifest says which blocks a
 * stage may call, the gateway enforces the calling, and this enforces the naming.
 *
 * DERIVED, never a list of document names. Nothing here says "intent.md" or "spec.md" —
 * `stage` on the manifest's document says which stage writes it, and the stage says what it
 * may reach. selection.md, plan.md and the build are exempt automatically, because their
 * stages declare blocks: that is where technology belongs and the flow already said so.
 *
 * Measured before it shipped: of 136 intent and spec documents in the store, 2 named a
 * registered block. This is a backstop against drift, not a change of behaviour. */
async function vocabularyCheck(chain: Chain, relPath: string, content: string): Promise<string | null> {
  const parts = relPath.replace(/^\/+/, "").split("/");
  if (parts.length !== 2) return null;
  const stageName = chain.documents.find((d) => d.name === parts[1])?.stage;
  if (!stageName) return null;
  const declared = chain.stages.find((st) => st.name === stageName)?.blocks;
  // ONLY a stage that declares an empty list. `undefined` is a flow that has said nothing,
  // and "selected" is a stage that reaches blocks by definition.
  if (!Array.isArray(declared) || declared.length) return null;
  const words = await blockVocabulary();
  if (!words.length) return null;
  const body = documentBody(content);
  const found = words.filter((w) =>
    new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(body));
  if (!found.length) return null;
  return (
    `ERROR: ${parts[1]} names ${found.map((f) => `\`${f}\``).join(", ")}, and ${stageName} ` +
    "declares no building block. This stage writes what must be true, in the stakeholder's " +
    "own words, and no block has been chosen yet — naming one here decides the solution " +
    "before anybody agreed to it, and the document is read by somebody with no technical " +
    "background. Say what the system must DO. The block's name belongs in the selection " +
    "document, which is where the choice is made and recorded.\n\n" +
    "IF THE STAKEHOLDER SAID IT THEMSELVES, keep it without putting it here — their words " +
    "verbatim as a source, and `their current system` in the document. The quote stays " +
    "attributed and durable, the document stays one they can read, and somebody naming what " +
    "they have today is not the same as the work choosing what it will be built on.\n\n" +
    // THE WHOLE CALL, because the last refusal walked straight into the next one. A live run
    // followed this advice and passed `<initiative>/intent.md` to `supports`, which takes a
    // BARE document name — so the agent was refused twice for one mistake, and the second
    // refusal was caused by the first one's instruction being half a sentence short.
    `    add_source(initiative: "${parts[0]}", title: "<what they said, in a few words>",\n` +
    "               content: \"<their words, verbatim>\", supports: \"" + parts[1] + "\")\n\n" +
    "`supports` is the DOCUMENT NAME on its own — `" + parts[1] + "`, never " +
    `\`${parts[0]}/${parts[1]}\`. The initiative is already its own argument.`
  );
}
/** Everything that must be true BEFORE a mutation is allowed, in one place.
 *
 * The symmetric half of persistDocument, and it exists for the same reason that one does.
 * These checks were listed at each call site instead, so every new write path started with
 * none of them and got whichever ones its author remembered: revise_document had zero, and
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
export async function documentGuards(chain: Chain, root: string, relPath: string, content: string,
                              team: string | null, via: string | null = null): Promise<string | null> {
  return ownershipCheck(root, relPath, content, via)
    ?? approvedDocumentGuard(chain, root, relPath, via)
    ?? gateCheck(chain, root, relPath)
    ?? closeCheck(chain, root, relPath, content)
    ?? statusCheck(chain, relPath, content)
    ?? outcomeCheck(chain, relPath, content)
    ?? attributionCheck(chain, relPath, content, team)
    ?? sectionCheck(chain, relPath, content)
    // AWAITED, both of them. An async function returns a Promise, and a Promise is never
    // null — so `?? selectionCheck(...)` ended the `??` chain at the first async guard and
    // everything after it was dead code. The outer await then resolved that Promise to null
    // for any document that was not a selection, so every write passed and nothing failed:
    // the two guards below this line were deployed, exercised, and silently absent.
    ?? await selectionCheck(chain, relPath, content)
    ?? await vocabularyCheck(chain, relPath, content);
}
