/**
 * client-package — turn a person's installed flows into an installable package
 * for their client.
 *
 * The rule this module exists to keep: **a client is told where the tools are
 * and what the entry skill is called, and nothing else.** No stage, no gate and
 * no document shape is ever rendered into a file here. The method is fetched at
 * run time with skill_view(), from the same catalog that serves the browser, so
 * a flow fixed on the server is live everywhere on the next message.
 *
 * It also never writes CLAUDE.md, AGENTS.md or SOUL.md. Those are engine-global
 * — in context for every task the person ever does — so a flow placed there
 * changes the behaviour of the whole engine, and two flows collide in one file.
 * Everything below installs and uninstalls as a unit instead.
 *
 * Distribution is a tarball, not a git remote: Claude Code accepts a local path
 * and so does Codex, and a path costs us no git server.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { catalogEntry } from "@zz/catalog";
import { serviceVersion } from "@zz/mcp-http";

import { digestOf } from "./package/archive.js";
import { cardDescription, commandFile, commandName, headersHelper, platformPlugins, pluginName, promoteStandalone, routerSkill, trimTo, withoutFrontmatter } from "./package/skills.js";

/** This platform's release version, read from the gateway's own manifest so there is one
 * number and no second place to forget to update.
 *
 * Through @zz/mcp-http's serviceVersion, which is that read. This file carried its own copy —
 * the same dirname, the same `join(here, "..", "package.json")`, the same "0.0.0" on failure —
 * so "there is one number" was true of the number and not of the code that finds it. The
 * comment beside serviceVersion records what a second answer to this question already cost:
 * three servers announcing three different wrong versions at the MCP handshake. */
export const PLATFORM_VERSION: string = serviceVersion(import.meta.url);

/** The clients a package is BUILT for — each one runs on a person's own machine and holds
 * files. Declared as a tuple so it can be the type, the runtime list AND the zod enum: the
 * same three names were written in four places (here, ALL_CLIENTS in admin.ts, and a
 * hard-typed z.enum in each of admin.ts and server.ts), and nothing checked that they
 * agreed. Adding a fourth client meant finding all four, and the one that got missed would
 * have refused it at a tool boundary with "invalid enum value" while the package built. */
export const CLIENT_KINDS = ["claude-code", "codex", "hermes"] as const;
export type ClientKind = (typeof CLIENT_KINDS)[number];

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
  /** The clients this flow EFFECTIVELY runs on for this team: what they chose at install,
   * bounded by what the manifest declares. A manifest with no `clients` declares every
   * client the platform supports, so an existing flow keeps working untouched. */
  clients: string[];
}

/** Clients whose method is SERVED at run time rather than shipped as files.
 *
 * A browser has no local disk: a flow running there can only fetch its method from the
 * platform with skill_view(). Everything else on this list is a client that runs on a
 * person's own machine and can hold files.
 *
 * Named as a ROLE, not as a product. The test below used to ask whether the client list
 * contained "open-webui", so the only way into the browser-is-present branch was to name one
 * particular front end — and when that front end was replaced, every flow silently became
 * local-only and started shipping a second copy of its own method. This set is the one line
 * to change when a front end is swapped, and adding a browser back is one entry.
 *
 * IT IS EMPTY, AND THAT IS THE TRUE ANSWER RIGHT NOW. The browser front end was removed on
 * 2026-09-10; this platform serves MCP to terminal clients and nothing else. Empty makes
 * `isLocalOnly` true for every flow, which is correct — with no browser there is no second
 * place a method could be served from, so shipping skills as files cannot produce the two
 * drifting copies this set exists to prevent. Keeping "librechat" here instead kept a flow
 * shippable to a client that does not exist. */
const SERVED_CLIENTS = [] as const as readonly string[];

/** Every client the platform can serve, packaged or served. A manifest naming anything else
 * is a typo refused at install time, because the alternative is a flow that silently never
 * appears. Derived, so it cannot fall behind either list it is made of. */
export const ALL_CLIENTS: string[] = [...SERVED_CLIENTS, ...CLIENT_KINDS];

