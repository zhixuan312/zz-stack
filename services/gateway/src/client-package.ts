/**
 * client-package — turn a person's installed flows into an installable package
 * for their client.
 *
 * The rule this module exists to keep: **a client is told where the tools are
 * and what the entry skill is called, and nothing else.** No stage, no gate and
 * no document shape is ever rendered into a file here. The method is fetched at
 * run time with skill_read(), from the same catalog that serves the browser, so
 * a flow fixed on the server is live everywhere on the next message.
 *
 * It also never writes CLAUDE.md, AGENTS.md or SOUL.md. Those are engine-global
 * — in context for every task the person ever does — so a flow placed there
 * changes the behaviour of the whole engine, and two flows collide in one file.
 * Everything below installs and uninstalls as a unit instead.
 *
 * Distribution is a PUBLIC marketplace committed to this repository, which
 * `build-marketplace.mjs` renders with the very function below. It used to be a tarball from
 * `/pkg/`, behind `Authorization: Bearer` — which put a credential in front of the tools a
 * person installs in order to obtain one. The shelf was never the boundary: every tool it
 * lists is a door at the gateway, and the door still refuses.
 *
 * There is ONE client. Codex and Hermes were removed on 2026-09-12 because nobody ran
 * either, and with them went the tarball route, the archive writer, two more install stories
 * and a `clients` matrix that ran from the manifest through the database.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { catalogEntry, catalogManifest } from "@zz/catalog";
import { serviceVersion } from "@zz/mcp-http";

import { digestOf } from "./package/describe.js";
import { EVALS_DIR } from "./package/plugin-lock.js";
import { BASELINE, cardDescription, commandFile, entryCommand, headersHelper, platformPlugins, pluginName, promoteCommands, routerSkill, withoutFrontmatter } from "./package/skills.js";

/** This platform's release version, read from the gateway's own manifest so there is one
 * number and no second place to forget to update.
 *
 * Through @zz/mcp-http's serviceVersion, which is that read. This file carried its own copy —
 * the same dirname, the same `join(here, "..", "package.json")`, the same "0.0.0" on failure —
 * so "there is one number" was true of the number and not of the code that finds it. The
 * comment beside serviceVersion records what a second answer to this question already cost:
 * three servers announcing three different wrong versions at the MCP handshake. */
export const PLATFORM_VERSION: string = serviceVersion(import.meta.url);

/** Where the Claude Code shelf is published, as `claude plugin marketplace add` takes it.
 *
 * The repository is the distribution: `build-marketplace.mjs` renders the shelf into it and
 * the gate refuses a release whose committed copy has fallen behind. This is the one place
 * that name is written — the install, refresh and owner URL below all read it. */
const MARKETPLACE_REPO = "zhixuan312/zz-stack";

/** What the shelf is CALLED, as `plugin@marketplace` ids spell it.
 *
 * The same word as the repository, deliberately: `marketplace add zhixuan312/zz-stack`
 * followed by `install zz@zz-platform` made a person learn two names for one shelf and
 * guess which belonged where. It is not the same word as the platform's own TEAM, which is
 * `zz-platform` (PLATFORM_TEAM, in identity.ts) — those were the two things the old name
 * ran together, and a marketplace and a team are not remotely the same object. */
export const MARKETPLACE = "zz-stack";

/** Who publishes this shelf. One object for the marketplace's `owner` and every plugin's
 * `author`, because they are the same claim and `claude plugin validate` asks for both —
 * two literals would be two places to disagree about who made this. */
const OWNER = { name: "ZZ Stack", url: `https://github.com/${MARKETPLACE_REPO}` };

export interface PackageFile {
  /** Path inside the package, relative to its root. */
  path: string;
  content: string;
  /** Unix mode; scripts need the execute bit or the client cannot run them. */
  mode?: number;
}

export interface InstalledFlow {
  flow: string;
  version: string;
  entry: string;
  agentName: string | null;
  /** One line from the entry skill: when this flow is the right one. */
  whenToUse: string;
  blocks: string[];
  /** Platform surfaces this flow's METHOD needs, beyond the baseline. A flow whose skills
   * instruct an admin tool has to be able to reach one; without this the package shipped the
   * instruction and not the tool. */
  servers: { name: string; path: string }[];
}

