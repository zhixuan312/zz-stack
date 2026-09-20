// `zz-lexical-v1`'s own regression suite, alongside the plan-authored `tenant-complete-text.ts`.
//
// `tenant-complete-text.ts` is the frozen, hash-verified form of I-14's technical AC and is
// never edited here. This file exists because the task that produced it also asked for
// explicit coverage `tenant-complete-text.ts` does not carry: empty text, CRLF, a forced
// long-token split with no whitespace anywhere to prefer, a full 1-MiB body with a
// whitespace-delimited tail term, a phrase deliberately placed where a passage boundary would
// fall without the built-in overlap, and the identifier/fingerprint properties the frozen
// check only samples one case of each.
import assert from 'node:assert/strict';
import {
  passagesOf, identifierTokens, derivationFingerprint,
  PASSAGE_MAX_SCALARS, MAX_INPUT_BYTES, assertWithinInputLimit, InputTooLargeError,
} from '../packages/indexing/dist/tenant-analysis.js';

// ── empty text ───────────────────────────────────────────────────────────────────────────────
assert.deepEqual(passagesOf(''), []);

// ── CRLF ─────────────────────────────────────────────────────────────────────────────────────
// Windows line endings are two ASCII bytes and a whitespace scalar apiece — nothing here is
// specific to CRLF, and that is the point: the general byte-offset machinery must not need a
// special case for it.
{
  const body = 'line one\r\nline two\r\nzzcrlftail\r\n'.repeat(3000);
  const buf = Buffer.from(body, 'utf8');
  const ps = passagesOf(body);
  assert.ok(ps.length > 1);
  for (let i = 0; i < ps.length; i++) {
    const p = ps[i];
    assert.equal(buf.subarray(p.start, p.end).toString('utf8'), p.text);
    assert.ok([...p.text].length <= PASSAGE_MAX_SCALARS);
    assert.ok(p.end > p.start);
    if (i) assert.ok(p.start < ps[i - 1].end && p.end > ps[i - 1].end);
  }
  assert.equal(ps[0].start, 0);
  assert.equal(ps[ps.length - 1].end, buf.length);
  assert.ok(ps.some((p) => p.text.includes('zzcrlftail')));
}

// ── forced long-token split ──────────────────────────────────────────────────────────────────
// One uninterrupted run with no whitespace anywhere near it — the "oversized uninterrupted
// run" the contract names. There is nothing to prefer, so every split is forced at the scalar
// ceiling, and the result must still be byte-accurate, still bounded, and still cover every
// byte.
{
  const body = 'z'.repeat(PASSAGE_MAX_SCALARS * 3 + 17);
  const buf = Buffer.from(body, 'utf8');
  const ps = passagesOf(body);
  assert.ok(ps.length > 1, 'a run this long with no whitespace must still be split');
  for (let i = 0; i < ps.length; i++) {
    const p = ps[i];
    assert.equal(buf.subarray(p.start, p.end).toString('utf8'), p.text);
    assert.ok([...p.text].length <= PASSAGE_MAX_SCALARS);
    if (i) assert.ok(p.start < ps[i - 1].end && p.end > ps[i - 1].end);
  }
  assert.equal(ps[0].start, 0);
  assert.equal(ps[ps.length - 1].end, buf.length);
}

// ── a 1-MiB body, whitespace-delimited tail ─────────────────────────────────────────────────
// Independent of `tenant-complete-text.ts`'s own 1-MiB-scale fixture: this one is sized to an
// exact byte target and mixes English and Chinese, so the "no 200,000-character truncation"
// property is checked again, on different content, rather than trusting one fixture for it.
{
  const unit = '知识库 retrieval word ';
  const unitBytes = Buffer.byteLength(unit, 'utf8');
  const repeats = Math.ceil((1024 * 1024) / unitBytes);
  const body = unit.repeat(repeats) + ' zzonemebtailterm';
  const buf = Buffer.from(body, 'utf8');
  assert.ok(buf.length > 1024 * 1024, 'fixture must actually exceed 1 MiB to test the claim');
  const ps = passagesOf(body);
  assert.ok(ps.length > 1);
  assert.ok(ps.some((p) => p.text.includes('zzonemebtailterm')),
    'a unique tail term past the former 200,000-character cutoff must be retrievable');
  for (let i = 0; i < ps.length; i++) {
    const p = ps[i];
    assert.equal(buf.subarray(p.start, p.end).toString('utf8'), p.text);
    if (i) assert.ok(p.start < ps[i - 1].end && p.end > ps[i - 1].end);
  }
  assert.equal(ps[0].start, 0);
  assert.equal(ps[ps.length - 1].end, buf.length);
}

