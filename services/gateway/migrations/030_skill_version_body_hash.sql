-- Did the SKILL actually change, or only its frontmatter?
--
-- zz.skill_version.content_hash covers the whole file, so bumping `version:` changes it — the
-- one edit that is guaranteed to accompany every version and to mean nothing about the skill.
-- Anything asking "is the ruler still right for this version" therefore got "the file
-- changed" as the answer every single time, which is the same as getting no answer.
--
-- It is also not a hash: `size + length-in-hex` collides for any two files of the same size,
-- and two versions of one skill are exactly the documents most likely to be nearly the same
-- length.
--
-- body_hash is sha256 over the text BELOW the frontmatter. Same body, different frontmatter,
-- same hash — so a version bump that reformats or re-dates says so, and the evaluation flow
-- can carry straight on instead of stopping a person to re-approve a ruler nothing moved.
alter table zz.skill_version add column if not exists body_hash text not null default '';

comment on column zz.skill_version.body_hash is
  'sha256 of the SKILL.md below its frontmatter. Equal hashes mean the skill itself did not change.';
