#!/usr/bin/env node
/**
 * `source_list` says what each source supports, through a real zz-core on a throwaway database.
 *
 * A `supports` link needs its target's row, so a source that supports a document nobody has
 * written yet is filed with its declaration and no link, and `saveDocument` files the link when
 * the document is first written. `source_list` read the links alone, so until then it answered an
 * empty `supports` for a source whose own text said otherwise — the reading an agent runs just
 * before judging a document (bug e9d91c40). It names such a target as not written yet, and the
 * plain name once the document exists.
 *
 * Exits 1 naming the case, 2 when Docker is absent.
 */
import { withThrowawayCore } from "../scripts/schema/throwaway-core.ts";

const NAME = "source-list";

type Listed = { sources: { path: string; supports: string }[] };

process.exitCode = await withThrowawayCore(NAME,
  `${NAME}: a source names what it supports, a document not written yet as such, then by name once written: ok`,
  async (c) => {
    const I = await c.open("listed");
    const filed = await c.source("a source for a document not written yet",
      { initiative: I, title: "Early material", content: "Notes the spec will rest on.", supports: ["spec.md", "plan.md"] });
    const listed = async (): Promise<string | undefined> =>
      (JSON.parse(await c.ok("list the sources", "source_list", { initiative: I })) as Listed)
        .sources.find((s) => s.path === filed)?.supports;

    let step = "a target not written yet is named as such, never left out";
    const before = await listed();
    if (before !== "spec.md (not written yet), plan.md (not written yet)") c.fail(step, `supports: ${JSON.stringify(before)}`);
    c.pass(step);

    step = "once the document exists, the target is named plainly";
    await c.ok(step, "document_write", { path: `${I}/spec.md`, content: "# Spec\n\nBody.\n" });
    const after = await listed();
    if (after !== "spec.md, plan.md (not written yet)") c.fail(step, `supports: ${JSON.stringify(after)}`);
    c.pass(step);

    // A source and its target written at the same moment can leave the source without its link
    // while the target exists: the target is named plainly all the same, never as not written.
    step = "a target that exists is named plainly even where no link was filed";
    await c.sql.query(
      `delete from zz.doc_link l using zz.doc s, zz.initiative i
        where l.from_doc_id = s.id and s.initiative_id = i.id and i.slug = $1 and s.path = $2 and l.kind = 'supports'`,
      [I, filed.slice(I.length + 1)]);
    const unlinked = await listed();
    if (unlinked !== "spec.md, plan.md (not written yet)") c.fail(step, `supports: ${JSON.stringify(unlinked)}`);
    c.pass(step);

    step = "a document named twice, with and without its extension, is listed once";
    const twice = await c.source(step, { initiative: I, title: "Named twice", content: "Twice over.", supports: ["spec", "spec.md"] });
    const once = (JSON.parse(await c.ok(step, "source_list", { initiative: I })) as Listed).sources.find((s) => s.path === twice)?.supports;
    if (once !== "spec.md") c.fail(step, `supports: ${JSON.stringify(once)}`);
    c.pass(step);
  });
