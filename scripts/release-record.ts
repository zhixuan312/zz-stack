#!/usr/bin/env node
/**
 * release-record.ts — what a release's row in `zz.release` says, read from its own changelog
 * section, and the one statement that records it.
 *
 *   node scripts/release-record.ts --correct <version>   # rewrite that version's row from the
 *                                                        # current changelog, printing it before and after
 *   node scripts/release-record.ts --record <version>    # write the rows a release could not: that
 *                                                        # version's, and every other tag's that has none
 *
 * The release records itself right after it writes its tag (`scripts/release.ts` step 7, and
 * `scripts/release/tag-live.ts` for a release tagged by `--verify-only`). Each call passes every
 * `v*` tag with its creation time, so the first release that has the table records every release
 * before it, and every later one adds only itself.
 *
 * A release whose row could not be written (the database did not answer, say) stays released, and its
 * warning names `--record <version>`, which writes the row the same way once the database answers:
 * from that version's tag, which must exist, and its changelog section. It is safe to run again: a row
 * already there is left as it is.
 *
 * A row is inserted once and never compared again, except the version being recorded: a stored row
 * for it that differs from what its section says now is reported and left as it is, for an operator
 * to settle with `--correct`. So a later edit to a published section, or a change to this parser,
 * touches no release that is already recorded.
 *
 * A tag with no section is recorded as `No changelog entry`, and its client action as unknown,
 * never as nothing to do: the absence of upgrade notes means nothing to do only where a section
 * was written and left them out.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { log, root, run, warn } from "./deployment.ts";
import { regSql } from "./release/registries.ts";

export const NO_CHANGELOG = "No changelog entry";
export const UNKNOWN_ACTION = "Unknown — no recorded upgrade notes";

interface ReleaseRecord {
  summary: string;
  changelog: string;
  upgradeNotes: string | null;
  clientAction: string | null;
  consoleVersion: string | null;
}

interface Recorded {
  recorded: string[];
  already: string[];
  conflicts: string[];
  tags: number;
  rows: number;
}

const SEMVER = String.raw`\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?`;
/** The line of versions an early section opens with, in place of the heading's own. */
const BANNER = /^(?:\*\*)?zz-stack \d+\.\d+\.\d+ · .+$/;
/** A list item's marker at the start of a line: `-`, `*`, `+` or `1.`. */
const ITEM = /^(?:[-*+]|\d+\.)\s+/;
/** Words whose full stop does not end a sentence. */
const ABBREVIATIONS = new Set(["e.g", "i.e", "etc", "vs", "cf"]);

const escaped = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const blank = (l: string): boolean => l.trim() === "";
const heading = (l: string): boolean => /^#{1,6}\s/.test(l);

/** Lines without the blank ones at either end, as one text. */
function trimmed(lines: string[]): string {
  let a = 0, b = lines.length;
  while (a < b && blank(lines[a])) a++;
  while (b > a && blank(lines[b - 1])) b--;
  return lines.slice(a, b).join("\n");
}

/** The first top-level list item in `lines`, its continuation lines joined onto it. */
function firstItem(lines: string[]): string | null {
  const at = lines.findIndex((l) => ITEM.test(l));
  if (at < 0) return null;
  const parts = [lines[at].replace(ITEM, "")];
  for (const l of lines.slice(at + 1)) {
    if (blank(l) || !/^\s/.test(l) || ITEM.test(l.trimStart())) break;
    parts.push(l.trim());
  }
  return parts.join(" ");
}

/** The paragraph the lines open with, joined onto one line; null when they open with anything else. */
function openingParagraph(lines: string[]): string | null {
  const at = lines.findIndex((l) => !blank(l));
  if (at < 0 || !firstLineIsParagraph(lines[at])) return null;
  const parts: string[] = [];
  for (const l of lines.slice(at)) {
    if (blank(l) || heading(l) || ITEM.test(l)) break;
    parts.push(l.trim());
  }
  return parts.join(" ");
}

