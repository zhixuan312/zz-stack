/**
 * `document_edit` — every change to an existing document, one tool.
 *
 * Beside `artifacts.ts` rather than in it, and registered from there the way `source_list` is: the
 * document tools already fill that file. Phase 0 builds one mode, an exact edit batch applied to a
 * draft's body (`applyEdits`, which holds the rules). The schema declares every argument the final
 * tool takes so a client sees its whole shape now, and an argument whose mode is not built yet is
 * answered `NOT_YET` rather than ignored — an ignored argument would look like a change that
 * landed.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { documentBody, parseCaller } from "@zz/contracts";
import { WRITES, requestHeaders, text } from "@zz/mcp-http";
import { z } from "zod";

import { chainFor } from "../chain.js";
import { fieldRefusal } from "../document-rules.js";
import { documentGuards } from "../guards.js";
import { applyEdits, type EditRefusal, MAX_EDITS } from "../document-edits.js";
import { unopenedRefusal } from "../initiative-record.js";
import { safePath, tagRefusal, writeGuard } from "../paths.js";
import { db, teamFor } from "../platform-db.js";
import { loadDocument, recordAct, saveDocument } from "../versions.js";
import { normalizeSections } from "../write-guards.js";
import { acceptanceLine, NO_DB, NO_TEAM } from "./artifacts.js";
import { nextMoveLine } from "./initiative-status.js";

const INITIATIVE = "2026-10-06-doc-write-and-update-paradigm";

/** The arguments whose modes are not built, in the order the first one present is named, and the
 *  phase each arrives in. COUPLED: the schema below declares exactly these. */
const NOT_BUILT: { names: string[]; phase: number }[] = [
  { names: ["section", "section_level", "section_occurrence", "content"], phase: 1 },
  { names: ["sources", "source_content", "source_title", "note"], phase: 1 },
  { names: ["title", "tags", "stakeholder", "fields"], phase: 1 },
  { names: ["base", "request_id"], phase: 1 },
  { names: ["upload", "file"], phase: 4 },
];

const notYet = (what: string, phase: number): string =>
  `ERROR: NOT_YET — ${what} arrives in Phase ${phase} of ${INITIATIVE}; use document_revise until then`;

/** The refusal in the platform's `ERROR: <CODE> — <what to send instead>` form. */
function refusalText(path: string, r: EditRefusal): string {
  const at = r.edit_index === undefined ? "" : `edit ${r.edit_index} (0-based): `;
  switch (r.code) {
    case "EDIT_COUNT":
      return `ERROR: EDIT_COUNT — send between 1 and ${MAX_EDITS} edits in one call.`;
    case "INVALID_EDIT":
      return `ERROR: INVALID_EDIT — ${at}\`find\` must be a non-empty string and \`replace\` a string ` +
        "(an empty `replace` deletes).";
    case "NO_MATCH":
      return `ERROR: NO_MATCH — ${at}\`find\` does not occur in ${path}. Matching is exact, with no ` +
        "whitespace folding: read the document and copy the text as it is.";
    case "MULTIPLE_MATCHES":
      return `ERROR: MULTIPLE_MATCHES — ${at}\`find\` occurs ${r.match_count} times, on lines ` +
        `${(r.lines ?? []).join(", ")} of the body. Send a longer \`find\` that includes enough ` +
        "surrounding text to occur exactly once.";
    case "OVERLAPPING_EDITS":
      return `ERROR: OVERLAPPING_EDITS — ${at}this edit covers text another edit in the batch also ` +
        "covers (identical edits included). Merge them into one edit, or make their `find` text disjoint.";
  }
}

