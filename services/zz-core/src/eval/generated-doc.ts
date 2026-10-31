/**
 * The one writer for a document the evaluation door renders from its own record — findings.md,
 * improvement.md and proposal.md. Each is regenerated whole from rows, never edited by hand, so
 * each write is a rewrite of the caller's own team's copy, through the same guards and the same
 * insert path (`saveDocument`) as a document an agent writes.
 */
import { parseCaller, parseEnvelope, PLATFORM_OWNED } from "@zz/contracts";
import { requestHeaders } from "@zz/mcp-http";
import type pg from "pg";

import { chainFor } from "../chain.js";
import { saveDocument } from "../document-save.js";
import { documentGuards } from "../guards.js";
import { sealOf } from "../indexing.js";
import { unopenedRefusal } from "../initiative-record.js";
import { safePath } from "../paths.js";
import { teamFor } from "../platform-db.js";
import { loadDocument } from "../versions.js";
import { envelopeFor, normalizeSections, stampEnvelope } from "../write-guards.js";

/** Write `body` at `path` (`<initiative>/<name>.md`) for `team` — the caller's, unless the rows it
 *  renders belong to another — under `title` and the envelope `fields` that name the rows it was
 *  rendered from. The fields the platform owns, and the version, are carried from the document's
 *  current revision, so a regeneration never resets them. Returns the path and the stamped length,
 *  or a refusal string — never throws for a refusal, the same contract `documentGuards` answers in. */
export async function writeGeneratedDoc(
  p: pg.Pool, path: string, body: string, envelope: { title: string; fields: Record<string, string> },
  forTeam?: string,
): Promise<{ path: string; chars: number } | string> {
  const team = forTeam ?? await teamFor(parseCaller(requestHeaders()).email);
  if (!team) {
    return "ERROR: this caller resolves to no team, so the document has no shelf to be filed on";
  }
  const unopened = await unopenedRefusal(p, team, path);
  if (unopened) return unopened;
  await safePath(path);
  const chain = await chainFor(p, team, path, body);
  const existing = await loadDocument(team, path);
  const onDisk = existing.ok ? parseEnvelope(existing.text) : {};
  const carry: Record<string, string> = {};
  for (const k of [...PLATFORM_OWNED, "version"]) {
    if (onDisk[k]) carry[k] = onDisk[k];
  }
  const content = envelopeFor(chain, path, body, { ...envelope, carry });
  const fixed = normalizeSections(chain, path, content);
  const gate = await documentGuards(chain, path, fixed.content, team);
  if (gate) return gate;
  // `chars` is the stamped document's length, so the count this returns is the bytes that were
  // filed rather than the bytes that were passed in.
  const stamped = stampEnvelope(chain, path, fixed.content);
  const saved = await saveDocument({
    team, relPath: path, initiative: path.split("/")[0], text: stamped, by: parseCaller(requestHeaders()).email,
    flow: chain.name ?? undefined, act: "write", mode: "rewrite",
    seal: sealOf(stamped, existing.ok ? existing.rev : null),
  });
  if ("refusal" in saved) return saved.refusal;
  return { path, chars: stamped.length };
}
