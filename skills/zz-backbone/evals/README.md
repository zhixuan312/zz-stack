# Measuring zz-backbone

zz-backbone owes no document. It is the rule set every step runs inside — call `initiative_status`
before continuing work, load the step's skill through `skill_view`, close what you opened — so
there is no artefact to read and mark. Giving it one would mean inventing an artefact so the
grader has something easy to look at, which is the tail wagging the dog.

It is measured the way sm-build is: on the calls it made, and on whether the work those calls were
part of was accepted. Both halves come from the platform's own record in `zz.event`, so nothing
here depends on a model's opinion.

One file per version, named for it.
