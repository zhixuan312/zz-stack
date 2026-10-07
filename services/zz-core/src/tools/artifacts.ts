/**
 * The store: reading, writing and showing a document, and the sources attached to one.
 *
 * Every write goes through the same two steps — `documentGuards` decides whether it may land,
 * `saveDocument` lands it — and no tool here decides either for itself, so a rule added to
 * the guards holds on every path. A document is read back from the row that retained it: `doc`
 * carries its identity and its status, `doc_revision` the bytes it has had, and a path that
 * does not exist is refused rather than answered from a file.
 *
 * `document_present` returns the document rather than a rendering of it, in a review context
 * (review-context.ts): the first present of a context shows the whole current snapshot, a later
 * one what changed since the context last covered it, and every page is recorded with its target
 * and span before the text is returned. What a context covers is what an approval rests on.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { parseCaller } from "@zz/contracts";
import { READS, WRITES, requestHeaders, text } from "@zz/mcp-http";
import type pg from "pg";
import { z } from "zod";

import { chainFor } from "../chain.js";
import { composeReceipt, type Line, mintRef, readDetails, receiptReply, refusalText, replayText,
         settleRefusal } from "../document-details.js";
import { normalizeContent, normalizeRefs, normalizeTags } from "../document-normalize.js";
import { fieldRefusal } from "../document-rules.js";
import { documentGuards } from "../guards.js";
import { auditRoundOf, assessRound } from "../audit-rounds.js";
import { docRows } from "../indexing.js";
import { assessReviewRound, ledgerRefusal, reviewRoundOf, reviewRounds } from "../review-rounds.js";
import { noteDocument, noteSource } from "../host/observe.js";
import { sourceDocument } from "../indexing.js";
import { unopenedRefusal } from "../initiative-record.js";
import { PLAIN_TOKEN, safeName, safePath, tagRefusal, titleSlug, writeGuard } from "../paths.js";
import { registerDocumentEditTool } from "./document-edit.js";
import { registerSourceListTool } from "./source-list.js";
import { registerUploadStartTool } from "./upload-start.js";
import { db, teamFor } from "../platform-db.js";
import { documentAt, documentPaths, loadDocument, loadSnapshot, NO_DB, recordAct } from "../versions.js";
import { saveDocument } from "../document-save.js";
import { citedRevisions, sourceReceipt } from "../source-receipt.js";
import { acceptanceLine, consumptionOf, envelopeOnlyRefusal, NO_TEAM, planCreate, replayFor, requestOf } from "../document-change.js";
import { FILE_INPUT, FILE_META, fileSource, oneBody, stagedUpload, uploadContent, uploadLines } from "../upload-consume.js";
import { present } from "../document-present.js";
import { type PanelDocument, PRESENT_META } from "../document-panel.js";
import { CONTEXT_INPUT, presentRefusal, viewerOf } from "../review-context.js";
import { asksPart, PART_LIMIT, partHeader, slicePart } from "../document-parts.js";
import { journalOrdinal, listJournalNodes, readJournalNode } from "./journal.js";

import { isoToday } from "../write-guards.js";
import { nextMoveLine } from "./initiative-status.js";

/** The part of a long document to return. COUPLED: document-parts.ts slicePart reads these. */
const PART_INPUT = {
  section: z.string().optional()
    .describe("Return only the part under this heading (its text, without the #s), down to the next heading of the same or a higher level."),
  offset: z.number().int().nonnegative().optional()
    .describe("Start at this character — the `Next: offset N` a previous part named."),
  limit: z.number().int().positive().optional()
    .describe(`At most this many characters (default ${PART_LIMIT}).`),
};

/** The ChatGPT `file` route, built once at start: the hosts files are fetched from, and nothing else
 *  from the environment. Empty — the default — and the route is off (upload-consume.ts). */
const FILES = fileSource({ hosts: (process.env.OPENAI_FILE_HOSTS ?? "").split(",").map((h) => h.trim()).filter(Boolean) });

