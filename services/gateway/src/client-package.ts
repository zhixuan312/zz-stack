/**
 * client-package — turn the catalog into the installable package a client takes.
 *
 * A client is told where the tools are and what the entry skill is called, and nothing else.
 * No stage, no gate and no document shape is rendered into a file here: the method is fetched
 * at run time with skill_read(), from the same catalog that serves the browser, so a flow
 * fixed on the server is live everywhere on the next message.
 *
 * DELIBERATE: never writes CLAUDE.md, AGENTS.md or SOUL.md. Those are engine-global, so a flow
 * placed there changes the whole engine and two flows collide in one file. Everything below
 * installs and uninstalls as a unit instead.
 *
 * Distribution is a public marketplace committed to this repository, which
 * `build-marketplace.ts` renders with the function below. The shelf is not a boundary: every
 * tool it lists is a door at the gateway, and the door still refuses.
 *
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { catalogEntry, catalogManifest, pluginName } from "@zz/catalog";
import { serviceVersion } from "@zz/mcp-http";

import { digestOf } from "./package/describe.js";
import { BASELINE, cardDescription, commandFile, entryCommand, headersHelper, platformPlugins, promoteCommands, routerSkill, shelfFlows, withoutFrontmatter } from "./package/skills.js";

/** This platform's release version, read from the gateway's own manifest so there is one number
 * and no second place to forget to update. Through @zz/mcp-http's serviceVersion, which is that
 * read. */
export const PLATFORM_VERSION: string = serviceVersion(import.meta.url);

/** Where the Claude Code shelf is published, as `claude plugin marketplace add` takes it.
 *
 * COUPLED: the repository is the distribution — `build-marketplace.ts` renders the shelf into
 * it and the gate refuses a release whose committed copy has fallen behind. The install,
 * refresh and owner URL below all read this one name. */
const MARKETPLACE_REPO = "zhixuan312/zz-stack";

/** What the shelf is called, as `plugin@marketplace` ids spell it. The same word as the
 * repository, deliberately, so a person learns one name.
 *
 * Not the same word as the platform's own team, which is `zz-platform` (PLATFORM_TEAM, in
 * identity.ts). A marketplace and a team are different objects. */
export const MARKETPLACE = "zz-stack";

/** Who publishes this shelf. One object for the marketplace's `owner` and every plugin's
 * `author` — the same claim, and `claude plugin validate` asks for both. */
const OWNER = { name: "ZZ Stack", url: `https://github.com/${MARKETPLACE_REPO}` };

export interface PackageFile {
  /** Path inside the package, relative to its root. */
  path: string;
  content: string;
  /** Unix mode; scripts need the execute bit or the client cannot run them. */
  mode?: number;
}

export interface ShelfFlow {
  flow: string;
  version: string;
  entry: string;
  agentName: string | null;
  /** One line from the entry skill: when this flow is the right one. */
  whenToUse: string;
  /** Platform surfaces this flow's method needs, beyond the baseline. A flow whose skills
   * instruct an admin tool has to be able to reach one. */
  servers: { name: string; path: string }[];
}

/** The platform's own skills, such as zz-platform. A tree of their own, beside the catalog
 * rather than in it, because they are true wherever this runs and belong to nobody's flow.
 *
 * Overridable for the same reason `CATALOG_DIR` is: the gate builds real packages on a
 * developer's machine where `/skills` does not exist.
 */
const SKILLS_DIR = process.env.ZZ_SKILLS_DIR || "/skills";

function platformOwnSkills(prefix: string): PackageFile[] {
  if (!existsSync(SKILLS_DIR)) return [];
  const out: PackageFile[] = [];
  const walk = (dir: string, rel: string): void => {
    for (const f of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, f.name);
      if (f.isDirectory()) walk(abs, `${rel}/${f.name}`);
      else out.push({ path: `${prefix}/${rel}/${f.name}`, content: readFileSync(abs, "utf8") });
    }
  };
  // Directories only, for the reason `residentFiles` states below.
  for (const e of readdirSync(SKILLS_DIR, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (e.isDirectory()) walk(join(SKILLS_DIR, e.name), e.name);
  }
  return out;
}


