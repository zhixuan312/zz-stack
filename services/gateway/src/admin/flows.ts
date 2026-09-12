/**
 * What a team runs: the flows installed for them, and the client package that carries those
 * flows into somebody's terminal.
 *
 * `flowsFor` is the one answer to "what does this target run", and every surface that asks —
 * the shelf, the package builder, the console — asks it rather than reading the table its
 * own way. Installing and uninstalling are here beside it for the same reason: the write and
 * the read of one fact belong together or they drift.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { catalogManifest, installableFlows } from "@zz/catalog";
import { CatalogManifest } from "@zz/contracts";
import { text } from "@zz/mcp-http";
import { z } from "zod";

import { buildClientPackage, type ClientPackage, type InstalledFlow } from "../client-package.js";
import { platformDb } from "../db.js";
import { auditAdmin, isSuper, type Identity } from "../identity.js";
import { callerIdentity as caller } from "../identity.js";
import { describePackage } from "../package/describe.js";
import { whenToUse as whenToUseFor } from "../package/skills.js";
import { principalId, teamAuthority, teamId } from "./authority.js";
import { type TeamWriteOutcome } from "./teams.js";

/** Last-resort agent name for a manifest that declares none. Deliberately crude, and
 * deliberately not the usual path: a flow should say what its agent is called. */
const titleCase = (s: string) =>
  s.replace(/-flow$/, "").split(/[-_]/).filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1)).join(" ") + " Agent";
/** Flows in the catalog that every team gets without asking — the platform's own.
 * `install: "auto"` in the manifest is what says so; it used to be inferred from living
 * in catalog/zz/, which meant the rule was a directory name rather than a statement. */
export function autoFlows(): { flow: string; manifest: CatalogManifest }[] {
  const out: { flow: string; manifest: CatalogManifest }[] = [];
  for (const entry of installableFlows()) {
    const flow = entry.split("/")[1] ?? entry;
    const m = catalogManifest(flow);
    if (m?.install === "auto") out.push({ flow, manifest: m });
  }
  return out;
}
/** JSON with object keys sorted, so two structurally equal values compare equal as strings.
 *
 * Needed because a pinned manifest comes back out of a jsonb column, and jsonb does not keep
 * the key order it was given. A plain JSON.stringify comparison against the file on disk
 * would therefore report every manifest as different, which is a check nobody would trust
 * twice. */
