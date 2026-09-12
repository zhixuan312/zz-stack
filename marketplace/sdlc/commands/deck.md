---
name: "deck"
description: "Turn something already written — a spec, a report, a changelog, a thread — into a slide deck that makes an argument, built on the house visual system. Not an outline of the source: a conclusion, the claims that carry it, and one composition per claim."
when_to_use: "The person typed /sdlc:deck."
disable-model-invocation: true
---

<!-- Design note: deck-chassis.html ships inside the plugin at skills/sdlc-deck/, which is
     where it stays even on Claude Code, where this text is installed as a command. Resolve it
     from the plugin root; your own location differs by client. Output always lands at
     decks/YYYY-MM-DD-<slug>.html under the workspace root — the same file whether or not an
     initiative happens to be in progress; a deck is not a flow document and has no business
     asking. -->

# /sdlc:deck

A command that turns something already written — a changelog, a spec, a design doc, a report,
the previous message — into a slide deck built on the house visual system. `/sdlc:deck` on
Claude Code, a matched skill on Codex.

It runs entirely in your own context: no platform tool is called, nothing is dispatched, and the
only output is one HTML file on disk.

**The deck is an argument, not an outline.** A deck that maps each heading to a slide and
each paragraph to a bullet is a table of contents with a background. The template's own
authoring contract says it plainly — *"Write the conclusion before selecting a layout"* and
*"Give every content slide one job and one dominant composition"* — and this command exists
to honour that discipline, not to reformat a document.

## 1. Select the source

**Load `sdlc-authoring` first, then come back here.** It carries how the source is chosen
from what the reader typed, and the writing rules this deck is held to. Both were copied into
this file and into sdlc-tldr, and had already drifted apart.

Read the source completely before designing anything.

Optional arguments: a target slide count (otherwise derive one — see Phase 2), and an
audience (executive, engineering, mixed) which changes emphasis, not structure.

**Ask which medium if it is not obvious, because it sets the density budget.** A deck that
will be *projected* while someone talks carries the minimum on each slide — the speaker is
the other half. A deck that will be *read alone*, as a pre-read or a leave-behind, has to
survive without a narrator and can carry more. A changelog or a report is usually read
alone; a design review is usually projected. Same argument either way; different amount of
words on the slide.

## 2. Find the argument — before any layout decision

This phase is the reason the command exists. Do it in full before opening the chassis.

1. **State the conclusion in one sentence.** What should the audience believe or do after
   the deck? If the source does not state one, derive it and say so.
2. **List the 3–7 claims that carry that conclusion.** Not the source's sections — the
   claims. Several sections may collapse into one claim; one dense section may split into
   three.
3. **For each claim, name its evidence** — the number, comparison, sequence, structure, or
   quote in the source that makes it true. A claim with no evidence is an assertion the
   deck should either cut or state as an opinion.
4. **Order the claims as an argument**, not as the source's order. Lead with the
   conclusion; the deck earns it afterwards. Where the source pairs a problem with a fix,
   or a current state with a proposed one, **alternate them** — grouping all the problems
   and then all the fixes destroys the contrast that makes each pair land. The close is two
   things, and it is not a summary: what the audience should now **do**, and what is
   **true afterwards** that was not true before.

5. **Give each claim its evidence pieces, then let the slide count follow.** A claim is not
   automatically one slide. The invariant is **one message per slide**, which forbids two
   claims sharing a slide but never requires one slide per claim:
   - a claim with **several distinct pieces** of evidence (a table, a before/after, a
     quotation) becomes **that many slides**, each with a narrower assertion
   - a claim with **nothing showable** is demoted — folded into the conclusion or a
     neighbouring claim. A slide with an assertion and nothing to show becomes a bullet
     list, which is the failure this command exists to prevent.

   Deriving slide count from the claim list is the same mistake as deriving it from the
   headings, one level up. Never pad to a round number.

**Every slide title is an assertion, not a label.** This is the single best-evidenced rule
in presentation design: in a controlled study of 739 students — same course, same
instructor, same material, slide design the only difference — sentence headlines raised
recall from **69% to 79%** (p < .001). The study also reports the null: where the recalled
fact sat in the slide *body*, the two designs were indistinguishable. **The entire measured
gain came from promoting the assertion into the headline**, not from general prettification.

A title must pass all four:

- a **declarative sentence with a finite verb** — "Latency doubled after the migration",
  never "Latency", "Results", or "Background"
