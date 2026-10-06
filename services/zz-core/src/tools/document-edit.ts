/**
 * `document_edit` — every change to an existing document, one tool.
 *
 * Beside `artifacts.ts` rather than in it, and registered from there the way `source_list` is: the
 * document tools already fill that file. What a call changes, what caused it and which public
 * version it lands in are computed by the change service (`document-change.ts`); this handler runs
 * the guards on that candidate and writes it, so the path every write takes — `writeGuard`, then
 * `documentGuards`, then `saveDocument` — is read here in one place.
 *
 * A change commits only onto the state it was computed from. When the document moved in between,
 * `saveDocument` sends it back and the call is computed again from the top — a request key looked
 * up again, the document read again — at most MAX_ATTEMPTS times.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { parseCaller } from "@zz/contracts";
import { WRITES, requestHeaders, text } from "@zz/mcp-http";
import type pg from "pg";
import { z } from "zod";

import { acceptanceLine, callRefusals, MAX_ATTEMPTS, NO_TEAM, planEdit, replayFor,
         RETRYABLE_UNAVAILABLE } from "../document-change.js";
import { composeReceipt, receiptReply, refusalText, replayText, settleRefusal } from "../document-details.js";
import { MAX_EDITS } from "../document-edits.js";
import { normalizeTags } from "../document-normalize.js";
import { fieldRefusal } from "../document-rules.js";
import { saveDocument } from "../document-save.js";
import { documentGuards } from "../guards.js";
import { noteDocument, noteRevision } from "../host/observe.js";
import { insertEvent } from "../indexing.js";
import { unopenedRefusal } from "../initiative-record.js";
import { safePath, tagRefusal, writeGuard } from "../paths.js";
import { db, teamFor } from "../platform-db.js";
import { NO_DB, recordAct } from "../versions.js";
import { nextMoveLine } from "./initiative-status.js";

export function registerDocumentEditTool(server: McpServer): void {
  server.registerTool("document_edit", {
    annotations: WRITES,
    description:
      "Change an existing document by sending only what changed. ONE body change per call: " +
      "`edits` — 1 to " + MAX_EDITS + " exact {find, replace} pairs, each `find` occurring exactly " +
      "once in the document as it is now (an empty `replace` deletes; the batch is all or nothing, " +
      "and a replacement never becomes another edit's target); or `section` with `content` — the " +
      "section's new text, heading line first, with `section_level` and `section_occurrence` to pick " +
      "among headings of the same name; or `content` alone — the whole body, only when the change " +
      "is not one section's. Metadata — `title`, `tags`, `stakeholder`, `fields` — may come with any " +
      "of them, or ALONE: a metadata-only call changes no body and never needs a cause. " +
      "An APPROVED document's body changes only with its cause: name an existing source in " +
      "`sources`, or pass the words that caused it as `source_content` (with `source_title`), which " +
      "the platform files as a source. A cause new to the current version opens the next version, as " +
      "a draft; the approved version stays readable. Sources filed since the release that declare " +
      "they support this document are linked by the platform itself and named in the reply. `note` " +
      "is the version's one-line note. Send the `content revision` your last read returned as `base` " +
      "and a change made to a document that moved since is refused instead of landing on text you " +
      "did not read. Send one `request_id` per intended change and reuse it on every retry of that " +
      "change: a retry of a change that already landed returns its first reply instead of landing " +
      "twice. Every list in the reply is counted — `causes (3): …` — and every reply names its " +
      "complete details as `details: dr_…`, which `document_read(path, details_ref)` returns in full.",
    inputSchema: {
      path: z.string(),
      edits: z.array(z.object({ find: z.string(), replace: z.string() })).optional()
        .describe(`1..${MAX_EDITS} exact edits, applied together.`),
      section: z.string().optional().describe("The heading text of the section `content` replaces."),
      section_level: z.number().int().optional().describe("1..4: the heading's level, when several share its text."),
      section_occurrence: z.number().int().optional()
        .describe("1-based: which of the headings left after `section` and `section_level`."),
      content: z.string().optional()
        .describe("With `section`: the section's new text, heading line first. Alone: the whole body."),
      upload: z.string().optional(), file: z.record(z.unknown()).optional(),
      sources: z.array(z.string()).optional()
        .describe("Sources that caused this change, as paths inside the initiative, e.g. 'sources/2026-10-06-call.md'."),
      source_content: z.string().optional().describe("The words that caused this change, filed as a new source."),
      source_title: z.string().optional().describe("The title of the source `source_content` files."),
      note: z.string().optional().describe("One line on what this version is; stored as its revision note."),
      title: z.string().optional(), tags: z.array(z.string()).optional(),
      stakeholder: z.string().optional(), fields: z.record(z.string()).optional(),
      base: z.string().optional().describe("The `content revision` your last read returned."),
      request_id: z.string().optional().describe("One per intended change, reused on every retry of it."),
    },
  }, async (args) => {
    const p = db();
    if (!p) return text(NO_DB);
    const who = parseCaller(requestHeaders()).email;
    const team = await teamFor(who);
    if (!team) return text(NO_TEAM);
    // DELIBERATE: the path is resolved before anything about it is judged, and the canonical form
    // is what the lock, the request key and every row are addressed by.
    const path = await safePath(args.path);
    const initiative = path.split("/")[0];
    // The next move a receipt states, read on the client it is handed — the write's own, so it is
    // the move the committed change will show.
    // DELIBERATE: a transaction's client is not a pool, and the next move asks nothing but `query`.
    const moveOf = (c: Pick<pg.Pool, "query">) => nextMoveLine(c as pg.Pool, team, initiative);
    const now = async () => nextMoveLine(p, team, initiative);
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      // (0) A request already committed under this key answers as it did the first time.
      const replay = await replayFor(p, team, who, path, args);
      if (replay) return text("refusal" in replay ? replay.refusal : replayText(replay.replayed, await now()));
      // (1)
      const blocked = writeGuard(path);
      if (blocked) return text(blocked);
      const unopened = await unopenedRefusal(p, team, path);
      if (unopened) return text(unopened);
      // (2) The rules every write applies to a caller's field names and tags — the tags lower-cased
      // first, as they will be stored. An envelope sent in whole `content` is the change service's
      // to separate (8), and its tags are held to the same rule there; refused here, the call is
      // also read as (8) would read it, so every fault that depends on no other comes back at once.
      const { fields } = args;
      const { tags } = normalizeTags(args.tags);
      const malformed = [fieldRefusal(fields), tagRefusal(tags)].filter((r): r is string => r !== null);
      if (malformed.length) {
        const all = [...new Set([...malformed, ...callRefusals(args, initiative)])];
        return text(await settleRefusal(p, { who, team, path }, refusalText(all)));
      }
      // (3)–(10)
      const plan = await planEdit(p, team, who, path, args, moveOf);
      if ("reply" in plan) return text(plan.reply);
      // An unkeyed no_change writes no document row, only the record its receipt's details_ref
      // names — awaited, so the ref the reply prints names a row that is there.
      if (plan.noChange && args.request_id === undefined) {
        const receipt = composeReceipt(plan.lines(), plan.ref, await now());
        const recorded = await insertEvent(p, { actor: who, team, initiative, kind: "document.edit", subject: path,
          detail: { user: who, action: "edit", path, result: "no_change", details_ref: plan.ref, details: receipt.details.text } });
        return text(recorded.ok ? receiptReply(receipt)
          : receiptReply({ ...receipt, text: receipt.text.replace(`\`${plan.ref}\``, () => `not recorded (${recorded.error})`) }));
      }
      // (11) The guards, on the whole candidate. `via`: this tool composes the governance fields
      // itself — it carries an outcome forward and takes an approval off — so the three guards
      // that refuse a caller writing them by hand stand aside, as they do for the other acts.
      const bad = plan.noChange ? null : await documentGuards(plan.chain, path, plan.text, team, "document_edit");
      if (bad) return text(bad);
      const written = await saveDocument(plan.write);
      if ("retry" in written) continue;
      // The same key committed between the lookup above and the lock: its receipt, as (0) gives it.
      if ("replayed" in written) return text(replayText(written.replayed, await now()));
      if ("refusal" in written) return text(written.refusal);
      const receipt = written.receipt ?? composeReceipt(plan.lines(written.capturedPath), plan.ref, await now());
      if (plan.noChange) return text(receiptReply(receipt));
      recordAct(path, { user: who, action: "document_edit", path, version: written.version,
                        sources: plan.causes.map((c) => c.path).join(","), explained: plan.causes.length > 0 });
      // The control loop is told after the write, never before. A new version, or an approved
      // snapshot turned into a draft, withdraws the approval it displaced; anything else is a
      // document fact. Awaited: a reply that returned before its evidence landed would let a
      // caller be told the step is unmet.
      const at = { version: written.version, revision: written.revision };
      if (written.newVersion || plan.replaced) {
        await noteRevision(plan.chain, path, at, plan.replaced, who, team);
      } else {
        await noteDocument(plan.chain, path, "document", at, who, team);
      }
      return text(receiptReply(receipt, await acceptanceLine(p, team, plan.chain, path, plan.text)));
    }
    return text(RETRYABLE_UNAVAILABLE);
  });
}