export function canonicalJson(v: unknown): string {
  const walk = (x: unknown): unknown => {
    if (Array.isArray(x)) return x.map(walk);
    if (x && typeof x === "object") {
      return Object.fromEntries(Object.keys(x as Record<string, unknown>).sort()
        .map((k) => [k, walk((x as Record<string, unknown>)[k])]));
    }
    return x;
  };
  return JSON.stringify(walk(v));
}
/** A person's installed flows, in the shape the package renderer wants. */
async function flowsFor(target: string): Promise<InstalledFlow[]> {
  const db = platformDb();
  const { rows } = await db.query<{
    flow: string; version: string; agent_name: string | null;
    manifest: CatalogManifest | null;
  }>(
    // `t.status = 'active'`, as caller() does six lines up. Without it, archiving a team
    // left its flows in every member's client package: the commands and skills stayed
    // installed on their machine, and re-rendering the package kept putting them back.
    //
    // ORDERED PAST THE FLOW NAME, because the caller takes the first row per flow and two
    // teams can install one flow differently. `distinct` keeps both rows whenever the
    // version or the agent name differs, and ordering by the flow alone left
    // which one survives to whatever the planner returned first — so a person in two teams
    // could get one version today and the other tomorrow, in a file they install. Newest
    // install wins: a package should carry the most recent method the person has access to.
    //
    // `f.created_at` IS IN THE PROJECTION BECAUSE IT IS IN THE ORDER BY. Postgres refuses a
    // SELECT DISTINCT ordered by an expression it does not select (42P10), so ordering by a
    // column and not selecting it is not a slower query, it is a query that never runs — and
    // this one is behind /pkg, so the whole route 500'd and nobody could install or refresh a
    // client package at all. Nothing reads the column in TypeScript; it is here to make the
    // tie-break above legal, and removing it as unused restores the outage.
    //
    // NOT `distinct on (f.flow)`, which would return one row per flow and read as tidier. The
    // paragraph above is the reason: which of two installs survives is decided by the order,
    // and `distinct on` would pick before that order has been applied.
    `select distinct f.flow, f.version, f.agent_name, f.manifest, f.created_at
       from flow_install f
     join team t on t.id = f.team_id join membership m on m.team_id = t.id
     join principal p on p.id = m.principal_id
     where p.email = $1 and t.status = 'active'
     order by f.flow, f.version desc, f.created_at desc`, [target]);

  const shape = (flow: string, version: string, agentName: string | null,
                 m: CatalogManifest | null): InstalledFlow => ({
    flow, version, entry: m?.entry || flow, agentName,
    whenToUse: whenToUseFor(flow, m?.entry || flow),
    blocks: m?.tools ?? [],
    servers: m?.servers ?? [],
  });

  // EVERY row, deliberately. The duplicates `distinct` leaves — two teams installing one flow
  // at different versions or agent names — are dropped by clientPackageFor, which takes the
  // first row per flow in the order this query established.
  const installed = rows.map((r) => shape(r.flow, r.version ?? "", r.agent_name, r.manifest));
  const have = new Set(installed.map((f) => f.flow));
  // Platform flows are not a choice: a team that never installed them still has them.
  const auto = autoFlows().filter((a) => !have.has(a.flow))
    .map((a) => shape(a.flow, a.manifest.version ?? "", null, a.manifest));
  return [...installed, ...auto].sort((a, b) => a.flow.localeCompare(b.flow));
}
/** No default, deliberately.
 *
 * It used to fall back to this deployment's own tailnet address. A client package is a file
 * a person installs, and every URL inside it has to be the address they will actually
 * reach — so on any install that did not set GATEWAY_PUBLIC_URL, everyone would have been
 * handed a package pointing at our host, and nothing would have said so. */
const publicBase = (): string => {
  const base = (process.env.GATEWAY_PUBLIC_URL || "").trim();
  if (!base) {
    throw new Error(
      "GATEWAY_PUBLIC_URL is not set on this gateway. A client package carries the address " +
      "people will reach it at, and this service cannot guess it — set it in deploy/.env " +
      "and restart the gateway.");
  }
  return base;
};
/** Build a person's client package. One implementation for both doors —
 * my_client_setup on /manage (your own, a personal act) and
 * render_harness_config on /admin (someone else's, an admin act) — because a
 * config that drifts between doors is a support case waiting to happen. */
async function clientPackageFor(target: string): Promise<ClientPackage> {
  // ONE ENTRY PER FLOW, however many teams install it. Membership of two teams that both
  // run ops-flow produced two identical plugins, two identical MCP files, and a router that
  // offered the same flow twice — "Picks the right installed flow (ops-flow, ops-flow,
  // zz-flow-builder)". Blocks were already deduplicated here; flows were not, and the
  // difference was invisible until somebody belonged to a second team.
  //
  // The NEWEST install wins — flowsFor orders for it, rather than this relying on whatever
  // the planner returned first. The flow's method is the same either way, since both resolve
  // to one catalog entry; the version and the agent name are what differ.
  const seen = new Set<string>();
  const flows = (await flowsFor(target))
    .filter((f) => !seen.has(f.flow) && seen.add(f.flow));
  return buildClientPackage({ target, base: publicBase(), flows });
}
/** Render a person's client setup as instructions they can follow.
 *
 * Note what is NO LONGER here: the "paste into CLAUDE.md" stanza. Those files
 * are engine-global, so a flow placed there rewrites how the person's whole
 * engine behaves on every unrelated task, and two installed flows collide in
 * one file. The package installs and uninstalls as a unit instead. */
export async function renderClientSetup(target: string): Promise<string> {
  return describePackage(await clientPackageFor(target), target);
}
/** The shelf, on the door the reader actually has.
 *
 * `list_catalog` answers "what could my team use?", and its own authorisation has always
 * been membership — seeing your own team's shelf is not an administrative act. It was once
 * mounted on the admin door, which `zz-access` did not carry: the flow whose whole job is a
 * person's own access could not tell them what they could install. The mechanism was
 * complete and unreachable, which is the quietest kind of missing feature. That class of bug
 * is what retiring the second door removed.
 *
 * Registered for everyone, unconditionally — a member's shelf is a member's business. */
