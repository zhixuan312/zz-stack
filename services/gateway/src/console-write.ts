/**
 * /api/console — the console's WRITE surface.
 *
 * console.ts is GET only, deliberately (see its own header): a read-only surface cannot be
 * driven by a forged cross-site form, and every act on the platform belongs in a flow,
 * through zz-core, as the caller. This file is those acts, each arriving from a button in the
 * console rather than a chat turn — the console's stepper shows a document is awaiting
 * approval, and there is no session an operator can carry into an agent's chat to press the
 * button for them.
 *
 * Copies POST /api/kb/sources (kb.ts), the proven browser-to-zz-core write path in this
 * codebase: collect the request's own `x-zz-*` headers, open an `Mcp` client against
 * `CORE_MCP_URL` with them attached, and call the tool. THE GATEWAY WRITES NO PLATFORM TABLE
 * ITSELF and never sets `approved_by` — zz-core reads the author from those headers and
 * trusts them because a peer allowlist admits only the gateway, and forwarding them is what
 * keeps the web from ever acting as somebody else. `on_behalf_of` is never sent for the same
 * reason: that field is for a verdict that is someone else's, and the console caller is
 * always approving as themselves.
 *
 * Authorised through console.ts's own `handler()`, not a copy of it — the same directory-or-
 * superadmin gate and the same `resolveScope` that decides which team a read sees. A write
 * needs a settled answer to "which team", not the platform-wide reading of it: `document_approve`
 * stamps one document belonging to one team, and there is no fleet-wide version of that
 * question for `?scope=platform` to answer, so this route refuses that case with a 400
 * rather than picking a team to log against that nobody asked for.
 *
 * `revise` (Task I-23) is the same shape with one thing added in the middle: there is no
 * editor anywhere in this console (see the initiative that shipped it — "nobody hand-edits
 * document markdown in a browser") so a body to send zz-core does not exist until this
 * route makes one. It reads the document's discussion thread (never the request body — the
 * caller supplies nothing but the instruction to proceed), asks the platform's own model to
 * write the next version from it, and only THEN reaches `core.call("document_revise", …)`
 * exactly the way `document_approve` reaches `core.call("document_approve", …)` above. A generation failure
 * leaves the document untouched — nothing is written to zz-core until `generate()` has
 * already succeeded.
 */
import type { Express, Request, Response } from "express";

import { parseEnvelope } from "@zz/contracts";
import { Mcp, McpError } from "@zz/mcp-client";

import { handler, type ResolvedScope } from "./console/shared.js";
import { platformDb } from "./db.js";
import { fetchMessages, type ThreadMessage } from "./discussion.js";
import { logEvent } from "./events.js";
import { generate } from "./generate.js";
import { withoutFrontmatter } from "./package/skills.js";

/**
 * The revision prompt — the part of this route worth reading carefully.
 *
 * WHY THIS IS NOT "here's a document, make it better": a model handed a document and told
 * to incorporate feedback treats the whole document as a draft it is free to improve —
 * tightening a sentence nobody flagged, re-ordering a section, fixing a table it decided
 * looked wrong. That is invisible generosity from the model's side and an unreviewable diff
 * from the team's: whoever looks at the new draft has no way to tell which of forty changed
 * lines came from the conversation they just had and which came from the model deciding the
 * prose could be better. So the rule is stated twice, in different words: change only what
 * the discussion actually asks for, and leave everything else — including a disagreement
 * nobody resolved — exactly as it was. Silently picking a side in an open argument would be
 * worse than leaving the argument visible in the next round of discussion.
 *
 * WHY NO FRONTMATTER: the platform writes the envelope (version, status, approval) itself,
 * deterministically, the same way for every caller of `document_revise` — that is the whole
 * reason the tool exists instead of a plain overwrite. A model asked to produce "a document"
 * reaches for frontmatter out of habit, and zz-core refuses a body that opens with one
 * (`frontmatterRefusal`), which is why the rule is spelled out rather than assumed.
 */
const REVISE_SYSTEM_PROMPT =
  "You are the ZZ platform, authoring the next version of a governed document on behalf " +
  "of the team that just discussed it below. You are not a writing assistant asked to " +
  "improve the document in general — you are implementing what the discussion decided, " +
  "and nothing else.\n\n" +
  "Rules:\n" +
  "1. Change only what the discussion actually asks for. Leave every other sentence, " +
  "heading and section exactly as it already reads.\n" +
  "2. Never invent agreement the discussion does not contain. Where people raised a " +
  "question without resolving it, or disagreed without landing anywhere, leave that part " +
  "of the document unchanged rather than silently picking a side.\n" +
  "3. Output ONLY the complete revised document body, in markdown, starting at the first " +
  "heading. Do not write any YAML frontmatter or an opening '---' block — the platform " +
  "writes that itself and refuses a body that opens with one.\n" +
  "4. Output the full document, not a diff or a summary of changes — every section the " +
  "discussion did not touch must still be present, verbatim.";

