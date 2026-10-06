/** Facts about the record that a script decides, so no model has to.
 *
 * A skill is prose, and prose read by a model can be followed, half-followed or reasoned
 * around with nothing downstream able to tell which. Anything settleable by running a function
 * is settled here, and the tool reports the answer. The model chooses which function to call.
 *
 * WHAT AN APPROVAL RESTS ON. `document_approve` signs exactly one snapshot — the current one, whose
 * content revision is the generation its compare-and-swap pins — and only when a review context of
 * the caller's covered exactly that snapshot (`approvalBasis`): the one passed, or the caller's most
 * recent one that covers it. A context is the caller's own (review-context.ts): the same principal,
 * team, document and credential kind, so a console session's presentation never satisfies an
 * agent's approval, nor the reverse, and nobody else's presentation satisfies anybody's. Coverage is
 * read from the presentation rows themselves and FAILS CLOSED: a read that cannot answer refuses.
 * The approval's own record — the context it rests on, the snapshot, the signer, the caller — is
 * composed here (`approvalRecord`) and written in the seal's transaction, as its one act row.
 *
 * COUPLED: `doc_revision.presented_at` is still set when a presentation completes the current
 * snapshot's coverage in its review context (`commitPresentation`, review-context.ts), and the pin
 * rule (`currentRow`, document-snapshot.ts) reads it. No approval reads it any more: a timestamp per
 * row cannot say who was shown the bytes, in which review, or which snapshot an approval means.
 */
import type pg from "pg";

import { deltaOf, recordLine } from "./document-delta.js";
import { type Line, refusalText, settleRefusal } from "./document-details.js";
import { contextState, coverageOf, pagesOf, type Viewer } from "./review-context.js";
import { changeSnapshot } from "./stale-base.js";
import { loadSnapshot } from "./versions.js";

/** The `kind` every document act is recorded under: `document.<action>`. Exported because
 *  `recordAct` (versions.ts) is the writer and the presentation rows are read back by that prefix,
 *  and a prefix spelled twice is one that drifts. */
export const DOCUMENT_EVENT_PREFIX = "document.";

/** The document's address split the way every reader splits it: the initiative, and the name
 *  inside it. `null` for a path that is not `<initiative>/<document>` — a bare name, or a
 *  document under a folder of its own. */
export function splitDocPath(relPath: string): { initiative: string; path: string } | null {
  const parts = relPath.replace(/^\/+/, "").split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  return { initiative: parts[0], path: parts[1] };
}

/** Which presentation an approval of `target` — the current snapshot's content revision — rests
 *  on, or why it may not be recorded:
 *    - `expected` (the caller's `expected_revision`) that is not `target` is `APPROVAL_CONFLICT`;
 *    - a passed `context` must be the caller's: an unknown one is `PRESENTATION_REQUIRED`, one that
 *      covers `target` is used, one still presenting `target` is `PRESENTATION_REQUIRED`, to finish
 *      it, and one whose covered snapshot is an earlier one is `APPROVAL_CONFLICT` — what it showed
 *      is not what would be signed;
 *    - with none passed, the caller's most recent context — by its last recorded page — that covers
 *      `target` is used; none is `PRESENTATION_REQUIRED`, naming the context to present in.
 *  A read that fails refuses. */
