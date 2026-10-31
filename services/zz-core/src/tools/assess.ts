/**
 * `assess` — ask one semantic-assessment question family about one subject.
 *
 * The checkpoints a flow's skills declare cite the nine families by name. Two of them are asked
 * by the platform itself, the moment an audit round lands (`source_add`); every other checkpoint
 * is asked here, by the stage that reaches it. Either way the answer is recorded in
 * `zz.assessment` with its provenance, and the reading is the platform's, drawn from the
 * probability by a fixed rule — the model answers the question and decides nothing.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { parseCaller, QUESTION_FAMILIES } from "@zz/contracts";
import { WRITES, requestHeaders, text } from "@zz/mcp-http";
import { z } from "zod";

import { initiativeIdFor, unknownInitiative } from "../initiative-record.js";
import { safeName } from "../paths.js";
import { db, teamFor } from "../platform-db.js";
import { Refusal } from "../refusal.js";
import { assessFamily, READING_BANDS } from "../semantic.js";

export function registerAssessTool(server: McpServer): void {
  server.registerTool(
    "assess",
    {
      annotations: WRITES,
      description:
        "Ask one bounded semantic question about one subject and get the platform's reading: " +
        "yes, no, unclear or unavailable, with the probability behind it. `family` is one of the " +
        `nine checkpoint families a flow's skills cite: ${QUESTION_FAMILIES.join(", ")}. ` +
        "`subject` is the text being judged; `context` is what it is judged against (the agreed " +
        "document, the earlier findings, the requirement). The answer is recorded with the " +
        "question, the model that answered and what it was about. It is evidence for a decision, " +
        "never the decision: what to do with `unclear` is the stage's call.",
      inputSchema: {
        family: z.string().describe(`One of: ${QUESTION_FAMILIES.join(", ")}.`),
        subject: z.string().min(1).describe("The text the question is about."),
        context: z.string().optional().describe("What the subject is judged against, when the family compares."),
        initiative: z.string().optional().describe("The initiative this checkpoint belongs to."),
        about: z.string().optional().describe("What is being assessed — a document path, a source, a finding id."),
      },
    },
    async ({ family, subject, context, initiative, about }) => {
      if (initiative) {
        const bad = safeName(initiative, "initiative");
        if (bad) return text(bad);
      }
      // Who would hold the reading, settled before the model is asked: a caller with no team gets
      // a paid answer nothing can record, and an initiative the team does not hold would be
      // recorded against nothing, where a stage reading its checkpoints back never finds it.
      const askedBy = parseCaller(requestHeaders()).email;
      const team = await teamFor(askedBy);
      if (!team) return text(`ERROR: no team — ${askedBy} acts for no live team, so a reading has nowhere to be recorded. Nothing was asked.`);
      const p = db();
      const named = initiative?.trim();
      if (p && named && !await initiativeIdFor(p, team, named)) {
        return text(`ERROR: ${await unknownInitiative(p, team, named)} Nothing was asked.`);
      }
      try {
        const a = await assessFamily({ family, subject, context, initiative: named || null,
                                       about: about ?? null,
                                       askedBy,
                                       recover: "Call `assess` again with the same arguments to record it." });
        return text(JSON.stringify({
          family: a.family, reading: a.reading, probability: a.probability,
          bands: READING_BANDS, question_digest: a.question_digest,
          instruction_version: a.instruction_version,
          requested_model: a.requested_model, resolved_model: a.resolved_model,
          identity_assurance: a.identity_assurance, reason: a.reason,
        }, null, 2));
      } catch (err) {
        if (err instanceof Refusal) return text(err.message);
        throw err;
      }
    },
  );
}
