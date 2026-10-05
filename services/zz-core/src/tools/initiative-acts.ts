/**
 * The acts: approving a document and revising an approved one. Opening and closing an
 * initiative are their own files, registered from here so the acts stay one registration.
 *
 * An act is the only thing that may move the fields the platform owns. `status`,
 * `approved_by`, `approved_at`, `outcome` and `closed_by` are stamped from the session and the
 * clock, and every write path refuses them typed by a caller. `document_approve`,
 * `document_revise` and `initiative_close` are the exceptions, and there is no fourth.
 *
 * Both acts here read and write `doc` and `doc_revision`: a document's identity and its status
 * are the `doc` row's, and the bytes an act signs are the current `doc_revision`. Nothing is
 * read from a file — the row that retained the revision is the authority the act answers from.
 *
 * `document_revise` exists because an approved document cannot be written over: the
 * approver's name would stand on bytes they never read. It files a new `doc_revision`, returns
 * `doc` to draft, clears the stale approval and leaves the approved revision untouched.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { documentBody, parseCaller, parseEnvelope } from "@zz/contracts";
import { WRITES, requestHeaders, text } from "@zz/mcp-http";
import type pg from "pg";
import { z } from "zod";

import { shownSinceLastChange } from "../attest.js";
import { chainFor, gateRefusal } from "../chain.js";
import { PANEL_CALLABLE } from "../document-panel.js";
import { fieldRefusal, frontmatterRefusal, oneLine, putEnvelopeField, renderEnvelope } from "../document-rules.js";
import { replaceSection } from "../document-parts.js";
import { documentGuards } from "../guards.js";
import { noteDocument, noteRevision } from "../host/observe.js";
import { docRows, sourceDocument } from "../indexing.js";
import { DOC_REF, safePath, tagRefusal, titleSlug, writeGuard } from "../paths.js";
import { db, teamFor } from "../platform-db.js";
import { improvementApprovalRefusal } from "../release-owners.js";
import { acceptanceApprovalRefusal } from "../review-acceptance.js";
import { specApprovalRefusal } from "../spec-gate.js";
import { citationsOf, dayOf, documentAt, documentPaths, loadDocument, recordAct,
         principalId, revisionsOf, saveDocument, supportsOf } from "../versions.js";
import { isoToday, normalizeSections } from "../write-guards.js";

import { registerInitiativeCloseTool } from "./initiative-close.js";
import { registerInitiativeOpenTool } from "./initiative-open.js";
import { assessmentsFor } from "../review-rounds.js";
import { nextMoveLine } from "./initiative-status.js";

/** A deployment with no database has no store left: the columns are where a document lives, and
 *  there is no file to fall back to. */
const NO_DB = "ERROR: no platform database — the store is the database now, so there is " +
  "nowhere to read or write this document.";

