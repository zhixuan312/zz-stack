/**
 * The change set between two snapshots of one document: what a reviewer who saw the baseline must
 * be shown to have seen the target. Pure — two snapshots in, records and their text out — so the
 * stale `base` reply, a presentation and the panel all read one answer.
 *
 * A body is cut into blocks: the PREAMBLE before the first heading, each SECTION from a heading to
 * the next heading of any level (fence-aware: `document-parts.ts` `headings`, the one heading scan),
 * and the TRAILING text — the whitespace after the last block's content. Every body byte is in
 * exactly one block. A block is its content, up to its last non-whitespace character, and its gap,
 * the blank lines before the next heading; a gap is compared only where a block follows it on both
 * sides, since the last block's whitespace is the trailing text and a gap that appears because a
 * section was added after it is part of that addition.
 *
 * Sections are matched first by exact bytes — so an unchanged section that moved is found — then by
 * an unchanged non-blank body under a new heading line (a rename; only when that body is unique on
 * both sides, never by guess), then by level, title and occurrence among those still unmatched. What
 * remains is added or removed. A matched section off the longest run kept in order is moved. No
 * fuzzy matching: one changed character makes a section edited, never "similar".
 *
 * Positions count sections from 1, the preamble excluded. An extent is lines and characters
 * (UTF-16), of the block with its gap.
 */
import { headings } from "./document-parts.js";

/** A snapshot as the change set reads it: its body and the metadata a reviewer weighs — the
 *  same fields its content identity is taken over (`identityOf`, document-save.ts). */
export interface Snapshot { body: string; title: string; tags: string[]; stakeholder: string; fields: Record<string, string> }

type Extent = { lines: number; chars: number };
type DeltaRecord =
  | { kind: "added"; heading: string; at: number }
  | { kind: "edited"; heading: string; at: number }
  | { kind: "removed"; heading: string; from: number; lines: number; chars: number }
  | { kind: "renamed"; from: string; to: string; at: number }
  | { kind: "moved"; heading: string; from: number; to: number }
  | { kind: "preamble"; was: Extent; now: Extent }
  | { kind: "trailing"; was: string; now: string }
  | { kind: "metadata"; field: string; was: string; now: string };

/** The records, and the text a reader is shown — or `full` when that text would be at least as long
 *  as the target's body, and the body itself is the shorter way to show it. */
type Delta = { kind: "delta"; records: DeltaRecord[]; text: string } | { kind: "full" };

/** One block: its heading line as written and as named, its content and its gap. */
interface Block { line: string; head: string; level: number; title: string; core: string; gap: string; body: string }

const extent = (s: string): Extent =>
  ({ lines: s === "" ? 0 : s.split("\n").length - (s.endsWith("\n") ? 1 : 0), chars: s.length });

/** A body's blocks: the preamble, the sections, and the trailing whitespace. */
function blocksOf(body: string): { preamble: { core: string; gap: string }; sections: Block[]; trailing: string } {
  const text = body.trimEnd();
  const cut = (lo: number, hi: number) => {
    const s = text.slice(lo, hi);
    const core = s.trimEnd();
    return { core, gap: s.slice(core.length) };
  };
  const hs = headings(text);
  return {
    preamble: cut(0, hs[0]?.at ?? text.length),
    sections: hs.map((h, i) => {
      const { core, gap } = cut(h.at, hs[i + 1]?.at ?? text.length);
      const nl = core.indexOf("\n");
      const line = nl < 0 ? core : core.slice(0, nl);
      return { line, head: line.trimEnd(), level: h.level, title: h.title, core, gap, body: nl < 0 ? "" : core.slice(nl + 1) };
    }),
    trailing: body.slice(text.length),
  };
}

/** Which baseline section each target section is, or -1: the three tiers of the module header. */
function match(was: Block[], now: Block[]): number[] {
  const of = now.map(() => -1);
  const used = was.map(() => false);
  const take = (i: number, j: number) => { of[i] = j; used[j] = true; };
  const queues = (key: (b: Block) => string) => {
    const q = new Map<string, number[]>();
    was.forEach((b, j) => { if (!used[j]) q.set(key(b), [...(q.get(key(b)) ?? []), j]); });
    return q;
  };
  const exact = queues((b) => b.core);
  now.forEach((t, i) => { const j = exact.get(t.core)?.shift(); if (j !== undefined) take(i, j); });
  // A rename: the body is the evidence, so it must name one section on each side.
  const count = (bs: Block[], open: (k: number) => boolean) => {
    const n = new Map<string, number>();
    bs.forEach((b, k) => { if (open(k)) n.set(b.body, (n.get(b.body) ?? 0) + 1); });
    return n;
  };
  const inWas = count(was, (j) => !used[j]), inNow = count(now, (i) => of[i] < 0);
  now.forEach((t, i) => {
    if (of[i] >= 0 || !t.body.trim() || inWas.get(t.body) !== 1 || inNow.get(t.body) !== 1) return;
    take(i, was.findIndex((b, j) => !used[j] && b.body === t.body));
  });
  const titled = queues((b) => `${b.level}\u0000${b.title}`);
  now.forEach((t, i) => {
    if (of[i] >= 0) return;
    const j = titled.get(`${t.level}\u0000${t.title}`)?.shift();
    if (j !== undefined) take(i, j);
  });
  return of;
}

