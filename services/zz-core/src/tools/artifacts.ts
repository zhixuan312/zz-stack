/**
 * The store: reading, writing and showing a document, and the sources attached to one.
 *
 * Every write goes through the same two steps — `documentGuards` decides whether it may land,
 * `saveDocument` lands it — and no tool here decides either for itself, so a rule added to
 * the guards holds on every path. A document is read back from the row that retained it: `doc`
 * carries its identity and its status, `doc_revision` the bytes it has had, and a path that
 * does not exist is refused rather than answered from a file.
 *
 * `document_present` returns the document rather than a rendering of it, and stamps
 * `doc_revision.presented_at` on the revision it showed. That stamp is what makes "was this
 * fetched before its gate was approved" answerable per document: `attest.ts` reads it against
 * the revision's own `written_at`, and `document_approve` refuses a revision that was not shown
 * after it was written. A column and not a log entry, because a log can be swept and a gate
 * backed by one fails open.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { parseCaller } from "@zz/contracts";
import { READS, WRITES, requestHeaders, text } from "@zz/mcp-http";
import type pg from "pg";
import { z } from "zod";

import { chainFor } from "../chain.js";
import { envelopeEditRefusal, fieldRefusal, frontmatterRefusal } from "../document-rules.js";
import { documentGuards } from "../guards.js";
import { type Chain } from "../write-guards.js";
import { auditRoundOf, assessRound } from "../audit-rounds.js";
import { docRows } from "../indexing.js";
import { assessAcceptance, verifyingDoc } from "../review-acceptance.js";
import { assessReviewRound, ledgerRefusal, reviewRoundOf, reviewRounds } from "../review-rounds.js";
import { noteDocument, noteSource } from "../host/observe.js";
import { sourceDocument } from "../indexing.js";
import { unopenedRefusal } from "../initiative-record.js";
import { PLAIN_TOKEN, safeName, safePath, tagRefusal, titleSlug, writeGuard } from "../paths.js";
import { registerDocumentEditTool } from "./document-edit.js";
import { registerSourceListTool } from "./source-list.js";
import { registerSourceUploadTool } from "./source-upload.js";
import { db, teamFor } from "../platform-db.js";
import { dayOf, documentAt, documentPaths, loadDocument, recordAct, revisionsOf } from "../versions.js";
import { saveDocument } from "../document-save.js";
import { present } from "../document-present.js";
import { type PanelDocument, panelDocument, PRESENT_META } from "../document-panel.js";
import { asksPart, PART_LIMIT, partHeader, slicePart } from "../document-parts.js";
import { journalOrdinal, listJournalNodes, readJournalNode } from "./journal.js";

import { envelopeFor, isoToday, normalizeSections } from "../write-guards.js";
import { nextMoveLine } from "./initiative-status.js";

/** A deployment with no database has no store left: the columns are where a document lives, and
 *  there is no file to fall back to. Said once, in the refusals that would otherwise reach a
 *  pool that is not there. */
export const NO_DB = "ERROR: no platform database — the store is the database now, so there is " +
  "nowhere to read or write this document.";

/** A person the platform cannot place in a team has no store to act on. */
export const NO_TEAM = "ERROR: you are not in a team — a team's documents live in the database under " +
  "its own membership, and nothing resolves you to one.";

/** The part of a long document to return. COUPLED: document-parts.ts slicePart reads these. */
const PART_INPUT = {
  section: z.string().optional()
    .describe("Return only the part under this heading (its text, without the #s), down to the next heading of the same or a higher level."),
  offset: z.number().int().nonnegative().optional()
    .describe("Start at this character — the `Next: offset N` a previous part named."),
  limit: z.number().int().positive().optional()
    .describe(`At most this many characters (default ${PART_LIMIT}).`),
};

