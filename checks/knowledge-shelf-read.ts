#!/usr/bin/env node
/**
 * A knowledge node is read from the shelf it is on — its `team_id`, and nothing else — through a real
 * zz-core on a throwaway database.
 *
 * `_knowledge/nodes/<ordinal>-<slug>.md` names a node by an ordinal allocated per shelf, so one address
 * can name a node on the caller's team shelf and another on the platform's. `document_read` serves it
 * from the caller's own shelf, and from the platform shelf with `scope: "platform"`; a node only the
 * platform shelf holds is refused naming that shelf, with the scope to ask for it; and `document_list`
 * lists the caller's own nodes by the addresses `document_read` serves.
 *
 * Exits 1 naming the case, 2 when Docker is absent.
 */
import { withThrowawayCore, type Core } from "../scripts/schema/throwaway-core.ts";

const NAME = "knowledge-shelf-read";
/** COUPLED: KNOWLEDGE_TEAM in services/zz-core/src/paths.ts. */
const PLATFORM_SHELF = "zz-platform";

/** `knowledge_add` on `scope`'s shelf: the node's address, read off the row it made. */
async function add(c: Core, initiative: string, scope: "team" | "platform", title: string): Promise<string> {
  const step = `knowledge_add with scope: ${scope}`;
  const reply = await c.ok(step, "knowledge_add", {
    title, type: "decision", scope, evidence: [initiative], tags: scope === "platform" ? ["platform:guardrail"] : [],
    body: `${title}: recorded by the ${NAME} check.`,
  });
  const ordinal = /^journal node (\d+) created/.exec(reply)?.[1];
  if (!ordinal) c.fail(step, `answered "${reply}", naming no node`);
  const shelf = scope === "platform" ? PLATFORM_SHELF : c.team;
  const { rows } = await c.sql.query<{ slug: string }>(
    `select k.slug from zz.knowledge_node k join zz.team t on t.id = k.team_id
      where t.slug = $1 and k.node_ordinal = $2`, [shelf, ordinal]);
  if (rows.length !== 1) c.fail(step, `${rows.length} nodes on ${shelf} carry ordinal ${ordinal}, not one`);
  return `_knowledge/nodes/${ordinal}-${rows[0]!.slug}.md`;
}

const ordinalOf = (address: string): string => /nodes\/(\d+)-/.exec(address)![1]!;

process.exitCode = await withThrowawayCore(NAME,
  `${NAME}: a node is read from the shelf it is on, the platform's only with scope: "platform", a node only ` +
  "the platform holds is refused naming that shelf, and the listing shows the addresses the read serves: ok",
  async (c) => {
    const I = await c.open("shelf-read");
    const own = await add(c, I, "team", "Team cache expiry");
    // The platform shelf is a team like any other, and the throwaway seeds only the caller's.
    await c.sql.query("insert into zz.team (slug, name, created_by) select $2, 'Platform', id from zz.principal where email = $1",
      [c.email, PLATFORM_SHELF]);
    // Two platform nodes, so one carries an ordinal the team shelf does not hold.
    const shared = [await add(c, I, "platform", "Platform guardrail wording"),
                    await add(c, I, "platform", "Platform retry budget")];

    let step = "a node on the caller's own shelf is read by its address";
    const read = await c.ok(step, "document_read", { path: own });
    if (!read.includes("Team cache expiry")) c.fail(step, `${own} answered: ${read.slice(0, 300)}`);
    c.pass(step);

    step = "scope: \"platform\" reads the platform shelf, never the caller's";
    const same = shared.find((a) => ordinalOf(a) === ordinalOf(own));
    const onlyPlatform = shared.find((a) => ordinalOf(a) !== ordinalOf(own))!;
    const platformRead = await c.call(step, "document_read", { path: onlyPlatform, scope: "platform" });
    if (!platformRead.includes("Platform") || platformRead.includes("Team cache expiry")) {
      c.fail(step, `${onlyPlatform} with scope: "platform" answered: ${platformRead.slice(0, 300)}`);
    }
    if (same) {
      const sameRead = await c.call(step, "document_read", { path: own, scope: "platform" });
      if (sameRead.includes("Team cache expiry")) c.fail(step, `${own} with scope: "platform" served the team's node`);
    }
    c.pass(step);

    step = "a node only the platform shelf holds is refused naming that shelf and the scope to ask with";
    const refusal = await c.call(step, "document_read", { path: onlyPlatform });
    if (!refusal.includes("does not exist on your team's shelf") || !refusal.includes(`on the ${PLATFORM_SHELF} shelf`)
        || !refusal.includes('scope: "platform"')) {
      c.fail(step, `${onlyPlatform} with no scope answered: ${refusal.slice(0, 300)}`);
    }
    c.pass(step);

    step = "document_list shows the caller's own nodes by the address document_read serves";
    const listed = JSON.parse(await c.ok(step, "document_list", { prefix: "_knowledge" })) as string[];
    if (!listed.includes(own)) c.fail(step, `document_list(prefix: "_knowledge") answered ${JSON.stringify(listed)}, without ${own}`);
    // Every platform node, the one sharing the team node's ordinal included: a join on the ordinal
    // alone across the shelves is the leak most likely, and the addresses differ by slug.
    if (shared.some((a) => a !== own && listed.includes(a))) {
      c.fail(step, `document_list lists a platform node on the caller's shelf: ${JSON.stringify(listed)}`);
    }
    c.pass(step);
  });