- **two lines maximum**
- the ***so what*** test — it answers the implicit question, rather than naming a topic
- the **cross-document** test — if it could sit unchanged in a different document, it is a
  label, so rewrite it

## 3. Choose a composition per claim

Route each claim through the guidebook's decision guide instead of defaulting to bullets.
Ask what the claim's evidence *is*:

| The evidence is… | Family | Use |
|---|---|---|
| order and ownership | lane | sequence, swimlane |
| edges that carry meaning | graph | state, ER, data flow, integration, current state, loop, tree |
| things inside or above things | band | layers, medallion, pyramid, nested |
| axes or coverage | matrix | quadrant, coverage, gantt |
| measured space | plot | radar, scatter, venn |
| quantity comparison | chart | bars, line, stacked, waterfall |
| one number that carries the finding | statement | a metric tile with the unit in the note |
| records the reader must compare | table | rows are records, numbers right-aligned |
| no evidence, just the claim | statement | a sentence set large, with the source beneath |

**Choosing is mandatory, and the choice is a field, not a mood.** For every slide, name the
composition from the table above before you write any markup. Left to a default, a model
emits bullets every time — and composition is the most common flaw in real decks by a wide
margin: 70.5% of slides in an annotated set of 2,400, against 43% for typography and 13.7%
for colour, with only 28.7% of slides flaw-free.

**Evidence is shown, not bulleted.** The rule the recall study actually tested is *visual
evidence instead of a bulleted list*. A bullet list removes the hierarchy among its items,
so the claim carries no more weight than the least important line beneath it, even when it
is first. It also hides the relationships between items, leaving the reader to reconstruct
them.

So: **a slide's stage carries a composition, not a list of sentences.** Bullets are legal
only for genuine peers — a set of options, a checklist — and never as a container for prose
you did not want to lay out. If the only thing you can think of is a bullet list, you have
either chosen the wrong composition or found a claim with no showable evidence, which
Phase 2 tells you to demote.

Limits the guidebook states and you must respect: simple compositions carry 3–6 objects;
network diagrams 7–24 nodes. Above the limit, split the argument rather than the diagram.
One dominant composition per slide — never two.

## 4. Emit the deck

**A stated departure, not a silent one.** Elsewhere on this platform, a skill that produces a
document writes it with the platform's document tools, because those give the document an
envelope, a version snapshot taken at approval, and telemetry. This skill does not use them. A
deck needs none of the three — there is no approval moment for a deck, and nothing reads its
telemetry — and it could not survive what the platform's write would prepend to it: the moment
that frontmatter landed, the file would stop being valid HTML. So the two steps below build the
deck with your runtime's own file write, then fill it with its own exact-string file edit, one
slide at a time.

### Resolve the chassis

The chassis asset ships inside this plugin at **`skills/sdlc-deck/deck-chassis.html`**, relative
to the plugin's root. It carries the shared style layer, the behaviour scripts, the dock and the
self-QA — and nothing else. It holds no slides at all, which is what makes it small enough to
read in full before you write anything. That path is the same on every client; where YOU are
reading from is not:

| Client | You are reading | The chassis asset is |
|---|---|---|
| Codex | `skills/sdlc-deck/SKILL.md` | beside you |
| Claude Code | `commands/deck.md` | `../skills/sdlc-deck/deck-chassis.html` |

On Claude Code this file is installed as a command, because a deck is something a person asks
for on purpose. Only the skill's text moves into `commands/`; its assets stay where they were.
So resolve the chassis asset from the plugin root, never from your own location — the two are
the same directory on one client and not on the other.

If it is not there, **stop and say so.** Never fabricate the styling: a deck built on invented
CSS looks plausible and is not on the house system, which is the entire point of the command.

### Step 4a — scaffold, in one write

Read the chassis asset in full, then write the complete deck file in **one write**:

- the `<style>` layer, the behaviour scripts, the dock and the self-QA travel **verbatim** —
  copy them exactly, changing nothing.
- **there is nothing to exclude.** The chassis holds no slides and no manifest, so everything in
  it travels. The composition reference — the 53 guidebook `<section>` elements carrying the
  `slide` class, plus the `<script id="housebook-manifest">` block that describes them — lives in
  a separate file, `skills/sdlc-deck/deck-guidebook.html`, which **this step does not read**.
  Consult it in Phase 3 if you want to see a composition rendered; never copy from it, and never
  open it here. Reading only the chassis is the point: it is roughly a third of what the two
  files hold together.