/** A person the platform cannot place in a team has no store to act on. */
const NO_TEAM = "ERROR: you are not in a team — a team's documents live in the database under " +
  "its own membership, and nothing resolves you to one.";

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
        "last write, patch or revise, in its own call, then approve.",
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
      const acceptance = await acceptanceApprovalRefusal(p, team, chain, relPath, doc, who.email,
                                                          sources, answers);
      if (acceptance.refusal) return text(acceptance.refusal);
      // A spec whose flow declares a phase outline and core statements is approved on them: every
      // criterion placed in a phase, every statement backed by a spike — spec-gate.ts's rules.
      const foundation = await specApprovalRefusal(p, team, chain, relPath, doc, who.email, sources);
      if (foundation.refusal) return text(foundation.refusal);
      const already = loaded.doc.status === "approved";
      doc = putEnvelopeField(doc, "status", "approved");
      doc = putEnvelopeField(doc, "approved_by", signer);
      doc = putEnvelopeField(doc, "approved_at", isoToday());
      const fixed = normalizeSections(chain, relPath, doc);
      const bad = await documentGuards(chain, relPath, fixed.content, team, "document_approve");
      if (bad) return text(bad);
      // The seal, the status and the revision move together, in one statement's worth of write:
      // `doc_current_revision_required` holds that `status: approved` is true exactly when
      // `approved_revision` is the current revision, so a writer that set one without the other
      // would leave a document nobody can read.
      const sealed = await saveDocument({
        team, relPath, initiative: parts[0], text: fixed.content, by: who.email,
        flow: chain.name ?? undefined, type: chain.roles[parts[1]],
        mode: "rewrite", act: "document_approve", seal: { by: signer, at: isoToday() },
      });
      if ("refusal" in sealed) return text(sealed.refusal);
      recordAct(relPath, { user: who.email, action: "document_approve", path: relPath, signer, fetched });
      // An approval is a separate fact from the document: a gated step requires `1x document` and
      // `1x approval`, so recording only one leaves the step a requirement short or credits a
      // document nobody wrote.
      await noteDocument(chain, relPath, "approval", who.email, team);
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
          : `The approved revision is v${"revision" in sealed ? sealed.revision : ""}, and the ` +
            "seal is on it.") +
        // What the flow expects next, computed the way initiative_status computes it: an approval
        // is where an owed audit round or a close is most often forgotten.
        await nextMoveLine(p, team, parts[0]),
      );
    },
  );

  server.registerTool(
    "document_revise",
    {
      annotations: WRITES,
      description:
        "Revise a document and record WHY it changed, in one call. Send the BODY — the " +
        "platform writes the frontmatter. The platform bumps the " +
        "`version` (v1 -> v2), puts `status` back to draft so the gate goes to a human again, " +
        "clears the stale approval, and links the material behind the change; the previously " +
        "approved revision stays filed beside it. " +
        "EVERY VERSION NAMES THE MATERIAL BEHIND IT. Cite what is already on the record with " +
        "`sources` — an audit round, a decision written down — or pass the words themselves as " +
        "`source_content` and the platform stores them as a source and links them. A revision " +
        "naming neither is refused, whatever the edit was: content does not change without " +
        "material behind it. Never overwrite an approved document with document_write. " +
        "A LARGE DOCUMENT is revised one section at a time: pass `section` (a heading, as " +
        "document_read's `section` takes it) and `content` replaces that heading and everything " +
        "under it, down to the next heading of the same or a higher level — the rest of the " +
        "document is kept exactly as it was.",
      inputSchema: {
        path: z.string().describe("e.g. '2026-08-23-sample-queue/intent.md'"),
        content: z.string().describe(
          "The full revised body — or, with `section`, that section's replacement, starting with its heading line."),
        section: z.string().optional().describe(
          "Replace only this heading's section, e.g. 'Phase 5 — Delivery'. Everything else is kept as it is."),
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
    async ({ path: relPath, content, section, source_content, source_title, sources, note,
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
      const p = db();
      if (!p) return text(NO_DB);
      const team = await teamFor(who.email);
      if (!team) return text(NO_TEAM);
      const parts = relPath.replace(/^\/+/, "").split("/");
      if (parts.length !== 2) return text("ERROR: path must be '<initiative>/<document>.md'");
      const blocked = writeGuard(relPath);
      if (blocked) return text(blocked);
      await safePath(relPath);
      // The document being revised, read from the rows: its status and identity from `doc`, the
      // envelope's facts and the body from the revision those name.
      const loaded = await loadDocument(team, relPath);
      if (!loaded.ok) {
        return text(loaded.why === "missing"
          ? `ERROR: ${relPath} does not exist — document_write creates a document; document_revise changes one`
          : loaded.refusal);
      }
      const chain = await chainFor(p, team, relPath, loaded.text);
      // A document the flow does not declare is exempt from its rules, not refused by them — the same
      // condition `write-guards.ts` uses to stand aside. `document_revise` is the only call that
      // records why a document changed, so refusing it here would leave exactly the documents a flow
      // is not watching unable to explain themselves.
      //
      // `document_approve` still refuses an undeclared document, and that stays right: there
      // is no gate on it, so there is no verdict to record. A revision is not a gate.

      // A closed record may be corrected; what closed it may not be. An initiative closes once, on one
      // verdict, and correcting what a report says is a different act from changing what it concluded.
      //
      // COUPLED: `outcome` is carried forward below. initiative_close() reads it off the document to
      // refuse a second close, and ledgerOnClose reads it off disk before appending a row.
      //
      // Nothing here is a quiet overwrite: the approved revision stays filed, the revision
      // bumps, a revision_note is recorded, and a gated document goes back to a person.
      // The previous revision's envelope — ALL of it, read from the rows, never a hand-kept list of
      // the keys somebody remembered. A list here silently drops every key it does not name: it
      // dropped `closed_by` on any revision of a closed document, so the revised text carried an
      // outcome with nobody's name on it and the next guard refused it as written by hand; and it
      // dropped `stakeholder` and every field a FLOW declares, the same unbounded set
      // `doc_revision.fields` exists to hold. The payload rule is "every key a column cannot hold",
      // and a fixed list is the one shape that cannot express it.
      const prevEnv: Record<string, string> = { ...parseEnvelope(loaded.text) };
      // The columns win over the payload, as they do everywhere else, and they are the rows rather
      // than a copy of them.
      delete prevEnv.approved_by;
      delete prevEnv.approved_at;
      delete prevEnv.status;
      delete prevEnv.title;
      delete prevEnv.tags;
      delete prevEnv.revision_note;
      delete prevEnv.version;
      delete prevEnv.updated_at;
      delete prevEnv.sources;
      if (loaded.doc.status) prevEnv.status = loaded.doc.status;
      // The anchor row's outcome wins where it holds one — it is authoritative after a close, and
      // the payload's copy is the fallback for a close recorded before the row carried one.
      if (loaded.doc.outcome) prevEnv.outcome = loaded.doc.outcome;
      if (loaded.rev.title) prevEnv.title = loaded.rev.title;
      if (loaded.rev.tags?.length) prevEnv.tags = loaded.rev.tags.join(", ");
      if (loaded.rev.approved_by) prevEnv.approved_by = loaded.rev.approved_by;
      if (loaded.rev.approved_at) prevEnv.approved_at = dayOf(loaded.rev.approved_at);
      if (loaded.rev.revision_note) prevEnv.revision_note = loaded.rev.revision_note;
      // COUPLED: `outcome` is carried, not merely left alone.
      const closedOutcome = prevEnv.outcome;
      const prevVersion = loaded.doc.current_revision ?? 1;
      const nextVersion = prevVersion + 1;
      const wasApproved = loaded.doc.status === "approved";
      // The superseded revision, named the way the rows name it: the approved bytes are the
      // revision the seal is on, and nothing overwrites one.
      const priorApproval = loaded.history.find((r) => r.approved_by) ?? null;
      // The body, and only the body. `stakeholder`, `tags` and `title` are named arguments, so the
      // model never composes envelope YAML. With `section`, the body is the current one with that
      // section replaced: a plan grown past what one tool call can carry is revised by the part that
      // changed, and nothing outside it moves.
      let body = content;
      if (section !== undefined) {
        const spliced = replaceSection(documentBody(loaded.text), section, content);
        if ("refusal" in spliced) return text(spliced.refusal);
        body = spliced.body;
      }
      const linked = new Set<string>(
        (await citationsOf(p, loaded.doc.id, prevVersion))
          .map((x) => x.startsWith(`${parts[0]}/`) ? x.slice(parts[0].length + 1) : x));
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
      //
      // COUPLED: the SUPPORTS relation, never `citationsOf`. They are different relations — `cites`
      // is what the source read, `supports` is the document it bears on — and reading the first
      // while the rule is the second let round 1 of a review, recorded before `review.md` exists,
      // be ignored by the revision that answers it.
      // Compared on the rows, which is where "added after" is a fact: a revision's `written_at` is
      // when the platform filed it.
      const owed: string[] = [];
      for (const rel of await documentPaths(team, `${parts[0]}/sources`)) {
        if (!rel.endsWith(".md")) continue;
        const at = await documentAt(p, team, rel);
        if (!at) continue;
        const rev = (await revisionsOf(p, at.id)).find((r) => r.revision === at.current_revision);
        const supports = (await supportsOf(p, at.id, rev?.revision ?? 0)).map((x) => x.split("/").pop());
        const ref = rel.slice(parts[0].length + 1);
        if (supports.includes(parts[1]) && (rev?.written_at ?? "") > (loaded.doc.updated_at ?? "")
            && !linked.has(ref)) {
          owed.push(ref);
        }
      }
      if (owed.length) {
        // The `sources` to send is the whole list — what this call already cited plus what it
        // still owes. Suggesting only the missing one read as a replacement: a caller who cited
        // one of two owed sources was told to cite the other, did so literally, and was then told
        // to cite the first (bug 5913fa5b), round and round.
        const whole = [...new Set([...(sources ?? []).map((x) => x.trim()), ...owed])];
        return text(
          `ERROR: ${owed.join(", ")} ${owed.length === 1 ? "supports" : "support"} ${parts[1]} ` +
          `and ${owed.length === 1 ? "was" : "were"} added after the version you are replacing, ` +
          `so ${owed.length === 1 ? "it is" : "they are"} what this revision answers. Send the whole ` +
          `list — every source this revision answers, not only the missing one: \`sources: ` +
          `${JSON.stringify(whole)}\`. A version that does not name what changed it cannot be ` +
          "checked by anybody later.");
      }

      // The input that caused the change is stored beside the document it changed, so v2 always says
      // what made it differ.
      //
      // DELIBERATE: prepared here, filed after the guards pass. Filed earlier, a revision the
      // platform then refused would leave the source filed, indexed and logged, for a change that
      // never happened. Only the name is needed up here, because the document links to it by name.
      let capturedSource: string | null = null;
      let pendingSource: { rel: string; doc: string } | null = null;
      if (source_content && source_content.trim()) {
        const title = (source_title || `Input behind v${nextVersion}`).trim();
        const slug = titleSlug(title, "source");
        const day = isoToday();
        let rel = `${parts[0]}/sources/${day}-${slug}.md`;
        let n = 2;
        while (await documentAt(p, team, rel)) rel = `${parts[0]}/sources/${day}-${slug}-${n++}.md`;
        pendingSource = {
          rel,
          doc: sourceDocument({ title, by: who.email, day,
                                content: source_content.trim() }),
        };
        capturedSource = rel.slice(parts[0].length + 1);
        linked.add(capturedSource);
      }

      // Always true by here — the refusal above spends the other case — and kept because the activity
      // log is read by people who were not in this call. Links inherited from the previous version
      // explain that version, not this one.
      const explained = causes.length > 0;
      const env: Record<string, string> = { ...prevEnv, version: String(prevVersion) };
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
      // was written at that close. The signed text stays retrievable as the `doc_revision` row
      // that revision was sealed at, with the correction filed as the revision after it.
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
      const bad = await documentGuards(chain, relPath, fixed.content, team, "document_revise");
      if (bad) return text(bad);

      // The revision is allowed, so the source that explains it is written now — before the
      // revision itself, so the link it records has a row to point at.
      if (pendingSource) {
        const src = await saveDocument({
          team, relPath: pendingSource.rel, initiative: parts[0], text: pendingSource.doc,
          by: who.email, flow: "", type: "source", mode: "create", act: "source",
        });
        if ("refusal" in src) return text(src.refusal);
        recordAct(pendingSource.rel,
          { user: who.email, action: "source_add", path: pendingSource.rel, supports: parts[1] });
      }
      // The revision is filed through the one insert path, so its rows land together. `seal` is
      // set only where the initiative is closed: the revision of a closed record inherits the
      // verdict the close rested on.
      const written = await saveDocument({
        team, relPath, initiative: parts[0], text: fixed.content, by: who.email,
        flow: chain.name ?? undefined, type: role,
        mode: "append", act: "revise", note: note ?? null,
        seal: priorApproval?.approved_by && closedOutcome && gatedHere
          ? { by: priorApproval.approved_by, at: dayOf(priorApproval.approved_at) } : null,
        cites: await linkedRevisions(p, team, parts[0], [...linked]),
      });
      if ("refusal" in written) return text(written.refusal);
      // The two fields below are a pair, and the pair carries three states: a flag alone collapses
      // "no cause existed" and "the cause was not captured", and only the second can be fixed.
      //
      // DELIBERATE: this comment sits above the call, not inside it. The gate check holding both names
      // to this payload reads a window around `action: "document_revise"`, so a comment inside the
      // object naming them would satisfy it after the fields were deleted.
      recordAct(relPath, {
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
            (priorApproval
              ? `The revision the person signed — v${priorApproval.revision}, approved by ` +
                `${priorApproval.approved_by} — is filed and untouched. `
              : `No approved revision of v${prevVersion} is filed. `) +
            `What changed here is what the report SAYS, not what it concluded — if the verdict ` +
            `itself was wrong, that is a journal node, not a revision.\n`
          : wasApproved
          ? `The v${prevVersion} approval is filed as its own revision and no longer applies to ` +
            "the current text.\n"
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
        (closedOutcome ? "" : await nextMoveLine(p, team, parts[0])),
      );
    },
  );
}

/** The revisions a revision cites: one `cites` link per source path, at the revision that source
 *  is currently at. A path that names no document is skipped — a revision may cite material the
 *  store does not hold, and a link to a row nobody has is a foreign key Postgres would refuse. */
async function linkedRevisions(
  p: Pick<pg.Pool, "query">, team: string, initiative: string, refs: string[],
): Promise<{ path: string; revision: number }[]> {
  const out: { path: string; revision: number }[] = [];
  for (const ref of refs) {
    const path = `${initiative}/${ref}`;
    const at = await documentAt(p, team, path);
    if (at && at.current_revision !== null) out.push({ path, revision: at.current_revision });
  }
  return out;
}