/* The served-vs-local split lived here: SERVED_CLIENTS, ALL_CLIENTS and isLocalOnly.
 *
 * It existed because a browser has no local disk, so a flow running there had to fetch its
 * method from the platform — and a flow that ALSO shipped its skills as files to the same
 * team's terminals put two copies of one method in the world, which drift. With the browser
 * front end removed on 2026-09-10 and Codex and Hermes on 2026-09-12, every client is a
 * terminal that holds files, `isLocalOnly` was true for every flow it was ever asked about,
 * and the branch it guarded had one live side. Keeping the machinery would have been a
 * matrix with one cell. */

/** The platform's OWN skills — zz-backbone, zz-distil, zz-evolve, zz-kb-usage,
 * blocks-capabilities. A tree of their own, beside the catalog rather than in it,
 * because they are true wherever this runs and belong to nobody's flow.
 *
 * Overridable for the same reason `CATALOG_DIR` is: the gate builds real packages
 * on a developer's machine where `/skills` does not exist, and a hardcoded path
 * would make that probe silently produce a package missing every one of them.
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
  // Directories only, for the reason `residentSkills` states below.
  for (const e of readdirSync(SKILLS_DIR, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (e.isDirectory()) walk(join(SKILLS_DIR, e.name), e.name);
  }
  return out;
}

/** The baseline plugin's own eval cases. Same walk and the same directories-only rule as
 * `platformOwnSkills`, rooted at `evals/` because that is where the command looks.
 *
 * `zz-core` needs its own because it is the one plugin whose FILES are not read from the catalog —
 * it is synthesised
 * per caller — so `residentFiles` has nothing to resolve for it. It is also the plugin everybody
 * installs, which makes it the one most worth having a suite for. */
function platformOwnEvals(): PackageFile[] {
  if (!existsSync(EVALS_DIR)) return [];
  const out: PackageFile[] = [];
  const walk = (dir: string, rel: string): void => {
    for (const f of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, f.name);
      if (f.isDirectory()) walk(abs, `${rel}/${f.name}`);
      else out.push({ path: `evals/${rel}/${f.name}`, content: readFileSync(abs, "utf8") });
    }
  };
  for (const e of readdirSync(EVALS_DIR, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (e.isDirectory()) walk(join(EVALS_DIR, e.name), e.name);
  }
  return out;
}

/** What the baseline plugin carries: the router, the platform's own skills, and a command
 * for each skill its manifest declares one for.
 *
 * The baseline got skills and no commands, so `doctor`, `update` and `migrate` — the three a
 * person types rather than a method loads — had no way to be typed. Flows have promoted their
 * declared commands since they existed; this is the same rule applied to the one plugin
 * everybody has, and now through the same function.
 *
 * `promoteCommands`, not a second promoter reading each skill's frontmatter. The baseline had
 * no manifest to put a commands map in, so each skill carried `command: doctor` itself; it has
 * one at `catalog/zz/zz-core/flow.json` now, so the map lives where every other package's map
 * lives. Its SKILLS are still the tree beside the catalog rather than that entry's `skills/` —
 * one of them is GENERATED per person and none of them can be read from a shared catalog. */
function baselineFiles(flows: InstalledFlow[]): PackageFile[] {
  const skills = [
    { path: "skills/zz-router/SKILL.md", content: routerSkill(flows) },
    ...platformOwnSkills("skills"),
  ];
  const { commands, promoted } = promoteCommands(BASELINE, skills);
  // Assets beside a promoted skill still travel: only its SKILL.md moves. That is what
  // carries each command's script, which lives in the skill's own directory.
  return [...commands, ...skills.filter((sk) => !promoted.has(sk)), ...platformOwnEvals()];
}

/** The baseline's marketplace card, addressed to whoever this package was built for.
 *
 * THE PROSE LIVES IN THE MANIFEST, like every other package's, and only the ADDRESS is spliced
 * in here — because the address is the one part that is not a property of the package: on the
 * gateway `target` is the person's email, and on the committed shelf it is "your team". This
 * sentence was a template literal here while the manifest said nothing, which was fine while
 * the baseline had no manifest; it has one now, and keeping both would leave the card a person
 * receives and the card the catalog declares free to drift apart.
 *
 * THROWS rather than falling back. An empty card on the one plugin everybody must install is
 * the failure nobody notices, and catalog-manifest.mjs already refuses a shelved entry with no
 * description — so reaching this line means the manifest is not the one that check read. */