- **your own manifest is written once, here, from the slide plan** — a JSON object naming the
  deck, its canvas and its conclusion sentence, with one `slides` entry per planned slide, in
  deck order, mirroring that slide's attributes. Step 4b never revisits it. It goes in a
  `<script id="housebook-manifest" type="application/json">` block, and its `slides` order must
  match the order your `<section>` elements appear in — the build check reads both out of the
  one file and compares them position by position.

  ```json
  {
    "name": "<deck title>",
    "version": "1.2.3",
    "updated": "<YYYY-MM-DD>",
    "canvas": { "width": 1280, "height": 720, "ratio": "16:9" },
    "summary": "<the deck's conclusion sentence, one line>",
    "slides": [
      {
        "number": 1,
        "id": "the-cost",
        "component": "Statement",
        "chapter": "Ch 1 · The problem",
        "job": "State the cost"
      }
    ]
  }
  ```

  One entry per slide, `number` starting at 1. **The fields mirror the seven attributes above —
  no `choose`, `use`, `limits` or `tags`**, for the same reason those are absent from the
  section: they describe a reference deck, not yours. `version` must equal the `data-version` on
  every slide, and must equal the one in the worked example above; a build check compares all
  three.
- **one real `<section>` per planned slide**, carrying its final attributes, and, as its entire
  body, a single placeholder line:

  ```
    <!-- slide: <data-slide-id> — <the slide's one-line intent from the plan> -->
  ```

  The `<data-slide-id>` segment is what makes the line unique within the file — the slide plan
  already requires those ids to be distinct. The intent text is written for the model that will
  fill it, not for the reader; step 4b deletes it.

  ```html
  <section aria-label="What one-shot costs"
           class="slide"
           data-chapter="Ch 1 · The problem"
           data-component="Statement"
           data-job="State the cost"
           data-slide-id="the-cost"
           data-source-required="false"
           data-version="1.2.3">
    <!-- slide: the-cost — what one-shot generation costs a weak model -->
  </section>
  ```

  **Those seven attributes are the whole set. Do not add `data-choose`, `data-use`,
  `data-limits` or `data-tags`.** Those four are the guidebook's teaching metadata — they answer
  "when would I pick this composition", which is a question about the reference deck, not about
  your slide. A content slide has nothing to say for them, and Phase 5 tells you the QA row that
  demands them is expected to fail on a real deck. An earlier version of this example carried all
  four, copied from a guidebook slide's shape, which put it in direct contradiction with that
  instruction — the first person to follow this skill end to end hit exactly that and had to
  guess which one won.

  A **cover** slide's attributes differ — `class="slide active slide--cover"`, with `active` on
  the first slide only — but it scaffolds the same way: final attributes now, one placeholder
  line as its whole body.

**Where they go in the file.** Your `<section>` elements replace the gap the chassis leaves for
them — after the `<i class="progress">` element and before the `<div class="dock">` block — and
the manifest `<script>` goes immediately after your last `</section>`. The behaviour scripts find
slides with `querySelectorAll('.slide')`, so a deck whose sections sit elsewhere may still
appear to work; put them in the gap anyway, because the print stylesheet, the dock and the
progress indicator all assume that order.

This write returns a file that is valid, openable HTML the moment it lands — it simply has no
slide content yet. Nothing about the chassis and nothing about the manifest is touched again
after this step.

### Step 4b — fill, one slide per edit, in deck order

Then replace each placeholder line with that slide's finished content, using your runtime's own
exact-string file edit — **one edit per slide. Never fill more than one slide's content in a
single edit, and never emit a second slide's content while filling the first.**

**The anchor rule.** An exact-string edit replaces its target only when that target appears
exactly once, so:

- the `find` for a fill step is **the placeholder line, in full**, including its
  `data-slide-id`;
- the `find` is **never** `</section>`, which is never unique, and **never** the bare substring
  `class="slide"`, which repeats across every slide;
- a slide's opening tag is unique and may anchor a whole-section replacement, but the fill loop
  does not need this — the placeholder sits inside the section, so the section's own tags are
  left untouched.

**Each fill step is handed exactly four things, and nothing else:**

| | |
|---|---|
| the placeholder line | its `find` target, verbatim |
| the slide's plan entry | title, intent, chosen composition, evidence |
| the through-line | the deck's conclusion sentence and the ordered list of all slide titles |
| the chassis contract | the zone grid, design tokens, and object-count limits below |

The through-line is the defence against cross-slide repetition — a slide written without it
restates what its neighbours already said; a slide written with it can refer backwards and set
up forwards.

Fill a content slide with the zone structure the chassis expects:

```html
  <div class="sheet">
    <header class="zone-head">
      <div><p class="kicker">MEASURED</p><h2>Latency doubled after the migration.</h2></div>
      <p class="head-note">One line on why this slide exists.</p>
    </header>
    <div class="zone-stage">…exactly one composition…</div>
    <footer class="zone-foot"></footer>
  </div>
```

**Copy that head structure exactly — it is a grid, not a stack.** `.zone-head` is
`grid-template-columns: minmax(0,1fr) minmax(300px,430px)` and expects **exactly two
children**: one `<div>` wrapping the kicker and the `<h2>`, then the `.head-note`. Emit the
kicker, title and note as three siblings and the grid puts the title in the right-hand column
and pushes the note onto a second row. It still renders, and it looks wrong in a way no error
reports.

**Leave `<footer class="zone-foot">` empty.** The chassis fills it with the chapter and the
plate number (`01 · 09`) and counts your slides itself. Putting anything there breaks the zone
contract.

A **cover** slide fills differently: `<div class="sheet sheet--poster">` and no head or foot at
all — just a `zone-stage` holding `<div class="cover-copy">` with a `.kicker`, an
`<h1 class="display">` and a `.lede`. The behaviour script sets `active` on whichever slide is
current, so a deck without it is not broken — it is blank for the moment before that script
runs, which is what the chassis avoids by shipping the class on its own cover. Printing is
unaffected either way: the print stylesheet makes every slide visible.

Rules the chassis enforces on you, for every fill:

- **Zones are a grid contract.** Head states the answer, stage proves it, foot carries chapter
  and plate number. **Nothing may enter the foot, ever.**
- **One composition per stage.** Never two.
- **Type and spacing come from the ladders** — `--fs-*` (10.5 · 11.5 · 15.5 · 18.5 · 22 · 26 ·
  40 · 52 · 58 · 82) and `--s1`…`--s10` (4 · 8 · 12 · 16 · 20 · 26 · 34 · 46 · 60 · 76). Never
  invent an off-ladder value, and never shrink audience-facing type to solve overflow — cut
  words instead.
- **One signal colour per slide.** `--signal` marks the one thing that matters. The status trio
  (`--good`, `--warn`, `--stop`) is reserved for status and is never a chart series.
- **Data marks take data tokens** — `--series-1`…`--series-4` or `--accent`, never the text
  colour `--ink` and never the hairline `--line`.
- **Every figure needs `role="img"`, `aria-labelledby`, a `<title>` and a `<desc>`.**

**The loop ends on a file property, not a counter.** Keep filling until a search of the file for
`<!-- slide:` returns nothing. A miscounted slide is caught by the file rather than believed
from memory.

### Where the deck goes

Output path: `decks/YYYY-MM-DD-<slug>.html` under the workspace root, always — a deck is
`standalone` and is written the same way whether or not an initiative happens to be in
progress. Derive `<slug>` from the deck's title: lowercase, non-alphanumeric runs to
`-`, collapsed, trimmed, 40 characters maximum. Use today's real date. Create `decks/`
if it does not exist. An explicit path argument from the reader overrides all of this.

Regenerating from the same source writes the **same file**, so the reader refreshes an open
tab rather than collecting a trail of links.

### Hand it over

Print the path and its `file://` URL, and open it once — this first time only. On a
regeneration, print the path and say it is updated; do not reopen it.

## 5. Check your own work before reporting

**Before any of that, confirm the fill loop actually finished.** Search the file for
`<!-- slide:`; if anything matches, the deck is unfinished, not clean — go back to
Step 4b and fill what remains rather than reporting done.

**The through-line test comes first, because it is the one that catches a deck that merely
echoed its source.** Concatenate every slide title, in order, and read them as a single
paragraph. That paragraph must stand on its own as the whole argument. A deck that mirrored
its source reads as a list of nouns; a deck with a through-line reads as a chain of claims.
If it does not hold together, the fault is the claim order from Phase 2, not the wording —
go back and re-order, do not re-phrase the titles.

Then the structural checks. **The template runs most of them for you** — open the deck with
`?qa`, or the Menu's QA tab, and read the per-slide results. Two things to know before you do,
or the report is unusable:

- **"Agent metadata" fails on every slide of a real deck, and that is correct.** It requires
  `data-use`, `data-choose`, `data-limits` and `data-tags` — the guidebook's teaching metadata,
  answering "when would I pick this composition". A content slide has a `data-job` and nothing
  to say for the other four. Ignore that row; do not invent values to silence it.