// ── a phrase at what would be a passage boundary without overlap ───────────────────────────
// Filler sized to land the ideal (no-overlap) boundary in the middle of the marker phrase, so
// this fails if the 512-scalar overlap this task's contract requires is ever removed or
// shrunk to zero: the phrase would then be split across two passages and appear whole in
// neither.
//
// "Metadata/body field boundaries remain explicit" (this task's contract, Data mapping) is a
// property of how a caller COMPOSES the text handed to `passagesOf` — which field a byte range
// came from — not of `passagesOf` itself, which only ever sees one string. That composition is
// projection-write work (`tenant-projections.ts`'s header: populating `zz.artifact_passage`
// is a later task), so it is not exercised here.
{
  const phrase = 'zzboundaryphrase marker';
  const fillerLen = PASSAGE_MAX_SCALARS - Math.floor(phrase.length / 2);
  const body = 'x'.repeat(fillerLen) + ' ' + phrase + ' ' + 'y'.repeat(PASSAGE_MAX_SCALARS * 2);
  const ps = passagesOf(body);
  assert.ok(ps.length > 1);
  assert.ok(ps.some((p) => p.text.includes(phrase)),
    'a phrase spanning where a passage boundary would fall must still be found whole');
}

// ── identifier analysis beyond the frozen check's one sample ───────────────────────────────
{
  // Acronym-to-word and a trailing digit, together — the frozen check only exercises a
  // trailing `v2`, not an acronym run immediately followed by a capitalized word.
  const raw = 'HTTPServer2';
  const tokens = identifierTokens(raw);
  for (const t of [raw, 'http', 'server', '2']) assert.ok(tokens.includes(t), `missing "${t}"`);
  assert.ok(!tokens.includes(raw.toLowerCase()) || raw.toLowerCase() === raw,
    'the unsplit spelling stays exact-case; a separately-lowercased whole identifier is not implied by that');

  // A bare word: no delimiter, no boundary, one token in and one token out (plus itself).
  assert.deepEqual(identifierTokens('plugin').sort(), ['plugin']);

  // Delimiters that touch: "a..b" must not produce an empty token between the two dots.
  assert.ok(!identifierTokens('a..b/-c').includes(''));
}

// ── derivation fingerprint: every named field is load-bearing, not only `analyzer` ─────────
{
  const base = { content_hash: 'b'.repeat(64), record_format: 1, parser: 1, analyzer: 1, passage: 1, projection: 1 };
  const h0 = derivationFingerprint(base);
  assert.equal(h0, derivationFingerprint({ ...base }), 'identical versions must hash identically');
  assert.notEqual(h0, derivationFingerprint({ ...base, content_hash: 'c'.repeat(64) }));
  assert.notEqual(h0, derivationFingerprint({ ...base, record_format: 2 }));
  assert.notEqual(h0, derivationFingerprint({ ...base, parser: 2 }));
  assert.notEqual(h0, derivationFingerprint({ ...base, passage: 2 }));
  assert.notEqual(h0, derivationFingerprint({ ...base, projection: 2 }));
}

// ── the 8 MiB kernel gate, and its one named exception ──────────────────────────────────────
{
  const overLimit = MAX_INPUT_BYTES + 1;
  assert.throws(() => assertWithinInputLimit(overLimit), InputTooLargeError);
  try {
    assertWithinInputLimit(overLimit);
    assert.fail('must throw');
  } catch (err) {
    assert.ok(err instanceof InputTooLargeError);
    assert.equal(err.actualBytes, overLimit);
    assert.equal(err.allowedBytes, MAX_INPUT_BYTES);
  }
  assert.doesNotThrow(() => assertWithinInputLimit(MAX_INPUT_BYTES));
  // Legacy content already larger than the limit is preserved and indexed by import, never
  // refused and never truncated to fit.
  assert.doesNotThrow(() => assertWithinInputLimit(overLimit, { imported: true }));
}

console.log('tenant-passage-analysis: ok');