/** The positions in `seq` of one longest strictly increasing run — the sections that kept their
 *  order; every other matched section moved. Patience sorting, so the run is the same every time. */
function keptOrder(seq: number[]): Set<number> {
  const tops: number[] = [];
  const prev = seq.map(() => -1);
  seq.forEach((v, k) => {
    let lo = 0, hi = tops.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (seq[tops[mid]] < v) lo = mid + 1; else hi = mid; }
    if (lo > 0) prev[k] = tops[lo - 1];
    tops[lo] = k;
  });
  const kept = new Set<number>();
  for (let k = tops.length ? tops[tops.length - 1] : -1; k >= 0; k = prev[k]) kept.add(k);
  return kept;
}

/** The metadata records: title, tags (as a set), stakeholder, then each field by name. */
function metadataRecords(was: Snapshot, now: Snapshot): DeltaRecord[] {
  const tags = (s: Snapshot) => [...s.tags].sort().join(", ");
  const pairs: [string, string, string][] = [["title", was.title, now.title], ["tags", tags(was), tags(now)],
                                             ["stakeholder", was.stakeholder, now.stakeholder]];
  for (const k of [...new Set([...Object.keys(was.fields), ...Object.keys(now.fields)])].sort()) {
    pairs.push([`fields.${k}`, was.fields[k] ?? "", now.fields[k] ?? ""]);
  }
  return pairs.filter(([, a, b]) => a !== b).map(([field, a, b]) => ({ kind: "metadata", field, was: a, now: b }));
}

/** One record as a line of the delta's text — and of a stale `base`'s reply. */
export function recordLine(r: DeltaRecord): string {
  const q = JSON.stringify;
  const ext = (e: Extent) => `${e.lines} lines, ${e.chars} characters`;
  switch (r.kind) {
    case "added": return `added ${q(r.heading)} at section ${r.at}`;
    case "edited": return `edited ${q(r.heading)} at section ${r.at}`;
    case "removed": return `removed ${q(r.heading)} from section ${r.from} (${ext(r)})`;
    case "renamed": return `renamed ${q(r.from)} to ${q(r.to)} at section ${r.at}`;
    case "moved": return `moved ${q(r.heading)} from section ${r.from} to section ${r.to}`;
    case "preamble": return `preamble: was ${ext(r.was)}; now ${ext(r.now)}`;
    case "trailing": return `trailing text: was ${q(r.was)}; now ${q(r.now)}`;
    case "metadata": return `${r.field}: was ${q(r.was)}; now ${q(r.now)}`;
  }
}

/** What changed from `baseline` to `target`: every record, in a fixed order — the preamble, each
 *  target section in order (renamed, moved, edited, or added), each removed section in the
 *  baseline's order, the trailing text, the metadata — then every added or edited block in full.
 *  Deterministic and total. */
export function deltaOf(baseline: Snapshot, target: Snapshot): Delta {
  const was = blocksOf(baseline.body), now = blocksOf(target.body);
  const records: DeltaRecord[] = [];
  const shown: string[] = [];
  const both = was.sections.length > 0 && now.sections.length > 0;
  if (was.preamble.core !== now.preamble.core || (both && was.preamble.gap !== now.preamble.gap)) {
    records.push({ kind: "preamble", was: extent(was.preamble.core + was.preamble.gap),
                   now: extent(now.preamble.core + now.preamble.gap) });
    if (now.preamble.core) shown.push(now.preamble.core);
  }
  const of = match(was.sections, now.sections);
  const matched = of.map((j, i) => [i, j]).filter(([, j]) => j >= 0);
  const kept = keptOrder(matched.map(([, j]) => j));
  const inOrder = new Set(matched.filter((_, k) => kept.has(k)).map(([i]) => i));
  const lastWas = was.sections.length - 1, lastNow = now.sections.length - 1;
  now.sections.forEach((t, i) => {
    const j = of[i];
    if (j < 0) {
      records.push({ kind: "added", heading: t.head, at: i + 1 });
      shown.push(t.core);
      return;
    }
    const b = was.sections[j];
    if (b.line !== t.line) records.push({ kind: "renamed", from: b.head, to: t.head, at: i + 1 });
    if (!inOrder.has(i)) records.push({ kind: "moved", heading: t.head, from: j + 1, to: i + 1 });
    if (b.body !== t.body || (j < lastWas && i < lastNow && b.gap !== t.gap)) {
      records.push({ kind: "edited", heading: t.head, at: i + 1 });
      shown.push(t.core);
    }
  });
  const taken = new Set(of);
  was.sections.forEach((b, j) => {
    if (!taken.has(j)) records.push({ kind: "removed", heading: b.head, from: j + 1, ...extent(b.core + b.gap) });
  });
  if (was.trailing !== now.trailing) records.push({ kind: "trailing", was: was.trailing, now: now.trailing });
  records.push(...metadataRecords(baseline, target));
  const text = records.length ? [records.map(recordLine).join("\n"), ...shown].join("\n\n") : "";
  return text.length >= target.body.length ? { kind: "full" } : { kind: "delta", records, text };
}