const firstLineIsParagraph = (l: string | undefined): boolean =>
  l !== undefined && !heading(l) && !ITEM.test(l) && !/^\s*(?:\||```|>|<)/.test(l);

/** Markdown's emphasis and code markers and link targets removed, on one line. */
function plain(s: string): string {
  return s
    .replace(/!?\[((?:[^[\]]|\[[^[\]]*\])*)\]\([^()\s]*(?:\([^()]*\)[^()\s]*)*\)/g, "$1")
    .replace(/\[((?:[^[\]]|\[[^[\]]*\])*)\]\[[^\]]*\]/g, "$1")
    .replace(/`+/g, "")
    .replace(/\*\*|__|~~/g, "")
    .replace(/\*(\S(?:[^*]*?\S)?)\*/g, "$1")
    .replace(/(^|\W)_(\S(?:[^_]*?\S)?)_(?=\W|$)/g, "$1$2")
    .replace(/\s+/g, " ")
    .trim();
}

/** The first sentence of a plain text: up to the first `.`, `!` or `?` that a space or the end
 *  follows, closing brackets and quotes kept with it. */
function firstSentence(text: string): string {
  const end = /[.!?]["'”’)\]]*(?=\s|$)/g;
  for (let m = end.exec(text); m; m = end.exec(text)) {
    const word = /(\S+)$/.exec(text.slice(0, m.index))?.[1].toLowerCase() ?? "";
    if (m[0].startsWith(".") && ABBREVIATIONS.has(word)) continue;
    return text.slice(0, m.index + m[0].length);
  }
  return text;
}

/**
 * What a paragraph or a list item leads with. A bold lead ending in a colon (`**Breaking:**`) is a
 * label, and the sentence after it is used instead. Otherwise, when `bold`, a bold lead is used as
 * it is, and the first sentence when there is none.
 */
function leadOf(text: string, bold: boolean): string {
  const label = /^\*\*([^*]+?):\*\*\s*/.exec(text);
  if (label) {
    const rest = plain(text.slice(label[0].length));
    return rest ? firstSentence(rest) : plain(label[1]);
  }
  const lead = bold ? /^\*\*(.+?)\*\*/.exec(text) : null;
  if (lead && plain(lead[1])) return plain(lead[1]);
  return firstSentence(plain(text));
}

/** One version's release record, from the changelog's `## [<version>]` section. */
export function releaseFromChangelog(changelog: string, version: string): ReleaseRecord {
  const lines = changelog.replace(/\r\n/g, "\n").split("\n");
  const start = lines.findIndex((l) => new RegExp(`^## \\[${escaped(version)}\\]`).test(l));
  if (start < 0) {
    return { summary: NO_CHANGELOG, changelog: NO_CHANGELOG, upgradeNotes: null, clientAction: UNKNOWN_ACTION, consoleVersion: null };
  }
  const next = lines.findIndex((l, i) => i > start && l.startsWith("## "));
  const section = lines.slice(start + 1, next < 0 ? lines.length : next);
  let body = section;
  // The early sections carry their versions on a line of their own under the heading
  // (`**zz-stack 0.28.0 · zz-stack-dashboard 0.4.0**`): it is read as the heading's, never as a summary.
  const at = body.findIndex((l) => !blank(l));
  const banner = at >= 0 && BANNER.test(body[at]) && (at + 1 >= body.length || blank(body[at + 1])) ? body[at] : "";
  if (banner) body = body.slice(at + 1);

  const consoleVersion = new RegExp(`· console (${SEMVER})`).exec(lines[start])?.[1]
    ?? new RegExp(`· (?:console|zz-stack-dashboard) (${SEMVER})(?! \\(unchanged)`).exec(banner)?.[1]
    ?? body.map((l) => new RegExp(`^### zz-stack-dashboard (${SEMVER})\\s*$`).exec(l)?.[1]).find(Boolean)
    ?? null;

  const opening = openingParagraph(body);
  const item = opening === null ? firstItem(body) : null;
  const summary = opening !== null ? leadOf(opening, false)
    : item !== null ? leadOf(item, true)
    : firstSentence(plain(body.find((l) => !blank(l) && !heading(l)) ?? "")) || NO_CHANGELOG;

  const notesAt = body.findIndex((l) => l.startsWith("### Upgrade notes"));
  let upgradeNotes: string | null = null;
  let clientAction: string | null = null;
  if (notesAt >= 0) {
    const notesEnd = body.findIndex((l, i) => i > notesAt && l.startsWith("### "));
    const notes = body.slice(notesAt + 1, notesEnd < 0 ? body.length : notesEnd);
    upgradeNotes = trimmed(notes) || null;
    const first = firstItem(notes) ?? openingParagraph(notes);
    clientAction = upgradeNotes === null || first === null ? null : leadOf(first, true);
  }
  return { summary, changelog: trimmed(section), upgradeNotes, clientAction, consoleVersion };
}

/** PostgreSQL string literal: a single quote is doubled, which is the whole escape. */
const literal = (s: string | null): string => (s === null ? "null::text" : `'${s.replace(/'/g, "''")}'`);

const COLUMNS = "version, console_version, released_at, summary, changelog, upgrade_notes, client_action";

/**
 * Records every tag that has no row yet, in one statement run through `run`, and compares the row
 * of `current` with what its section says now. The insert is `on conflict (version) do nothing`, so
 * a retry adds no row and moves no time; `released_at` is the tag's creation time and is not
 * compared, because a retry is not a correction. `rows` is the table's count once the insert is in.
 */
export async function recordReleases(
  changelog: string,
  tags: { version: string; taggedAt: string }[],
  current: string | null,
  run: (sql: string) => Promise<string>,
): Promise<Recorded> {
  const versions = [...new Map(tags.map((t) => [t.version, t])).values()];
  if (current !== null && !versions.some((t) => t.version === current)) {
    throw new Error(`no v${current} tag among the ${versions.length} passed, so it has no time to be recorded at`);
  }
  const rows = versions.map((t) => {
    const r = releaseFromChangelog(changelog, t.version);
    return `(${[literal(t.version), literal(r.consoleVersion), `${literal(t.taggedAt)}::timestamptz`, literal(r.summary),
                literal(r.changelog), literal(r.upgradeNotes), literal(r.clientAction)].join(", ")})`;
  });
  // DELIBERATE: one statement. Its outer select reads the table as it was before the insert, which
  // is what tells a row this call wrote from one that was already there.
  const sql = rows.length === 0 ? "select 'rows', count(*)::text from zz.release" : `
with input (${COLUMNS}) as (values
  ${rows.join(",\n  ")}
),
ins as (
  insert into zz.release (version, console_version, released_at, summary, changelog, upgrade_notes, client_action)
  select ${COLUMNS} from input
  on conflict (version) do nothing
  returning version
)
select 'recorded', version from ins
union all
select 'already', i.version from input i where exists (select 1 from zz.release r where r.version = i.version)
union all
select 'conflict', r.version from zz.release r join input i on i.version = r.version
 where ${current === null ? "false" : `r.version = ${literal(current)}`}
   and (r.console_version, r.summary, r.changelog, r.upgrade_notes, r.client_action)
       is distinct from (i.console_version, i.summary, i.changelog, i.upgrade_notes, i.client_action)
union all
select 'rows', ((select count(*) from zz.release) + (select count(*) from ins))::text`;
  const out: Recorded = { recorded: [], already: [], conflicts: [], tags: versions.length, rows: -1 };
  const answer = await run(sql);
  for (const line of answer.split("\n").filter(Boolean)) {
    const [kind, value] = line.split("|");
    if (kind === "recorded") out.recorded.push(value);
    else if (kind === "already") out.already.push(value);
    else if (kind === "conflict") out.conflicts.push(value);
    else if (kind === "rows") out.rows = Number(value);
  }
  if (out.rows < 0) throw new Error(`the record statement answered no row count: ${JSON.stringify(answer.slice(0, 200))}`);
  return out;
}

/** Every `v*` tag in this checkout, with the time it was created. */
function releaseTags(): { version: string; taggedAt: string }[] {
  return run("git", ["for-each-ref", "--format=%(refname:short) %(creatordate:iso-strict)", "refs/tags/v*"], { cwd: root })
    .split("\n").filter(Boolean)
    .map((l) => { const [name, at] = l.split(" "); return { version: name.slice(1), taggedAt: at }; });
}

/**
 * A tagged release's record of itself: every tag passed, `current` compared, the reconciliation
 * printed. Returns the problem lines, empty when the record agrees. Never throws: the release is
 * tagged by now and stays released, and its caller exits non-zero at its end on a problem.
 */
export async function recordAfterTag(current: string, runSql: (sql: string) => Promise<string>): Promise<string[]> {
  try {
    const r = await recordReleases(readFileSync(join(root, "CHANGELOG.md"), "utf8"), releaseTags(), current, runSql);
    log(`  release record: tags ${r.tags}, rows ${r.rows} — ${r.recorded.length} recorded, ${r.already.length} already there`);
    if (r.rows !== r.tags) {
      warn(`  zz.release holds ${r.rows} row(s) for ${r.tags} v* tag(s) in this checkout — a row without a tag, or a tag without a row`);
    }
    return r.conflicts.map((v) =>
      `zz.release already holds a row for ${v} that differs from its changelog section now, and it was left as it is. ` +
      `Correct the section if it is wrong, then run: node scripts/release-record.ts --correct ${v}`);
  } catch (e) {
    return [`zz.release was not written for ${current}: ${String((e as Error)?.message ?? e).slice(0, 400)}. ` +
      `Once the deployment's database answers, run: node scripts/release-record.ts --record ${current}`];
  }
}

/** `--correct <version>`: that row rewritten from the current changelog, its tag time kept. */
async function correct(version: string, runSql: (sql: string) => Promise<string>): Promise<number> {
  const r = releaseFromChangelog(readFileSync(join(root, "CHANGELOG.md"), "utf8"), version);
  const before = await runSql(`select row_to_json(r) from zz.release r where r.version = ${literal(version)}`);
  if (!before) {
    console.error(`release-record: zz.release holds no row for ${version}, so there is nothing to correct — ` +
      `write it with: node scripts/release-record.ts --record ${version}`);
    return 1;
  }
  console.log(`before: ${before}`);
  const after = await runSql(`update zz.release r set console_version = ${literal(r.consoleVersion)}, summary = ${literal(r.summary)},
    changelog = ${literal(r.changelog)}, upgrade_notes = ${literal(r.upgradeNotes)}, client_action = ${literal(r.clientAction)}
    where r.version = ${literal(version)} returning row_to_json(r)`);
  console.log(`after:  ${after}`);
  return 0;
}

/** `--record <version>`: the rows a release could not write, as the release writes them once its tag exists. */
async function record(version: string, runSql: (sql: string) => Promise<string>): Promise<number> {
  const problems = await recordAfterTag(version, runSql);
  for (const p of problems) console.error(`release-record: ${p}`);
  return problems.length ? 1 : 0;
}

/** The operator's command, `--correct <version>` or `--record <version>`, against `runSql`, the deployment's
 *  database unless a caller hands another; its exit code. */
export async function operatorCommand(args: string[], runSql: (sql: string) => Promise<string> = regSql): Promise<number> {
  const [flag, version] = args;
  if ((flag !== "--correct" && flag !== "--record") || !version || !new RegExp(`^${SEMVER}$`).test(version)) {
    console.error("usage: node scripts/release-record.ts --correct <version> | --record <version>");
    return 1;
  }
  return flag === "--correct" ? correct(version, runSql) : record(version, runSql);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await operatorCommand(process.argv.slice(2));
}
