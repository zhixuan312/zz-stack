/**
 * The store: reading, writing and showing a document, and the sources attached to one.
 *
 * EVERY WRITE GOES THROUGH THE SAME TWO STEPS — `documentGuards` decides whether it may
 * land, `persistDocument` lands it — and no tool here decides either for itself. That is
 * what makes a rule added to the guards a rule that holds on every path rather than on the
 * paths somebody remembered.
 *
 * `show_document` is the odd one: it returns the document rather than a rendering of it,
 * and every call appends a `shown` entry naming the path and version. Whether a document
 * was fetched before its gate was approved is answerable from the record because of it.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { documentBody, parseCaller, parseEnvelope } from "@zz/contracts";
import { requestHeaders, text } from "@zz/mcp-http";
import { z } from "zod";

import { chainFor } from "../chain.js";
import { envelopeEditRefusal, fieldRefusal, frontmatterRefusal, initiativeNameShape } from "../document-rules.js";
import { documentGuards, flowDeclarationCheck, initiativeNameTaken } from "../guards.js";
import { indexDoc, sourceDocument, walk } from "../indexing.js";
import { PLAIN_TOKEN, platformPath, safeName, safePath, tagRefusal, titleSlug, userRoot, writeGuard } from "../paths.js";
import { commitStore, logActivity, persistDocument } from "../persist.js";
import { teamFor } from "../platform-db.js";
import { envelopeFor, isoToday, normalizeSections } from "../write-guards.js";

export function registerArtifactTools(server: McpServer): void {
  server.registerTool(
    "write_file",
    {
      description:
        "Create or overwrite a file in your team's artifact store (specs, plans, " +
        "logs, records). The store is shared with your whole team if you belong to " +
        "one. Paths are relative, e.g. '2026-08-20-sample-intake/spec.md'. " +
        "SEND THE BODY, starting at its first heading: the frontmatter is written by the " +
        "platform from what it already knows, and anything else the document needs — " +
        "`flow` on the first document, `stakeholder`, `tags`, `title` — is an argument here.",
      inputSchema: {
        path: z.string(),
        content: z.string().describe("The document's BODY, starting at its first heading. No frontmatter — the platform writes that."),
        flow: z.string().optional()
          .describe("Which flow governs this initiative. Required on the FIRST document; stamped onto later ones."),
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
    async ({ path, content, flow, stakeholder, tags, title, blocks, fields }) => {
      const blocked = writeGuard(path);
      if (blocked) return text(blocked);
      const refused = frontmatterRefusal(content, "write_file") ?? fieldRefusal(fields)
        ?? tagRefusal(tags);
      if (refused) return text(refused);
      const root = await userRoot();
      const team = await teamFor(parseCaller(requestHeaders()).email);
      // RESOLVED FIRST, as approve, close, patch_file and revise_document all resolve it.
      //
      // This was the one write path that resolved last, after eight guards and a chain
      // lookup — so `.zz/spec.md` was answered with a complaint about the flow's required
      // sections, and the reason it could never be written anywhere was the message after
      // the author had rewritten the document. pathShapeRefusal exists to teach the path
      // form once, and it cannot do that from behind the guards.
      const target = await safePath(path);
      // The flow arrives as an ARGUMENT now, not as a line the model typed. chainFor still
      // resolves it from the content of an existing document when there is one; on a first
      // write there is nothing to read, which is exactly the case this argument covers.
      const declared = flow?.trim() ? `---\nflow: ${flow.trim()}\n---\n` : content;
      const chain = await chainFor(root, path, team, declared);
      content = envelopeFor(chain, path, content, { flow, stakeholder, tags, title, blocks, fields });
      const fixed = normalizeSections(chain, path, content);
      const gate = initiativeNameShape(path.replace(/^\/+/, "").split("/")[0])
        ?? initiativeNameTaken(chain, root, path)
        ?? await documentGuards(chain, root, path, fixed.content, team)
        ?? await flowDeclarationCheck(chain, path, team, fixed.content);
      if (gate) return text(gate);
      const written = persistDocument(chain, root, path, target, fixed.content, "write");
      logActivity(root, path,
        { user: parseCaller(requestHeaders()).email, action: "write_file", path, chars: written.length });
      return text(`written: ${path} (${written.length} chars)`
        + (fixed.renamed.length ? `\nRenamed to the heading this flow declares: ${fixed.renamed.join(", ")}.` : ""));
    },
  );

  server.registerTool(
    "read_file",
    {
      description:
        "Read a file from your team's artifact store. Paths are relative to it — " +
        "`<initiative>/spec.md`. A search result that came back with `shelf: \"platform\"` " +
        "lives in the journal every team shares, not in yours: pass `scope: \"platform\"` " +
        "with the same path to read it.",
      inputSchema: {
        path: z.string(),
        // READ-ONLY, and only here. write_file and patch_file stay on the caller's own team,
        // because a shared journal anyone may edit is not a journal. knowledge_add already
        // owns the writing side and already takes `scope`.
        scope: z.enum(["team", "platform"]).optional()
          .describe("Which shelf the path is on. Omit for your team's own store; " +
                    "\"platform\" for the shared journal, as search_knowledge reports it."),
      },
    },
    async ({ path, scope }) => {
      // THE SEARCH SPANS TWO SHELVES AND THE READ REACHED ONE, which made the platform's own
      // lessons visible and unreadable to every team agent. Observed end to end on a live
      // ops-flow round: the agent searched, found the two nodes describing the exact casebox
      // refusal it was about to hit, was told both "do not exist", hit the refusal, and asked
      // a non-technical person to build the workflows by hand. Knowledge you can see and
      // cannot open is worse than knowledge you do not have — it reads as a working store.
      const target = scope === "platform"
        ? platformPath(path)
        : await safePath(path);
      if (existsSync(target)) return text(readFileSync(target, "utf8"));
      // NAMES THE OTHER SHELF, once, when the path looks like a journal node. The whole
      // failure above was a caller who had no way to know a second shelf existed.
      const hint = scope !== "platform" && path.startsWith("_knowledge/")
        ? " — if search_knowledge returned it with `shelf: \"platform\"`, read it with scope: \"platform\""
        : "";
      return text(`ERROR: ${path} does not exist${hint}`);
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
  // AND IT NEVER JUDGES (spec C-6). No summary, no score, no comment of its own. read_file
  // already returns the bytes; what this adds is that the ENVELOPE IS STATED. A reader handed
  // frontmatter has been handed a parsing job, and the facts that decide whether a document may
  // be approved — its version, its status, whose signature is already on it — are exactly the
  // ones buried in it.
  //
  // IT DOES NOT GUARANTEE ANYBODY SAW IT. A tool result is model input, not a display (spec
  // D10). The platform guarantees the fetch; the hop from here to a person's screen belongs to
  // the interface, and this tool claims nothing about it.
  server.registerTool(
    "show_document",
    {
      description:
        "Fetch a document from your team's artifact store to put in front of the person. " +
        "Returns the document's body as markdown, with its path, version, status and " +
        "approval stated separately — the document itself, never a summary or a judgement " +
        "of it. Call it after writing a document and before asking anyone to decide on it — " +
        "in a SEPARATE call once the write has returned, never alongside the write in one " +
        "batch: parallel calls have no order between them, and a fetch that runs first " +
        "answers truthfully that the document is not there yet. " +
        "Paths are relative to the store — `<initiative>/spec.md`.",
      inputSchema: { path: z.string() },
    },
    async ({ path }) => {
      const target = await safePath(path);
      const root = await userRoot();
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
        return text(held.length
          ? `ERROR: no document at \`${path}\`. The initiative holds: ${held.join(", ")}. ` +
            `Ask for one of those by its full path, \`${initiative}/<name>\`, or call ` +
            "list_files to see the rest of the store."
          : `ERROR: no document at \`${path}\`. The initiative holds: nothing this tool can ` +
            `show — \`${initiative}\` is empty or is not a folder in your team's store. Call ` +
            "list_files to see what the store does hold, then ask again by full path.");
      }
      const content = readFileSync(target, "utf8");
      const env = parseEnvelope(content);
      // ONLY WHAT THE DOCUMENT CARRIES. A source has no version and no status, and stating
      // "version: none" for one is the platform asserting a lifecycle nothing governs — the
      // same line stampEnvelope declines to cross for a document no manifest declares.
      const facts = [`This is ${path}`];
      if (env.version) facts.push(`version ${env.version}`);
      if (env.status) facts.push(`status ${env.status}`);
      const signed = env.approved_by
        ? ` Approved by ${env.approved_by}${env.approved_at ? ` on ${env.approved_at}` : ""}.`
        : "";
      // THE FETCH IS THE HALF THE PLATFORM CAN ACTUALLY VOUCH FOR, so it is recorded. The
      // record answers one question nothing could answer before: was this document ever
      // fetched, and at which version, before its gate was approved. That is detection, not
      // prevention — the refusal that would make an approval on an unfetched document
      // impossible is a `shown` check inside the document guards, named in the spec as FR-14a
      // and deliberately out of scope, because turning it on today would break every flow.
      // Spelled without its call parentheses on purpose: "every document write runs the
      // guards" counts that call shape across the whole file, comments included, and pairs it
      // against persistDocument — so naming it the usual way here made a read-only tool look
      // like a sixth guarded write path and failed the check.
      //
      // THE VERSION IS THE POINT of recording more than a path. A document fetched at v3 and
      // approved at v5 was read, and what was read is not what was signed; a bare path cannot
      // tell those apart. Empty when the document carries no version — a source has none, and
      // stating one it does not have would put a fact into the record that is not true.
      //
      // ON SUCCESS ONLY. A refusal fetched nothing and has no version to name, and logging it
      // as `shown` would let a mistyped path answer "yes, it was shown" for a document that
      // was never opened.
      //
      // AND IT CANNOT FAIL THE FETCH: logActivity swallows its own errors by design —
      // "telemetry must never break the operation it describes" — so an unwritable
      // activity.jsonl costs the record, never the document.
      logActivity(root, path, {
        user: parseCaller(requestHeaders()).email,
        action: "shown",
        path,
        version: env.version ?? "",
      });
      return text(`${facts.join(", ")}.${signed}\n\n${documentBody(content).trim()}\n`);
    },
  );

  server.registerTool(
    "patch_file",
    {
      description:
        "Replace an exact text fragment (must occur exactly once) in an artifact file. " +
        "This is how a DRAFT is filled in section by section. It is refused on a gated " +
        "document once that document is approved — an approved document changes through " +
        "revise_document, which versions it and returns it to draft, because a signature " +
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
      // write_file and revise_document refuse content that opens with frontmatter, and say
      // why: "the envelope is the platform's; the body is yours ... there is no third source,
      // and 'the model typed it into some YAML' was the third source". patch_file WAS that
      // third source. It edits text in place, so `find: "flow: ops-flow"` reached the envelope,
      // and ownershipCheck only guards the five fields in PLATFORM_OWNED — `flow` is not one
      // of them.
      //
      // WHICH fields, and what closing this route costs, are envelopeEditRefusal's own
      // docstring. They were written out here as well, in nearly the same words, and each
      // copy pointed at the other — "one comment in patch_file contemplated" there, "one
      // comment here contemplated" in this one — so a reader following either was sent to
      // the paragraph they had just read.
      const edited = envelopeEditRefusal(body, result);
      if (edited) return text(edited);
      // The chain comes from what the document says. It cannot differ from the file's own
      // envelope now, and reading it from `result` keeps this the same expression write_file
      // uses rather than a second way of asking the same question.
      const chain = await chainFor(root, path, team, result);
      // Against the RESULTING document, not the replacement fragment. A patch is normally a
      // few lines, so a check reading `replace` was reading a document with no frontmatter —
      // which is why the guards have to see the whole thing.
      const fixed = normalizeSections(chain, path, result);
      const bad = await documentGuards(chain, root, path, fixed.content, team)
        ?? await flowDeclarationCheck(chain, path, team, fixed.content);
      if (bad) return text(bad);
      persistDocument(chain, root, path, target, fixed.content, "patch");
      logActivity(root, path,
        { user: parseCaller(requestHeaders()).email, action: "patch_file", path });
      return text(`patched: ${path}`
        + (fixed.renamed.length ? `\nRenamed to the heading this flow declares: ${fixed.renamed.join(", ")}.` : ""));
    },
  );

  server.registerTool(
    "list_files",
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
    "add_source",
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
      // list_sources all refuse — a source attached to something no other tool calls an
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
      const target = await safePath(rel);
      if (existsSync(target)) return text(`ERROR: ${rel} already exists — sources are immutable; add a new file`);
      const doc = sourceDocument(
        { title, by: who.email, day: date, supports: list.join(", "), content });
      mkdirSync(resolve(target, ".."), { recursive: true });
      writeFileSync(target, doc);
      logActivity(root, rel, { user: who.email, action: "add_source", path: rel, supports: list.join(",") });
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
            `decide to, revise_document bumps the version, links this source and re-opens the gate.`
          : list.length ? "\n\nNo approved document is affected." : ""),
      );
    },
  );

  server.registerTool(
    "list_sources",
    {
      description:
        "The immutable inputs attached to an initiative (minutes, emails, call notes) with their " +
        "titles and what each supports. Read these before judging a document: they are the " +
        "evidence behind it. Use add_source to attach a new one.",
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
        // `contributed_by` is what add_source and revise_document actually write. This
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
