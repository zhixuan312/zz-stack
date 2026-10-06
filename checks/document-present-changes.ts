#!/usr/bin/env node
/**
 * checks/document-present-changes.ts — Phase 3's acceptance, through a real zz-core on a throwaway
 * database: a presentation shows what changed since the reviewer's covered baseline, and approval
 * signs exactly the snapshot presented (AC-3.1, AC-3.2).
 *
 *   node checks/document-present-changes.ts   # needs Docker and a built tree (`npm run build`)
 *
 * What it establishes, one line per case:
 *
 *   - presenting what changed (AC-3.1): r1 is presented in full in a new context, r2 as the
 *     complete delta from r1, and r3 compares with r2; a new context is shown everything; `full:
 *     true` shows it whole; a read records nothing; a new, deleted (with its extent), renamed,
 *     reordered and moved section, the second of two sections with one title, the preamble, the text
 *     between sections, the trailing text and the review metadata are each in a delta; a working row
 *     nobody was shown is rewritten in place, and a partial presentation pins its snapshot so the
 *     next edit files a new row and the snapshot stays readable by identity; a context resumes from
 *     the pinned snapshot on another session and another client of its principal; pages of two
 *     snapshots of one length never combine; and another principal, or the same principal under
 *     another credential kind, can neither borrow a context nor join its open presentation;
 *   - approving what was shown (AC-3.2): an edit or a metadata change after display is
 *     APPROVAL_CONFLICT; presenting twice without a context, then approving, rests on the most
 *     recent; a body over PART_LIMIT paged with no context passed is approved; the four rules for a
 *     passed context — another's is PRESENTATION_REQUIRED with no fallback, one that covered an
 *     earlier snapshot is APPROVAL_CONFLICT, one still presenting the target is
 *     PRESENTATION_REQUIRED to finish it, and a coverage read that fails is a plain ERROR; an
 *     approval and an edit raced on the document's lock, in both orders, sign only the snapshot
 *     presented; a present and an edit raced the same way, in both orders, leave the edit filing a
 *     new row or the present covering nothing; a document whose rows carry no generation is
 *     presented, stamped, approved, keeps its `base` token and stays readable by identity after an
 *     edit; a ticketless `document_shown` from an agent's credential is refused and records nothing;
 *     and a full and a delta present record `text_chars` and `meta_bytes` exactly.
 *
 * The case groups live in `scripts/schema/present-cases.ts`. Races are staged with the order
 * PostgreSQL grants one advisory lock — the document's own, which a presentation's record and a
 * write both take — as the Phase 1 checks stage them.
 *
 * Exit 0: every case held — one line per case, then the final line.
 * Exit 1: a case failed — the case and what was found, then zz-core's last output.
 * Exit 2: Docker is not available — the check could not run, and that is not a pass.
 */
import { advancingBaseline, approvalRules, approvals, contextsAndPins, everyChange, legacyRows, races,
         recordsAndSizes } from "../scripts/schema/present-cases.ts";
import { withThrowawayCore } from "../scripts/schema/throwaway-core.ts";

const NAME = "document-present-changes";

process.exitCode = await withThrowawayCore(NAME,
  `${NAME}: a complete delta advances the reviewer's covered baseline, a context is its own principal's, and approval signs exactly the snapshot presented: ok`,
  async (c) => {
    await advancingBaseline(c);
    await everyChange(c);
    await contextsAndPins(c);
    await approvals(c);
    await approvalRules(c);
    await races(c);
    await legacyRows(c);
    await recordsAndSizes(c);
  });