export async function approvalBasis(
  p: pg.Pool, who: Viewer, rel: string, target: string, a: { expected?: string; context?: string },
): Promise<{ target: string; context: string } | { refusal: string }> {
  if (a.expected !== undefined && a.expected !== target) {
    return { refusal: await approvalConflict(p, who, rel, a.expected, target) };
  }
  const present = (how: string): string =>
    `${how} — it shows what changed since that context last covered the document — put every part it ` +
    "returns in front of the person, then approve with the `review_context` and `expected_revision` it names.";
  try {
    if (a.context !== undefined) {
      const s = await contextState(p, who, rel, a.context);
      if (!s.known) {
        return { refusal:
          `ERROR: PRESENTATION_REQUIRED — the review context ${a.context} is not one of yours for ${rel}: a context ` +
          "belongs to the person, the document and the kind of credential it was presented under. Call " +
          `\`document_present\` on ${rel}, put every part it returns in front of the person, then approve with ` +
          "the `review_context` it returns." };
      }
      if (s.covered.includes(target)) return { target, context: a.context };
      if (s.baseline && s.open?.target !== target) return { refusal: await approvalConflict(p, who, rel, s.baseline, target) };
      return { refusal:
        `ERROR: PRESENTATION_REQUIRED — the review context ${a.context} has not covered ${target}, the current ` +
        `snapshot of ${rel}: its presentation of it is not complete. Continue it — \`document_present\` with path ` +
        `"${rel}", review_context: "${a.context}" and the \`offset\` its last part named — put every part in front ` +
        "of the person, then approve with that `review_context`." };
    }
    const by = new Map<string, Awaited<ReturnType<typeof pagesOf>>>();
    for (const page of await pagesOf(p, who, rel, null)) {
      const own = by.get(page.context) ?? [];
      own.push(page);
      by.delete(page.context);
      by.set(page.context, own);
    }
    // Most recent last: a context moves to the end each time a page of it is recorded.
    const recent = [...by.keys()].reverse();
    const used = recent.find((c) => coverageOf(by.get(c)!).includes(target));
    if (used) return { target, context: used };
    return { refusal:
      `ERROR: PRESENTATION_REQUIRED — no review context of yours covers ${target}, the current snapshot of ` +
      `${rel}, so nothing shows these bytes were presented to you. ` +
      (recent[0]
        ? present(`Call \`document_present\` with path "${rel}" and review_context: "${recent[0]}"`)
        : `Call \`document_present\` on ${rel}, put every part it returns in front of the person, then ` +
          "approve with the `review_context` and `expected_revision` it names.") };
  } catch (err) {
    return { refusal:
      `ERROR: ${rel} was not approved — what was presented of it could not be read ` +
      `(${err instanceof Error ? err.message : String(err)}), and an approval is never recorded on a presentation ` +
      "nobody can confirm. Call `document_approve` again." };
  }
}

/** `APPROVAL_CONFLICT`: the snapshot an approval was meant for is not the current one — a stale
 *  `expected_revision`, a context that covered an earlier snapshot, or a write that landed between
 *  the approval's read and its seal. Names the current revision and the change set from the one
 *  meant, when it is retained; a list too long for the reply is settled as a refusal's detail. */
export async function approvalConflict(
  p: Pick<pg.Pool, "query">, who: Viewer, rel: string, meant: string, current: string,
): Promise<string> {
  const lead = `ERROR: APPROVAL_CONFLICT — ${rel} is at content revision ${current} now, not ${meant}, the snapshot ` +
    "this approval was for; nothing was approved";
  const again = "Present it again — in the same review context, so only what changed is shown — then approve the " +
    "snapshot that present names.";
  let line: Line;
  try {
    const [was, now] = [await loadSnapshot(who.team, rel, meant), await loadSnapshot(who.team, rel, current)];
    if (!was.ok) {
      const why = /^ERROR: SNAPSHOT_UNAVAILABLE — (.*?)(; read the current one)?$/.exec(was.refusal)?.[1] ??
        `${meant} retained no bytes`;
      line = `${lead}, and what changed since it cannot be named: ${why}. ${again}`;
    } else if (!now.ok) {
      line = `${lead}, and it changed again while this was answered. ${again}`;
    } else {
      const delta = deltaOf(changeSnapshot(was.text), changeSnapshot(now.text));
      line = delta.kind === "full"
        ? `${lead}; what changed since it is as long as the document itself. ${again}`
        : !delta.records.length
          ? `${lead}, though its content is what ${meant}'s was. ${again}`
          : { lead: `${lead}; `, label: `changed since ${meant}`, items: delta.records.map(recordLine), sep: "; ",
              tail: `. ${again}` };
    }
  } catch (err) {
    line = `${lead}, and what changed since it cannot be named: ${err instanceof Error ? err.message : String(err)}. ${again}`;
  }
  return settleRefusal(p, { who: who.email, team: who.team, path: rel }, refusalText([line]));
}

/** The approval's record — the detail of its one act row, written in the seal's transaction by
 *  `saveDocument`: who recorded it, whose decision it is, the review context it rests on and the
 *  snapshot it signs. Not "the signer read it": a delegated approval rests on the caller's
 *  presentation, and the record says so by naming both. */
export function approvalRecord(a: { caller: string; signer: string; context: string; target: string }): Record<string, string> {
  return { user: a.caller, signer: a.signer, review_context: a.context, content_revision: a.target };
}

/** Record that the current snapshot's coverage was completed — on the row a presentation pinned.
 *
 * Called by `commitPresentation` (review-context.ts) alone, inside the presentation's transaction
 * and on its client, so the column is written exactly when the row recording the completing page
 * commits; a failure fails that transaction. The pin rule reads it. */
export async function recordPresented(
  c: Pick<pg.Pool, "query">, docId: string, revision: number,
): Promise<void> {
  await c.query(
    "update zz.doc_revision r set presented_at = now() where r.doc_id = $1::uuid and r.revision = $2",
    [docId, revision]);
}