function baselineCard(target: string): string {
  const said = catalogManifest(BASELINE, true)?.description;
  if (!said) {
    throw new Error(
      `${BASELINE} declares no description — the baseline's marketplace card is its manifest's, ` +
      "and there is nothing else to show a person choosing what to install.");
  }
  // A FUNCTION, not a replacement string. `target` is the person's own email on the
  // gateway, and `$&` or `$'` inside a replacement STRING are read as patterns — the
  // defect security-boundary.mjs found in nine sites that put somebody's words into
  // somebody's document.
  return said.replace("ZZ platform baseline", () => `ZZ platform baseline for ${target}`);
}

/** Every file under one of a catalog entry's directories, as package files rooted at the same
 * name.
 *
 * `sub` was hard-coded to "skills" while the caller passed a `prefix` that was always that same
 * word — one directory the shelf could carry. It carries two now: `evals/` holds the cases
 * `claude plugin eval` runs against the plugin, and they have to travel WITH it. The command
 * resolves an installed plugin to its cache directory and looks for `evals/` below it, so a
 * suite left behind in the catalog is a suite nobody can run against what they actually
 * installed — and the run silently becomes a baseline-only one with no comparison in it at all.
 *
 * Source and destination are the same word deliberately: a package that renamed the directory
 * on the way out would be a package whose layout the tool reading it cannot predict. */
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
  // DIRECTORIES only. This took every entry in skills/ and called readdirSync on it, so a
  // stray file there — a README, an editor's leftover — threw ENOTDIR and took down package
  // building for everyone running that flow, from a file that is not a skill and harms
  // nothing else.
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
  /** How to pick up a newly installed flow. */
  refresh: string[];
  /** How to remove it completely. */
  remove: string[];
  /** Anything true that the person should know, including what we cannot do. */
  notes: string[];
  flows: InstalledFlow[];
  blocks: string[];
}

/* ── reading the catalog ─────────────────────────────────────────── */








/* ── the three generated texts ───────────────────────────────────── */









/* ── the package ─────────────────────────────────────────────────── */

/** One installable unit inside the marketplace.
 *
 * The shelf used to hold a single plugin called `zz` carrying everything a person's team
 * had access to. That made selection impossible: install it and you got every block your
 * team was granted, wired into your runtime, whether your work touched them or not. A
 * person writing code got another team's MCP server because a colleague's
 * flow needed it.
 *
 * Now the marketplace lists many plugins and the runtime's own `plugin install` is the
 * chooser — no selector of ours to build, and the command is one people already know.
 * Each plugin declares only the MCP servers it actually needs, so a block arrives with the
 * flow that uses it or not at all. */
export interface Plugin {
  name: string;
  description: string;
  /** MCP servers this plugin needs, and nothing more. */
  servers: { name: string; url: string }[];
  files: PackageFile[];
  /** The baseline is not a choice — nothing else works without it. */
  required?: boolean;
}

interface PackageInput {
  target: string;
  base: string;
  flows: InstalledFlow[];
}