/** Whether this flow, AS THIS TEAM RUNS IT, is local-only.
 *
 * The input is the team's effective client set — what they chose, bounded by what the flow
 * can do — not what the flow is capable of. A flow may well support the browser and simply
 * not be wanted there; installed on the terminal alone, it is local-only for that team.
 *
 * Why the rule exists: a browser has no local disk, so a flow being run there can only be
 * served its method from the platform. If the same flow ALSO shipped its skills as files to
 * that team's terminals, the browser user and the terminal user would be running two copies
 * of one method, and copies drift — we spent a day deleting the ones that already had.
 *
 * So: browser in the mix → pointers everywhere. Terminals only → the method travels whole,
 * which is what makes it a native skill there, matched by description, with its worker
 * prompts and templates as files beside it. */
export const isLocalOnly = (f: InstalledFlow): boolean =>
  f.clients.length > 0 && !f.clients.some((c) => (SERVED_CLIENTS as readonly string[]).includes(c));

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

/** Every file under a flow's skills/ directory, as package files rooted at `prefix`. */
function residentSkills(flow: string, prefix: string): PackageFile[] {
  const e = catalogEntry(flow, true);
  if (!e) return [];
  const root = join(e.dir, "skills");
  if (!existsSync(root)) return [];
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
  kind: ClientKind;
  /** Directory the person unpacks into, e.g. ~/.zz */
  home: string;
  /** Top-level directory inside the archive. Empty means the files land
   * directly in `home` — which is what Hermes needs, since its skills and
   * config already live at fixed paths under ~/.hermes. */
  archivePrefix: string;
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
  kind: ClientKind;
  base: string;
  flows: InstalledFlow[];
}