/** What the baseline plugin carries: the router, the platform's own skills, and a command for
 * each skill its manifest declares one for. Its manifest is `catalog/zz/zz-core/flow.json`.
 *
 * DELIBERATE: its skills are the tree beside the catalog rather than that entry's `skills/`,
 * plus the router, which is generated from the shelf's flows when the package is built. */
function baselineFiles(flows: ShelfFlow[]): PackageFile[] {
  const skills = [
    { path: "skills/zz-router/SKILL.md", content: routerSkill(flows) },
    ...platformOwnSkills("skills"),
  ];
  const { commands, promoted } = promoteCommands(BASELINE, skills);
  // Assets beside a promoted skill still travel: only its SKILL.md moves. That is what
  // carries each command's script, which lives in the skill's own directory.
  return [...commands, ...skills.filter((sk) => !promoted.has(sk))];
}

/** The baseline's marketplace card, addressed to whoever this package was built for.
 *
 * The prose lives in the manifest, like every other package's; only the address is spliced in
 * here, because it is not a property of the package — on the gateway `target` is the person's
 * email, and on the committed shelf it is "your team".
 *
 * DELIBERATE: throws rather than falling back. catalog-manifest.ts already refuses a shelved
 * entry with no description, so reaching this line means the manifest is not the one that
 * check read. */
function baselineCard(target: string): string {
  const said = catalogManifest(BASELINE, true)?.description;
  if (!said) {
    throw new Error(
      `${BASELINE} declares no description — the baseline's marketplace card is its manifest's, ` +
      "and there is nothing else to show a person choosing what to install.");
  }
  // DELIBERATE: a function, not a replacement string. `target` is the person's own email, and
  // `$&` or `$'` inside a replacement string are read as patterns.
  return said.replace("ZZ platform baseline", () => `ZZ platform baseline for ${target}`);
}

/** Every file under one of a catalog entry's directories, as package files rooted at the same
 * name.
 *
 * `sub` is parameterised although "skills" is the only value any caller passes.
 *
 * DELIBERATE: source and destination are the same word. A package that renamed the directory on
 * the way out would be a package whose layout the tool reading it cannot predict. */
function residentFiles(flow: string, sub: string): PackageFile[] {
  const e = catalogEntry(flow, true);
  if (!e) return [];
  const root = join(e.dir, sub);
  if (!existsSync(root)) return [];
  const prefix = sub;
  const out: PackageFile[] = [];
  const walk = (dir: string, rel: string): void => {
    for (const f of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, f.name);
      if (f.isDirectory()) walk(abs, `${rel}/${f.name}`);
      else out.push({ path: `${prefix}/${rel}/${f.name}`, content: readFileSync(abs, "utf8") });
    }
  };
  // Directories only: a stray file in skills/ — a README, an editor's leftover — makes
  // readdirSync throw ENOTDIR and takes down package building for everyone running that flow.
  for (const e of readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (e.isDirectory()) walk(join(root, e.name), e.name);
  }
  return out;
}

export interface ClientPackage {
  /** Directory the person keeps their token in, e.g. ~/.zz */
  home: string;
  files: PackageFile[];
  /** Shell lines, in order, that install it. */
  install: string[];
  /** How to pick up a change to the shelf. */
  refresh: string[];
  /** How to remove it completely. */
  remove: string[];
  /** Anything true that the person should know, including what we cannot do. */
  notes: string[];
  flows: ShelfFlow[];
}


/** One installable unit inside the marketplace.
 *
 * The marketplace lists many plugins and the runtime's own `plugin install` is the chooser.
 * Each plugin declares only the MCP servers it actually needs, so a server arrives with the flow
 * that uses it or not at all. */
export interface Plugin {
  name: string;
  description: string;
  /** MCP servers this plugin needs, and nothing more. */
  servers: { name: string; url: string }[];
  files: PackageFile[];
  /** The platform's own plugins are not a choice — nothing else works without them. */
  required?: boolean;
}

interface PackageInput {
  target: string;
  base: string;
}