export function buildClientPackage({ target, base, flows }: PackageInput): ClientPackage {
  // ONE PLUGIN PER FLOW is a property of the package, so two entries for one flow is not
  // something to render — it is incoherent input, and rendering it produced two plugins of
  // one name and the same skill files written twice into one tarball, where extraction takes
  // whichever wins. The caller that could produce it has been fixed; this says so out loud
  // rather than leaving the next caller to discover it in a file somebody installed.
  const twice = flows.map((f) => f.flow).filter((f, i, all) => all.indexOf(f) !== i);
  if (twice.length) {
    throw new Error(
      `a client package carries one plugin per flow, and this one was given ` +
      `${[...new Set(twice)].join(", ")} more than once. Pick which install applies before ` +
      "rendering — two plugins of one name collide on install.",
    );
  }
  const blocks = [...new Set(flows.flatMap((f) => f.blocks))].sort();
  const files: PackageFile[] = [];
  const notes: string[] = [];

  // ── what the shelf holds ───────────────────────────────────────────
  //
  // Baseline first: the platform's own MCP and the router. Then one plugin per flow,
  // each carrying its own blocks. Admin is its own plugin because most people never
  // need it, and a tool that can create teams should not arrive by default.
  const core = { name: "zz-core", url: `${base}/core/mcp` };
  const plugins: Plugin[] = [
    {
      name: BASELINE,
      description: baselineCard(target),
      servers: [core],
      required: true,
      // The one plugin whose content is generated rather than read: the router describes
      // THIS person's installed flows, so it cannot live in a catalog shared by everyone.
      // The hermes flavour differs only in frontmatter, and it is built HERE so there is one
      // router in the package. Pushing a second copy in the hermes branch put two entries at
      // the same tar path, and the one that won on extraction was the wrong one.
      // MCP *AND* SKILLS. This carried the router and nothing else, so the five
      // skills in `/skills` — the platform's own, zz-backbone among them, which
      // has been read 194 times through skill_read — shipped in no plugin at all.
      // They were reachable over MCP and installable by nobody. This is the one
      // plugin everybody must have, and what we are is our MCP and our method.
      files: baselineFiles(flows),
    },
    ...platformPlugins().map((pp): Plugin => {
      const skills = residentFiles(pp.dir, "skills");
      const { commands, promoted } = promoteCommands(pp.dir, skills);
      return {
        name: pp.name,
        description: pp.description,
        servers: pp.servers.map((sv) => ({ name: sv.name, url: `${base}${sv.path}` })),
        // Assets beside a promoted skill still travel: only its SKILL.md moves.
        files: [...commands, ...skills.filter((sk) => !promoted.has(sk)),
                ...residentFiles(pp.dir, "evals")],
      };
    }),
    ...flows.map((f): Plugin => {
      const skills = residentFiles(f.flow, "skills");
      const entry = skills.find((s) => s.path === `skills/${f.entry}/SKILL.md`);
      // A skill a person invokes ON PURPOSE — the front door, and every other skill the
      // manifest names in `commands` — becomes a command; it ships exactly once either way.
      // Stage skills are never promoted: they are reached through the flow, not typed.
      //
      // BOTH HALVES HAVE TO HOLD for the entry. `entryCmd` is what the manifest says the
      // front door is typed as, and it is undefined for a package that declares no command
      // for its entry — there is no default to fall back to, and a flow reached only by
      // loading its skill is a legal thing to be. `entry` is whether that skill actually
      // shipped; when it did not, the command is still emitted, as a pointer that fetches
      // the method at run time.
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
        // A flow's blocks arrive with the flow, or not at all — and so does any platform
        // surface its method needs. Both are the same statement: this is what my skills call.
        servers: [
          ...f.blocks.map((b) => ({ name: b, url: `${base}/p/${b}/mcp` })),
          ...f.servers.map((sv) => ({ name: sv.name, url: `${base}${sv.path}` })),
        ],
        files: [
          ...(entryCmd ? [{
            path: `commands/${entryCmd}.md`,
            content: commandFile(f, entryCmd,
                                 asCommand && entry ? withoutFrontmatter(entry.content) : undefined),
          }] : []),
          ...declaredCommands,
          // Assets beside a promoted skill still travel: only its SKILL.md moves.
          ...skills.filter((sk) => !promoted.has(sk)),
          // And the eval suite, for the reason residentFiles gives: a suite that did not travel
          // with the plugin turns `claude plugin eval` into a baseline-only run with no
          // comparison in it, which looks like a result and is not one.
          ...residentFiles(f.flow, "evals"),
        ],
      };
    }),
  ];

  // The platform's own version, plus a digest of what THIS person's shelf contains.
  //
  // Two facts force this shape. The runtime caches an installed plugin in a directory named
  // by its version, so a version that does not change means a changed file never reaches
  // anyone — a fix to a skill would sit on the server forever. And the shelf differs per
  // person, so the platform version alone cannot identify it. Semver build metadata is
  // legal, is part of the directory name, and does not pretend to be a release.
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
    home: "~/.zz", files, flows, blocks, notes,
    install: [
      // CREATED restricted, not restricted afterwards. `>` makes the file with the shell's
      // umask — 644 on most machines — and the chmod lands after it already exists, so the
      // person's platform token is world-readable for that window. server.ts made exactly
      // this argument about the platform's own credential file ("setting it afterwards
      // would leave a window where the new file is world-readable") and fixed it by
      // creating with the mode; this is the same secret one layer out, on a machine that
      // may well have other users.
      //
      // The chmod stays for what umask cannot cover: a ~/.zz or a token file left behind by
      // an earlier install with looser permissions.
      // THE SHELF FIRST, AND IT NEEDS NO TOKEN. It used to come from `${base}/pkg/…`, which
      // put a credential in front of the tools a person installs to obtain one — so someone
      // with no token was handed two `claude plugin` commands that failed on a directory
      // that could not exist yet. The shelf is public because it was never the boundary:
      // every tool below is a door at the gateway and the door still refuses.
      `claude plugin marketplace add ${MARKETPLACE_REPO}`,
      `claude plugin install zz-core@${MARKETPLACE} # the baseline — everything else needs it`,
      ``,
      `# Then the token — it is what every tool above actually authenticates with.`,
      // CREATED restricted, not restricted afterwards. `>` makes the file with the shell's
      // umask — 644 on most machines — and the chmod lands after it already exists, so the
      // person's platform token is world-readable for that window. server.ts made exactly
      // this argument about the platform's own credential file ("setting it afterwards
      // would leave a window where the new file is world-readable") and fixed it by
      // creating with the mode; this is the same secret one layer out, on a machine that
      // may well have other users.
      //
      // The chmod stays for what umask cannot cover: a ~/.zz or a token file left behind by
      // an earlier install with looser permissions.
      `(umask 077; mkdir -p ~/.zz) && chmod 700 ~/.zz`,
      `(umask 077; printf '%s' "$ZZ_TOKEN" > ~/.zz/token) && chmod 600 ~/.zz/token`,
      ``,
      `# Then take what you want, and nothing else. To see the shelf:`,
      `#   /plugins in Claude Code, then the Marketplaces tab, or`,
      // node, not python3. Anyone running Claude Code has node — it is what Claude Code
      // runs on — and may not have python3 at all. A one-liner in an install instruction
      // is only useful if it runs on the machine reading it.
      `#   claude plugin list --available --json | node -e '`,
      `#     let s="";process.stdin.on("data",d=>s+=d).on("end",()=>JSON.parse(s).available`,
      `#       .filter(p=>(p.pluginId||"").includes("${MARKETPLACE}"))`,
      `#       .forEach(p=>console.log(p.name,"—",(p.description||"").slice(0,70))))'`,
      // COMMENTED, so this block stays a menu rather than a script that chooses for you.
      // These lines used to be live, directly under "take what you want, and nothing
      // else" — so anyone who pasted the block installed every optional plugin, which is
      // the exact thing the one-plugin-per-flow split exists to prevent. zz-admin came
      // with it, and a plugin that can create teams must not arrive by default.
      ``,
      `# Uncomment the ones you want:`,
      ...optional.map((n) => `# claude plugin install ${n}@${MARKETPLACE}`),
    ],
    // EXTRACT ONTO NOTHING. `tar xz` writes what the archive holds and removes nothing it
    // does not, so a plugin the platform has RETIRED stayed on the laptop for ever: the
    // marketplace stopped listing it, `claude plugin list` went on showing it, and it went
    // on pointing at whatever URL it was built with. Retiring zz-admin is exactly that —
    // its door stops answering, and a stale copy turns a completed change into an MCP
    // connection error on somebody's next session, with nothing saying why.
    //
    // Only the package directory is removed. `~/.zz/token` is a sibling of it, not a child,
    // and it is the one thing here that cannot be re-fetched.
    // One command, because the shelf is a git clone rather than an archive unpacked over
    // whatever was there before. That is what fixes the retirement problem this comment
    // was written for: a plugin the platform has retired LEAVES the shelf on update, where
    // `tar xz` could only ever add — so `zz-admin` stayed on laptops after it was folded
    // into `zz-access`, listed by `claude plugin list` and pointing at a door that had
    // stopped answering, with nothing saying why.
    //
    // AND IT IS NOT THE WHOLE JOB, which is why `/zz-core:update` leads. Refreshing the shelf
    // updates NO plugin: each one is resolved against the marketplace's copy, so a person who
    // runs only this is told, truthfully, that everything is up to date — at the version they
    // already had. This text said exactly that one command for as long as it existed, which
    // is the same failure mma shipped and had to name in its own release notes.
    refresh: [
      `/zz-core:update    # the shelf AND every plugin you have, in the order that works`,
      `# or, by hand — and the order is not optional:`,
      `claude plugin marketplace update ${MARKETPLACE}`,
      `claude plugin update zz-core@${MARKETPLACE} # ...and each plugin you installed`,
    ],
    // Every plugin, not just the baseline. This said `uninstall zz` alone, so a person
    // who followed it kept zz-access and every flow installed — pointing at a
    // marketplace that had just been removed and a ~/.zz that had just been deleted.
    // Optional ones first: the baseline is what they were installed on top of.
    remove: [
      ...optional.map((n) => `claude plugin uninstall ${n}`),
      `claude plugin uninstall zz`,
      `claude plugin marketplace remove ${MARKETPLACE}`,
      `rm -rf ~/.zz`,
    ],
  };
}


/* ── delivery ────────────────────────────────────────────────────── */