export function buildClientPackage({ target, kind, base, flows }: PackageInput): ClientPackage {
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
      name: "zz",
      description: `ZZ platform baseline for ${target} — identity, your team's documents and knowledge, the gates, and where each piece of work stands. Required by everything else.`,
      servers: [core],
      required: true,
      // The one plugin whose content is generated rather than read: the router describes
      // THIS person's installed flows, so it cannot live in a catalog shared by everyone.
      // The hermes flavour differs only in frontmatter, and it is built HERE so there is one
      // router in the package. Pushing a second copy in the hermes branch put two entries at
      // the same tar path, and the one that won on extraction was the wrong one.
      // MCP *AND* SKILLS. This carried the router and nothing else, so the five
      // skills in `/skills` — the platform's own, zz-backbone among them, which
      // has been read 194 times through skill_view — shipped in no plugin at all.
      // They were reachable over MCP and installable by nobody. This is the one
      // plugin everybody must have, and what we are is our MCP and our method.
      files: [
        { path: "skills/zz-router/SKILL.md", content: routerSkill(flows, kind === "hermes") },
        ...platformOwnSkills("skills"),
      ],
    },
    ...platformPlugins().map((pp): Plugin => {
      const skills = residentSkills(pp.dir, "skills");
      const { commands, promoted } = promoteStandalone(pp.dir, skills, kind === "claude-code");
      return {
        name: pp.name,
        description: pp.description,
        servers: pp.servers.map((sv) => ({ name: sv.name, url: `${base}${sv.path}` })),
        // Assets beside a promoted skill still travel: only its SKILL.md moves.
        files: [...commands, ...skills.filter((sk) => !promoted.has(sk))],
      };
    }),
    ...flows.map((f): Plugin => {
      // A flow this team runs only on local runtimes travels whole; one they also run
      // in a browser stays pointer-based, so both places run the same method.
      const skills = isLocalOnly(f) ? residentSkills(f.flow, "skills") : [];
      const entry = skills.find((s) => s.path === `skills/${f.entry}/SKILL.md`);
      // Claude Code has commands and Codex does not, so a skill a person invokes ON PURPOSE
      // — the front door, and each standalone skill — becomes a command there and stays a
      // skill here. Either way it ships exactly once. Stage skills are never promoted: they
      // are reached through the flow, not typed.
      const useCommands = kind === "claude-code";
      const asCommand = useCommands && entry !== undefined;
      const { commands: standaloneCommands, promoted: standalonePromoted } =
        promoteStandalone(f.flow, skills, useCommands);
      const promoted = new Set<PackageFile>([
        ...(asCommand && entry ? [entry] : []),
        ...standalonePromoted,
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
          {
            path: `commands/${commandName(pluginName(f.flow), f.entry || f.flow)}.md`,
            content: commandFile(f, asCommand && entry ? withoutFrontmatter(entry.content) : undefined),
          },
          ...standaloneCommands,
          // Assets beside a promoted skill still travel: only its SKILL.md moves.
          ...skills.filter((sk) => !promoted.has(sk)),
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

  if (kind === "claude-code") {
    files.push({
      path: ".claude-plugin/marketplace.json",
      content: JSON.stringify({
        name: "zz-platform",
        owner: { name: "ZZ Stack" },
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
        content: JSON.stringify({ name: pl.name, description: pl.description, version }, null, 2) + "\n",
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
      kind, home: "~/.zz", archivePrefix: "zz-platform", files, flows, blocks, notes,
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
        `(umask 077; mkdir -p ~/.zz) && chmod 700 ~/.zz`,
        `(umask 077; printf '%s' "$ZZ_TOKEN" > ~/.zz/token) && chmod 600 ~/.zz/token`,
        `curl -fsSL -H "Authorization: Bearer $ZZ_TOKEN" ${base}/pkg/claude-code.tgz | tar xz -C ~/.zz`,
        `claude plugin marketplace add ~/.zz/zz-platform`,
        `claude plugin install zz@zz-platform     # the baseline — everything else needs it`,
        ``,
        `# Then take what you want, and nothing else. To see the shelf:`,
        `#   /plugins in Claude Code, then the Marketplaces tab, or`,
        // node, not python3. Anyone running Claude Code has node — it is what Claude Code
        // runs on — and may not have python3 at all. A one-liner in an install instruction
        // is only useful if it runs on the machine reading it.
        `#   claude plugin list --available --json | node -e '`,
        `#     let s="";process.stdin.on("data",d=>s+=d).on("end",()=>JSON.parse(s).available`,
        `#       .filter(p=>(p.pluginId||"").includes("zz-platform"))`,
        `#       .forEach(p=>console.log(p.name,"—",(p.description||"").slice(0,70))))'`,
        // COMMENTED, so this block stays a menu rather than a script that chooses for you.
        // These lines used to be live, directly under "take what you want, and nothing
        // else" — so anyone who pasted the block installed every optional plugin, which is
        // the exact thing the one-plugin-per-flow split exists to prevent. zz-admin came
        // with it, and a plugin that can create teams must not arrive by default.
        ``,
        `# Uncomment the ones you want:`,
        ...optional.map((n) => `# claude plugin install ${n}@zz-platform`),
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
      refresh: [
        `rm -rf ~/.zz/zz-platform`,
        `curl -fsSL -H "Authorization: Bearer $ZZ_TOKEN" ${base}/pkg/claude-code.tgz | tar xz -C ~/.zz`,
        `claude plugin marketplace update zz-platform`,
      ],
      // Every plugin, not just the baseline. This said `uninstall zz` alone, so a person
      // who followed it kept zz-access and every flow installed — pointing at a
      // marketplace that had just been removed and a ~/.zz that had just been deleted.
      // Optional ones first: the baseline is what they were installed on top of.
      remove: [
        ...optional.map((n) => `claude plugin uninstall ${n}`),
        `claude plugin uninstall zz`,
        `claude plugin marketplace remove zz-platform`,
        `rm -rf ~/.zz`,
      ],
    };
  }

  if (kind === "codex") {
    files.push({
      path: ".agents/plugins/marketplace.json",
      content: JSON.stringify({
        name: "zz-platform",
        interface: { displayName: "ZZ Stack" },
        plugins: plugins.map((pl) => ({
          name: pl.name,
          source: { source: "local", path: `./plugins/${pl.name}` },
          policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
          category: "Productivity",
        })),
      }, null, 2) + "\n",
    });
    for (const pl of plugins) {
      const D = `plugins/${pl.name}`;
      files.push({
        path: `${D}/.codex-plugin/plugin.json`,
        content: JSON.stringify({
          name: pl.name, version, description: pl.description,
          skills: "./skills/",
          ...(pl.servers.length ? { mcpServers: "./.mcp.json" } : {}),
          interface: {
            displayName: pl.name,
            shortDescription: trimTo(pl.description, 100),
            longDescription: pl.description,
            category: "Productivity",
          },
        }, null, 2) + "\n",
      });
      if (pl.servers.length) {
        files.push({
          path: `${D}/.mcp.json`,
          content: JSON.stringify({
            // NO `headers` HERE. Codex does not read them — verified on 2026-08-28, and the
            // note below says so in the person's own instructions: `codex mcp list` reports
            // Auth "Unsupported" and every call answers "the tool is not available in this
            // session". Writing `Authorization: Bearer ${ZZ_TOKEN}` into this file put a
            // credential line in front of anyone reading it that looked like the auth
            // mechanism and was inert. What the file IS good for is the server list, which
            // Codex does read; the token goes in through `codex mcp add`.
            mcpServers: Object.fromEntries(pl.servers.map((sv) => [sv.name, {
              type: "http", url: sv.url,
            }])),
          }, null, 2) + "\n",
        });
      }
      // Codex plugins carry no commands, so a flow reaches its user through skills alone.
      for (const f of pl.files.filter((x) => !x.path.startsWith("commands/"))) {
        files.push({ path: `${D}/${f.path}`, content: f.content, mode: f.mode });
      }
    }

    notes.push(
      "Codex plugins carry no commands, so a flow is reached through its skills — describe " +
        "the work and the matching skill loads, or use the plugin's suggested opening prompt.",
        // VERIFIED 2026-08-28, and the answer was no. Codex does not read the `headers` in a
        // plugin's .mcp.json at all — neither the ${ZZ_TOKEN} form nor a literal token pasted
        // in its place. `codex mcp list` shows the servers it found from the plugin with an
        // empty "Bearer Token Env Var" and Auth "Unsupported"; every call answers "the tool is
        // not available in this session", and nothing says why. They have to be registered
        // with Codex's own command, which is the only place it accepts a credential.
        "Codex does NOT read the headers in a plugin's .mcp.json. Register each server with " +
          "Codex's own command, which is where it takes a token — one line per server:\n" +
          "    codex mcp add <name> --url <url> --bearer-token-env-var ZZ_TOKEN\n" +
          "  then export ZZ_TOKEN before starting Codex. `codex mcp list` should show " +
          "\"Bearer token\" against each one; \"Unsupported\" means it is still reading the " +
          "plugin file, and no tool will be reachable.",
        "Two more refusals that read as platform problems and are not: `codex exec` must run " +
          "inside a git repository (or take --skip-git-repo-check), and it will not make a " +
          "tool call that requires approval unless the approval policy allows it.",
    );

    const optionalCx = plugins.filter((pl) => !pl.required).map((pl) => pl.name);
    return {
      kind, home: "~/.zz", archivePrefix: "zz-platform", files, flows, blocks, notes,
      install: [
        `(umask 077; mkdir -p ~/.zz) && chmod 700 ~/.zz`,
        `export ZZ_TOKEN=<your token>   # add to your shell profile`,
        `curl -fsSL -H "Authorization: Bearer $ZZ_TOKEN" ${base}/pkg/codex.tgz | tar xz -C ~/.zz`,
        `codex plugin marketplace add ~/.zz/zz-platform`,
        `codex plugin add zz@zz-platform          # the baseline — everything else needs it`,
        ``,
        `# Then take what you want. To see the shelf: codex plugin list`,
        // Commented for the same reason as the Claude Code block: this is pasted into a
        // shell, so a live line here chooses for the person.
        `# Uncomment the ones you want:`,
        ...optionalCx.map((n) => `# codex plugin add ${n}@zz-platform`),
      ],
      // Onto nothing, for the reason spelled out over the Claude Code refresh above: an
      // extract never retires a plugin the platform has withdrawn. ~/.zz/token is a sibling.
      refresh: [
        `rm -rf ~/.zz/zz-platform`,
        `curl -fsSL -H "Authorization: Bearer $ZZ_TOKEN" ${base}/pkg/codex.tgz | tar xz -C ~/.zz`,
        `codex plugin marketplace upgrade zz-platform`,
      ],
      remove: [
        ...optionalCx.map((n) => `codex plugin remove ${n}`),
        `codex plugin remove zz`,
        `codex plugin marketplace remove zz-platform`,
        `rm -rf ~/.zz`,
      ],
    };
  }

  // hermes — no marketplace, no commands: files are placed and config merged.
  //
  // Its server list is DERIVED from the same shelf every other client gets, rather than
  // assembled separately. It used to be its own array of zz-core + zz-admin + blocks,
  // which quietly gave hermes users a different platform: the admin door always, even though
  // the shelf marks it as something most people never need, and no /manage/mcp at all —
  // the one endpoint where a person issues their own token and stores a block credential.
  const hermesServers = [...new Map(
    plugins.flatMap((pl) => pl.servers).map((sv) => [sv.name, sv]),
  ).values()].sort((a, b) => a.name.localeCompare(b.name));

  // The shelf's skills, the router among them. Only the SERVER list was derived from the shelf;
  // every plugin's files were built and then dropped, so a Hermes package was two files
  // against claude-code's forty — no zz-access, no zz-journal, no zz-okr, and no method for
  // a flow this team runs on terminals alone. The router pointed at skill_view() and the
  // platform answered, so nothing ever failed loudly; the person simply had less.
  //
  // Under skills/zz/, which is the directory `remove` below already deletes. Commands are
  // skipped for the reason they are skipped for Codex: neither runtime has any.
  for (const pl of plugins) {
    for (const f of pl.files) {
      if (f.path.startsWith("commands/")) continue;
      files.push({ path: `skills/zz/${f.path.replace(/^skills\//, "")}`, content: f.content, mode: f.mode });
    }
  }
  files.push({
    path: "mcp_servers.yaml",
    content:
      // The shelf version, because this is the only file in the Hermes package that can
      // carry it. Claude Code and Codex both get it in a plugin.json; Hermes has no such
      // file, and the router cannot hold it — the digest is computed FROM the router's own
      // text, so a version inside it would have to include itself. Without this line a
      // Hermes user could re-run the install and have no way to tell whether anything on
      // their shelf had changed, which is the one question re-running is meant to answer.
      `# zz-stack ${version}\n` +
      "# Merge these under the top-level `mcp_servers:` key of ~/.hermes/config.yaml.\n" +
      "# Replace <YOUR-TOKEN>; Hermes reads this file directly, so keep it out of any repo.\n" +
      "mcp_servers:\n" +
      hermesServers.map((s) => [
        `  ${s.name}:`,
        // Quoted by JSON.stringify, like every other generated scalar here. The URL is built
        // from GATEWAY_PUBLIC_URL, which an operator sets — and hand-quoting a value somebody
        // else supplies is a decision made by hoping.
        `    url: ${JSON.stringify(s.url)}`,
        `    headers:`,
        `      Authorization: "Bearer <YOUR-TOKEN>"`,
        `    timeout: 180`,
      ].join("\n")).join("\n") + "\n",
  });

  notes.push(
    "Hermes has no plugin or marketplace, so this is a file placement rather than an install.",
    "SOUL.md is NOT touched: your agent's own behaviour is unchanged outside the flow.",
    "There is no uninstall command — removal is deleting the skill directory and the config " +
      "block. This is the one client where clean removal cannot be promised.",
  );

  return {
    kind, home: "~/.hermes", archivePrefix: "", files, flows, blocks, notes,
    install: [
      `curl -fsSL -H "Authorization: Bearer $ZZ_TOKEN" ${base}/pkg/hermes.tgz | tar xz -C ~/.hermes`,
      `# then merge ~/.hermes/mcp_servers.yaml into ~/.hermes/config.yaml`,
    ],
    // The hermes archive has no prefix of its own — it lands directly in ~/.hermes beside
    // config.yaml — so the only thing that can safely be cleared first is the skills tree it
    // owns. mcp_servers.yaml is overwritten by the extract either way.
    refresh: [
      `rm -rf ~/.hermes/skills/zz`,
      `curl -fsSL -H "Authorization: Bearer $ZZ_TOKEN" ${base}/pkg/hermes.tgz | tar xz -C ~/.hermes`,
    ],
    remove: [`rm -rf ~/.hermes/skills/zz ~/.hermes/mcp_servers.yaml`, `# remove the zz entries from config.yaml`],
  };
}


/* ── delivery ────────────────────────────────────────────────────── */