export function registerArtifactTools(server: McpServer): void {
  // The source subject, past what this file holds: `source_add` stays here with the document
  // tools, and the read-back and the start of an upload are each their own file beside it.
  registerSourceListTool(server);
  registerUploadStartTool(server);
  registerDocumentEditTool(server, FILES);
  server.registerTool(
    "document_write",
    {
      annotations: WRITES,
      description:
        "Create a document in your team's store (specs, plans, logs, records). It CREATES ONLY: " +
        "a path that already holds a document is refused, and an existing document changes " +
        "through document_edit. The store is shared with your whole team if you belong to " +
        "one. Paths are relative, e.g. '2026-08-20-sample-intake/spec.md'. " +
        "SEND THE BODY, starting at its first heading: the frontmatter is written by the " +
        "platform from what it already knows, and anything else the document needs — " +
        "`stakeholder`, `tags`, `title`, `fields` — is an argument here. Content that opens with " +
        "an envelope anyway is taken apart and reported: its title, tags, stakeholder and flow " +
        "fields read as those arguments, the fields the platform writes ignored. The initiative must already " +
        "exist: `initiative_open` creates one, and this does not. The FLOW is declared " +
        "there too, never here. What the document rests on is named in `sources`, or passed as " +
        "`source_content` (with `source_title`), which the platform files as a source; sources " +
        "filed since the release that declare they support this document are linked by the " +
        "platform itself, and the reply names every cause. A long file you already have is sent as " +
        "`upload` — the id upload_start answered, once its file is staged — in place of `content`; in ChatGPT, an " +
        "attached file goes as `file`. " +
        "Send one `request_id` per document " +
        "you mean to create and reuse it on every retry of that create: a retry of a create that " +
        "already landed returns its first reply instead of being refused as existing. Every list " +
        "in the reply is counted, and the reply names its complete details as `details: dr_…`, " +
        "which `document_read(path, details_ref)` returns in full.",
      inputSchema: {
        path: z.string(),
        content: z.string().optional().describe("The document's BODY, starting at its first heading. The platform writes the frontmatter."),
        upload: z.string().optional().describe("In place of `content`: the id upload_start answered, once its file is staged."),
        file: FILE_INPUT.optional(),
        stakeholder: z.string().optional().describe("Who asked for this, where the document records one."),
        tags: z.array(z.string()).optional().describe("Index tags for this document."),
        title: z.string().optional().describe("Document title for the index. Defaults to the first heading."),
        fields: z.record(z.string()).optional()
          .describe("This FLOW's own frontmatter fields, e.g. {component: 'billing'}. Not envelope names."),
        sources: z.array(z.string()).optional()
          .describe("Sources this document rests on, as paths inside the initiative, e.g. 'sources/2026-10-06-call.md'."),
        source_content: z.string().optional().describe("Words this document rests on, filed as a new source."),
        source_title: z.string().optional().describe("The title of the source `source_content` files."),
        request_id: z.string().optional().describe("One per document you mean to create, reused on every retry of it."),
      },
      _meta: FILE_META,
    },
    async (args) => {
      const p = db();
      if (!p) return text(NO_DB);
      const who = parseCaller(requestHeaders()).email;
      const team = await teamFor(who);
      if (!team) return text(NO_TEAM);
      // DELIBERATE: the path is resolved before anything about it is judged, as approve, close and
      // document_edit all do, and the canonical form is what the lock, the request key and every row
      // are addressed by. A bad path answered from behind the guards is answered with a complaint
      // about the document's sections instead.
      const path = await safePath(args.path);
      const initiative = path.split("/")[0];
      const now = async () => nextMoveLine(p, team, initiative);
      // (0) A create already committed under this key answers as it did the first time — before
      // the target is found to exist, because the document it made is the one that exists now.
      const replay = await replayFor(p, team, who, path, args, "document_write");
      if (replay) return text("refusal" in replay ? replay.refusal : replayText(replay.replayed, await now()));
      // (1)
      const blocked = writeGuard(path);
      if (blocked) return text(blocked);
      // This write does not create an initiative — `initiative_open` does, and the name shape,
      // the taken check and the flow declaration are asked there, once. What is left here is
      // an existence test.
      const unopened = await unopenedRefusal(p, team, path);
      if (unopened) return text(unopened);
      const twice = oneBody(args); // and an upload read and checked before its bytes are
      if (twice) return text(twice);
      const staged = args.upload !== undefined ? await stagedUpload(p, team, who, args.upload)
        : args.file !== undefined ? await FILES(args.file) : undefined;
      if (staged && "refusal" in staged) return text(staged.refusal);
      // (2) The content in the spelling the store keeps — its envelope, if it sent one, separated
      // and read into the metadata it stands for; an uploaded file read as the file it is — then the
      // rules every write applies to the field names and tags that leaves. Collected, not chained:
      // each fault depends on no other, so every one comes back in one answer.
      const named = { title: args.title, tags: args.tags, stakeholder: args.stakeholder, fields: args.fields };
      const sent = staged ? uploadContent(staged, named) : normalizeContent(args.content ?? "", named);
      const { fields, tags } = "refusals" in sent ? { fields: args.fields, tags: normalizeTags(args.tags).tags } : sent.metadata;
      const ruled = [fieldRefusal(fields), tagRefusal(tags)];
      const read = "refusals" in sent ? sent.refusals
        : [envelopeOnlyRefusal(staged?.text ?? args.content ?? "", sent.body, "document_write")];
      const refused = [...read, ...ruled].filter((r): r is string => r !== null);
      const settle = (reply: string) => settleRefusal(p, { who, team, path }, reply);
      if (refused.length || "refusals" in sent) return text(await settle(refusalText(refused)));
      // (3) onwards: an absent target, its envelope, its causes and its receipt. The flow is read
      // from the record `initiative_open` wrote, never from an argument here: an initiative that
      // acquired a manifest on its second document would have that manifest's gates land on
      // documents already written and unapproved.
      const plan = await planCreate(p, team, who, path, args, sent,
                                    (c) => nextMoveLine(c as pg.Pool, team, initiative), staged);
      if ("reply" in plan) return text(plan.reply);
      const gate = await documentGuards(plan.chain, path, plan.text, team);
      if (gate) return text(await settle(gate));
      // The create takes the per-document lock and finds the path still absent under it, or
      // answers TARGET_EXISTS; a key committed meanwhile replays.
      const written = await saveDocument(plan.write);
      if ("replayed" in written) return text(replayText(written.replayed, await now()));
      if (!("revision" in written)) {
        return text("refusal" in written ? written.refusal : `ERROR: ${path} could not be written`);
      }
      recordAct(path, { user: who, action: "document_write", path, chars: plan.text.length,
                        sources: plan.causes.map((c) => c.path).join(",") });
      // The control loop is told after the write succeeded, never before. `noteDocument`
      // cannot refuse anything — `documentGuards` above has already decided — it only records
      // the fact the close is later derived from.
      //
      // DELIBERATE: awaited, not fired and forgotten. A write that returned before its
      // evidence landed would let a caller write a document and be told the step is unmet.
      await noteDocument(plan.chain, path, "document", { version: written.version, revision: written.revision },
                         who, team);
      const assessed = await acceptanceLine(p, team, plan.chain, path, plan.text);
      return text(receiptReply(written.receipt ?? composeReceipt(plan.lines(written.capturedPath), plan.ref, await now()),
                               assessed));
    },
  );

  server.registerTool(
    "document_read",
    {
      annotations: READS,
      description:
        "Read a document from your team's store. Paths are relative to it — " +
        "`<initiative>/spec.md`. Pass an ARRAY of paths to read several in one call; they " +
        "come back in the order you asked, and a path that cannot be read names its own " +
        "failure without costing you the others. `version: N` reads the copy filed when " +
        "approval N landed instead of the current document — document_present lists which " +
        "versions exist. A search result that came back with `shelf: \"platform\"` " +
        "lives in the journal every team shares, not in yours: pass `scope: \"platform\"` " +
        "with the same path to read it. A document too long for one result — over about " +
        `${PART_LIMIT} characters — is read in parts: \`section\` by heading, or \`offset\` and ` +
        "`limit` in characters. A part states the file's total size, which characters it is, " +
        "and the offset to continue from. `details_ref` — the `dr_…` a reply named — reads that " +
        "reply's complete details instead, a page at a time: send the `cursor` a page ends with " +
        "for the next, until one ends `complete`. `content_revision` — a `cr_…` an envelope or a " +
        "reply named — reads that exact snapshot of one document, whole, for as long as it is retained.",
      inputSchema: {
        path: z.union([z.string(), z.array(z.string())])
          .describe("One path, or an array of paths read in the order given."),
        version: z.number().int().positive().optional()
          .describe("Read the copy filed at approval N instead of the current document."),
        // DELIBERATE: `scope` is read-only and only on this tool. document_write and
        // document_edit stay on the caller's own team; knowledge_add owns the writing side
        // of the shared journal and takes its own `scope`.
        scope: z.enum(["team", "platform"]).optional()
          .describe("Which shelf the path is on. Omit for your team's own store; " +
                    "\"platform\" for the shared journal, as knowledge_search reports it."),
        ...PART_INPUT,
        details_ref: z.string().optional()
          .describe("The `dr_…` a receipt or a refusal named: read its complete details, with `path` the document it named."),
        cursor: z.string().optional().describe("The `dc_…` cursor the last details page ended with."),
        content_revision: z.string().optional()
          .describe("A `cr_…` token: read exactly that snapshot of `path`, whole."),
      },
    },
    async ({ path, version, scope, section, offset, limit, details_ref, cursor, content_revision }) => {
      if (content_revision !== undefined) {
        return text(await snapshotRead({ path, version, scope, section, offset, limit, details_ref, cursor }, content_revision));
      }
      // A details read is its own mode: one document's stored detail, by its ref, page by page.
      if (details_ref !== undefined || cursor !== undefined) {
        return text(await detailsRead({ path, version, scope, section, offset, limit, details_ref, cursor }));
      }
      // Refused before the loop, not once per entry. The shared journal holds no gated
      // documents, so it files no approvals and has no version history; answering per entry
      // would read as a missing file rather than as a request that does not apply.
      if (version !== undefined && scope === "platform") {
        return text("ERROR: `version` reads a copy filed at an approval, and the platform " +
                    "journal keeps none — its nodes are superseded, not versioned. Drop one " +
                    "of the two.");
      }
      const team = await teamFor(parseCaller(requestHeaders()).email);
      // Resolved here rather than inside the platform-shelf branch: a node is a row, and the
      // branch that reads one is not the branch that reads a document.
      const p = db();
      const single = !Array.isArray(path);
      const rows: { rel: string; body: string }[] = [];
      // One bad entry does not cost the others: nothing returns from inside this loop, and
      // every outcome, refusal included, becomes a row.
      for (const rel of (single ? [path as string] : path as string[])) {
        try {
          let readRel = rel;
          // A knowledge node is not a `doc` row, so it is answered from the journal — the one
          // shelf this store does not address. `journal.ts` owns how that address resolves.
          const ordinal = journalOrdinal(rel);
          if (ordinal && p) {
            rows.push({ rel: readRel, body: await readJournalNode(p, { rel, ordinal, team, scope }) });
            continue;
          }
          if (!team) { rows.push({ rel, body: NO_TEAM }); continue; }
          // Resolved before the read: a path that walks out of the store is refused by name
          // rather than looked up as a row.
          await safePath(rel);
          const loaded = await loadDocument(team, rel, version);
          if (!loaded.ok) {
            if (loaded.why === "no_database") { rows.push({ rel, body: loaded.refusal }); continue; }
            if (loaded.why !== "missing") { rows.push({ rel, body: loaded.refusal }); continue; }
            // Says what to call next: a refusal that only names the missing file left one caller
            // presenting another initiative's document instead (eval 2026-09-26, run fc6b98bd).
            //
            // DELIBERATE: no arm here for a journal path. Every `_knowledge/nodes/<ordinal>-…md`
            // is answered by the branch above, on the caller's own shelf or on the platform's, and
            // the arm that used to send the caller to `scope: "platform"` was what turned a
            // team-shelf node into a loop between two refusals.
            const initiative = rel.split("/")[0];
            const hint = !initiative || initiative === rel
              ? ""
              : ` — document_list(prefix: "${initiative}") lists what that initiative holds`;
            const known = !initiative || initiative === rel
              ? true
              : (await documentPaths(team, initiative)).length > 0;
            rows.push({ rel, body: `ERROR: ${rel} does not exist` +
              (hint || (known
                ? ""
                : ` — there is no initiative "${initiative}" in your team's store; initiative_status() lists the open ones`)) });
            continue;
          }
          const bytes = loaded.text;
          readRel = rel;
          // DELIBERATE: parts only when asked. Unasked, the answer is the bytes and nothing else —
          // console-write.ts parses the envelope off that string and hands the whole of it to a
          // model to revise, so a part there would truncate the document it writes back.
          const ask = { section, offset, limit };
          if (!asksPart(ask)) { rows.push({ rel: readRel, body: bytes }); continue; }
          const part = slicePart(bytes, ask);
          rows.push({ rel: readRel, body: typeof part === "string" ? part
            : `${partHeader(readRel, part, "the whole file, frontmatter included", bytes)}\n\n${part.text}` });
        } catch (err) {
          // safePath throws a Refusal for a path that walks out of the store or is the wrong
          // shape. Caught here so it becomes a row rather than ending the call and discarding
          // the entries that were fine.
          rows.push({ rel, body: err instanceof Error ? err.message : String(err) });
        }
      }
      // DELIBERATE: the response shape follows the request shape, not the count. `path: "x"`
      // is the bytes and nothing else — console-write.ts and the chain check consume that
      // string directly — and `path: ["x"]` is labelled even at length one.
      return text(single
        ? rows[0]?.body ?? ""
        : rows.map((r) => `── ${r.rel} ──\n${r.body}`).join("\n\n"));
    },
  );

  // COUPLED: this note stays outside the registration below. scripts/gate/checks/
  // documents-lifecycle.ts reads the whole registration body, comments included, and fails on
  // a renderer's name in it.
  //
  // The platform renders nothing: the body goes back as markdown, unfenced and unescaped,
  // because every interface renders markdown itself and a fenced body is source presented as
  // syntax.
  //
  // It never judges: no summary, no score. What it adds over document_read is that the
  // envelope is stated separately, so the facts that decide an approval are not buried in
  // frontmatter the reader has to parse.
  //
  // It does not guarantee anybody saw it: a tool result is model input, not a display.
  server.registerTool(
    "document_present",
    {
      annotations: READS,
      description:
        "Put a document from your team's store in front of the person. Returns its body as " +
        "markdown, with its path, version, status, approval and the versions filed for it stated " +
        "separately — the document itself, never a summary. Every present is part of a REVIEW " +
        "CONTEXT: the reply names one (`Review context: rc_…`) — pass it back as `review_context` on " +
        "the next present of the same document and you are shown only what changed since that " +
        "context last covered it (each change named, then every added or edited section in full); " +
        "`full: true` shows it whole. Without `review_context` a new context starts, in full. An " +
        "ARRAY of paths presents each in full, in its own context. Call it after writing or editing, " +
        "in a SEPARATE call once the write has returned, never alongside the write in one batch: " +
        "parallel calls have no order between them. Paths are relative to the store — " +
        `\`<initiative>/spec.md\`. Text longer than ${PART_LIMIT} characters comes back in parts: each ` +
        "part names the next `offset` and the review_context to pass with it. A document counts as " +
        "presented — and document_approve accepts it — once its current content is covered in a " +
        "context: every character of it, or of what changed since a covered baseline, delivered. " +
        "`version: N` and `section` are reads beside the review: they count nothing towards approval.",
      inputSchema: {
        path: z.union([z.string(), z.array(z.string())])
          .describe("One path, or an array of paths presented in the order given."),
        version: z.number().int().positive().optional()
          .describe("Show the copy filed at approval N instead of the current document."),
        ...PART_INPUT,
        ...CONTEXT_INPUT,
      },
      _meta: PRESENT_META,
    },
    async ({ path, version, section, offset, limit, review_context, full }) => {
      // The arguments first: a combination no present can serve is answered before anything is read.
      const ask = { review_context, full, version, section, offset, limit };
      const refused = presentRefusal(path, ask);
      if (refused) return text(refused);
      const user = parseCaller(requestHeaders()).email;
      const team = await teamFor(user);
      const p = db();
      if (!p || !team) return text(NO_TEAM);
      const single = !Array.isArray(path);
      const out: string[] = [];
      // What the document panel draws — every document whole, whatever part the text carries.
      const panel: PanelDocument[] = [];
      const reading = asksPart({ section, offset, limit });
      // COUPLED: the record of what was shown is written by `present` (document-present.ts), once
      // per document and in that document's own review context, and nothing in this registration
      // touches it. checks/document-reads.ts asserts both halves.
      for (const rel of (single ? [path as string] : path as string[])) {
        await safePath(rel);
        // A path that names no document is answered with what the initiative DOES hold. The
        // initiative is taken off the path, never off a resolved one — `safePath` has already
        // refused anything that walks out.
        const at = await documentAt(p, team, rel);
        if (!at) {
          const initiative = rel.replace(/^\/+/, "").split("/")[0];
          const held = (await documentPaths(team, initiative))
            .filter((x) => x.startsWith(`${initiative}/`) && x.slice(initiative.length + 1).indexOf("/") < 0)
            .map((x) => x.slice(initiative.length + 1)).sort();
          // Two answers: an empty list means either the initiative is there and holds no
          // document, or there is no such initiative, and those want different next moves.
          out.push(held.length
            ? `ERROR: no document at \`${rel}\`. The initiative holds: ${held.join(", ")}. ` +
              `Ask for one of those by its full path, \`${initiative}/<name>\`, or call ` +
              "document_list to see the rest of the store."
            : `ERROR: no document at \`${rel}\`. The initiative holds: nothing this tool can ` +
              `show — \`${initiative}\` is empty or is not an initiative in your team. Call ` +
              "document_list to see what the store does hold, then ask again by full path.");
          continue;
        }
        // A part asked for is the model reading, not a person being shown: in ChatGPT every paging
        // call drew the whole document again, in a new panel, under the last one (0.92.0).
        const shown = await present(p, viewerOf(team), rel.replace(/^\/+/, ""), ask, !reading);
        out.push(shown.text);
        if (shown.panel) panel.push(shown.panel);
      }
      // `_meta`, never `structuredContent`: see document-panel.ts for what each client shows a model.
      return { ...text(out.join("\n\n────────\n\n")),
               _meta: { "zz-core/documents": panel, ...(reading ? { "zz-core/reading": true } : {}) } };
    },
  );

  server.registerTool(
    "document_list",
    {
      annotations: READS,
      description:
        "List the paths in your team's store (shared with every member of it), sorted: each " +
        "initiative's documents and its `sources/` files, plus the team's journal nodes under " +
        "`_knowledge/nodes/` when `prefix` is omitted or names `_knowledge`. `prefix` narrows " +
        "to one initiative or a folder inside one, e.g. '2026-08-20-sample-intake/sources'. " +
        "RETURNS a JSON array of paths and nothing else — no status, version or content: " +
        "`initiative_status` says where work stands and `document_read` returns a document. " +
        "Returns [] when the caller acts for no team. Platform-shelf nodes are not listed; " +
        "`knowledge_search` finds them.",
      inputSchema: { prefix: z.string().optional() },
    },
    async ({ prefix }) => {
      const team = await teamFor(parseCaller(requestHeaders()).email);
      if (!team) return text(JSON.stringify([]));
      const base = prefix?.replace(/\/+$/, "");
      const docs = await documentPaths(team, base || undefined);
      // The journal is not a `doc` row, so `documentPaths` cannot see it: a node lives in
      // `zz.knowledge_node` and its address is derived from the ordinal and the slug the row
      // carries. Listed only when the prefix asks for the journal or for nothing: a prefix
      // naming an initiative is a question about that initiative's documents.
      const wantsJournal = !base || base === "_knowledge" || base.startsWith("_knowledge/");
      if (!wantsJournal) return text(JSON.stringify(docs));
      const p = db();
      if (!p) return text(JSON.stringify(docs));
      const journal = await listJournalNodes(p, team, base ?? "");
      return text(JSON.stringify([...docs, ...journal].sort()));
    },
  );

  // Knowledge tools: format is mechanical, judgment stays with skills.

  server.registerTool(
    "source_add",
    {
      annotations: WRITES,
      description:
        "Attach supporting material (meeting minutes, an email excerpt, call notes, a decision " +
        "taken elsewhere) to an initiative. Ungated and immutable — anyone on the team may add " +
        "one at any time, from any harness, including while the work is in flight. Name in " +
        "`supports` every document this material bears on: each of those documents is then " +
        "flagged for refinement if it was already approved, and initiative_status reports it as " +
        "the next move. This is how information reaches work without editing around the gates. A file " +
        "you have goes as `upload` (upload_start's id, once staged) in place of `content` — in ChatGPT, an attached " +
        "file as `file` — kept as it is. " +
        "Reuse one `request_id` on every retry of a source: a retry returns the one filed first, any day.",
      inputSchema: {
        initiative: z.string(),
        title: z.string(),
        content: z.string().optional(),
        upload: z.string().optional().describe("In place of `content`: the id upload_start answered, once its file is staged."),
        file: FILE_INPUT.optional(),
        request_id: z.string().optional().describe("One per source you mean to add, reused on every retry of it."),
        supports: z.union([z.string(), z.array(z.string())]).optional()
          .describe("Document(s) this material bears on, e.g. 'spec.md' or ['spec.md','plan.md']."),
        stage: z.string().optional()
          .describe("The flow stage this source is the output of, when it is one — an audit round " +
                    "names its audit stage, e.g. 'sdlc-spec-audit', and a review round the stage " +
                    "that writes the verifying document, e.g. 'sdlc-review', with its ```json " +
                    "ledger in `content`. Only a source naming its stage counts as that stage's round."),
      },
      _meta: FILE_META,
    },
    async ({ initiative, title, content, upload, file, supports, stage, request_id }) => {
      // The same guard the other initiative-taking tools apply. safePath below only
      // stops a path leaving the store, which is a different question from whether the name
      // is an initiative — and `join(root, initiative, d)` further down asks the second one.
      const badInitiative = safeName(initiative, "initiative");
      if (badInitiative) return text(badInitiative);
      const who = parseCaller(requestHeaders());
      // The string form is split on commas, so `supports: "intent.md, spec.md"` and the array
      // form mean the same thing. Unsplit it is one entry containing a comma, which the check
      // below refuses.
      // Each in its canonical spelling — `./spec`, `<initiative>/spec.md` and `spec` all name
      // `spec.md` — so the link it declares is filed rather than waiting on a name nothing has.
      // One entry at a time, so every entry that cannot be one comes back in one answer.
      const named = (Array.isArray(supports) ? supports : supports ? supports.split(",") : [])
        .map((x) => x.trim()).filter(Boolean).map((x) => normalizeRefs([x], initiative.trim(), "supports entry"));
      const list = named.flatMap((n) => ("refs" in n ? n.refs : []));
      const normalised = named.flatMap((n) => ("normalised" in n ? n.normalised : []));
      // These are written into YAML and read back by a comma-splitter, so a separator inside
      // one becomes two entries and a bracket or newline ends the envelope. They name
      // documents — single path segments.
      const badSupports = [...named.flatMap((n) => ("refusals" in n ? n.refusals : [])),
        ...list.filter((d) => !PLAIN_TOKEN.test(d.trim())).map((d) => `ERROR: supports entry "${d}" must be a document name — ` +
          "letters, digits, dot, dash or underscore, nothing else")];
      const slug = titleSlug(title, "source");
      const date = isoToday();
      // The name asked for; a source already filed under it today makes the write take the first
      // free suffix instead (`reserveName`), under the lock, and the reply says so.
      const asked = `${initiative}/sources/${date}-${slug}.md`;
      // `initiative` is caller-supplied, so the assembled path is too. Cheap to check,
      // and it is what stops a tool added later from being the exception.
      const blocked = writeGuard(asked, "source_add");
      if (blocked) return text(blocked);
      // The second creation path: `mkdirSync(..., {recursive:true})` below would build
      // `<initiative>/sources/` for an initiative nobody opened, leaving a half-initiative
      // with material in it and no record of anyone opening it.
      const p0 = db();
      if (!p0) return text(NO_DB);
      const team0 = await teamFor(who.email);
      if (!team0) return text(NO_TEAM);
      const unopened = await unopenedRefusal(p0, team0, asked);
      if (unopened) return text(unopened);
      await safePath(asked);
      const p = p0;
      const team = team0;
      const settle = (reply: string) => settleRefusal(p, { who: who.email, team, path: asked }, reply);
      // (1) A source this key already filed answers as it did — on any later day, before the upload
      // is looked at. The key is held in `<initiative>/sources`, not at the path a day names.
      const keyed = { initiative, title, content, upload, file, supports, stage, request_id };
      const replay = await replayFor(p, team, who.email, `${initiative}/sources`, keyed, "source_add");
      if (replay) return text("refusal" in replay ? replay.refusal : replayText(replay.replayed, await nextMoveLine(p, team, initiative)));
      if (badSupports.length) return text(await settle(refusalText(badSupports)));
      const twice = oneBody({ content, upload, file });
      if (twice) return text(twice);
      const staged = upload !== undefined ? await stagedUpload(p, team, who.email, upload)
        : file !== undefined ? await FILES(file) : undefined;
      if (staged && "refusal" in staged) return text(staged.refusal);
      const words = staged ? staged.text : content ?? ""; // literally, whatever its extension
      // An audit round is a source that names the stage producing it and supports the document
      // that stage audits. Anything else is material, however it is titled: a stakeholder's
      // answers support spec.md too, and counting them as a round would let a spec pass its
      // audit without anybody auditing it.
      const governing = await chainFor(p, team, `${initiative}/x.md`);
      const review = reviewRoundOf(governing, stage, list);
      // A review round's ledger is what the next move is computed from, so a malformed one is
      // refused here, before anything is written: a source cannot be corrected once it lands.
      if (review) {
        const earlier = reviewRounds(await docRows(p, team, initiative), review.stage, review.document)
          .map((r) => r.ledger);
        const refused = ledgerRefusal(words, earlier, review.document);
        if (refused) return text(await settle(refused));
      }
      const round = auditRoundOf(governing, stage, list) ?? review;
      const cited = round ? await documentAt(p, team, `${initiative}/${round.document}`) : null;
      // The PUBLIC version the round read, the one a reader is shown — not the snapshot id.
      const auditsVersion = round && !review && cited?.current_version != null
        ? String(cited.current_version) : undefined;
      const doc = sourceDocument(
        { title, by: who.email, day: date, content: words, supports: list,
          stage: round ? round.stage : undefined, audits_version: auditsVersion });
      // Which of the named documents were already approved when this landed? An audit round lands
      // on an approved document by design — the next move says what follows from it. And which do
      // not exist yet: a `supports` link needs a document to point at, so `saveDocument` files
      // none for these — said here rather than dropped without a word.
      const stale: string[] = [];
      const unwritten: string[] = [];
      for (const d of list) {
        const at = await documentAt(p, team, `${initiative}/${d}`);
        if (!at) unwritten.push(d);
        else if (!round && at.status === "approved") stale.push(d);
      }
      // The receipt, composed by the write once the name it filed is settled; its detail is the
      // source's own act row.
      const ref = mintRef();
      const lines = (rel: string): Line[] => sourceReceipt({ rel, asked, list, normalised, round, auditsVersion,
                                                            stage, review: !!review, unwritten, stale,
                                                            upload: staged ? uploadLines(staged) : [] });
      const wrote = await saveDocument({
        team, relPath: asked, initiative, text: doc, by: who.email, flow: "", reserveName: true,
        // The stage is kept on the row's `type`: a source has no flow role, and the round it
        // was recorded as is the one fact about it the store states beside its title. A source
        // that is not a round of any stage is typed `source`.
        type: round ? round.stage : "source",
        cites: await citedRevisions(p, team, initiative, list),
        // The same list, as the relation it is. `list` is what the caller said this source bears
        // on — `supports: ["review.md"]` — and it is a relation to the DOCUMENT, not to a revision
        // of it, so it lands as `doc_link` rows of kind `supports` rather than as a citation. The
        // two are different facts: `cites` is what the source read, `supports` is what it is for.
        supports: list.map((d) => `${initiative}/${d}`),
        mode: "create", act: "source",
        change: { nextVersion: false, receipt: async (_c, _captured, filed) => composeReceipt(lines(filed), ref, ""),
                  request: requestOf(keyed, who.email, `${initiative}/sources`, { result: "created" }, "source_add", staged),
                  upload: consumptionOf(keyed, "source_add", staged) },
      });
      if ("replayed" in wrote) return text(replayText(wrote.replayed, await nextMoveLine(p, team, initiative)));
      if (!("revision" in wrote)) return text("refusal" in wrote ? wrote.refusal : `ERROR: ${asked} could not be written`);
      const rel = wrote.reserved ?? asked;
      recordAct(rel, { user: who.email, action: "source_add", path: rel, supports: list.join(",") });
      // An audit evidences itself with a source, which is why this call is here and not in a
      // tool named for auditing: `sdlc-spec-audit` and `sdlc-plan-audit` are declared as
      // producing a source that supports the document they audited, and no document of their
      // own. Only a source naming its audit stage is that step's evidence; other material is
      // recorded and flagged, and credits no step.
      //
      // DELIBERATE: `governing` is resolved from `<initiative>/x.md`, not from the source's own
      // path. `chainFor` answers for a document the flow declares; a source lives under
      // `sources/` and carries no `flow:`, so its own path returns EMPTY_CHAIN. This is the form
      // `initiative_open` uses to resolve a chain before any document exists.
      const sourceTeam = await teamFor(who.email);
      if (round && !review) await noteSource(governing, rel, round.document, who.email, sourceTeam);
      // The round is assessed the moment it lands, so the next move can route on it: does it
      // reopen something already agreed. A review round asks `repeats_finding` once per S1/S2
      // finding it introduces.
      const assessed = review
        ? await assessReviewRound(p, team, initiative, rel, review.stage, review.document, who.email)
        : round ? await assessRound(p, team, initiative, rel, round.document, words, who.email) : null;
      return text(receiptReply(wrote.receipt ?? composeReceipt(lines(rel), ref, ""), assessed ? `\n${assessed}` : "") +
        await nextMoveLine(p, team, initiative));
    },
  );

}

