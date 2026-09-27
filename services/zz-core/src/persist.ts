/**
 * Writing a document down, and the four records that go with it.
 *
 * `persistDocument` is the only way bytes reach the store through the tools registered today
 * (document_write/patch, source_add, the initiative acts). It also takes the version snapshot
 * at an approval, writes the activity entry, appends the ledger row on a close, and commits.
 *
 * The envelope is stamped here and nowhere else: `status`, `approved_by`, `approved_at`,
 * `outcome` and `closed_by` are the platform's to write, which is why a model may not send
 * them.
 */
import { execFile } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { ENVELOPE_BLOCK, parseCaller, parseEnvelope } from "@zz/contracts";
import { indexDoc } from "@zz/indexing";
import { requestHeaders } from "@zz/mcp-http";

import { oneLine, tableRow } from "./document-rules.js";
import { type Chain, isoToday, stampEnvelope } from "./write-guards.js";

/** When a flow document's status flips to approved, copy the approved content to
 * _versions/<doc>.v<N>.md. The model never writes these. */
function snapshotOnApproval(chain: Chain, root: string, relPath: string, target: string, newContent: string): void {
  try {
    const parts = relPath.replace(/^\/+/, "").split("/");
    // DELIBERATE: a flow's declaration narrows this; its absence does not switch it off. A
    // freeform initiative has no manifest, and an approval there still files a frozen copy.
    if (parts.length !== 2) return;
    if (chain.documents.length && !chain.docs.has(parts[1])) return;
    if (parseEnvelope(newContent).status !== "approved") return;
    const oldStatus = existsSync(target)
      ? parseEnvelope(readFileSync(target, "utf8")).status
      : undefined;
    if (oldStatus === "approved") return; // only on the flip
    // Through parseEnvelope, not a bare regex: `^version:` with /m over the whole document
    // matches a line in the body, and takes the first match where parseEnvelope takes the last.
    const declaredV = parseEnvelope(newContent).version ?? "";
    const v = /^\d+$/.test(declaredV) ? declaredV : "1";
    const snapshot = parts[1].replace(/\.md$/, "") + ".v" + v + ".md";
    const dir = join(root, parts[0], "_versions");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, snapshot), newContent);
    // Indexed by the path that wrote it, so a frozen approval is searchable without a manual
    // knowledge_reindex. indexDoc derives `superseded_by` from exactly this path shape.
    //
    // The file is the record and the index is derived from it, so a failure here must not fail
    // the write — indexDoc swallows its own errors and reports them, as logActivity does.
    //
    // This one snapshot, not a rebuild of the team: an approval's cost must not grow with the
    // size of the store.
    void indexDoc(root, `${parts[0]}/_versions/${snapshot}`, newContent);
  } catch {
    /* snapshots must never break the write */
  }
}
/** Replace a field's line inside the frontmatter, leaving the body alone.
 *
 * A bare `doc.replace(/^status: .*$/m, …)` is applied to the whole document and rewrites
 * whichever line comes first, and a journal node has body lines that begin with a word and a
 * colon. */
export function setEnvelopeField(doc: string, field: string, value: string): string {
  const m = doc.match(ENVELOPE_BLOCK);
  if (!m) return doc;
  const line = new RegExp(`^${field}:.*$`, "m");
  if (!line.test(m[1])) return doc;
  // Function replacements, both of them: a string replacement interprets $$, $&, $` and $',
  // and `value` is not always the platform's own — initiative_close() passes the model's
  // `accepted_by` through putEnvelopeField below, so `$'` in a name duplicates the rest of the
  // document into its envelope.
  //
  // oneLine() for the other half: a newline in a value adds a field rather than corrupting
  // one, and parseEnvelope takes the last value of a repeated key, so `"Dana Reyes\nflow:
  // other"` sets a flow the platform never chose. Applied here rather than at the four call
  // sites. ownershipCheck cannot catch it: approve and close pass `via`, and that check returns
  // null on `via`.
  return doc.replace(m[0], () => m[0].replace(line, () => `${field}: ${oneLine(value)}`));
}
/** Set an envelope field, adding it when it is not already there.
 *
 * setEnvelopeField only replaces: it returns the document untouched when the field is absent,
 * and the governance fields are stamped onto documents that have never carried them. The
 * insert goes at the end of the frontmatter block, so `flow` and `type` stay at the top where
 * a reader scans for them. */
export function putEnvelopeField(doc: string, field: string, value: string): string {
  const m = doc.match(ENVELOPE_BLOCK);
  if (!m) return doc;
  if (new RegExp(`^${field}:.*$`, "m").test(m[1])) return setEnvelopeField(doc, field, value);
  const block = m[0].replace(/\n---[ \t]*\n?$/, () => `\n${field}: ${oneLine(value)}\n---\n`);
  return doc.replace(m[0], () => block);
}
/** Mechanical activity log — system telemetry, never written by the model.
 * Entries about a file inside an initiative folder go to that folder's
 * activity.jsonl; everything else to _activity.jsonl at the store root. */
export function logActivity(root: string, relPath: string | null, entry: Record<string, unknown>): void {
  try {
    let dir = root;
    const seg = relPath?.replace(/^\/+/, "").split("/")[0];
    if (relPath && relPath.includes("/") && seg && existsSync(join(root, seg))) {
      dir = join(root, seg);
    }
    const line = JSON.stringify({ ts: new Date().toISOString(), ...entry });
    appendFileSync(join(dir, dir === root ? "_activity.jsonl" : "activity.jsonl"), line + "\n");
  } catch {
    /* telemetry must never break the operation it describes */
  }
}
/** Mechanical ledger row on close: when outcome lands in the closing
 * document, append one row to the team's _ledger.md — basics only; the
 * learning analysis computes the rest from telemetry. */