export function registerArtifactTools(server: McpServer): void {
  // The source subject, past what this file holds: `source_add` stays here with the document
  // tools, and the read-back and the upload's other half are each their own file beside it.
  registerSourceListTool(server);
  registerSourceUploadTool(server);
  registerDocumentEditTool(server);
  server.registerTool(
    "document_write",
    {
      annotations: WRITES,
      description:
        "Create or overwrite a document in your team's store (specs, plans, " +
        "logs, records). The store is shared with your whole team if you belong to " +
        "one. Paths are relative, e.g. '2026-08-20-sample-intake/spec.md'. " +
        "SEND THE BODY, starting at its first heading: the frontmatter is written by the " +
        "platform from what it already knows, and anything else the document needs — " +
        "`stakeholder`, `tags`, `title` — is an argument here. The initiative must already " +
        "exist: `initiative_open` creates one, and this does not. The FLOW is declared " +
        "there too, never here.",
      inputSchema: {
        path: z.string(),
        content: z.string().describe("The document's BODY, starting at its first heading. No frontmatter — the platform writes that."),
        stakeholder: z.string().optional().describe("Who asked for this, where the document records one."),
        tags: z.array(z.string()).optional().describe("Index tags for this document."),
        title: z.string().optional().describe("Document title for the index. Defaults to the first heading."),
        fields: z.record(z.string()).optional()
          .describe("This FLOW's own frontmatter fields, e.g. {component: 'billing'}. Not envelope names."),
      },
    },
    async ({ path, content, stakeholder, tags, title, fields }) => {
      const blocked = writeGuard(path);
      if (blocked) return text(blocked);
      const refused = frontmatterRefusal(content, "document_write") ?? fieldRefusal(fields)
        ?? tagRefusal(tags);
      if (refused) return text(refused);
      const p = db();
      if (!p) return text(NO_DB);
      const who = parseCaller(requestHeaders()).email;
      const team = await teamFor(who);
      if (!team) return text(NO_TEAM);
      // DELIBERATE: the path is resolved before the guards run, as approve, close,
      // document_patch and document_revise all do. A bad path answered from behind the guards
      // is answered with a complaint about the document's sections instead.
      await safePath(path);
      // This write does not create an initiative — `initiative_open` does, and the name shape,
      // the taken check and the flow declaration are asked there, once. What is left here is
      // an existence test.
      const unopened = await unopenedRefusal(p, team, path);
      if (unopened) return text(unopened);
      // The flow is read from the record `initiative_open` wrote, never from an argument here:
      // an initiative that acquired a manifest on its second document would have that
      // manifest's gates land on documents already written and unapproved.
      const chain = await chainFor(p, team, path, content);
      // The document already there is read before it is overwritten: the overwrite half of
      // "create or overwrite" has to preserve the fields the platform wrote on the previous
      // copy — see envelopeFor's `carry`. Read from the rows, which are the authority: a
      // document whose file is gone still carries its own verdicts.
      const prev = await documentAt(p, team, path);
      const carry: Record<string, string> = {};
      if (prev) {
        const rev = prev.current_revision === null
          ? null : (await revisionsOf(p, prev.id)).find((r) => r.revision === prev.current_revision);
        if (prev.status) carry.status = prev.status;
        if (rev?.approved_by) carry.approved_by = rev.approved_by;
        if (rev?.approved_at) carry.approved_at = dayOf(rev.approved_at);
        if (prev.current_revision !== null) carry.version = String(prev.current_revision);
      }
      // An approved document is not overwritten by a write: the bytes a person signed would be
      // replaced under their name. Asked of the row, which is where the verdict lives — the
      // guard asks the file, and a store that has not been mirrored yet answers nothing.
      if (prev?.status === "approved") {
        return text(
          `ERROR: ${path} is approved, so document_write does not overwrite it. An approval is a ` +
          "verdict on bytes a person read: change it with document_revise, which files a new " +
          "revision, names what caused the change and puts the gate back in front of them.");
      }
      content = envelopeFor(chain, path, content, { stakeholder, tags, title, fields, carry });
      const fixed = normalizeSections(chain, path, content);
      const gate = await documentGuards(chain, path, fixed.content, team);
      if (gate) return text(gate);
      const written = await saveDocument({
        team, relPath: path, initiative: path.split("/")[0], text: fixed.content, by: who,
        flow: chain.name ?? undefined, type: chain.roles[path.split("/")[1] ?? ""],
        mode: prev ? "rewrite" : "create", act: "write",
      });
      if ("refusal" in written) return text(written.refusal);
      recordAct(path, { user: who, action: "document_write", path, chars: fixed.content.length });
      // The control loop is told after the write succeeded, never before. `noteDocument`
      // cannot refuse anything — `documentGuards` above has already decided — it only records
      // the fact the close is later derived from.
      //
      // DELIBERATE: awaited, not fired and forgotten. A write that returned before its
      // evidence landed would let a caller write a document and be told the step is unmet.
      await noteDocument(chain, path, "document", who, team);
      const assessed = await acceptanceLine(p, team, chain, path, fixed.content);
      return text(`written: ${path} (${fixed.content.length} chars)` +
        (fixed.renamed.length ? `\nRenamed to the heading this flow declares: ${fixed.renamed.join(", ")}.` : "") +
        assessed + await nextMoveLine(p, team, path.split("/")[0]));
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
        "and the offset to continue from.",
      inputSchema: {
        path: z.union([z.string(), z.array(z.string())])
          .describe("One path, or an array of paths read in the order given."),
        version: z.number().int().positive().optional()
          .describe("Read the copy filed at approval N instead of the current document."),
        // DELIBERATE: `scope` is read-only and only on this tool. document_write and
        // document_patch stay on the caller's own team; knowledge_add owns the writing side
        // of the shared journal and takes its own `scope`.
        scope: z.enum(["team", "platform"]).optional()
          .describe("Which shelf the path is on. Omit for your team's own store; " +
                    "\"platform\" for the shared journal, as knowledge_search reports it."),
        ...PART_INPUT,
      },
    },
    async ({ path, version, scope, section, offset, limit }) => {
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
        "Fetch a document from your team's store to put in front of the person. " +
        "Returns the document's body as markdown, with its path, version, status, approval " +
        "and the list of versions filed for it stated separately — the document itself, " +
        "never a summary or a judgement of it. Pass an ARRAY of paths to put several in " +
        "front of them at once; each is fetched and recorded in its own right. `version: N` " +
        "shows the copy filed when approval N landed. Call it after writing a document and " +
        "before asking anyone to decide on it — " +
        "in a SEPARATE call once the write has returned, never alongside the write in one " +
        "batch: parallel calls have no order between them, and a fetch that runs first " +
        "answers truthfully that the document is not there yet. " +
        "Paths are relative to the store — `<initiative>/spec.md`. A body longer than " +
        `${PART_LIMIT} characters comes back in parts, as does any \`section\`, \`offset\` or ` +
        "`limit` you ask for: each part says which characters of how many it is. A document " +
        "counts as presented — and document_approve accepts it — once the parts presented " +
        "since its last change cover every character of it.",
      inputSchema: {
        path: z.union([z.string(), z.array(z.string())])
          .describe("One path, or an array of paths presented in the order given."),
        version: z.number().int().positive().optional()
          .describe("Show the copy filed at approval N instead of the current document."),
        ...PART_INPUT,
      },
      _meta: PRESENT_META,
    },
    async ({ path, version, section, offset, limit }) => {
      const user = parseCaller(requestHeaders()).email;
      const team = await teamFor(user);
      const p = db();
      if (!p || !team) return text(NO_TEAM);
      const single = !Array.isArray(path);
      const out: string[] = [];
      // What the document panel draws — every document whole, whatever part the text carries.
      const panel: PanelDocument[] = [];
      const reading = asksPart({ section, offset, limit });
      // COUPLED: the `shown` record and the `presented_at` column are both written by
      // `present` (document-present.ts), once per document, and nothing in this registration
      // touches the record. `shownSinceLastChange` answers per document, so one record for a
      // batch would make an approval look attested when only a neighbouring document was
      // opened. checks/document-reads.ts and checks/approve-needs-present.ts assert both halves.
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
        // Whole when it fits and no part was asked for; otherwise one part, which records a
        // `shown_part` and counts as presented only once the parts cover the body. `present`
        // makes that choice, so a second caller cannot forget it.
        out.push(await present(p, team, rel, version, user, { section, offset, limit }));
        // A part asked for is the model reading, not a person being shown: in ChatGPT every paging
        // call drew the whole document again, in a new panel, under the last one (0.92.0).
        const drawn = reading ? null : await panelDocument(p, team, rel, version, user);
        if (drawn) panel.push(drawn);
      }
      // `_meta`, never `structuredContent`: see document-panel.ts for what each client shows a model.
      return { ...text(out.join("\n\n────────\n\n")),
               _meta: { "zz-core/documents": panel, ...(reading ? { "zz-core/reading": true } : {}) } };
    },
  );

  server.registerTool(
    "document_patch",
    {
      annotations: WRITES,
      description:
        "Replace an exact text fragment (must occur exactly once) in a document. " +
        "This is how a DRAFT is filled in section by section. It is refused on a gated " +
        "document once that document is approved — an approved document changes through " +
        "document_revise, which versions it and returns it to draft, because a signature " +
        "has to cover the bytes it signed.",
      inputSchema: { path: z.string(), find: z.string(), replace: z.string() },
    },
    async ({ path, find, replace }) => {
      const blocked = writeGuard(path);
      if (blocked) return text(blocked);
      const p = db();
      if (!p) return text(NO_DB);
      const who = parseCaller(requestHeaders()).email;
      const team = await teamFor(who);
      if (!team) return text(NO_TEAM);
      await safePath(path);
      // The body is the current revision's, read from the row that retained it — the same
      // bytes every other reader is answered with.
      const loaded = await loadDocument(team, path);
      if (!loaded.ok) {
        return text(loaded.why === "missing" ? `ERROR: ${path} does not exist` : loaded.refusal);
      }
      if (loaded.doc.status === "approved") {
        return text(
          `ERROR: ${path} is approved, so document_patch refuses it. An approval is a verdict ` +
          "on bytes a person read: change it with document_revise, which files a new revision, " +
          "names what caused the change and puts the gate back in front of them.");
      }
      const body = loaded.text;
      const n = body.split(find).length - 1;
      if (n !== 1) return text(`ERROR: \`find\` occurs ${n} times, need exactly 1`);
      // DELIBERATE: a function replacement, not a string one. `replace` is the model's own
      // text, and a string replacement interprets `$$`, `$&`, `` $` `` and `$'` inside it.
      const result = body.replace(find, () => replace);
      // The envelope is not patchable: a patch edits text in place, so `find: "flow: x"` would
      // otherwise reach the envelope, and ownershipCheck guards only PLATFORM_OWNED. Which
      // fields, and what closing this route costs, are in envelopeEditRefusal's docstring.
      const edited = envelopeEditRefusal(body, result);
      if (edited) return text(edited);
      // The chain comes from `result`, which is the same expression document_write uses.
      const chain = await chainFor(p, team, path, result);
      // Against the resulting document, not the replacement fragment: a fragment is a few
      // lines with no frontmatter, and the guards have to see the whole thing.
      const fixed = normalizeSections(chain, path, result);
      const bad = await documentGuards(chain, path, fixed.content, team);
      if (bad) return text(bad);
      const written = await saveDocument({
        team, relPath: path, initiative: path.split("/")[0], text: fixed.content, by: who,
        flow: chain.name ?? undefined, type: chain.roles[path.split("/")[1] ?? ""],
        mode: "rewrite", act: "patch",
      });
      if ("refusal" in written) return text(written.refusal);
      recordAct(path, { user: who, action: "document_patch", path });
      const assessed = await acceptanceLine(p, team, chain, path, fixed.content);
      return text(`patched: ${path}`
        + (fixed.renamed.length ? `\nRenamed to the heading this flow declares: ${fixed.renamed.join(", ")}.` : "")
        + assessed);
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
        "the next move. This is how information reaches work without editing around the gates.",
      inputSchema: {
        initiative: z.string(),
        title: z.string(),
        content: z.string(),
        supports: z.union([z.string(), z.array(z.string())]).optional()
          .describe("Document(s) this material bears on, e.g. 'spec.md' or ['spec.md','plan.md']."),
        stage: z.string().optional()
          .describe("The flow stage this source is the output of, when it is one — an audit round " +
                    "names its audit stage, e.g. 'sdlc-spec-audit', and a review round the stage " +
                    "that writes the verifying document, e.g. 'sdlc-review', with its ```json " +
                    "ledger in `content`. Only a source naming its stage counts as that stage's round."),
      },
    },
    async ({ initiative, title, content, supports, stage }) => {
      // The same guard the other initiative-taking tools apply. safePath below only
      // stops a path leaving the store, which is a different question from whether the name
      // is an initiative — and `join(root, initiative, d)` further down asks the second one.
      const badInitiative = safeName(initiative, "initiative");
      if (badInitiative) return text(badInitiative);
      const who = parseCaller(requestHeaders());
      // The string form is split on commas, so `supports: "intent.md, spec.md"` and the array
      // form mean the same thing. Unsplit it is one entry containing a comma, which the check
      // below refuses.
      const list = (Array.isArray(supports) ? supports : supports ? supports.split(",") : [])
        .map((x) => x.trim()).filter(Boolean);
      // These are written into YAML and read back by a comma-splitter, so a separator inside
      // one becomes two entries and a bracket or newline ends the envelope. They name
      // documents — single path segments.
      for (const d of list) {
        if (!PLAIN_TOKEN.test(d.trim())) {
          return text(`ERROR: supports entry "${d}" must be a document name — ` +
                      "letters, digits, dot, dash or underscore, nothing else");
        }
      }
      const slug = titleSlug(title, "source");
      const date = isoToday();
      const rel = `${initiative}/sources/${date}-${slug}.md`;
      // `initiative` is caller-supplied, so the assembled path is too. Cheap to check,
      // and it is what stops a tool added later from being the exception.
      const blocked = writeGuard(rel, "source_add");
      if (blocked) return text(blocked);
      // The second creation path: `mkdirSync(..., {recursive:true})` below would build
      // `<initiative>/sources/` for an initiative nobody opened, leaving a half-initiative
      // with material in it and no record of anyone opening it.
      const p0 = db();
      if (!p0) return text(NO_DB);
      const team0 = await teamFor(who.email);
      if (!team0) return text(NO_TEAM);
      const unopened = await unopenedRefusal(p0, team0, rel);
      if (unopened) return text(unopened);
      await safePath(rel);
      const p = p0;
      const team = team0;
      if (await documentAt(p, team, rel)) {
        return text(`ERROR: ${rel} already exists — sources are immutable; add a new file`);
      }
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
        const refused = ledgerRefusal(content, earlier, review.document);
        if (refused) return text(refused);
      }
      const round = auditRoundOf(governing, stage, list) ?? review;
      const cited = round ? await documentAt(p, team, `${initiative}/${round.document}`) : null;
      const auditsVersion = round && !review && cited?.current_revision != null
        ? String(cited.current_revision) : undefined;
      const doc = sourceDocument(
        { title, by: who.email, day: date, content, supports: list,
          stage: round ? round.stage : undefined, audits_version: auditsVersion });
      const wrote = await saveDocument({
        team, relPath: rel, initiative, text: doc, by: who.email, flow: "",
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
      });
      if ("refusal" in wrote) return text(wrote.refusal);
      recordAct(rel, { user: who.email, action: "source_add", path: rel, supports: list.join(",") });
      // which of the named documents were already approved when this landed? An audit round
      // lands on an approved document by design — the next move says what follows from it.
      const stale: string[] = [];
      // And which of them do not exist yet. A `supports` link needs a document to point at, so
      // `saveDocument` files none for these — said here rather than dropped without a word.
      const unwritten: string[] = [];
      for (const d of list) {
        const at = await documentAt(p, team, `${initiative}/${d}`);
        if (!at) unwritten.push(d);
        else if (!round && at.status === "approved") stale.push(d);
      }
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
        : round ? await assessRound(p, team, initiative, rel, round.document, content, who.email) : null;
      const stageNote = stage && !round
        ? `\n\nNOT COUNTED AS A ROUND: "${stage}" is not a stage of this flow that produces a source ` +
          `supporting ${list.join(", ") || "nothing"}, so this was recorded as material only.`
        : "";
      return text(
        `source recorded: ${rel}` +
        (list.length ? `\nsupports: ${list.join(", ")}` : "") +
        (round ? `\nrecorded as a ${round.stage} round on ${round.document}` +
                 (auditsVersion ? ` v${auditsVersion}` : "") : "") +
        (assessed ? `\n${assessed}` : "") + stageNote +
        (unwritten.length
          ? `\n\nNOT LINKED YET: ${unwritten.join(", ")} ${unwritten.length > 1 ? "do" : "does"} not ` +
            "exist yet. The link is filed when " + (unwritten.length > 1 ? "each is" : "it is") +
            " first written, and until then this source is not listed as material behind " +
            `${unwritten.length > 1 ? "them" : "it"}.` +
            (review ? " The review round itself is counted by its stage, not by the link." : "")
          : "") +
        (stale.length
          ? `\n\nNote for whoever works on this next: ${stale.join(", ")} ` +
            `${stale.length > 1 ? "were" : "was"} already approved before this material arrived, so ` +
            `the approval does not cover it. initiative_status reports this under ` +
            `sources_after_approval. Whether to change the document is the team's call — if they ` +
            `decide to, document_revise bumps the version, links this source and re-opens the gate.`
          : list.length && !round ? "\n\nNo approved document is affected." : "") +
        await nextMoveLine(p, team, initiative),
      );
    },
  );

}

/** The current revision of each document a source names in `supports`, as `cites` links. A name
 *  that resolves to no document is skipped: a source may cite material outside this store, and
 *  a link to a row nobody has is a foreign key Postgres would refuse. */
async function citedRevisions(
  p: Pick<pg.Pool, "query">, team: string, initiative: string, names: string[],
): Promise<{ path: string; revision: number }[]> {
  const out: { path: string; revision: number }[] = [];
  for (const d of names) {
    const path = `${initiative}/${d}`;
    const at = await documentAt(p, team, path);
    if (at && at.current_revision !== null) out.push({ path, revision: at.current_revision });
  }
  return out;
}

/** After a verifying document is written or patched: ask `evidence_relation` of the acceptance
 *  rows nobody asked about yet, so approval reads a cache instead of waiting on the service. */
export async function acceptanceLine(p: pg.Pool, team: string, chain: Chain, path: string,
                              content: string): Promise<string> {
  const doc = verifyingDoc(chain, path);
  if (!doc) return "";
  const said = await assessAcceptance(p, team, path.split("/")[0], doc, content,
                                      parseCaller(requestHeaders()).email);
  return said ? `\n${said}` : "";
}