/** `document_read(path, details_ref, cursor?)`: the page of a stored detail, for the caller's team
 *  and the path the detail is about — so a refused create's detail is readable though no document
 *  exists. Every other way to narrow a read is another mode, and refused with it. */
async function detailsRead(a: { path: string | string[]; version?: number; scope?: string; section?: string;
                                offset?: number; limit?: number; details_ref?: string; cursor?: string }): Promise<string> {
  const others = [a.section !== undefined && "`section`", a.offset !== undefined && "`offset`",
                  a.limit !== undefined && "`limit`", a.version !== undefined && "`version`",
                  a.scope === "platform" && "`scope: \"platform\"`", Array.isArray(a.path) && "an array `path`"]
    .filter((x): x is string => typeof x === "string");
  if (a.details_ref === undefined) {
    return "ERROR: INVALID_MODE — `cursor` continues a details read; send it with the `details_ref` it belongs to.";
  }
  if (others.length) {
    return `ERROR: INVALID_MODE — \`details_ref\` reads one reply's complete details, page by page, and cannot ` +
      `be combined with ${others.join(", ")}. Send \`path\` (the one document the reply named), \`details_ref\` and ` +
      "the `cursor` the last page named.";
  }
  const p = db();
  if (!p) return NO_DB;
  const team = await teamFor(parseCaller(requestHeaders()).email);
  if (!team) return NO_TEAM;
  return readDetails(p, team, await safePath(a.path as string), a.details_ref, a.cursor);
}