- Everything else applies: safe-area overflow, figure accessibility, reading floor, one dominant
  composition, title length, source treatment, figure text fits and text contrast are real
  findings on a real deck.

The full list, whether you run the QA or check by hand:

- zero `<!-- slide:` placeholders remain — the fill loop's own termination check, run
  again here as a final guard. The `?qa` panel cannot see an HTML comment, so this one
  needs a plain text search, not the QA tab.
- every slide title is a declarative sentence with a finite verb, two lines at most (the QA
  counts characters instead — 88 is its ceiling — because it cannot see line breaks)
- every `<section>` has a unique `data-slide-id`
- no content sits inside a `zone-foot` — it stays empty and the chassis fills it
- no stage content overflows its row
- no figure text escapes its viewBox, overlaps another label, or runs past the shape it sits
  in. `.cx` and `.dgm` are `overflow:visible`, so none of this scrolls and none of it shows up
  as an overflow — the QA measures the text boxes directly
- every text node clears WCAG AA against its **composited** background. A tint like a 2% zebra
  row is not opaque; contrast has to be measured against what is actually behind it
- every figure carries `role`, `aria-labelledby`, `<title>`, `<desc>`
- body text is at or above the reading floor. The QA warns below 13.4px; `--fs-small` (15.5px)
  is the value to author at, and anything between the two is a deliberate choice you should be
  able to defend
- each slide has exactly one dominant composition, and no slide is a bare bullet list
- the JSON manifest lists exactly the sections present
- **if the deck will be printed or sent as a PDF, check the PDF, not the preview.**
  Print lays each slide out afresh; a slide authored to fill the 810px stage can
  lose whatever no longer fits, and it fails silently — the checks above measure
  the on-screen stage and pass. Read the printed text back and compare:

      pdftotext -f <n> -l <n> deck.pdf - | tr -d '[:space:]' | wc -c

  A page far thinner than its neighbours lost content — **including a diagram page.** Chrome
  prints SVG `<text>` as real PDF text and `pdftotext` reads it: measured, with a three-label
  SVG printed by the same command, all three came back. So a chart-heavy page that reads
  near-empty is a finding, not an artefact of the tool. Rasterise it with
  `pdftoppm -png -r 100 -f <n> -l <n>` and look, rather than assuming.

  One thing the character count genuinely cannot see: check the PDF in a real viewer, not
  just the text layer. Chrome rasterises a blurred `box-shadow` on print, which Preview can
  draw as a flat grey slab (the chassis suppresses shadows in print for that reason).

State what passed and what did not. **Never report a deck as clean without having checked**
— a deck that renders but breaks the contract is the failure this command is built to
avoid, and it fails silently rather than with an error.

## Common pitfalls

❌ **One slide per heading.** That is the source's structure, not an argument. **Fix:**
Phase 2 before Phase 3, always.

❌ **Titles that are labels.** "Results" tells the audience nothing. **Fix:** apply the
*so what* test and rewrite until the title carries the finding.

❌ **Bullets by default.** Bullets are for genuine peers, not for prose you did not want to
lay out. **Fix:** route the claim's evidence through the family table.

❌ **Two compositions on one stage** because both seemed useful. **Fix:** that is two
claims — split the slide.

❌ **Inventing CSS when the chassis will not resolve.** **Fix:** stop and say so.

❌ **Shrinking type to fit.** **Fix:** cut words. The ladder is not negotiable.

❌ **Reporting "done" without running the checks in Phase 5.**

## Failure handling

| Scenario | What to do |
|---|---|
| The template cannot be resolved | Stop. Report which paths you probed. Never invent styling. |
| The source is unreadable or empty | Report it; do not produce a deck from nothing. |
| The source is enormous | Read what you can, say exactly what you read, and derive the argument from that. Never claim full coverage. |
| The source has no discernible conclusion | Derive one, state that you derived it, and show the claims it rests on. |
| A claim has no evidence in the source | Keep it as a statement slide or cut it. Never invent a number or a citation. |
| `decks/` cannot be created | Write beside the source and say where it went. |
| A self-check in Phase 5 fails | Fix it and re-check. Report any that remain. |

## Writing the slides themselves

Slide copy is tighter than prose, so three rules bind harder here than `sdlc-authoring`'s
writing rules, loaded at the top of this command. A number always carries its unit, and a
comparison always carries its baseline. A risk names what triggers it and who owns it. And
exact text is copied exactly — a command, a path, an identifier, a configuration value, or a
quotation is reproduced verbatim or not shown at all.
