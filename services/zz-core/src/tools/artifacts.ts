/**
 * The store: reading, writing and showing a document, and the sources attached to one.
 *
 * Every write goes through the same two steps — `documentGuards` decides whether it may land,
 * `persistDocument` lands it — and no tool here decides either for itself, so a rule added to
 * the guards holds on every path.
 *
 * `document_present` returns the document rather than a rendering of it, and appends a
 * `shown` entry naming the path and version for each document it fetched. That is what makes
 * "was this fetched before its gate was approved" answerable per document.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { parseCaller, parseEnvelope, PLATFORM_OWNED } from "@zz/contracts";
import { indexDoc, walk } from "@zz/indexing";
import { requestHeaders, text } from "@zz/mcp-http";
import { z } from "zod";

import { chainFor } from "../chain.js";
import { envelopeEditRefusal, fieldRefusal, frontmatterRefusal } from "../document-rules.js";
import { documentGuards } from "../guards.js";
import { noteDocument, noteSource } from "../host/observe.js";
import { sourceDocument } from "../indexing.js";
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
      const root = await userRoot();
      const team = await teamFor(parseCaller(requestHeaders()).email);
      // DELIBERATE: the path is resolved before the guards run, as approve, close,
      // document_patch and document_revise all do. A bad path answered from behind the guards
      // is answered with a complaint about the document's sections instead.
      const target = await safePath(path);
      // This write does not create an initiative — `initiative_open` does, and the name shape,
      // the taken check and the flow declaration are asked there, once. What is left here is
      // an existence test.
      const unopened = unopenedRefusal(root, path);
      if (unopened) return text(unopened);
      // The flow is read from the record `initiative_open` wrote, never from an argument here:
      // an initiative that acquired a manifest on its second document would have that
      // manifest's gates land on documents already written and unapproved.
      const chain = chainFor(root, path, content);
      // The document already there is read before it is overwritten: the overwrite half of
      // "create or overwrite" has to preserve the fields the platform wrote on the previous
      // copy — see envelopeFor's `carry`.
      //
      // COUPLED: the carried set is PLATFORM_OWNED plus `version`, read from @zz/contracts, so
      // a field added to the platform's set is carried without editing this line.
      const onDisk = existsSync(target) && statSync(target).isFile()
        ? parseEnvelope(readFileSync(target, "utf8")) : {};
      const carry: Record<string, string> = {};
      for (const k of [...PLATFORM_OWNED, "version"]) {
        if (onDisk[k]) carry[k] = onDisk[k];
      }
      content = envelopeFor(chain, path, content, { stakeholder, tags, title, fields, carry });
      const fixed = normalizeSections(chain, path, content);
      const gate = documentGuards(chain, root, path, fixed.content, team);
      if (gate) return text(gate);
      const written = persistDocument(chain, root, path, target, fixed.content, "write");
      logActivity(root, path,
        { user: parseCaller(requestHeaders()).email, action: "document_write", path, chars: written.length });
      // The control loop is told after the write succeeded, never before. `noteDocument`
      // cannot refuse anything — `documentGuards` above has already decided — it only records
      // the fact the close is later derived from.
      //
      // DELIBERATE: awaited, not fired and forgotten. A write that returned before its
      // evidence landed would let a caller write a document and be told the step is unmet.
      await noteDocument(chain, path, "document",
                         parseCaller(requestHeaders()).email, team);
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
        // DELIBERATE: `scope` is read-only and only on this tool. document_write and
        // document_patch stay on the caller's own team; knowledge_add owns the writing side
        // of the shared journal and takes its own `scope`.
        scope: z.enum(["team", "platform"]).optional()
          .describe("Which shelf the path is on. Omit for your team's own store; " +
                    "\"platform\" for the shared journal, as knowledge_search reports it."),
      },
    },
    async ({ path, version, scope }) => {
      // Refused before the loop, not once per entry. The shared journal holds no gated
      // documents, so it files no approvals and has no `_versions/`; answering per entry
      // would read as a missing file rather than as a request that does not apply.
      if (version !== undefined && scope === "platform") {
        return text("ERROR: `version` reads a copy filed at an approval, and the platform " +
                    "journal keeps none — its nodes are superseded, not versioned. Drop one " +
                    "of the two.");
      }
      const root = await userRoot();
      const single = !Array.isArray(path);
      const rows: { rel: string; body: string }[] = [];
      // One bad entry does not cost the others: nothing returns from inside this loop, and
      // every outcome, refusal included, becomes a row.
      for (const rel of (single ? [path as string] : path as string[])) {
        try {
          let readRel = rel;
          if (version !== undefined) {
            const refused = versionRefusal(root, rel, version);
            if (refused) { rows.push({ rel, body: refused }); continue; }
            readRel = documentVersions(root, rel).find((v) => v.version === version)?.rel ?? rel;
          }
          // The search spans two shelves, so the read reaches both: a node knowledge_search
          // returns with `shelf: "platform"` is otherwise visible and unopenable.
          const target = scope === "platform" ? platformPath(readRel) : await safePath(readRel);
          if (!existsSync(target)) {
            // Names the other shelf, once, when the path looks like a journal node — a caller
            // has no other way to learn a second shelf exists.
            const hint = scope !== "platform" && rel.startsWith("_knowledge/")
              ? " — if knowledge_search returned it with `shelf: \"platform\"`, read it with scope: \"platform\""
              : "";
            rows.push({ rel, body: `ERROR: ${rel} does not exist${hint}` });
            continue;
          }
          rows.push({ rel: readRel, body: readFileSync(target, "utf8") });
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
      // COUPLED: `shown` is written by presentDocument, once per document, and nothing in
      // this registration touches the record. attest.ts shownSinceLastChange answers per
      // document, so one `shown` per batch would make an approval look attested when only a
      // neighbouring document had been opened. checks/document-reads.ts asserts both halves.
      for (const rel of (single ? [path as string] : path as string[])) {
        const target = await safePath(rel);
        // A directory passes `existsSync` and readFileSync on one throws EISDIR, which would
        // reach the caller as a raw error instead of this file's refusal.
        if (!existsSync(target) || !statSync(target).isFile()) {
          // The initiative is taken off the resolved path, never off the argument — safePath
          // has already refused anything that walks out of the store.
          const initiative = target.slice(root.length + 1).split(sep)[0];
          const folder = join(root, initiative);
          const held = existsSync(folder) && statSync(folder).isDirectory()
            ? readdirSync(folder).filter((f) => f.endsWith(".md")).sort()
            : [];
          // Two answers: an empty list means either the folder is there and holds no
          // document, or there is no such folder, and those want different next moves.
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
      // DELIBERATE: a function replacement, not a string one. `replace` is the model's own
      // text, and a string replacement interprets `$$`, `$&`, `` $` `` and `$'` inside it.
      const result = body.replace(find, () => replace);
      // The envelope is not patchable: a patch edits text in place, so `find: "flow: x"` would
      // otherwise reach the envelope, and ownershipCheck guards only PLATFORM_OWNED. Which
      // fields, and what closing this route costs, are in envelopeEditRefusal's docstring.
      const edited = envelopeEditRefusal(body, result);
      if (edited) return text(edited);
      // The chain comes from `result`, which is the same expression document_write uses.
      const chain = chainFor(root, path, result);
      // Against the resulting document, not the replacement fragment: a fragment is a few
      // lines with no frontmatter, and the guards have to see the whole thing.
      const fixed = normalizeSections(chain, path, result);
      const bad = documentGuards(chain, root, path, fixed.content, team);
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

  // Knowledge tools: format is mechanical, judgment stays with skills.

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
      // The same guard the other initiative-taking tools apply. safePath below only
      // stops a path leaving the store, which is a different question from whether the name
      // is an initiative — and `join(root, initiative, d)` further down asks the second one.
      const badInitiative = safeName(initiative, "initiative");
      if (badInitiative) return text(badInitiative);
      const who = parseCaller(requestHeaders());
      const root = await userRoot();
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
      // An audit evidences itself with a source, which is why this call is here and not in a
      // tool named for auditing: `sdlc-spec-audit` and `sdlc-plan-audit` are declared as
      // producing a source that supports the document they audited, and no document of their
      // own. One `noteSource` per supported document — a source supporting two documents is
      // evidence for both stages.
      //
      // DELIBERATE: the chain is resolved from `<initiative>/x.md`, not from the source's own
      // path. `chainFor` answers for a document the flow declares; a source lives under
      // `sources/` and carries no `flow:`, so its own path returns EMPTY_CHAIN and
      // `noteSource` would look the audit step up in an empty stage list and return silently.
      // This is the form `initiative_open` uses to resolve a chain before any document exists.
      const governing = chainFor(root, `${initiative}/x.md`);
      const sourceTeam = await teamFor(who.email);
      for (const supported of list) {
        await noteSource(governing, rel, supported, who.email, sourceTeam);
      }
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
        // COUPLED: `contributed_by` is the field source_add and document_revise write.
        return { path: `${initiative}/sources/${f}`, title: env.title || f,
                 supports: env.supports || "",
                 contributed_by: env.contributed_by || "", added_at: env.added_at || "" };
      });
      return text(JSON.stringify({ initiative, sources: rows }, null, 2));
    },
  );
}
