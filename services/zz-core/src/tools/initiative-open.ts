/**
 * `initiative_open` — the one act that creates an initiative.
 *
 * DELIBERATE: the date is the platform's, never the agent's. The caller sends a slug; there is
 * no argument for the date and no way to pass one. The date is what every listing sorts on, so
 * a wrong one files the initiative in the wrong place for good.
 *
 * Freeform is first-class, not degraded. Opening without a flow gives up only the platform
 * saying what comes next: with no declared chain there is no next stage, and naming one would
 * be a guess. Documents are written, approvals are recorded and the initiative closes, because
 * a gate is a person saying yes and the platform stamping it, not a manifest — `EMPTY_CHAIN`
 * in chain.ts is the same rule for the chain itself.
 *
 * There is no tool for adopting a flow afterwards, and document_write takes no flow
 * argument. Retrofitting a manifest onto documents written without one would land newly
 * demanded gates on documents already written and unapproved, so the platform would have to
 * either refuse the initiative it just adopted or record approvals nobody gave.
 *
 * COUPLED: the rules are in document-rules.ts (the slug) and initiative-record.ts (the name,
 * the record, the collision). This file is the door.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { governingFlows } from "@zz/catalog";
import { parseCaller } from "@zz/contracts";
import { requestHeaders, text } from "@zz/mcp-http";
import { z } from "zod";

import { chainFor } from "../chain.js";
import { moduleForFlow } from "../host/index.js";
import { openRun } from "../host/store.js";
import { slugify, slugRefusal } from "../document-rules.js";
import { initiativeNameFor, recordOpen, takenRefusal } from "../initiative-record.js";
import { db, teamFor } from "../platform-db.js";
import { platformEvent } from "../indexing.js";

import { packagedModules } from "../reviewed-modules.js";

import { initiativeState } from "./initiative-status.js";

export function registerInitiativeOpenTool(server: McpServer): void {
  server.registerTool(
    "initiative_open",
    {
      description:
        "START new work. An initiative is the unit of work on this platform and this is the " +
        "only thing that creates one — writing a document into a name nobody opened is " +
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
      // Shaped, not refused: the platform composes this name and the caller is told to use
      // what comes back, so holding the rest of it to the store's shape is the same rule one
      // character further along. What is genuinely ambiguous was refused above.
      const shaped = slugify(slug);
      if (!shaped) {
        return text(
          `ERROR: "${slug}" has no letters or digits in it, so there is no name to make from ` +
          "it. A few words in the stakeholder's own language.");
      }
      slug = shaped;
      const who = parseCaller(requestHeaders()).email;
      // The anchor row (`zz.initiative`) is the initiative: refused without a database, because
      // there is then nowhere to record it and no silent fallback would give a caller an honest
      // answer to `initiative_status`.
      const p = db();
      if (!p) {
        return text(
          "ERROR: no platform database configured — initiative_open records the initiative as " +
          "a row (its slug, flow, opened_at, opened_by). Nothing was written.");
      }
      const team = await teamFor(who);
      if (!team) {
        return text(
          "ERROR: no team — an initiative belongs to the team that owns the work, and you " +
          "belong to none. Nothing was written.");
      }
      const taken = await takenRefusal(p, team, slug);
      if (taken) return text(taken);

      // A flow the catalog does not have is refused, and the refusal lists the ones it does.
      // Accepting it would open an initiative whose declaration resolves to no chain, which
      // reads back as freeform — so a person who asked for gates would be told much later that
      // they have none.
      if (flow?.trim()) {
        const declared = flow.trim().split("@")[0].trim();
        const known = governingFlows();
        if (!known.includes(declared)) {
          return text(
            `ERROR: no flow named '${declared}'. Flows: ${[...known].sort().join(", ") || "none"}. ` +
            "Open this WITHOUT a flow if none of them govern the work — freeform is supported and " +
            "loses only the platform's next-move answer. It cannot be adopted once the " +
            "initiative exists.");
        }
      }

      const name = initiativeNameFor(slug);

      // ONE writer for the initiative's own row: `zz.initiative` IS the record, so the insert
      // and the declaration are the same act and there is no second statement to keep in step.
      // team_id and opened_by are resolved in that statement — a second round trip can disagree
      // with it about a team or a person renamed between the two.
      const record = await recordOpen(p, team, name, flow ?? null, who);
      // Into the initiative's own journal, which is why this runs after recordOpen: the row
      // carries `initiative_id`, and the initiative's row was written above.
      //
      // DELIBERATE: the journal is not where the declaration lives. `platformEvent` swallows every
      // failure by design, so a row that fails to insert is invisible, and chainFor returns
      // EMPTY_CHAIN for a record saying freeform — a lost row would turn an initiative
      // somebody governed into one governed by nothing, permanently. The event is recorded here
      // because it is an event; the declaration is a file because it has to be readable back
      // with certainty.
      // No `subject`: the declaration IS the initiative's own row now, so the act is about the
      // initiative and `platformEvent` files it under `name`. The old form named the
      // `_open.json` file it wrote, and there is no file.
      platformEvent({ actor: who, kind: "initiative_open",
                      initiative: name, flow: record.flow ?? "" });

      // The control loop is told the run exists.
      //
      // Not every initiative is governed, and null here says so. A freeform initiative and one
      // on a flow with no reviewed module both reach `moduleForFlow` and get null; no run is
      // opened and nothing downstream refuses them, because "not enrolled" and "enrolled and
      // unsatisfied" are different answers a caller has to be able to tell apart.
      //
      // DELIBERATE: a failure here reports rather than throws. The initiative's own row is
      // already written and is what `initiative_status` reads, so a control run that could not be
      // opened must not lose the initiative. `openRun` is idempotent on the initiative, so the run can
      // be opened later without a second one appearing.
      const governed = moduleForFlow(packagedModules, record.flow ?? null);
      let control: string | null = null;
      if (governed) {
        control = await openRun({
          team, initiative: name, digest: governed.digest, by: who,
        });
      }

      // COUPLED: one source for "what comes next" — the same `initiativeState` that
      // `initiative_status` answers from, run over the row just written. `chainFor` picks the
      // declaration up from that row; there is no document yet to read one off.
      const chain = await chainFor(p, team, `${name}/x.md`);
      const state = await initiativeState(p, team, name, chain, chain.documents);
      return text(JSON.stringify({
        initiative: name,
        flow: record.flow,
        // The row's own opened_at/opened_by, reported rather than implied — chain-check and any
        // other reader can see the row was actually written in this call.
        opened_at: record.opened_at,
        opened_by: record.opened_by,
        next_move: state.next_move,
        next_move_absent: state.next_move_absent,
        // Which module governs this, and whether a run is open. Reported rather than implied,
        // so a reader does not have to infer from silence whether the control loop knows about
        // the initiative they just opened.
        governed_by: governed?.module.id ?? null,
        control_run: control,
      }, null, 2));
    },
  );
}