export function registerDocumentEditTool(server: McpServer): void {
  server.registerTool("document_edit", {
    annotations: WRITES,
    description:
      "Change an existing DRAFT document. Send `edits`: 1 to " + MAX_EDITS + " exact " +
      "{find, replace} pairs, each `find` located in the document as it is now and occurring " +
      "exactly once (an empty `replace` deletes). The batch is all or nothing, and a replacement " +
      "never becomes another edit's target. An approved document is not edited here yet: it " +
      "changes through document_revise. The other arguments are declared so the final shape is " +
      "visible, and answer NOT_YET until their phase ships.",
    inputSchema: {
      path: z.string(),
      edits: z.array(z.object({ find: z.string(), replace: z.string() })).optional()
        .describe(`1..${MAX_EDITS} exact edits, applied together.`),
      section: z.string().optional(), section_level: z.number().int().optional(),
      section_occurrence: z.number().int().optional(), content: z.string().optional(),
      upload: z.string().optional(), file: z.record(z.unknown()).optional(),
      sources: z.array(z.string()).optional(), source_content: z.string().optional(),
      source_title: z.string().optional(), note: z.string().optional(),
      title: z.string().optional(), tags: z.array(z.string()).optional(),
      stakeholder: z.string().optional(), fields: z.record(z.string()).optional(),
      base: z.string().optional(), request_id: z.string().optional(),
    },
  }, async (args) => {
    const { path, edits, fields, tags } = args;
    const blocked = writeGuard(path);
    if (blocked) return text(blocked);
    // The same rules every write applies to a caller's fields and tags, asked before anything else
    // even while those arguments answer NOT_YET: a malformed name is refused by name, never
    // carried silently to the phase that will write it.
    const malformed = fieldRefusal(fields) ?? tagRefusal(tags);
    if (malformed) return text(malformed);
    const p = db();
    if (!p) return text(NO_DB);
    const who = parseCaller(requestHeaders()).email;
    const team = await teamFor(who);
    if (!team) return text(NO_TEAM);
    // DELIBERATE: the path is resolved before the guards run, as document_patch does.
    await safePath(path);
    const unopened = await unopenedRefusal(p, team, path);
    if (unopened) return text(unopened);
    // 1. The target. The body is the current revision's, read from the row that retained it.
    const loaded = await loadDocument(team, path);
    if (!loaded.ok) {
      return text(loaded.why === "missing"
        ? `ERROR: TARGET_MISSING — ${path} does not exist. document_write creates a document; ` +
          "document_list shows the paths there are."
        : loaded.refusal);
    }
    // 2. An unbuilt mode, the first present in table order.
    const given = args as Record<string, unknown>;
    for (const { names, phase } of NOT_BUILT) {
      const name = names.find((n) => given[n] !== undefined);
      if (name) return text(notYet(`\`${name}\``, phase));
    }
    // 3. An approved document is a verdict on bytes a person read.
    if (loaded.doc.status === "approved") return text(notYet("editing an approved document", 1));
    // 4. No mode at all.
    if (edits === undefined) {
      return text("ERROR: INVALID_MODE — send `edits`: a list of {find, replace} pairs. A call " +
        "with no body change asks for nothing.");
    }
    // 5. The batch's own refusals, in index order.
    const body = documentBody(loaded.text);
    const applied = applyEdits(body, edits);
    if ("code" in applied) return text(refusalText(path, applied));
    // The envelope is not editable: the edits ran on the body alone, and the envelope the
    // document already had goes back on byte for byte.
    const result = loaded.text.slice(0, loaded.text.length - body.length) + applied.body;
    const chain = await chainFor(p, team, path, result);
    const fixed = normalizeSections(chain, path, result);
    const bad = await documentGuards(chain, path, fixed.content, team);
    if (bad) return text(bad);
    const written = await saveDocument({
      team, relPath: path, initiative: path.split("/")[0], text: fixed.content, by: who,
      flow: chain.name ?? undefined, type: chain.roles[path.split("/")[1] ?? ""],
      mode: "rewrite", act: "patch",
    });
    if ("refusal" in written) return text(written.refusal);
    recordAct(path, { user: who, action: "document_edit", path });
    const assessed = await acceptanceLine(p, team, chain, path, fixed.content);
    return text(`edited: ${path} (${applied.changed} edits)`
      + (fixed.renamed.length ? `\nRenamed to the heading this flow declares: ${fixed.renamed.join(", ")}.` : "")
      + assessed + await nextMoveLine(p, team, path.split("/")[0]));
  });
}