export function buildClientPackage({ target, base }: PackageInput): ClientPackage {
  // The same shelf for everyone: the catalog's flows, never a team's record of installs.
  const flows = shelfFlows();
  const files: PackageFile[] = [];
  const notes: string[] = [];

  // Baseline first: the platform's own MCP and the router. Then the platform's other own
  // plugins, which are required like the baseline — zz-access is how a person gets a token at
  // all. Then one optional plugin per catalog flow.
  const core = { name: "zz-core", url: `${base}/core/mcp` };
  const plugins: Plugin[] = [
    {
      name: BASELINE,
      description: baselineCard(target),
      servers: [core],
      required: true,
      // The one plugin whose content is generated rather than read: the router names the flows
      // on the shelf, and the package carries the platform's own skills as well as its MCP.
      files: baselineFiles(flows),
    },
    ...platformPlugins().map((pp): Plugin => {
      const skills = residentFiles(pp.dir, "skills");
      const { commands, promoted } = promoteCommands(pp.dir, skills);
      return {
        name: pp.name,
        description: pp.description,
        servers: pp.servers.map((sv) => ({ name: sv.name, url: `${base}${sv.path}` })),
        required: true,
        // Assets beside a promoted skill still travel: only its SKILL.md moves.
        files: [...commands, ...skills.filter((sk) => !promoted.has(sk))],
      };
    }),
    ...flows.map((f): Plugin => {
      const skills = residentFiles(f.flow, "skills");
      const entry = skills.find((s) => s.path === `skills/${f.entry}/SKILL.md`);
      // A skill a person invokes on purpose — the front door, and every other skill the
      // manifest names in `commands` — becomes a command; it ships exactly once either way.
      // Stage skills are never promoted: they are reached through the flow, not typed.
      //
      // Both halves have to hold for the entry. `entryCmd` is undefined for a package that
      // declares no command for its entry, and there is no default. `entry` is whether that
      // skill actually shipped; when it did not, the command is still emitted, as a pointer
      // that fetches the method at run time.
      const entryCmd = entryCommand(f.flow, f.entry || f.flow);
      const asCommand = entryCmd !== undefined && entry !== undefined;
      const { commands: declaredCommands, promoted: declaredPromoted } =
        promoteCommands(f.flow, skills, [f.entry || f.flow]);
      const promoted = new Set<PackageFile>([
        ...(asCommand && entry ? [entry] : []),
        ...declaredPromoted,
      ]);
      return {
        name: pluginName(f.flow),
        description: cardDescription(f.flow, `${f.agentName || f.flow} — ${f.whenToUse}`.slice(0, 180)),
        // A flow's servers arrive with the flow, or not at all: this is what my skills call.
        servers: f.servers.map((sv) => ({ name: sv.name, url: `${base}${sv.path}` })),
        files: [
          ...(entryCmd ? [{
            path: `commands/${entryCmd}.md`,
            content: commandFile(f, entryCmd,
                                 asCommand && entry ? withoutFrontmatter(entry.content) : undefined),
          }] : []),
          ...declaredCommands,
          // Assets beside a promoted skill still travel: only its SKILL.md moves.
          ...skills.filter((sk) => !promoted.has(sk)),
        ],
      };
    }),
  ];

  // The platform's own version, plus a digest of what this person's shelf contains.
  //
  // The runtime caches an installed plugin in a directory named by its version, so a version
  // that does not change means a changed file never reaches anyone. The shelf differs per
  // person, so the platform version alone cannot identify it. Semver build metadata is legal,
  // is part of the directory name, and does not pretend to be a release.
  const version = `${PLATFORM_VERSION}+${digestOf(plugins)}`;

  files.push({
    path: ".claude-plugin/marketplace.json",
    content: JSON.stringify({
      name: MARKETPLACE,
      owner: OWNER,
      description:
        "Delivery flows and platform tools for the ZZ platform. Every tool here is a door " +
        "at the gateway and asks for your platform token; installing a plugin grants nothing " +
        "on its own.",
      plugins: plugins.map((pl) => ({
        name: pl.name,
        source: `./${pl.name}`,
        description: pl.required ? `REQUIRED — ${pl.description}` : pl.description,
      })),
    }, null, 2) + "\n",
  });
  for (const pl of plugins) {
    files.push({
      path: `${pl.name}/.claude-plugin/plugin.json`,
      content: JSON.stringify({ name: pl.name, description: pl.description, version, author: OWNER }, null, 2) + "\n",
    });
    if (pl.servers.length) {
      files.push({
        path: `${pl.name}/.mcp.json`,
        content: JSON.stringify({
          mcpServers: Object.fromEntries(pl.servers.map((sv) => [sv.name, {
            type: "http", url: sv.url,
            headersHelper: '"${CLAUDE_PLUGIN_ROOT}"/scripts/zz-mcp-headers.sh',
          }])),
        }, null, 2) + "\n",
      });
      // Each plugin carries its own copy: CLAUDE_PLUGIN_ROOT points at the plugin that
      // declared the server, so a shared script one directory up would not resolve.
      files.push({ path: `${pl.name}/scripts/zz-mcp-headers.sh`,
                   content: headersHelper(), mode: 0o755 });
    }
    for (const f of pl.files) files.push({ path: `${pl.name}/${f.path}`, content: f.content, mode: f.mode });
  }

  const optional = plugins.filter((pl) => !pl.required).map((pl) => pl.name);
  return {
    home: "~/.zz", files, flows, notes,
    install: [
      // The shelf first, and it needs no token. It is public because it was never the boundary:
      // every tool below is a door at the gateway and the door still refuses.
      `claude plugin marketplace add ${MARKETPLACE_REPO}`,
      ...plugins.filter((pl) => pl.required)
        .map((pl) => `claude plugin install ${pl.name}@${MARKETPLACE} # required`),
      ``,
      `# Then the token — it is what every tool above actually authenticates with.`,
      // DELIBERATE: created restricted, not restricted afterwards. `>` makes the file with the
      // shell's umask — 644 on most machines — so a chmod after the fact leaves the person's
      // token world-readable for that window. The chmod stays for what umask cannot cover: a
      // ~/.zz or a token file left behind by an earlier install with looser permissions.
      `(umask 077; mkdir -p ~/.zz) && chmod 700 ~/.zz`,
      `(umask 077; printf '%s' "$ZZ_TOKEN" > ~/.zz/token) && chmod 600 ~/.zz/token`,
      ``,
      `# Then take what you want, and nothing else. To see the shelf:`,
      `#   /plugins in Claude Code, then the Marketplaces tab, or`,
      // DELIBERATE: node, not python3. Anyone running Claude Code has node and may not have
      // python3 at all.
      `#   claude plugin list --available --json | node -e '`,
      `#     let s="";process.stdin.on("data",d=>s+=d).on("end",()=>JSON.parse(s).available`,
      `#       .filter(p=>(p.pluginId||"").includes("${MARKETPLACE}"))`,
      `#       .forEach(p=>console.log(p.name,"—",(p.description||"").slice(0,70))))'`,
      // DELIBERATE: commented out, so this block stays a menu rather than a script that
      // chooses for you. Live, they install every optional plugin — including zz-admin, which
      // can create teams.
      ``,
      `# Uncomment the ones you want:`,
      ...optional.map((n) => `# claude plugin install ${n}@${MARKETPLACE}`),
    ],
    // One command, because the shelf is a git clone rather than an archive unpacked over
    // whatever was there before: a plugin the platform has retired leaves the shelf on update.
    //
    // `/zz-access:update` leads because refreshing the shelf updates no plugin — each one is
    // resolved against the marketplace's copy, so a person who runs only the refresh is told,
    // truthfully, that everything is up to date at the version they already had.
    refresh: [
      `/zz-access:update  # the shelf AND every plugin you have, in the order that works`,
      `# or, by hand — and the order is not optional:`,
      `claude plugin marketplace update ${MARKETPLACE}`,
      `claude plugin update zz-core@${MARKETPLACE} # ...and each plugin you installed`,
    ],
    // Every plugin, not just the baseline: anything left installed points at a marketplace that
    // has just been removed and a ~/.zz that has just been deleted. Optional ones first — the
    // baseline is what they were installed on top of.
    remove: [
      ...optional.map((n) => `claude plugin uninstall ${n}`),
      `claude plugin uninstall zz`,
      `claude plugin marketplace remove ${MARKETPLACE}`,
      `rm -rf ~/.zz`,
    ],
  };
}




