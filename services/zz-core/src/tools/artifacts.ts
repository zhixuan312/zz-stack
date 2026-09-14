/**
 * The store: reading, writing and showing a document, and the sources attached to one.
 *
 * EVERY WRITE GOES THROUGH THE SAME TWO STEPS — `documentGuards` decides whether it may
 * land, `persistDocument` lands it — and no tool here decides either for itself. That is
 * what makes a rule added to the guards a rule that holds on every path rather than on the
 * paths somebody remembered.
 *
 * `document_present` is the odd one: it returns the document rather than a rendering of it,
 * and appends a `shown` entry naming the path and version FOR EACH DOCUMENT it fetched.
 * Whether a document was fetched before its gate was approved is answerable from the record
 * because of it — and stays answerable per document once a call may carry several.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { parseCaller, parseEnvelope } from "@zz/contracts";
import { requestHeaders, text } from "@zz/mcp-http";
import { z } from "zod";

import { chainFor } from "../chain.js";
import { envelopeEditRefusal, fieldRefusal, frontmatterRefusal } from "../document-rules.js";
import { documentGuards } from "../guards.js";
import { indexDoc, sourceDocument, walk } from "../indexing.js";
import { unopenedRefusal } from "../initiative-record.js";
import { PLAIN_TOKEN, platformPath, safeName, safePath, tagRefusal, titleSlug, userRoot, writeGuard } from "../paths.js";
import { commitStore, logActivity, persistDocument } from "../persist.js";
import { teamFor } from "../platform-db.js";
import { documentVersions, presentDocument, versionRefusal } from "../versions.js";

import { envelopeFor, isoToday, normalizeSections } from "../write-guards.js";

export function registerArtifactTools(server: McpServer): void {
  server.registerTool(
    "document_write",
    {
      description:
        "Create or overwrite a file in your team's artifact store (specs, plans, " +
        "logs, records). The store is shared with your whole team if you belong to " +
        "one. Paths are relative, e.g. '2026-08-20-sample-intake/spec.md'. " +
        "SEND THE BODY, starting at its first heading: the frontmatter is written by the " +
        "platform from what it already knows, and anything else the document needs — " +
        "`stakeholder`, `tags`, `title` — is an argument here. The initiative must already " +
        "exist: `initiative_open` creates one, and this no longer does. The FLOW is declared " +
        "there too, never here.",
      inputSchema: {
        path: z.string(),
        content: z.string().describe("The document's BODY, starting at its first heading. No frontmatter — the platform writes that."),
        stakeholder: z.string().optional().describe("Who asked for this, where the document records one."),
        tags: z.array(z.string()).optional().describe("Index tags for this document."),
        title: z.string().optional().describe("Document title for the index. Defaults to the first heading."),
        blocks: z.array(z.string()).optional().describe(
          "On a SELECTION document: the building blocks this initiative will be built on, by " +
          "block id (['casebox']), and only the ones chosen — never the ones considered and " +
          "rejected. The platform reads it: the stages after selection may call these and " +
          "nothing else. Five at most."),
        fields: z.record(z.string()).optional()
          .describe("This FLOW's own frontmatter fields, e.g. {building_block: 'casebox'}. Not envelope names."),
      },
    },
    async ({ path, content, stakeholder, tags, title, blocks, fields }) => {
      const blocked = writeGuard(path);
      if (blocked) return text(blocked);
      const refused = frontmatterRefusal(content, "document_write") ?? fieldRefusal(fields)
        ?? tagRefusal(tags);
      if (refused) return text(refused);
      const root = await userRoot();
      const team = await teamFor(parseCaller(requestHeaders()).email);
      // RESOLVED FIRST, as approve, close, document_patch and document_revise all resolve it.
      //
      // This was the one write path that resolved last, after eight guards and a chain
      // lookup — so `.zz/spec.md` was answered with a complaint about the flow's required
      // sections, and the reason it could never be written anywhere was the message after
      // the author had rewritten the document. pathShapeRefusal exists to teach the path
      // form once, and it cannot do that from behind the guards.
      const target = await safePath(path);
      // THE WRITE NO LONGER CREATES, and three guards left with the creating. The name shape,
      // the taken check and the flow declaration all asked questions about CREATION, and they
      // ran on every write of every document because this path could not tell which write was
      // the creating one. `initiative_open` is that moment now, so each is asked once, where
      // the answer can still be acted on, and what is left here is a single existence test.
      const unopened = unopenedRefusal(root, path);
      if (unopened) return text(unopened);
      // THE `flow` ARGUMENT IS GONE FROM THIS TOOL. It was the adopt-a-flow tool FR-30 forbids
      // reached through an argument instead of a verb: an initiative opened freeform would
      // acquire a manifest on its next document, and the gates that manifest declares would
      // land on documents already written and unapproved. The flow is declared to
      // `initiative_open`, at the one moment the choice is meaningful, and chainFor reads it
      // from the record written there — which is also what covers the window this argument
      // used to cover, an initiative whose first document is not yet on disk.
      const chain = await chainFor(root, path, team, content);
      content = envelopeFor(chain, path, content, { stakeholder, tags, title, blocks, fields });
      const fixed = normalizeSections(chain, path, content);
      const gate = await documentGuards(chain, root, path, fixed.content, team);
      if (gate) return text(gate);
      const written = persistDocument(chain, root, path, target, fixed.content, "write");
      logActivity(root, path,
        { user: parseCaller(requestHeaders()).email, action: "document_write", path, chars: written.length });
      return text(`written: ${path} (${written.length} chars)`
        + (fixed.renamed.length ? `\nRenamed to the heading this flow declares: ${fixed.renamed.join(", ")}.` : ""));
    },
  );

  server.registerTool(
    "document_read",
    {
      description:
        "Read a file from your team's artifact store. Paths are relative to it — " +
        "`<initiative>/spec.md`. Pass an ARRAY of paths to read several in one call; they " +
        "come back in the order you asked, and a path that cannot be read names its own " +
        "failure without costing you the others. `version: N` reads the copy filed when " +
        "approval N landed instead of the current document — document_present lists which " +
        "versions exist. A search result that came back with `shelf: \"platform\"` " +
        "lives in the journal every team shares, not in yours: pass `scope: \"platform\"` " +
        "with the same path to read it.",
      inputSchema: {
        path: z.union([z.string(), z.array(z.string())])
          .describe("One path, or an array of paths read in the order given."),
        version: z.number().int().positive().optional()
          .describe("Read the copy filed at approval N instead of the current document."),
        // READ-ONLY, and only here. document_write and document_patch stay on the caller's own team,
        // because a shared journal anyone may edit is not a journal. knowledge_add already
        // owns the writing side and already takes `scope`.
        scope: z.enum(["team", "platform"]).optional()
          .describe("Which shelf the path is on. Omit for your team's own store; " +
                    "\"platform\" for the shared journal, as knowledge_search reports it."),
      },
    },
    async ({ path, version, scope }) => {
      // AN ARGUMENT THAT DOES NOT APPLY, refused before the loop rather than once per entry.
      // The shared journal holds no gated documents, so it files no approvals and has no
      // `_versions/` — a version asked of it could only ever be answered "there are none",
      // which reads as a missing file rather than as a request that does not make sense.
      if (version !== undefined && scope === "platform") {
        return text("ERROR: `version` reads a copy filed at an approval, and the platform " +
                    "journal keeps none — its nodes are superseded, not versioned. Drop one " +
                    "of the two.");
      }
      const root = await userRoot();
      const single = !Array.isArray(path);
      const rows: { rel: string; body: string }[] = [];
      // ONE BAD ENTRY DOES NOT COST THE OTHERS, which is the whole reason an array is worth
      // having: a caller reading a spec, a plan and a source in one call gets the two that
      // exist and the name of the one that does not. So nothing returns from inside this
      // loop — every outcome, refusal included, becomes a row.
      for (const rel of (single ? [path as string] : path as string[])) {
        try {
          let readRel = rel;
          if (version !== undefined) {
            const refused = versionRefusal(root, rel, version);
            if (refused) { rows.push({ rel, body: refused }); continue; }
            readRel = documentVersions(root, rel).find((v) => v.version === version)?.rel ?? rel;
          }
          // THE SEARCH SPANS TWO SHELVES AND THE READ REACHED ONE, which made the platform's own
          // lessons visible and unreadable to every team agent. Observed end to end on a live
          // ops-flow round: the agent searched, found the two nodes describing the exact casebox
          // refusal it was about to hit, was told both "do not exist", hit the refusal, and asked
          // a non-technical person to build the workflows by hand. Knowledge you can see and
          // cannot open is worse than knowledge you do not have — it reads as a working store.
          const target = scope === "platform" ? platformPath(readRel) : await safePath(readRel);
          if (!existsSync(target)) {
            // NAMES THE OTHER SHELF, once, when the path looks like a journal node. The whole
            // failure above was a caller who had no way to know a second shelf existed.
            const hint = scope !== "platform" && rel.startsWith("_knowledge/")
              ? " — if knowledge_search returned it with `shelf: \"platform\"`, read it with scope: \"platform\""
              : "";
            rows.push({ rel, body: `ERROR: ${rel} does not exist${hint}` });
            continue;
          }
          rows.push({ rel: readRel, body: readFileSync(target, "utf8") });
        } catch (err) {
          // safePath throws a Refusal for a path that walks out of the store or is the wrong
          // shape. Thrown, that ends the whole call — right when one path was asked for, and
          // wrong for an array, where it would discard the entries that were fine.
          rows.push({ rel, body: err instanceof Error ? err.message : String(err) });
        }
      }
      // THE RESPONSE SHAPE FOLLOWS THE REQUEST SHAPE, not the count. `path: "x"` is the bytes
      // and nothing else, exactly as it has always been — console-write.ts and the chain check
      // consume that string directly. `path: ["x"]` is labelled even at length one, so a
      // caller that built its array in a loop never has to parse two different answers.
      return text(single
        ? rows[0]?.body ?? ""
        : rows.map((r) => `── ${r.rel} ──\n${r.body}`).join("\n\n"));
    },
  );

  // A DOCUMENT COMES BACK AS A DOCUMENT, and what that rules out is written here rather than
  // inside the registration: the gate check for this tool scans the registration body for the
  // renderer's own names, so a comment spelling them below would fail on correct code.
  //
  // THE PLATFORM RENDERS NOTHING (spec D9). The gateway owns a markdown-to-HTML renderer and it
  // is the wrong tool for this: it builds a page for the web console, while all four of this
  // platform's interfaces render markdown themselves. So the body goes back as markdown,
  // unfenced and unescaped (spec FR-12b, C-7) — a fenced body is source presented as syntax,
  // which is the one thing the readability floor rules out.
  //
  // AND IT NEVER JUDGES (spec C-6). No summary, no score, no comment of its own. document_read
  // already returns the bytes; what this adds is that the ENVELOPE IS STATED. A reader handed
  // frontmatter has been handed a parsing job, and the facts that decide whether a document may
  // be approved — its version, its status, whose signature is already on it — are exactly the
  // ones buried in it.
  //
  // IT DOES NOT GUARANTEE ANYBODY SAW IT. A tool result is model input, not a display (spec
  // D10). The platform guarantees the fetch; the hop from here to a person's screen belongs to
  // the interface, and this tool claims nothing about it.
  server.registerTool(
    "document_present",
    {
      description:
        "Fetch a document from your team's artifact store to put in front of the person. " +
        "Returns the document's body as markdown, with its path, version, status, approval " +
        "and the list of versions filed for it stated separately — the document itself, " +
        "never a summary or a judgement of it. Pass an ARRAY of paths to put several in " +
        "front of them at once; each is fetched and recorded in its own right. `version: N` " +
        "shows the copy filed when approval N landed. Call it after writing a document and " +
        "before asking anyone to decide on it — " +
        "in a SEPARATE call once the write has returned, never alongside the write in one " +
        "batch: parallel calls have no order between them, and a fetch that runs first " +
        "answers truthfully that the document is not there yet. " +
        "Paths are relative to the store — `<initiative>/spec.md`.",
      inputSchema: {
        path: z.union([z.string(), z.array(z.string())])
          .describe("One path, or an array of paths presented in the order given."),
        version: z.number().int().positive().optional()
          .describe("Show the copy filed at approval N instead of the current document."),
      },
    },
    async ({ path, version }) => {
      const root = await userRoot();
      const user = parseCaller(requestHeaders()).email;
      const single = !Array.isArray(path);
      const out: string[] = [];
      // ONE ROW PER DOCUMENT, WHICH IS WHY THE LOOP CALLS presentDocument RATHER THAN
      // RECORDING ANYTHING ITSELF. attest.ts shownSinceLastChange answers per document, so a
      // single `shown` written for a batch would make an approval look attested when only the
      // neighbouring document had been opened. Nothing in this registration touches the
      // record; the per-document helper owns it, and the check asserts both halves.
      for (const rel of (single ? [path as string] : path as string[])) {
        const target = await safePath(rel);
        // A DIRECTORY IS NOT A DOCUMENT, and `existsSync` alone says it is — readFileSync on one
        // throws EISDIR, which reaches the caller as a raw error instead of this file's refusal.
        if (!existsSync(target) || !statSync(target).isFile()) {
          // The initiative is taken off the RESOLVED path, never off the argument. safePath has
          // already refused anything that walks out of the store, and rebuilding a folder from
          // the raw string is the shape safeName's docstring records going wrong on the live
          // gateway.
          const initiative = target.slice(root.length + 1).split(sep)[0];
          const folder = join(root, initiative);
          const held = existsSync(folder) && statSync(folder).isDirectory()
            ? readdirSync(folder).filter((f) => f.endsWith(".md")).sort()
            : [];
          // TWO ANSWERS, because an empty list means two different things — the folder is there
          // and holds no document, or there is no such folder at all — and they want different
          // next moves. A refusal that reads the same either way sends someone looking for a
          // typo in a name that was never there.
          out.push(held.length
            ? `ERROR: no document at \`${rel}\`. The initiative holds: ${held.join(", ")}. ` +
              `Ask for one of those by its full path, \`${initiative}/<name>\`, or call ` +
              "document_list to see the rest of the store."
            : `ERROR: no document at \`${rel}\`. The initiative holds: nothing this tool can ` +
              `show — \`${initiative}\` is empty or is not a folder in your team's store. Call ` +
              "document_list to see what the store does hold, then ask again by full path.");
          continue;
        }
        out.push(presentDocument(root, rel, version, user));
      }
      return text(out.join("\n\n────────\n\n"));
    },
  );

  server.registerTool(
    "document_patch",
    {
      description:
        "Replace an exact text fragment (must occur exactly once) in an artifact file. " +
        "This is how a DRAFT is filled in section by section. It is refused on a gated " +
        "document once that document is approved — an approved document changes through " +
        "document_revise, which versions it and returns it to draft, because a signature " +
        "has to cover the bytes it signed.",
      inputSchema: { path: z.string(), find: z.string(), replace: z.string() },
    },
    async ({ path, find, replace }) => {
      const blocked = writeGuard(path);
      if (blocked) return text(blocked);
      const root = await userRoot();
      const team = await teamFor(parseCaller(requestHeaders()).email);
      const target = await safePath(path);
      if (!existsSync(target)) return text(`ERROR: ${path} does not exist`);
      const body = readFileSync(target, "utf8");
      const n = body.split(find).length - 1;
      if (n !== 1) return text(`ERROR: \`find\` occurs ${n} times, need exactly 1`);
      // A FUNCTION replacement. `replace` is the model's own text going into a team's
      // document, and a string replacement interprets $$, $&, $` and $' inside it: "$$50"
      // became "$50", a shell example containing $' swallowed the line and injected the whole
      // rest of the document after it, and "$&" wrote the text being replaced back out. All
      // four verified against this exact call. Silent, in the tool whose description says it
      // is how a draft is filled in section by section.
      const result = body.replace(find, () => replace);
      // THE ENVELOPE IS NOT PATCHABLE, which is the third and last way it was writable by hand.
      //
      // document_write and document_revise refuse content that opens with frontmatter, and say
      // why: "the envelope is the platform's; the body is yours ... there is no third source,
      // and 'the model typed it into some YAML' was the third source". document_patch WAS that
      // third source. It edits text in place, so `find: "flow: ops-flow"` reached the envelope,
      // and ownershipCheck only guards the five fields in PLATFORM_OWNED — `flow` is not one
      // of them.
      //
      // WHICH fields, and what closing this route costs, are envelopeEditRefusal's own
      // docstring. They were written out here as well, in nearly the same words, and each
      // copy pointed at the other — "one comment in document_patch contemplated" there, "one
      // comment here contemplated" in this one — so a reader following either was sent to
      // the paragraph they had just read.
      const edited = envelopeEditRefusal(body, result);
      if (edited) return text(edited);
      // The chain comes from what the document says. It cannot differ from the file's own
      // envelope now, and reading it from `result` keeps this the same expression document_write
      // uses rather than a second way of asking the same question.
      const chain = await chainFor(root, path, team, result);
      // Against the RESULTING document, not the replacement fragment. A patch is normally a
      // few lines, so a check reading `replace` was reading a document with no frontmatter —
      // which is why the guards have to see the whole thing.
      const fixed = normalizeSections(chain, path, result);
      // flowDeclarationCheck went with the creation guards. It asked "did you forget to
      // declare a flow?" — a question about an initiative being created, asked on a path that
      // has never created one. initiative_open asks it now, once, and an initiative that
      // exists is one that was already asked.
      const bad = await documentGuards(chain, root, path, fixed.content, team);
      if (bad) return text(bad);
      persistDocument(chain, root, path, target, fixed.content, "patch");
      logActivity(root, path,
        { user: parseCaller(requestHeaders()).email, action: "document_patch", path });
      return text(`patched: ${path}`
        + (fixed.renamed.length ? `\nRenamed to the heading this flow declares: ${fixed.renamed.join(", ")}.` : ""));
    },
  );

  server.registerTool(
    "document_list",
    {
      description:
        "List files in your team's artifact store (shared with every member of it), " +
        "optionally under a folder prefix.",
      inputSchema: { prefix: z.string().optional() },
    },
    async ({ prefix }) => {
      const root = await userRoot();
      const base = prefix ? await safePath(prefix) : root;
      if (!existsSync(base) || !statSync(base).isDirectory()) return text(JSON.stringify([]));
      const files = [...walk(base)].map((p) => p.slice(root.length + 1)).sort();
      return text(JSON.stringify(files));
    },
  );

  // ── knowledge tools: format is mechanical, judgment stays with skills ──

  server.registerTool(
    "source_add",
    {
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
      },
    },
    async ({ initiative, title, content, supports }) => {
      // The same guard the other four initiative-taking tools apply. This one did not, so it
      // accepted a multi-segment name like `a/b` that initiative_status, reconcile, close and
      // source_list all refuse — a source attached to something no other tool calls an
      // initiative. safePath below still stopped it leaving the store, which is why the gap
      // read as harmless; being inside the store is a different question from being an
      // initiative, and `join(root, initiative, d)` further down asks the second one.
      const badInitiative = safeName(initiative, "initiative");
      if (badInitiative) return text(badInitiative);
      const who = parseCaller(requestHeaders());
      const root = await userRoot();
      // The string form is split on commas, not taken whole. `supports` accepts either, and
      // the description asks for "every document this material bears on" — so the obvious
      // call is `supports: "intent.md, spec.md"`. Wrapped in an array unsplit, that is one
      // entry containing a comma, which the envelope check below correctly refuses. It used
      // to work by accident: the comma survived into the YAML and the reader split it there.
      // Splitting here is what makes both call shapes mean the same thing.
      const list = (Array.isArray(supports) ? supports : supports ? supports.split(",") : [])
        .map((x) => x.trim()).filter(Boolean);
      // Same reason as knowledge_add's evidence: these are written into YAML and read back by
      // a comma-splitter, so a separator inside one silently becomes two entries and a
      // bracket or newline ends the envelope. They name documents — single path segments.
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
      const blocked = writeGuard(rel);
      if (blocked) return text(blocked);
      // THE SECOND CREATION PATH, and it is easy to miss. `mkdirSync(..., {recursive:true})`
      // below builds `<initiative>/sources/` for an initiative that does not exist, so
      // attaching a source used to conjure the folder that document_write is now refused for
      // — leaving a half-initiative with material in it and no record of anyone opening it.
      const unopened = unopenedRefusal(root, rel);
      if (unopened) return text(unopened);
      const target = await safePath(rel);
      if (existsSync(target)) return text(`ERROR: ${rel} already exists — sources are immutable; add a new file`);
      const doc = sourceDocument(
        { title, by: who.email, day: date, supports: list.join(", "), content });
      mkdirSync(resolve(target, ".."), { recursive: true });
      writeFileSync(target, doc);
      logActivity(root, rel, { user: who.email, action: "source_add", path: rel, supports: list.join(",") });
      commitStore(root, who.email, "source", rel);
      void indexDoc(root, rel, doc);
      // which of the named documents were already approved when this landed?
      const stale = list.filter((d) => {
        const env = parseEnvelope(existsSync(join(root, initiative, d))
          ? readFileSync(join(root, initiative, d), "utf8") : "");
        return env.status === "approved";
      });
      return text(
        `source recorded: ${rel}` +
        (list.length ? `\nsupports: ${list.join(", ")}` : "") +
        (stale.length
          ? `\n\nNote for whoever works on this next: ${stale.join(", ")} ` +
            `${stale.length > 1 ? "were" : "was"} already approved before this material arrived, so ` +
            `the approval does not cover it. initiative_status reports this under ` +
            `sources_after_approval. Whether to change the document is the team's call — if they ` +
            `decide to, document_revise bumps the version, links this source and re-opens the gate.`
          : list.length ? "\n\nNo approved document is affected." : ""),
      );
    },
  );

  server.registerTool(
    "source_list",
    {
      description:
        "The immutable inputs attached to an initiative (minutes, emails, call notes) with their " +
        "titles and what each supports. Read these before judging a document: they are the " +
        "evidence behind it. Use source_add to attach a new one.",
      inputSchema: { initiative: z.string() },
    },
    async ({ initiative }) => {
      const bad = safeName(initiative, "initiative");
      if (bad) return text(bad);
      const root = await userRoot();
      const dir = join(root, initiative, "sources");
      if (!existsSync(dir)) return text(JSON.stringify({ initiative, sources: [] }));
      const rows = readdirSync(dir).filter((f) => f.endsWith(".md")).map((f) => {
        const env = parseEnvelope(readFileSync(join(dir, f), "utf8"));
        // `contributed_by` is what source_add and document_revise actually write. This
        // read `added_by`, a field nothing has ever written, so every source came back
        // with an empty contributor — the one thing that says whose material it is.
        return { path: `${initiative}/sources/${f}`, title: env.title || f,
                 supports: env.supports || "",
                 contributed_by: env.contributed_by || "", added_at: env.added_at || "" };
      });
      return text(JSON.stringify({ initiative, sources: rows }, null, 2));
    },
  );
}
