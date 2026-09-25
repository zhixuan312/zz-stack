/**
 * The acts: approving a document and revising an approved one. Opening and closing an
 * initiative are their own files, registered from here so the acts stay one registration.
 *
 * An act is the only thing that may move the fields the platform owns. `status`,
 * `approved_by`, `approved_at`, `outcome` and `closed_by` are stamped from the session and the
 * clock, and every write path refuses them typed by a caller. `document_approve`,
 * `document_revise` and `initiative_close` are the exceptions, and there is no fourth.
 *
 * `document_revise` exists because an approved document cannot be written over: the
 * approver's name would stand on bytes they never read. It bumps the version, returns the
 * document to draft, clears the stale approval and keeps the approved copy in `_versions/`.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { documentBody, parseCaller, parseEnvelope } from "@zz/contracts";
import { indexDoc } from "@zz/indexing";
import { requestHeaders, text } from "@zz/mcp-http";
import { z } from "zod";

import { shownSinceLastChange } from "../attest.js";
import { chainFor } from "../chain.js";
import { fieldRefusal, frontmatterRefusal, oneLine, renderEnvelope } from "../document-rules.js";
import { documentGuards } from "../guards.js";
import { noteDocument, noteRevision } from "../host/observe.js";
import { sourceDocument } from "../indexing.js";
import { DOC_REF, safePath, tagRefusal, titleSlug, userRoot, writeGuard } from "../paths.js";
import { logActivity, persistDocument, putEnvelopeField } from "../persist.js";
import { teamFor } from "../platform-db.js";
import { improvementApprovalRefusal } from "../release-owners.js";
import { acceptanceApprovalRefusal } from "../review-acceptance.js";
import { isoToday, normalizeSections } from "../write-guards.js";

import { registerInitiativeCloseTool } from "./initiative-close.js";
import { registerInitiativeOpenTool } from "./initiative-open.js";
import { nextMoveLine } from "./initiative-status.js";

export function registerInitiativeActTools(server: McpServer): void {
  // Opening is registered from here, in its own file because a tool whose refusals are the point
  // does not fit beside these. Registered from here rather than from server.ts, so the acts stay
  // one registration to the door — see initiative-open.ts for why the date is the platform's and
  // why a missing flow is a choice.
  registerInitiativeOpenTool(server);
  // Closing too, in its own file for the same reason: it is one subject, the act that writes the
  // outcome a team's counts are read from.
  registerInitiativeCloseTool(server);

  server.registerTool(
    "document_approve",
    {
      description:
        "Record an approval on a document, in one call. THE PLATFORM writes `status: approved`, " +
        "`approved_by` from the identity of this session and `approved_at` from the system " +
        "clock — you write none of the three, and writing them by hand is refused. " +
        "Call it the MOMENT the person agrees, in whatever words the agreement arrived: an " +
        "approval that exists only in the chat does not exist, and the person must never be " +
        "the one who discovers that later. Do not ask them to confirm a second time, and do " +
        "not ask them to edit frontmatter. Use `on_behalf_of` only when the verdict is " +
        "someone else's and they are not this session — a stakeholder who said it elsewhere.",
      inputSchema: {
        path: z.string().describe("e.g. '2026-08-23-sample-queue/spec.md'"),
        on_behalf_of: z.string().optional().describe(
          "The person whose decision this is, when that is not the caller. Omit for the " +
          "normal case: you acting with someone's authority IS their decision, under their name."),
      },
    },
    async ({ path: relPath, on_behalf_of }) => {
      const who = parseCaller(requestHeaders());
      const root = await userRoot();
      const team = await teamFor(who.email);
      const parts = relPath.replace(/^\/+/, "").split("/");
      if (parts.length !== 2) return text("ERROR: path must be '<initiative>/<document>.md'");
      const blocked = writeGuard(relPath);
      if (blocked) return text(blocked);
      const target = await safePath(relPath);
      if (!existsSync(target)) {
        return text(`ERROR: ${relPath} does not exist — approve records a verdict on a document that is already written`);
      }
      const chain = chainFor(root, relPath);
      // DELIBERATE: only a flow can say a document is not its business. A freeform initiative
      // resolves to EMPTY_CHAIN, so whatever is in its folder is approvable; a flow that declared its
      // documents refuses one it never named.
      if (chain.documents.length && !chain.docs.has(parts[1])) {
        return text(`ERROR: ${parts[1]} is not a document this flow declares`);
      }
      // Declaring a document is not gating it. An ungated document is finished by being written, and
      // `approved` on one is a verdict the platform has nowhere to put.
      //
      // COUPLED: `stampEnvelope` never writes a status where no gate exists, and this refuses a caller
      // writing one. Without both, the next approval of an audit report undoes the other.
      //
      // The refusal names the alternative, because the caller is not doing anything wrong.
      const entry = chain.documents.find((d) => d.name === parts[1]);
      if (entry && entry.gate !== true) {
        return text(
          `ERROR: ${parts[1]} carries no gate in ${chain.name ?? "this flow"}, so there is ` +
          "nothing to approve. A status records that a person was asked and answered; this " +
          "document was never put to anyone. It is complete because it was written — say so " +
          "and carry on. Which documents gate is the flow manifest's answer, and it can differ " +
          "between flows: the same name may be gated in one and not in another.");
      }
      const signer = (on_behalf_of ?? "").trim() || who.email;
      let doc = readFileSync(target, "utf8");
      // COUPLED: release_apply (eval/release-apply.ts) counts this approval only for owner teams the
      // signer is a member of. Checked here too, so a name nobody can vouch for is never stamped
      // onto the document that authorizes a release — least of all by somebody else, on_behalf_of.
      if (parts[1] === "improvement.md") {
        const refused = await improvementApprovalRefusal(documentBody(doc), signer, on_behalf_of?.trim() ? who.email : null);
        if (refused) return text(refused);
      }
      // A document that `verifies` others is approved on evidence: one acceptance row per
      // criterion they declare, each held to review-acceptance.ts's rules. Asked here and not in
      // documentGuards, which runs on every draft write and would refuse a table being filled in.
      const acceptance = await acceptanceApprovalRefusal(root, chain, relPath, doc, who.email);
      if (acceptance.refusal) return text(acceptance.refusal);
      const already = parseEnvelope(doc).status === "approved";
      doc = putEnvelopeField(doc, "status", "approved");
      doc = putEnvelopeField(doc, "approved_by", signer);
      doc = putEnvelopeField(doc, "approved_at", isoToday());
      const fixed = normalizeSections(chain, relPath, doc);
      const bad = documentGuards(chain, root, relPath, fixed.content, team, "document_approve");
      if (bad) return text(bad);
      // DELIBERATE: read before the write — persistDocument logs, and this asks about the log.
      const fetched = shownSinceLastChange(root, relPath);
      persistDocument(chain, root, relPath, target, fixed.content, "document_approve");
      logActivity(root, relPath, { user: who.email, action: "document_approve", path: relPath, signer, fetched });
      // An approval is a separate fact from the document: a gated step requires `1x document` and
      // `1x approval`, so recording only one leaves the step a requirement short or credits a
      // document nobody wrote.
      await noteDocument(chain, relPath, "approval", who.email, team);
      return text(
        `${relPath} approved — recorded under ${signer}` +
        (on_behalf_of ? ` (on their behalf, by ${who.email})` : "") + ".\n" +
        (already ? "It was already approved; the record now carries this verdict instead.\n" : "") +
        (acceptance.note ? `${acceptance.note}\n` : "") +
        (fixed.renamed.length ? `Renamed to the heading this flow declares: ${fixed.renamed.join(", ")}.\n` : "") +
        // DELIBERATE: said, not refused. An approval with no `document_present` since the content last
        // moved is flagged and never rejected: this call records a decision a person already made, so a
        // false positive would tell somebody their own approval was rejected. Addressed to the next
        // action, because the approval is already recorded.
        (fetched === false
          ? "\nNOT FETCHED: no `document_present` on this path since its content last changed, so " +
            "the record cannot show anyone saw these bytes before the verdict. The approval " +
            "stands — this is a note, not a refusal. Before the next gate, call " +
            "`document_present` and put what it returns in front of the person; a standing " +
            "\"approve without checking with me\" waives their REVIEW, not the fetch, because " +
            "the fetch is the part that reaches the record.\n"
          : "") +
        // True only of the flip. A snapshot is written when a document goes draft -> approved and on no
        // other write (persist.ts), so re-approving an approved document freezes nothing and the copy in
        // `_versions/` still carries the previous signer's verdict.
        (already
          ? "No new frozen copy was taken: the document was already approved, so the copy in " +
            "_versions/ is the one filed at the first approval."
          : "The approved copy is frozen in _versions/.") +
        // What the flow expects next, computed the way initiative_status computes it: an approval
        // is where an owed audit round or a close is most often forgotten.
        nextMoveLine(root, parts[0]),
      );
    },
  );

  server.registerTool(
    "document_revise",
    {
      description:
        "Revise a document and record WHY it changed, in one call. Send the BODY — the " +
        "platform writes the frontmatter. The platform bumps the " +
        "`version` (v1 -> v2), puts `status` back to draft so the gate goes to a human again, " +
        "clears the stale approval, and links the material behind the change; the previously " +
        "approved version stays in _versions/. " +
        "EVERY VERSION NAMES THE MATERIAL BEHIND IT. Cite what is already on the record with " +
        "`sources` — an audit round, a decision written down — or pass the words themselves as " +
        "`source_content` and the platform stores them as a source and links them. A revision " +
        "naming neither is refused, whatever the edit was: content does not change without " +
        "material behind it. Never overwrite an approved document with document_write.",
      inputSchema: {
        path: z.string().describe("e.g. '2026-08-23-sample-queue/intent.md'"),
        content: z.string().describe("The full revised document, body and all."),
        source_content: z.string().optional()
          .describe("The input that caused this change, verbatim (the person's own words). Stored as a source and linked."),
        source_title: z.string().optional()
          .describe("Short title for that input, e.g. 'Second brain dump — SLA and approvals'."),
        sources: z.array(z.string()).optional()
          .describe("Existing source files this revision is based on, e.g. ['sources/2026-08-23-sample-review.md']."),
        stakeholder: z.string().optional().describe("Who asked for this, where the document records one."),
        tags: z.array(z.string()).optional().describe("Index tags for this document."),
        title: z.string().optional().describe("Document title for the index."),
        fields: z.record(z.string()).optional()
          .describe("This FLOW's own frontmatter fields. Not envelope names."),
        note: z.string().optional().describe(
          "One line on WHAT changed, recorded as the revision note. An annotation, not a " +
          "cause: a version still names the material behind it."),
      },
    },
    async ({ path: relPath, content, source_content, source_title, sources, note,
             stakeholder, tags, title, fields }) => {
      const refusedFm = frontmatterRefusal(content, "document_revise") ?? fieldRefusal(fields)
        ?? tagRefusal(tags);
      if (refusedFm) return text(refusedFm);
      // What caused this version, asked once. A content change names the material behind it: the
      // next reader cannot tell a decision taken elsewhere from a second thought when the record says
      // neither. A typo fix costs one `source_content` line naming what was wrong.
      //
      // `note` says what changed, not what changed it, so it never satisfies this on its own.
      const causes = [
        source_content && source_content.trim() ? "source_content" : null,
        sources && sources.length ? "sources" : null,
      ].filter((c): c is string => c !== null);
      if (!causes.length) {
        return text(
          "ERROR: nothing says what caused this version. Content does not change without " +
          "material behind it: cite what is already on the record with `sources` — an audit " +
          "round, a decision written down — or pass the words themselves as `source_content`, " +
          "which the platform stores as a source and links. Even a wording fix has a cause " +
          "worth one line. Approving, closing and the envelope are untouched by this: it is " +
          "the BODY that may not change with the reason left off the record.");
      }
      const who = parseCaller(requestHeaders());
      const root = await userRoot();
      const team = await teamFor(who.email);
      const parts = relPath.replace(/^\/+/, "").split("/");
      if (parts.length !== 2) return text("ERROR: path must be '<initiative>/<document>.md'");
      const blocked = writeGuard(relPath);
      if (blocked) return text(blocked);
      const target = await safePath(relPath);
      if (!existsSync(target)) return text(`ERROR: ${relPath} does not exist — document_write creates a document; document_revise changes one`);
      const chain = chainFor(root, relPath);
      // A document the flow does not declare is exempt from its rules, not refused by them — the same
      // condition `write-guards.ts` uses to stand aside. `document_revise` is the only call that
      // records why a document changed, so refusing it here would leave exactly the documents a flow
      // is not watching unable to explain themselves.
      //
      // `document_approve` still refuses an undeclared document, and that stays right: there
      // is no gate on it, so there is no verdict to record. A revision is not a gate.

      const prevEnv = parseEnvelope(readFileSync(target, "utf8"));
      // A closed record may be corrected; what closed it may not be. An initiative closes once, on one
      // verdict, and correcting what a report says is a different act from changing what it concluded.
      //
      // COUPLED: `outcome` is carried forward below. initiative_close() reads it off the document to
      // refuse a second close, and ledgerOnClose reads it off disk before appending a row.
      //
      // Nothing here is a quiet overwrite: the approved copy is frozen in `_versions/`, the version
      // bumps, a revision_note is recorded, and a gated document goes back to a person.
      const closedOutcome = prevEnv.outcome;
      const prevVersion = parseInt(prevEnv.version || "1", 10) || 1;
      const nextVersion = prevVersion + 1;
      const wasApproved = prevEnv.status === "approved";
      // Does the frozen copy exist? A snapshot is taken only on the draft -> approved flip
      // (persist.ts), so a document revised twice while closed has none for the second revision, and
      // the messages below must not name a file nothing wrote.
      const frozenRel = `${parts[0]}/_versions/${parts[1].replace(/\.md$/, "")}.v${prevVersion}.md`;
      const frozenExists = existsSync(join(root, frozenRel));

      // The body, and only the body. `stakeholder`, `tags` and `title` are named arguments, so the
      // model never composes envelope YAML.
      const body = content;
      const linked = new Set<string>(
        (prevEnv.sources || "").split(",").map((x) => x.trim()).filter(Boolean));
      // A source ref is a path inside the initiative, so it has no room for a separator:
      // the list is written comma-joined and read comma-split.
      for (const src of sources ?? []) {
        if (!DOC_REF.test(src.trim())) {
          return text(`ERROR: source "${src}" must be a path inside the initiative — ` +
                      "letters, digits, dot, dash, underscore and / only");
        }
        linked.add(src.trim());
      }
      // What already explains this revision is cited. A source added after the version being
      // replaced, whose `supports` names this document, is by its own declaration what this revision
      // answers — an audit round is exactly that, and nothing here knows the word "audit".
      //
      // DELIBERATE: refused rather than linked silently. What changed a gated document is the caller's
      // claim to make.
      const dir = join(root, parts[0]);
      const sourceDir = join(dir, "sources");
      const owed = (existsSync(sourceDir) ? readdirSync(sourceDir) : [])
        .filter((f) => f.endsWith(".md"))
        .filter((f) => statSync(join(sourceDir, f)).mtimeMs > statSync(target).mtimeMs)
        .filter((f) => (parseEnvelope(readFileSync(join(sourceDir, f), "utf8")).supports || "")
          .split(",").map((x) => x.trim()).includes(parts[1]))
        .map((f) => `sources/${f}`)
        .filter((ref) => !linked.has(ref));
      if (owed.length) {
        return text(
          `ERROR: ${owed.join(", ")} ${owed.length === 1 ? "supports" : "support"} ${parts[1]} ` +
          `and ${owed.length === 1 ? "was" : "were"} added after the version you are replacing, ` +
          `so ${owed.length === 1 ? "it is" : "they are"} what this revision answers. Cite ` +
          `${owed.length === 1 ? "it" : "them"}: \`sources: ${JSON.stringify(owed)}\`. A version ` +
          "that does not name what changed it cannot be checked by anybody later.");
      }

      // The input that caused the change is stored beside the document it changed, so v2 always says
      // what made it differ.
      //
      // DELIBERATE: prepared here, written after the guards pass. Written earlier, a revision the
      // platform then refused would leave the source on disk, indexed and logged, for a change that
      // never happened. Only the name is needed up here, because the document links to it by name.
      let capturedSource: string | null = null;
      let pendingSource: { rel: string; doc: string } | null = null;
      if (source_content && source_content.trim()) {
        const title = (source_title || `Input behind v${nextVersion}`).trim();
        const slug = titleSlug(title, "source");
        const day = isoToday();
        let rel = `${parts[0]}/sources/${day}-${slug}.md`;
        let n = 2;
        while (existsSync(join(root, rel))) rel = `${parts[0]}/sources/${day}-${slug}-${n++}.md`;
        pendingSource = {
          rel,
          doc: sourceDocument({ title, by: who.email, day, supports: parts[1],
                                content: source_content.trim() }),
        };
        capturedSource = rel.slice(parts[0].length + 1);
        linked.add(capturedSource);
      }

      // Always true by here — the refusal above spends the other case — and kept because the activity
      // log is read by people who were not in this call. Links inherited from the previous version
      // explain that version, not this one.
      const explained = causes.length > 0;
      const env: Record<string, string> = { ...prevEnv };
      if (stakeholder?.trim()) env.stakeholder = oneLine(stakeholder);
      if (title?.trim()) env.title = oneLine(title);
      const revTags = (tags ?? []).map((t) => t.trim()).filter(Boolean);
      if (revTags.length) env.tags = revTags.join(", ");
      // Names checked by `fieldRefusal` above, the same predicate document_write uses.
      for (const [k, v] of Object.entries(fields ?? {})) {
        if (String(v).trim()) env[k.trim()] = oneLine(String(v));
      }
      // DELIBERATE: `outcome` is carried, not merely left alone. initiative_close() and ledgerOnClose
      // both read it to know the initiative already closed, so it is written back from the previous
      // envelope every time.
      if (closedOutcome) env.outcome = closedOutcome;
      env.version = String(nextVersion);
      // A revision returns the gate to a person — unless the initiative already closed. closeCheck
      // holds that a closing document carrying an outcome must be approved, because the ledger row
      // was written at that close. The signed text stays retrievable in `_versions/`, with the
      // correction beside it.
      //
      // COUPLED: a status exists only where the flow gates the document. stampEnvelope writes one only
      // there, and document_approve refuses a document that carries none.
      const gatedHere = chain.documents.find((d) => d.name === parts[1])?.gate === true;
      // DELIBERATE: the closed branch sits inside the gate rule, not above it. An ungated document an
      // initiative closed on — usually explore.md, on an abandoned sdlc-flow close — must not gain an
      // approval verdict nobody can give.
      if (closedOutcome && gatedHere) {
        env.status = "approved";
      } else if (gatedHere) {
        delete env.approved_by; delete env.approved_at;
        env.status = "draft";
      } else {
        // Ungated: finished by being written, and there is nothing for a person to answer.
        delete env.approved_by; delete env.approved_at; delete env.status;
      }
      env.updated_at = isoToday();
      // `flow` and `type` are manifest facts, and stampEnvelope only ever adds them, so the manifest
      // decides both here every time: a revision cannot relabel which flow governs a document.
      if (chain.name) env.flow = chain.name;
      const role = chain.documents.find((d) => d.name === parts[1])?.role;
      if (role) env.type = role;
      if (linked.size) env.sources = [...linked].join(", ");
      // Cut on a word, and say it was cut: a truncated note must not look whole.
      //
      // DELIBERATE: a truncation, not a refusal. The content change is already made, and losing the
      // revision over its label is the worse trade.
      if (note) env.revision_note = oneLine(note, 200);
      const doc = renderEnvelope(env,
        ["flow", "type", "title", "stakeholder", "tags", "version", "updated_at", "status", "sources", "revision_note"]) +
        "\n" + body.replace(/^\n+/, "");
      // A revision is a write, and goes through the same guards. statusCheck, attributionCheck and
      // closeCheck are inert here by construction; the rest fire. sectionCheck exempts only a gated
      // document in draft, so an ungated document's declared sections stay required in v2.
      const fixed = normalizeSections(chain, relPath, doc);
      // `via`: document_revise is an act whose job is to move the governance fields, so it passes the
      // guard that refuses a model writing them by hand.
      const bad = documentGuards(chain, root, relPath, fixed.content, team, "document_revise");
      if (bad) return text(bad);

      // The revision is allowed, so the source that explains it is written now — before
      // persistDocument, so both land in one commit.
      if (pendingSource) {
        const srcTarget = await safePath(pendingSource.rel);
        mkdirSync(resolve(srcTarget, ".."), { recursive: true });
        writeFileSync(srcTarget, pendingSource.doc);
        void indexDoc(root, pendingSource.rel, pendingSource.doc);
        logActivity(root, pendingSource.rel,
          { user: who.email, action: "source_add", path: pendingSource.rel, supports: parts[1] });
      }
      // Through persistDocument, like the other two paths, so a revision is stamped, snapshotted and
      // checked by the one shared writer. snapshotOnApproval and ledgerOnClose are inert here.
      persistDocument(chain, root, relPath, target, fixed.content, "revise");
      // The two fields below are a pair, and the pair carries three states: a flag alone collapses
      // "no cause existed" and "the cause was not captured", and only the second can be fixed.
      //
      // DELIBERATE: this comment sits above the call, not inside it. The gate check holding both names
      // to this payload reads a window around `action: "document_revise"`, so a comment inside the
      // object naming them would satisfy it after the fields were deleted.
      logActivity(root, relPath, {
        user: who.email, action: "document_revise", path: relPath,
        version: nextVersion, sources: [...linked].join(","), explained,
      });
      // The control loop is told. A revision withdraws the approval it was counting; the entry says
      // which earlier one it withdraws, and nothing is deleted.
      await noteRevision(chain, relPath, nextVersion, who.email, team);
      return text(
        // The status is named only where one exists: a closed record stays approved, and an ungated
        // document carries none.
        `${relPath} revised: v${prevVersion} -> v${nextVersion}` +
        (env.status ? `, status ${env.status}` : "") + ".\n" +
        (fixed.renamed.length
          ? `Renamed to the heading this flow declares: ${fixed.renamed.join(", ")}.\n` : "") +
        (closedOutcome
          ? `This initiative is CLOSED as \`${closedOutcome}\`, and the close is untouched: the ` +
            `ledger row stands and no second one can be written. ` +
            (frozenExists
              ? `The text a person signed is frozen as ${frozenRel}. `
              : `No frozen copy of v${prevVersion} exists — a snapshot is taken when a document is ` +
                `approved, and this one was already approved when it was last revised, so the ` +
                `superseded text is in the store's git history rather than in _versions/. `) +
            `What changed here is what the report SAYS, not what it concluded — if the verdict ` +
            `itself was wrong, that is a journal node, not a revision.\n`
          : wasApproved
          ? `The v${prevVersion} approval is preserved in ${frozenRel} and no longer applies.\n`
          : "") +
        (capturedSource ? `The input behind it is stored as ${parts[0]}/${capturedSource}.\n` : "") +
        (linked.size ? `Linked sources: ${[...linked].join(", ")}\n` : "") +
        // The last line applies only where a gate exists to be passed again. On an ungated document
        // nothing downstream waits, and document_approve refuses it.
        (closedOutcome
          ? "This initiative is closed, so nothing downstream is waiting on this document."
          : gatedHere
          ? "Nothing downstream may be written until this document is approved again."
          : "This document carries no gate, so nothing downstream is waiting on it.") +
        (closedOutcome ? "" : nextMoveLine(root, parts[0])),
      );
    },
  );
}