/** `document_read(path, content_revision)`: one exact retained snapshot of one document, whole.
 *  Every other way to narrow or redirect a read is another mode, and refused with it. */
async function snapshotRead(a: { path: string | string[]; version?: number; scope?: string; section?: string;
                                 offset?: number; limit?: number; details_ref?: string; cursor?: string },
                            token: string): Promise<string> {
  const others = [a.version !== undefined && "`version`", a.details_ref !== undefined && "`details_ref`",
                  a.cursor !== undefined && "`cursor`", a.section !== undefined && "`section`",
                  a.offset !== undefined && "`offset`", a.limit !== undefined && "`limit`",
                  a.scope === "platform" && "`scope: \"platform\"`", Array.isArray(a.path) && "an array `path`"]
    .filter((x): x is string => typeof x === "string");
  if (others.length) {
    return `ERROR: INVALID_MODE — \`content_revision\` reads one exact snapshot of one document, whole, and ` +
      `cannot be combined with ${others.join(", ")}. Send \`path\` and \`content_revision\` alone.`;
  }
  const team = await teamFor(parseCaller(requestHeaders()).email);
  if (!team) return NO_TEAM;
  const loaded = await loadSnapshot(team, await safePath(a.path as string), token);
  return loaded.ok ? loaded.text : loaded.refusal;
}