function ledgerOnClose(root: string, relPath: string, content: string): void {
  try {
    const parts = relPath.replace(/^\/+/, "").split("/");
    // A document directly inside an initiative folder; nothing else closes one.
    if (parts.length !== 2) return;
    // Whichever document carries the outcome, whatever a flow named as its closing document:
    // an initiative abandoned part-way is closed on the furthest document that exists, because
    // the closing one was never written.
    //
    // The outcome is the signal. outcomeCheck refuses one typed by hand, so only
    // initiative_close can write it; it writes exactly one; and the already-closed test below
    // stops a second row. Read through parseEnvelope, so a body that merely mentions
    // `outcome:` appends nothing.
    const outcome = parseEnvelope(content).outcome;
    if (!outcome) return;
    const prev = existsSync(join(root, parts[0], parts[1]))
      ? readFileSync(join(root, parts[0], parts[1]), "utf8")
      : "";
    if (parseEnvelope(prev).outcome) return; // already closed once
    let writes = 0, patches = 0, firstTs = "", lastTs = "";
    const act = join(root, parts[0], "activity.jsonl");
    if (existsSync(act)) {
      for (const line of readFileSync(act, "utf8").split("\n")) {
        if (!line.trim()) continue;
        try {
          const e = JSON.parse(line) as { ts?: string; action?: string };
          if (!firstTs && e.ts) firstTs = e.ts;
          if (e.ts) lastTs = e.ts;
          if (e.action === "document_write") writes++;
          if (e.action === "document_patch") patches++;
        } catch { /* skip */ }
      }
    }
    const hours = firstTs && lastTs
      ? ((new Date(lastTs).getTime() - new Date(firstTs).getTime()) / 3.6e6).toFixed(1)
      : "";
    const ledger = join(root, "_ledger.md");
    if (!existsSync(ledger)) {
      writeFileSync(ledger,
        "| closed | initiative | outcome | e2e hours | writes | patches |\n|---|---|---|---|---|---|\n");
    }
    // Escaped through tableRow, like every other table this file writes: an initiative folder
    // named `a|b`, which safePath permits, would otherwise append a row a parser reads as two
    // cells.
    appendFileSync(ledger, tableRow(isoToday(), parts[0], outcome, hours, writes, patches));
  } catch { /* the ledger must never break a close */ }
}
/** The team's store is a git repository, and every act that changes it is a commit.
 *
 * The actor is the git author, so attribution travels with the repository and is readable by
 * `git log` on a machine with nothing of ours installed.
 *
 * DELIBERATE: `add -A` rather than the one path. Journal nodes, sources and the ledger are
 * written by other tools, and staging everything keeps one commit path instead of a call at
 * every writeFileSync. The churn that would drown the history is excluded at init
 * instead, by STORE_GITIGNORE below.
 *
 * Never throws and never blocks: the file is on disk before this runs, so a git failure leaves
 * a team with their document and a missing commit rather than a refused write. Failures go to
 * the container log as well as the activity log, because nothing reads `git_failed`. */
const STORE_GITIGNORE = [
  "# Mechanical telemetry, appended on every call and already held in zz.event.",
  "# A commit per skill load would bury the history this repository exists for.",
  "activity.jsonl",
  "_activity.jsonl",
  "",
].join("\n");
export function commitStore(root: string, actor: string, action: string, subject: string): void {
  const run = (args: string[], then?: () => void): void => {
    execFile("git", ["-C", root, ...args], { timeout: 15_000 }, (err) => {
      if (err) {
        const why = `${args[0]}: ${String(err.message).slice(0, 160)}`;
        logActivity(root, null, { user: actor, action: "git_failed", detail: why });
        // The history can stop being written without a single request failing, and the
        // activity log is read by nothing.
        console.error(`git_failed in ${root}: ${why}`);
        return;
      }
      then?.();
    });
  };
  const name = actor.split("@")[0] || "zz";
  const commit = (): void => run(["add", "-A"], () =>
    // --allow-empty: a write that changed nothing still happened, and a run of them with no
    // commits reads as a store nobody touched.
    run(["-c", `user.name=${name}`, "-c", `user.email=${actor}`,
         "commit", "--allow-empty", "-m", `${action}: ${subject}`]));
  if (existsSync(join(root, ".git"))) return commit();
  // The first act on a team's store initialises it. `-b main` rather than the host's default:
  // a branch name that varies by machine breaks the day this repository gains a remote.
  try {
    writeFileSync(join(root, ".gitignore"), STORE_GITIGNORE);
  } catch { /* unwritable root: init will fail too, and that failure is the one worth logging */ }
  run(["init", "-b", "main"], commit);
}
/** Everything that happens once a mutation is allowed, in the order it must happen.
 *
 * `act` has no default. It becomes the commit message in the team's own repository, and a log
 * in which an approval and a typo fix both read "write" cannot answer what happened between
 * the approval and the close. Without a default, the compiler asks. */
export function persistDocument(chain: Chain, root: string, relPath: string, target: string,
                         content: string, act: string): string {
  const stamped = stampEnvelope(chain, relPath, content);
  mkdirSync(resolve(target, ".."), { recursive: true });
  snapshotOnApproval(chain, root, relPath, target, stamped);
  ledgerOnClose(root, relPath, stamped);
  writeFileSync(target, stamped);
  // The act, not "write": every commit here names its act.
  commitStore(root, parseCaller(requestHeaders()).email, act, relPath);
  void indexDoc(root, relPath, stamped);
  return stamped;
}