export function registerShelf(server: McpServer): void {
  server.registerTool("list_catalog", {
    // What it does and when to reach for it. It also carried a sentence of this platform's
    // own history — "until now the only way to discover a flow was to guess its name at
    // install_flow and read the error" — which is true, belongs in the changelog, and in a
    // tool description is prompt real estate teaching the model nothing it can act on. This
    // repository has measured what descriptions cost: a large tool surface's descriptions alone
    // can take most of a context window before a single message.
    description:
      "The shelf: every flow this platform has, whether you already run it, and where it can " +
      "run. Use this to answer 'what could my team use?' rather than only 'what do we " +
      "already have?'.",
    inputSchema: { team: z.string().optional().describe("Mark what this team has installed. Omit for your own.") },
  }, async ({ team }) => {
    const id = await caller();
    if (!id) return text("ERROR: no platform identity");
    // Every other team-scoped tool here checks authority; this one took any string and
    // reported what that team had installed. Membership is enough — seeing your own team's
    // shelf is not an admin act — but it has to be YOUR team.
    const myTeams = id.teams.map((t) => t.slug);
    // Named `every` rather than a local `isSuper`, which SHADOWED the imported check of
    // that name — a reader had every reason to think the helper was being called here.
    const every = isSuper(id);
    // Their ACTIVE team when they name none — the same team their documents land in, not
    // whichever membership sorted first. Answering "what does my team run" about a
    // different team than the one they are working in is a quiet way to be wrong.
    //
    // And no fallback past it. This ended `?? myTeams[0]`, which is the very thing the
    // sentence above refuses, written one line under it. It was also unreachable: actingTeam
    // returns null only when the person belongs to no live team — a bound token naming a
    // team they are not in is refused before any handler runs — and then myTeams is empty
    // too. A dead line that contradicts the rule beside it is worse than either alone.
    const slug = team ?? id.activeTeam;
    if (team && !every && !myTeams.includes(team)) {
      return text(`ERROR: you are not a member of '${team}'`);
    }
    const db = platformDb();
    const installed = new Set<string>();
    if (slug) {
      const { rows } = await db.query<{ flow: string }>(
        `select f.flow from flow_install f join team t on t.id = f.team_id where t.slug = $1`,
        [slug]);
      for (const r of rows) installed.add(r.flow);
    }
    // Which flows are automatic is ONE question with one answer: autoFlows(). Asking it here
    // as `manifest.install === "auto"` was the same rule written a second time, and the two
    // readers of flow_install that got it wrong got it wrong by re-deriving it locally.
    const automatic = new Set(autoFlows().map((a) => a.flow));
    const lines = installableFlows().map((entry) => {
      const flow = entry.split("/")[1] ?? entry;
      const m = catalogManifest(flow);
      const auto = automatic.has(flow);
      const has = auto || installed.has(flow);
      return {
        flow,
        version: m?.version ?? "",
        description: (m?.description ?? "").slice(0, 160),
        install: auto ? "automatic — every team has it" : "opt-in",
        you: has ? (auto ? "installed (platform)" : "installed") : "not installed",
        blocks: m?.tools ?? [],
      };
    });
    return text(JSON.stringify({ team: slug ?? null, catalog: lines }, null, 2));
  });
}
/** Install a catalog flow for a team — see the `install_flow` tool below for the shape of
 * what it records and why. */
