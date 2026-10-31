/**
 * The archive initiative zz-migrate puts a repository's history in: opened once, its explore.md
 * written once, each step recorded in the ledger the moment it succeeds, so a run stopped between
 * the two resumes at the second.
 */
export const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
/** The ledger key that records explore.md as written. */
export const EXPLORE_SENT = "doc:explore.md";
/**
 * The archive's name, opened if the ledger has none, and its explore.md written if the ledger
 * does not say it was. The slug carries no date: the platform prepends today's and refuses one
 * that already has it, and the name it answers is the one every later send cites. It is opened
 * with no flow: the archive is a reference, not delivery work, so no stage is owed and nothing
 * routes it to a next document.
 */
export async function openArchive(core, repo, ledger, remember, explore) {
    let initiative = ledger.__initiative;
    if (!initiative) {
        const opened = JSON.parse(await core.call("initiative_open", { slug: `mma-archive-${slug(repo)}` }));
        if (typeof opened.initiative !== "string")
            throw new Error("initiative_open answered no initiative name");
        initiative = opened.initiative;
        remember("__initiative", initiative);
    }
    if (!ledger[EXPLORE_SENT]) {
        await core.call("document_write", {
            path: `${initiative}/explore.md`, content: explore.content, title: explore.title,
            tags: ["mma-import", `mma-${slug(repo)}`],
        });
        remember(EXPLORE_SENT, true);
    }
    return initiative;
}
