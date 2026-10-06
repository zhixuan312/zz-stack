/**
 * The stale-base reply: what `BASE_CONFLICT` says at both places a caller's `base` is found stale —
 * the change service's step (7) and the compare-and-swap in `saveDocument` — and the snapshot shape
 * a change set is computed over.
 *
 * DELIBERATE: its own module. Both the change service and the write path call it, and the write path
 * is what the change service calls; living in either would make the two import each other.
 */
import { documentBody, parseEnvelope } from "@zz/contracts";
import type pg from "pg";

import { deltaOf, recordLine, type Snapshot } from "./document-delta.js";
import { type Line, refusalText, settleRefusal } from "./document-details.js";
import { RESERVED_ENVELOPE } from "./document-rules.js";
import { loadSnapshot } from "./versions.js";

/** A snapshot's text as the change set reads it: the body, and the metadata its content identity
 *  is taken over (`identityOf`, document-save.ts) — title, tags, stakeholder and every field the
 *  platform does not write — so a change set has a record exactly where the identity moved. */
function changeSnapshot(text: string): Snapshot {
  const env = parseEnvelope(text);
  return { body: documentBody(text), title: env.title ?? "", stakeholder: env.stakeholder ?? "",
           tags: (env.tags ?? "").split(",").map((t) => t.trim()).filter(Boolean),
           fields: Object.fromEntries(Object.entries(env).filter(([k]) => !RESERVED_ENVELOPE.has(k))) };
}

/** BASE_CONFLICT, at (7) and at the compare-and-swap in `saveDocument`: the current content
 *  revision, and what changed since the snapshot `base` names — its change set to the current one
 *  when it is retained, and why that cannot be named when it is not. Read on the pool, once the
 *  caller's transaction is gone; a list too long for the reply is settled as a refusal's detail. */
export async function baseConflict(
  p: Pick<pg.Pool, "query">, who: string, team: string, path: string, base: string, current: string,
): Promise<string> {
  const lead = `ERROR: BASE_CONFLICT — ${path} is at content revision ${current} now, not the one \`base\` names`;
  const again = "Read it again and apply the change to what it says now.";
  const [was, now] = [await loadSnapshot(team, path, base), await loadSnapshot(team, path, current)];
  let line: Line;
  if (!was.ok) {
    const why = /^ERROR: SNAPSHOT_UNAVAILABLE — (.*?)(; read the current one)?$/.exec(was.refusal)?.[1] ??
      `${base} retained no bytes`;
    line = `${lead}, and what changed since it cannot be named: ${why}. ${again}`;
  } else if (!now.ok) {
    line = `${lead}, and it changed again while this was answered. ${again}`;
  } else {
    const delta = deltaOf(changeSnapshot(was.text), changeSnapshot(now.text));
    line = delta.kind === "full"
      ? `${lead}; what changed since \`base\` is as long as the document itself. ${again}`
      : !delta.records.length
        ? `${lead}, though its content is what \`base\`'s was. ${again}`
        : { lead: `${lead}; `, label: "changed since `base`", items: delta.records.map(recordLine), sep: "; ",
            tail: `. ${again}` };
  }
  return settleRefusal(p, { who, team, path }, refusalText([line]));
}
