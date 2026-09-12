# The instrument — what evaluation found in itself

Defects in the thing doing the measuring. **This is the largest group, and every one of them was
reporting success.**

| | |
|---|---|
| H1 | every stakeholder turn recorded twice — a count that is silently double still looks like an answer |
| H6 | a verdict looked up later is a verdict about the wrong day |
| H7 | every quality score measured form, not quality — a document can carry every fact, hold every section, and be the wrong answer |
| H8 | the block name in `zz.decision` was written seventeen ways for three blocks, so prediction-versus-reality joined on a third of its rows |
| H9 | the second version resumes the first version's initiatives, so an A/B comparison measures a revision rather than an answer |
| H10 | the noise floor, measured at 0.436 points — the median requirement moves a full point between runs of a skill that did not change |
| H11 | a day of measurement lived in a temp directory; the scores are now in tables that a tenant's deletion cannot reach |

Six more were found and fixed inside a single change each, so they never became files. Three
were ours and are worth stating: block state never reset between rounds, so nine rounds opened
onto the previous round's finished work; an EXIT trap forged a non-zero status on every clean
round; and a greedy content match attributed one requirement's document to another and scored
it 2/9 when it was 9/9. The other three were the harness mishandling responses from systems
this repository does not contain, and the detail belonged to those systems rather than here.

**The numbering has gaps.** Not every finding became a file.

## Why this group is kept, and kept first

A measurement apparatus that is wrong in the FLATTERING direction deserves more suspicion than
the thing it measures. Ten evaluation rounds were run before anybody checked whether the ground
was clean, and the answer was that it never had been — every comparison drawn from them was
archaeology, and the reset had reported success throughout.

The habit that catches these is cheap: **when a number looks good, try to make the instrument
produce it from nonsense.** Scoring every requirement against its neighbour's document should
score near zero. When it does, the good number means something.