/** Strips one Markdown code fence wrapping the whole answer, if the model added one despite
 *  rule 3 above — "markdown only" reads, to a model, as "format this as markdown", and a
 *  ```` ```markdown ... ``` ```` fence around an otherwise-correct answer is a habit no
 *  amount of prompt wording reliably suppresses. Only the OUTERMOST fence is removed, and
 *  only when it wraps the entire answer (open on the first line, close on the last) — a
 *  fence that is part of the document's own content (a spec quoting a code block) must
 *  survive untouched. */
function stripWrappingFence(body: string): string {
  const m = /^```[^\n]*\n([\s\S]*)\n```\s*$/.exec(body.trim());
  return m ? m[1] : body;
}

export function mountConsoleWrite(app: Express): void {
  // NOT A TOOL: handler()'s first argument is the human-readable label in "console <name>
  // failed" and "could not read <name>" — its siblings are "an answer", "the thread" and
  // "revise". Renaming it to the tool would make the error read "could not read
  // document_approve", which is worse prose and out of step with every other route here.
  app.post("/api/console/documents/approve", handler("approve", async (req: Request, res: Response, scope: ResolvedScope) => {
    if (scope.kind !== "team") {
      // Only `{ kind: "platform" }` reaches here otherwise (a refused scope already
      // answered inside handler()), and the platform reading exists for fleet-wide
      // dashboards — it names no team, so there is nothing for `zz.event`'s team column
      // or the membership check below to be about.
      res.status(400).json({ error: "approve needs one team — pass ?team=<slug>, not ?scope=platform" });
      return;
    }
    const { initiative, path } = (req.body ?? {}) as Record<string, string>;
    if (!initiative || !path) {
      res.status(400).json({ error: "initiative and path required" });
      return;
    }
    const actor = req.zzIdentity!.email;
    // The caller's own identity, forwarded — see the file header for why this is not the
    // gateway acting on the caller's behalf.
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (k.toLowerCase().startsWith("x-zz-") && typeof v === "string") headers[k] = v;
    }
    const core = new Mcp(process.env.CORE_MCP_URL || "http://zz-core:8000/mcp", { headers });
    const subject = `${initiative}/${path}`;
    let reply: string;
    try {
      reply = await core.call("document_approve", { path: subject });
    } catch (err) {
      // `Mcp.call` throws only for a transport or protocol failure — a refusal comes back
      // as ordinary text beginning with ERROR, read below. So everything that lands here is
      // "could not reach zz-core", never "zz-core said no", and the caller needs a status
      // that says which one happened rather than a generic 500.
      res.status(502).json({ error: err instanceof McpError ? err.message : "zz-core unreachable" });
      return;
    }
    // zz-core's refusal IS the diagnosis — not a member of the document's team, the path
    // does not exist, the document is not one this flow declares — so it is carried back
    // unchanged rather than replaced with a generic message that would throw that away.
    if (/^ERROR/.test(reply)) { res.status(400).json({ error: reply }); return; }
    // Written after the act succeeds, never before, and `via: "web"` is stated explicitly
    // here rather than assumed from `document_approve` itself — document_approve() has callers that are not
    // this console, and none of them should inherit a door marker they did not come
    // through. See the gate check below this file's sibling check in scripts/gate.ts for
    // what happens to FR-8 the day a route forgets this line.
    logEvent({ actor, teamSlug: scope.slug, kind: "document.approve", subject, detail: { via: "web" } });
    res.json({ ok: true, result: reply });
  }));

  app.post("/api/console/documents/revise", handler("revise", async (req: Request, res: Response, scope: ResolvedScope) => {
    if (scope.kind !== "team") {
      // Same reasoning as approve's own refusal above: a revision stamps one team's
      // document, and there is no fleet-wide reading of "revise" for ?scope=platform to
      // answer.
      res.status(400).json({ error: "revise needs one team — pass ?team=<slug>, not ?scope=platform" });
      return;
    }
    const { initiative, path } = (req.body ?? {}) as Record<string, string>;
    if (!initiative || !path) {
      res.status(400).json({ error: "initiative and path required" });
      return;
    }
    const actor = req.zzIdentity!.email;
    const subject = `${initiative}/${path}`;

    // THE THREAD, READ SERVER-SIDE — never the request body. There is no editor and no
    // client-supplied content on this route (see the file header): the only thing a caller
    // sends is `{ initiative, path }`, and what changes the document is whatever the team
    // already said to each other, read fresh off `zz.discussion_message` through the SAME
    // `fetchMessages` the GET route in discussion.ts uses — not a second query for the same
    // rows. An empty thread names itself rather than reaching the model with nothing to
    // work from.
    const messages: ThreadMessage[] = await fetchMessages(platformDb(), scope.slug, initiative, path, undefined);
    if (messages.length === 0) {
      res.status(400).json({ error: "the discussion on this document is empty — there is nothing to revise from" });
      return;
    }

    // The caller's own identity, forwarded — see the file header for why this is not the
    // gateway acting on the caller's behalf.
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (k.toLowerCase().startsWith("x-zz-") && typeof v === "string") headers[k] = v;
    }
    const core = new Mcp(process.env.CORE_MCP_URL || "http://zz-core:8000/mcp", { headers });

    let current: string;
    try {
      current = await core.call("document_read", { path: subject });
    } catch (err) {
      res.status(502).json({ error: err instanceof McpError ? err.message : "zz-core unreachable" });
      return;
    }
    // A missing document, or a path this flow does not declare, comes back as zz-core's own
    // refusal text — carried back unchanged, same as approve's own reply below.
    if (/^ERROR/.test(current)) { res.status(400).json({ error: current }); return; }

    // A CLOSED INITIATIVE'S DOCUMENTS ARE THE RECORD, and this refuses to rewrite one.
    //
    // Found by doing it on UAT: revising the closing document of a closed initiative moved
    // its version while `outcome` and `closed_by` stayed on it. Nothing was corrupted —
    // zz-core carries those forward deliberately, and its own comment records the incident
    // where DELETING them reopened a closed initiative and let initiative_close() append a second
    // ledger row for the same work. But the ledger row was written from this document at the
    // close, and rewriting it afterwards is how a document and the ledger come to disagree
    // about work that is finished.
    //
    // The console already hides the control for a closed document. Hiding is not enforcing:
    // a request can still arrive, and the rule belongs where the act happens.
    if ((parseEnvelope(current).outcome ?? "").trim()) {
      res.status(400).json({
        error: "this initiative is closed — its documents are the record the ledger was " +
               "written from, and a revision now would leave the two disagreeing. Open a " +
               "new initiative for work that continues.",
      });
      return;
    }

    // QUOTED, NEVER PARAPHRASED (AC-7). The exact text handed to the model is the exact
    // text that becomes `source_content` below, so the record of why the document changed
    // is provably the conversation itself and not this route's own summary of it.
    const discussionText = messages
      .map((m) => `${m.author.name} (${m.author.email}):\n${m.body}`)
      .join("\n\n---\n\n");

    let revisedBody: string;
    try {
      revisedBody = await generate({
        system: REVISE_SYSTEM_PROMPT,
        user:
          `Document: ${subject}\n\n` +
          `Current version, in full:\n\n${withoutFrontmatter(current)}\n\n` +
          "---\n\nThe discussion about this document, in order, verbatim:\n\n" +
          `${discussionText}\n\n` +
          "---\n\nWrite the complete revised document body reflecting what the discussion " +
          "above actually decided. Nothing else changes.",
        // Generous on purpose: this rewrites a whole document, not a chat answer, and the
        // ask feature's own defaults (generate.ts) are tuned for a short reply to a
        // question. judge.ts and stakeholder.ts already run a call over a full document at
        // 110s/120s (see generate.ts's own header) — a full rewrite gets the same headroom,
        // not the 60s meant for a person watching a spinner over one paragraph. A truncated
        // answer is still a failure either way: generate() itself refuses one (see its own
        // `finish_reason: "length"` handling) before this route ever sees it.
        maxTokens: 16_000,
        timeoutMs: 120_000,
      });
    } catch (err) {
      // generate()'s own contract: 503 when the endpoint has no LLM_* configured, 502 for a
      // timeout, a bad provider answer, or a truncated/empty one. Either way NOTHING has
      // been written yet — core.call("document_revise", …) below is the first write this
      // route makes, and it is never reached from this branch.
      const status = (err as { status?: number }).status ?? 502;
      res.status(status).json({ error: err instanceof Error ? err.message : "generation failed" });
      return;
    }

    let reply: string;
    try {
      reply = await core.call("document_revise", {
        path: subject,
        content: stripWrappingFence(revisedBody),
        source_content: discussionText,
        source_title: `Discussion — ${subject}`,
      });
    } catch (err) {
      res.status(502).json({ error: err instanceof McpError ? err.message : "zz-core unreachable" });
      return;
    }
    // A frontmatter body, a stale path, a closed initiative — zz-core's refusal is the
    // diagnosis, same as every other route in this file.
    if (/^ERROR/.test(reply)) { res.status(400).json({ error: reply }); return; }

    // Written after the act succeeds, never before — same rule as approve's own write above.
    logEvent({ actor, teamSlug: scope.slug, kind: "document.revise", subject, detail: { via: "web" } });

    // zz-core's own success text always opens "<path> revised: vN -> vM, status …" (see
    // document_revise's registration) — read from THAT reply rather than a second round
    // trip back to zz-core to ask the version it just wrote.
    const version = /-> v(\d+)/.exec(reply)?.[1];
    res.json({ ok: true, version: version ? Number(version) : null });
  }));
}
