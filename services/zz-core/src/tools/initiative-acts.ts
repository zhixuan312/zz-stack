/**
 * The acts: approving a document. Opening and closing an initiative are their own files,
 * registered from here so the acts stay one registration.
 *
 * An act is the only thing that may move the fields the platform owns. `status`,
 * `approved_by`, `approved_at`, `outcome` and `closed_by` are stamped from the session and the
 * clock, and every write path refuses them typed by a caller. `document_approve` and
 * `initiative_close` are the exceptions; `document_edit` composes them only by carrying a close
 * forward and taking an approval off, never by setting one.
 *
 * Approval reads and writes `doc` and `doc_revision`: a document's identity and its status are
 * the `doc` row's, and the bytes it signs are the current `doc_revision`. Nothing is read from a
 * file — the row that retained the revision is the authority the act answers from. It signs only
 * the state it read: a change committed between its read and its write sends it back.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { documentBody, parseCaller } from "@zz/contracts";
import { WRITES, requestHeaders, text } from "@zz/mcp-http";
import { z } from "zod";

import { shownSinceLastChange } from "../attest.js";
import { chainFor, gateRefusal } from "../chain.js";
import { PANEL_CALLABLE } from "../document-panel.js";
import { NO_TEAM } from "../document-change.js";
import { settleRefusal } from "../document-details.js";
import { putEnvelopeField } from "../document-rules.js";
import { documentGuards } from "../guards.js";
import { noteDocument } from "../host/observe.js";
import { docRows } from "../indexing.js";
import { safePath, writeGuard } from "../paths.js";
import { db, teamFor } from "../platform-db.js";
import { improvementApprovalRefusal } from "../release-owners.js";
import { acceptanceApprovalRefusal } from "../review-acceptance.js";
import { specApprovalRefusal } from "../spec-gate.js";
import { loadDocument, NO_DB, principalId, recordAct } from "../versions.js";
import { documentState, saveDocument, STATE_CHANGED } from "../document-save.js";
import { isoToday, normalizeSections } from "../write-guards.js";

import { registerInitiativeCloseTool } from "./initiative-close.js";
import { registerInitiativeOpenTool } from "./initiative-open.js";
import { assessmentsFor } from "../review-rounds.js";
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
      annotations: WRITES,
      description:
        "Record an approval on a document, in one call. THE PLATFORM writes `status: approved`, " +
        "`approved_by` from the identity of this session and `approved_at` from the system " +
        "clock — you write none of the three, and writing them by hand is refused. " +
        "Call it the MOMENT the person agrees, in whatever words the agreement arrived: an " +
        "approval that exists only in the chat does not exist, and the person must never be " +
        "the one who discovers that later. Do not ask them to confirm a second time, and do " +
        "not ask them to edit frontmatter. Use `on_behalf_of` only when the verdict is " +
        "someone else's and they are not this session — a stakeholder who said it elsewhere. " +
        "Refused until the CURRENT content was presented: call `document_present` after the " +
        "last write or edit, in its own call, then approve. A change that lands between the " +
        "present and this call sends it back: present it again.",
      inputSchema: {
        path: z.string().describe("e.g. '2026-08-23-sample-queue/spec.md'"),
        on_behalf_of: z.string().optional().describe(
          "The person whose decision this is, when that is not the caller. Omit for the " +
          "normal case: you acting with someone's authority IS their decision, under their name."),
      },
      // The document panel's Approve button calls this, through the client.
      _meta: PANEL_CALLABLE,
    },
    async ({ path: relPath, on_behalf_of }) => {
      const who = parseCaller(requestHeaders());
      const p = db();
      if (!p) return text(NO_DB);
      const team = await teamFor(who.email);
      if (!team) return text(NO_TEAM);
      const parts = relPath.replace(/^\/+/, "").split("/");
      if (parts.length !== 2) return text("ERROR: path must be '<initiative>/<document>.md'");
      const blocked = writeGuard(relPath);
      if (blocked) return text(blocked);
      await safePath(relPath);
      // The state the approval signs, read BEFORE the document — so the document read can only be
      // newer than the state, never older, and an edit landing in between sends this back rather
      // than sealing bytes nobody presented.
      const state = await documentState(p, team, relPath);
      // The document is read from the row that retained it: its identity and status from
      // `doc`, its body from the current revision.
      const loaded = await loadDocument(team, relPath);
      if (!loaded.ok) {
        return text(loaded.why === "missing"
          ? `ERROR: ${relPath} does not exist — approve records a verdict on a document that is already written`
          : loaded.refusal);
      }
      const chain = await chainFor(p, team, relPath, loaded.text);
      const ungated = gateRefusal(chain, parts[1]);
      if (ungated) return text(ungated);
      // The one step an approval holds for: the bytes it signs were put in front of somebody.
      // Approval is delegated to agents, so nothing else stands between an unread revision and a
      // verdict on it. `false` only — `null` is a record that cannot answer (no activity log, or
      // no recorded change to be "since"), and a refusal invented from a missing record would
      // stop an approval over the platform's own gap. Asked before anything is read or written.
      const fetched = await shownSinceLastChange(p, team, relPath);
      if (fetched === false) {
        return text(
          `ERROR: present it first — ${relPath} changed after it was last presented, so no ` +
          "record shows anyone saw these bytes. Call `document_present` on it in its own call, " +
          "put what it returns in front of the person, then approve. A long document comes back " +
          "in parts; present every part. A standing \"approve without checking with me\" waives " +
          "their review, not the present — the present is what the record keeps.");
      }
      const signer = (on_behalf_of ?? "").trim() || who.email;
      // DELIBERATE: the signer is resolved HERE rather than at the row. `zz.doc_revision.approved_by`
      // is a principal id and `doc_revision_approval_paired` holds it null exactly when
      // `approved_at` is, so a signer no principal carries would write an approval with no
      // attribution — and the row is where the envelope's own `approved_by` is rendered back from,
      // so the document would read as approved with nobody's name on it, and the next gate would
      // refuse it with a message about the document rather than about the name. Refusing here names
      // the thing to fix: add them as a person, or approve on behalf of someone the platform knows.
      if (!(await principalId(p, signer))) {
        return text(
          `ERROR: \`${signer}\` is not a person this platform knows, so the approval would carry no ` +
          `attribution — and a gated document approved with nobody's name on it is refused by the ` +
          `next gate it meets. Pass \`on_behalf_of\` an address or a name a principal carries, or ` +
          `add them first (\`person_add\`).\n`);
      }
      let doc = loaded.text;
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
      // Every source and every typed answer this initiative holds, in two queries, for the two
      // gates below — a review round's routing and a spec's statements both read them, and both
      // read the rows rather than a second copy of them.
      const sources = await docRows(p, team, parts[0]);
      const answers = await assessmentsFor(p, team, parts[0]);
      // A refusal whose list was cut names its complete detail, recorded here before it is answered.
      const settle = (reply: string) => settleRefusal(p, { who: who.email, team, path: relPath }, reply);
      const acceptance = await acceptanceApprovalRefusal(p, team, chain, relPath, doc, who.email,
                                                          sources, answers);
      if (acceptance.refusal) return text(await settle(acceptance.refusal));
      // A spec whose flow declares a phase outline and core statements is approved on them: every
      // criterion placed in a phase, every statement backed by a spike — spec-gate.ts's rules.
      const foundation = await specApprovalRefusal(p, team, chain, relPath, doc, who.email, sources);
      if (foundation.refusal) return text(await settle(foundation.refusal));
      const already = loaded.doc.status === "approved";
      doc = putEnvelopeField(doc, "status", "approved");
      doc = putEnvelopeField(doc, "approved_by", signer);
      doc = putEnvelopeField(doc, "approved_at", isoToday());
      const fixed = normalizeSections(chain, relPath, doc);
      const bad = await documentGuards(chain, relPath, fixed.content, team, "document_approve");
      if (bad) return text(await settle(bad));
      // The seal, the status and the revision move together, in one statement's worth of write:
      // `doc_current_revision_required` holds that `status: approved` is true exactly when
      // `approved_revision` is the current revision, so a writer that set one without the other
      // would leave a document nobody can read.
      const sealed = await saveDocument({
        team, relPath, initiative: parts[0], text: fixed.content, by: who.email,
        flow: chain.name ?? undefined, type: chain.roles[parts[1]],
        mode: "rewrite", act: "document_approve", seal: { by: signer, at: isoToday() },
        ...(state ? { expect: state } : {}),
      });
      if ("refusal" in sealed) {
        return text(sealed.refusal.startsWith(STATE_CHANGED)
          ? `ERROR: ${relPath} changed after it was presented — present it again`
          : sealed.refusal);
      }
      recordAct(relPath, { user: who.email, action: "document_approve", path: relPath, signer, fetched });
      // An approval is a separate fact from the document: a gated step requires `1x document` and
      // `1x approval`, so recording only one leaves the step a requirement short or credits a
      // document nobody wrote.
      if ("revision" in sealed) {
        await noteDocument(chain, relPath, "approval", { version: sealed.version, revision: sealed.revision },
                           who.email, team);
      }
      return text(
        `${relPath} approved — recorded under ${signer}` +
        (on_behalf_of ? ` (on their behalf, by ${who.email})` : "") + ".\n" +
        (already ? "It was already approved; the record now carries this verdict instead.\n" : "") +
        (acceptance.note ? `${acceptance.note}\n` : "") +
        (foundation.note ? `${foundation.note}\n` : "") +
        (fixed.renamed.length ? `Renamed to the heading this flow declares: ${fixed.renamed.join(", ")}.\n` : "") +
        // True only of the flip. The seal lands on the revision the approval names, and a
        // revision already approved is updated in place rather than filed a second time.
        (already
          ? "No new revision was filed: the document was already approved, so the record now " +
            "carries this verdict on the same revision."
          : `The approved version is v${"version" in sealed ? sealed.version : ""}, and the ` +
            "seal is on it.") +
        // What the flow expects next, computed the way initiative_status computes it: an approval
        // is where an owed audit round or a close is most often forgotten.
        await nextMoveLine(p, team, parts[0]),
      );
    },
  );
}