export async function installFlow(
  id: Identity | null, team: string, flow: string, version: string | undefined,
  agentNameInput: string | undefined,
  extraDetail: Record<string, unknown> = {},
): Promise<TeamWriteOutcome> {
  if (!teamAuthority(id, team)) return { ok: false, status: 403, error: `team admin or superadmin required for ${team}` };
  const db = platformDb();
  const tid = await teamId(db, team);
  if (!tid) {
    return { ok: false, status: 400,
      error: `no active team '${team}' — create_team on the same slug restores an archived one` };
  }
  const manifest = catalogManifest(flow);
  if (!manifest) {
    // A platform capability resolves to null here on purpose: everyone already has it.
    const asPlatform = catalogManifest(flow, true);
    if (asPlatform) {
      return { ok: false, status: 400, error:
        `'${flow}' is a platform capability, not an installable flow — every person already ` +
        "has it from the shelf. Installing it would create a duplicate that ships twice." };
    }
    return { ok: false, status: 400,
      error: `no flow '${flow}' in the catalog. Available: ${installableFlows().join(", ") || "(none mounted)"}` };
  }
  // What the installer asked for, else what the flow calls itself, else a guess.
  const agentName = (agentNameInput ?? "").trim() || manifest.agentName || titleCase(flow);
  const actorId = await principalId(db, id.email);
  await db.query(
    `insert into flow_install (team_id, flow, version, installed_by, manifest, agent_name)
     values ($1,$2,$3,$4,$5,$6)
     on conflict (team_id, flow) do update
       set version = excluded.version, manifest = excluded.manifest,
           agent_name = excluded.agent_name`,
    [tid, flow, version ?? manifest.version ?? "", actorId, JSON.stringify(manifest), agentName],
  );
  // The registry IS the install. A preset used to be projected into the front end's own
  // tables here, which made installing a flow a write into a product we do not control and
  // gave that product a copy of platform truth to drift from. The front end now reads what a
  // team runs the same way every other client does — over MCP, as the caller.
  const report: string[] = [`registry recorded — '${flow}' is now on this team's shelf.`];
  const blocks = manifest.tools ?? [];
  if (blocks.length) report.push(`manifest declares blocks [${blocks.join(", ")}] — grant_tool each one (superadmin) if not already granted`);
  auditAdmin(id, "install_flow", `${team}:${flow}`, { version: version ?? "", agent: agentName, report, ...extraDetail }, team);
  // Say where this install actually shows up. There is one client, and it reads the shelf
  // from GitHub rather than fetching a package — so the sentence that used to name the
  // team's chosen clients, and the one before it that named LibreChat, are both gone.
  const tail = "\nTeam members see it once they run `claude plugin marketplace update "
    + "zz-stack`; `my_client_setup` prints how.";
  return { ok: true, message: `${flow} installed for ${team}.\n` + report.join("\n") + tail };
}
/** Remove a team's flow install. `confirm` must repeat the flow name exactly. */
export async function uninstallFlow(
  id: Identity | null, team: string, flow: string, confirm: string,
  extraDetail: Record<string, unknown> = {},
): Promise<TeamWriteOutcome> {
  if (!teamAuthority(id, team)) return { ok: false, status: 403, error: `team admin or superadmin required for ${team}` };
  if (confirm !== flow) return { ok: false, status: 400, error: `confirm must repeat the flow name exactly ('${flow}')` };
  const db = platformDb();
  // `confirm` only proves the two arguments agree with each other. A flow name misspelt in
  // both places passes it, deletes nothing, and this reported the uninstall anyway — and
  // then went on to try removing an Open WebUI preset that was never there.
  const gone = await db.query(
    `delete from flow_install using team t
     where flow_install.team_id = t.id and t.slug = $1 and flow_install.flow = $2`,
    [team, flow],
  );
  if (!gone.rowCount) {
    // A flow the team has AUTOMATICALLY has no row to delete and is not theirs to remove,
    // which is a different answer from "you never had it" — and list_installs shows both
    // kinds now, so a reader sent there would find it listed and be none the wiser.
    const automatic = autoFlows().some((a) => a.flow === flow);
    return { ok: false, status: 400, error: automatic
      ? `'${flow}' is an automatic flow — every team has it, and no team installed it, so ` +
        "there is nothing to uninstall. Its `install` field in the catalog is what decides that."
      : `${team} does not have '${flow}' installed — nothing was removed. list_installs shows what they do have.` };
  }
  auditAdmin(id, "uninstall_flow", `${team}:${flow}`, { ...extraDetail }, team);
  return { ok: true, message: `${flow} uninstalled from ${team}` };
}
