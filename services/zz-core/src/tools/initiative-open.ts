/**
 * `initiative_open` — the one act that creates an initiative.
 *
 * THE DATE IS THE PLATFORM'S, NEVER THE AGENT'S. document-rules.ts records what the other way
 * costs: an agent inferred "today" from the newest stored row plus the digits in a run tag and
 * named a folder no later stamp could repair, and the date is what every listing sorts on, so
 * a wrong one files the initiative in the wrong place for good. The caller sends a slug. There
 * is no argument for the date and no way to pass one.
 *
 * FREEFORM IS FIRST-CLASS, NOT DEGRADED. Opening without a flow is a choice, and the only
 * thing it gives up is the platform saying what comes NEXT: with no declared chain there is no
 * next stage, and naming one would be a guess. Everything else works — documents are written,
 * approvals are recorded, the initiative closes — because a gate is a person saying yes and
 * the platform stamping it, not a manifest. chain.ts:75-82 words the same rule for the chain
 * itself: "Enforcing nothing is the honest outcome of not knowing; enforcing somebody else's
 * chain is a guardrail pointed at the wrong thing."
 *
 * THERE IS NO TOOL FOR ADOPTING A FLOW AFTERWARDS, per FR-30, and the argument that used to do
 * it by accident is gone from document_write. Retrofitting a manifest onto documents written
 * without one is a migration dressed as a verb: the gates it newly demands land on documents
 * already written and unapproved, so the platform would have to either refuse the initiative
 * it just adopted or record approvals nobody gave.
 *
 * The rules themselves are in document-rules.ts (the slug) and initiative-record.ts (the name,
 * the record, the collision). This file is the door.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { parseCaller } from "@zz/contracts";
import { requestHeaders, text } from "@zz/mcp-http";
import { z } from "zod";

import { chainFor } from "../chain.js";
import { slugRefusal } from "../document-rules.js";
import { initiativeNameFor, OPEN_RECORD, recordOpen, takenRefusal } from "../initiative-record.js";
import { userRoot } from "../paths.js";
import { logActivity } from "../persist.js";
import { teamFor } from "../platform-db.js";
import { governingFlows } from "../skill-roots.js";

import { initiativeState } from "./initiative-status.js";

export function registerInitiativeOpenTool(server: McpServer): void {
  server.registerTool(
    "initiative_open",
    {
      description:
        "START new work. An initiative is the unit of work on this platform and this is the " +
        "only thing that creates one — writing a document into a name nobody opened is now " +
        "refused. Send the SLUG alone, in the stakeholder's own words: the platform prepends " +
        "today's date, because the date is what every listing sorts on and an agent's idea of " +
        "today has filed a folder in the wrong place for good. " +
        "Pass `flow` when a flow governs this work and its gates and document order should be " +
        "enforced. LEAVING IT OUT IS A CHOICE, not an omission: a freeform initiative takes " +
        "every document, approval and close a governed one does, and the only thing it gives " +
        "up is the platform telling you what comes next. A flow cannot be adopted afterwards, " +
        "so decide here.",
      inputSchema: {
        slug: z.string().describe(
          "A few words in the stakeholder's own language, hyphenated: `payment-retries`. NO " +
          "DATE — the platform prepends today's."),
        flow: z.string().optional().describe(
          "The flow whose gates and document order govern this initiative, e.g. `sdlc-flow`. " +
          "Omit for freeform work; that is supported, not degraded."),
      },
    },
    async ({ slug, flow }) => {
      const bad = slugRefusal(slug);
      if (bad) return text(bad);
      const who = parseCaller(requestHeaders()).email;
      const root = await userRoot();
      const taken = takenRefusal(root, slug);
      if (taken) return text(taken);

      // A FLOW THE TEAM HAS NOT INSTALLED IS REFUSED, and the refusal lists the ones they
      // have. Accepting it would open an initiative whose declaration resolves to no chain,
      // which reads back as freeform — so a person who asked for gates would be told they
      // have none much later, by nothing in particular, and after writing documents under
      // the belief that something was checking them.
      const team = await teamFor(who);
      if (flow?.trim()) {
        const declared = flow.trim().split("@")[0].trim();
        let installed: Set<string> | null = null;
        try {
          installed = await governingFlows(team);
        } catch {
          // The registry is unreachable. Refusing here would block work over an outage the
          // caller cannot fix and cannot wait out, and unlike a write this act is cheap to
          // repeat. Accepted, and the chain simply resolves when the registry returns.
          installed = null;
        }
        if (installed && !installed.has(declared)) {
          return text(
            `ERROR: no flow named '${declared}' is installed for your team. Installed: ` +
            `${[...installed].sort().join(", ") || "none"}. Open this WITHOUT a flow if none ` +
            "of them govern the work — freeform is supported and loses only the platform's " +
            "next-move answer — or ask an admin to install the one you meant. It cannot be " +
            "adopted once the initiative exists.");
        }
      }

      const name = initiativeNameFor(slug);
      const record = recordOpen(root, name, flow ?? null, who);
      // INTO THE INITIATIVE'S OWN LOG, which is why this is called after recordOpen: the
      // folder has to exist for logActivity to place the line there rather than in the
      // team-wide `_activity.jsonl`, and `relPath: null` puts it in the team-wide one.
      //
      // THE LOG IS NOT WHERE THE DECLARATION LIVES, and that is deliberate rather than
      // duplication. logActivity swallows every failure by design — "telemetry must never
      // break the operation it describes" — so a line that fails to append is invisible. The
      // flow declaration is not telemetry: chainFor returns EMPTY_CHAIN for a record saying
      // freeform, so a lost line would turn an initiative somebody governed into one governed
      // by nothing, permanently, with nothing anywhere saying so. That is the failure shape
      // chain.ts already names — one that "fails in the direction that looks like success".
      // The event is recorded here because it IS an event; the declaration is a file because
      // it has to be readable back with certainty.
      logActivity(root, `${name}/${OPEN_RECORD}`,
        { user: who, action: "initiative_open", initiative: name, flow: record.flow ?? "" });

      // ONE SOURCE FOR "WHAT COMES NEXT". The same `initiativeState` that `initiative_status`
      // answers from, run over the folder just created — so the sentence a person reads at
      // open time and the one they read a week later come from the same code rather than from
      // two that agree today. chainFor picks the declaration up from the record written above;
      // there is no document yet for it to read one off.
      const chain = await chainFor(root, `${name}/x.md`, team);
      const state = initiativeState(root, name, chain, chain.documents);
      return text(JSON.stringify({
        initiative: name,
        flow: record.flow,
        next_move: state.next_move,
        next_move_absent: state.next_move_absent,
      }, null, 2));
    },
  );
}
