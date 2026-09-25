/** The catalog, read in one place: the manifest, a description, the commands map, the skills,
 * the entry skill's when_to_use, the platform entries, the installable list.
 *
 * COUPLED: the manifest shape is @zz/contracts' schema, not an interface declared here.
 */
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync, statSync } from "node:fs";
import { BlockList, isIP } from "node:net";
import { basename, dirname, join } from "node:path";

/** Where the shelf lives. `/catalog` in the image, which is where it ships.
 *
 * Overridable so a checkout can point at its own catalog/ directory: everything under
 * buildClientPackage reads the catalog through this constant, and without the override nothing
 * outside a container could build a package to look at.
 *
 * DELIBERATE: not a toggle and not a fallback — the default is the real path. */
export const CATALOG_DIR = process.env.ZZ_CATALOG_DIR || "/catalog";

/* The manifest's shape lives in @zz/contracts, as a schema rather than an interface: a schema
 * can say no to a manifest, and is published so somebody writing one can read the rules before
 * the write is refused.
 *
 * DELIBERATE: not re-exported from here. Both services already depend on @zz/contracts
 * directly, and a second module path to one definition is what this package exists to remove. */
import {
  addressResolver, CatalogManifest as CatalogManifestSchema, type CatalogManifest, type FlowDoc, whyNot,
} from "@zz/contracts";

interface CatalogEntry {
  owner: string;
  flow: string;
  dir: string;
  manifest: CatalogManifest;
}

/**
 * One flow.json, read and validated, or a sentence saying why not.
 *
 * Returns rather than throws: this package walks the whole catalog and must skip a broken flow
 * rather than take the build down, while manifest-audit and chain-check are given one file and
 * must stop with a sentence rather than a ZodError dump.
 *
 * Validation is not optional. An unchecked `as CatalogManifest` lets `gate: "true"` or a
 * misspelled `documents` key produce a chain that is wrong rather than absent, and a wrong chain
 * refuses writes at the stage that depends on them, far from the typo.
 */
export function manifestAt(file: string): { manifest: CatalogManifest; why: null }
  | { manifest: null; why: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    return { manifest: null, why: `could not be read as JSON — ${(err as Error).message}` };
  }
  const parsed = CatalogManifestSchema.safeParse(raw);
  if (parsed.success) {
    // The one law the schema cannot state, checked here because this is the only reader that
    // validates: a manifest declaring `documents` must declare `stages`, since `stages` is what
    // produces a document. The converse is legal — `stages` alone is an ordinary non-flow
    // package, and so is declaring neither, which is what zz-access is.
    //
    // DELIBERATE: zod cannot carry this. A `.superRefine()` turns `.shape`, `_def.unknownKeys`
    // and jsonSchema() into undefined, and the gate reads all three off CatalogManifest.
    const m = parsed.data;
    if (isFlow(m) && !(m.stages?.length ?? 0)) {
      return {
        manifest: null,
        why: "declares documents and no `stages` — a document has to be produced by " +
             "something, and `stages` is what produces it. Add the stage that writes each " +
             "document, naming it in that document's `stage`",
      };
    }
    return { manifest: m, why: null };
  }
  // The schema is strict, so the commonest failure is one mistyped key. safeParse gives the
  // issues without throwing, so the line says which field, at which path.
  return {
    manifest: null,
    why: `is not a valid manifest — ${whyNot(parsed.error)}`,
  };
}

/** A package on the shelf: `<owner>/<name>`, whether or not it ships a manifest. Not exported —
 * every caller destructures it. */
interface CatalogPackage {
  owner: string;
  name: string;
  dir: string;
}

/**
 * Every package the catalog holds, owner-then-name ordered.
 *
 * Sorted rather than left in filesystem order: skill_read returns the first match, so directory
 * order would decide which of two packages answers and would differ between two containers of
 * one image. The shelf's digest is keyed to this order too.
 *
 * DELIBERATE: the per-level try/catch is the point. A single try around the whole walk lets a
 * file where an owner directory was expected throw ENOTDIR and return whatever had accumulated;
 * a stray `.DS_Store` sorts first, so the answer is the empty list and every skill vanishes.
 *
 * Every package, including one with no flow.json — skill_read serves those. catalogEntries() is
 * the narrower question.
 */
export function catalogPackages(): readonly CatalogPackage[] {
  const out: CatalogPackage[] = [];
  let owners: string[];
  try {
    owners = readdirSync(CATALOG_DIR).sort();
  } catch { return out; }          // no catalog mounted (local dev)
  for (const owner of owners) {
    let names: string[];
    try {
      names = readdirSync(join(CATALOG_DIR, owner)).sort();
    } catch { continue; }          // a file where an owner directory was expected
    for (const name of names) out.push({ owner, name, dir: join(CATALOG_DIR, owner, name) });
  }
  return out;
}

/** Every catalog entry that has a manifest we can read, owner-then-name ordered.
 *
 * An unparseable manifest is skipped, not thrown: one broken flow must not take down the
 * package build for every person on the platform. */
export function catalogEntries(): CatalogEntry[] {
  const out: CatalogEntry[] = [];
  for (const { owner, name: flow, dir } of catalogPackages()) {
    const f = join(dir, "flow.json");
    if (!existsSync(f)) continue;
    const got = manifestAt(f);
    if (got.manifest) { out.push({ owner, flow, dir, manifest: got.manifest }); continue; }
    // Skipped, but never silently. A catalog edited on a running host — the build override
    // mounts the working tree over the image's copy — loses the flow from the shelf, from
    // catalog_list and from every gate it governs, and this line is the only symptom.
    console.error(`catalog: ${owner}/${flow}/flow.json ${got.why}, skipping`);
  }
  return out;
}

/** One entry by flow name, or null.
 *
 * DELIBERATE: `includePlatform` is off by default, and that default is the guard. Filtering
 * where a thing is looked up rather than where it is listed is what makes it a guard: a filter
 * on the listing alone leaves every direct lookup able to reach the entry. Callers that want a
 * platform entry — the package builder — ask for it. */
export function catalogEntry(flow: string, includePlatform = false): CatalogEntry | null {
  for (const e of catalogEntries()) {
    if (e.flow !== flow) continue;
    // Not installable — a question about ownership rather than shape. Shape is `documents`; see
    // isFlow and CatalogManifest.shelved.
    if (e.manifest.shelved && !includePlatform) return null;
    return e;
  }
  return null;
}

/** Just the manifest, for the many callers that want one field out of it. */
export function catalogManifest(flow: string, includePlatform = false): CatalogManifest | null {
  return catalogEntry(flow, includePlatform)?.manifest ?? null;
}

/** Is this package a flow? It is, if and only if it declares at least one document.
 *
 * The one classifier, so "what is this package" has one answer and no caller reconstructs it.
 * `documents` discriminates because a flow is a discipline over documents: gates, order, a
 * closing document, a chain that refuses a write. A stage count does not. `stages` keeps its
 * other jobs — `produces` hangs off it and the console's stepper walks it.
 *
 * A flow must still declare stages, and manifestAt refuses one that does not. A package with
 * stages and no documents is legal, which is what `zz-access` is.
 *
 * DELIBERATE: a type predicate, not a plain boolean, so callers can read `documents` without
 * each rewriting the same `(m.documents?.length ?? 0) > 0` to narrow it. */
export function isFlow(manifest: CatalogManifest): manifest is CatalogManifest & { documents: FlowDoc[] } {
  return (manifest.documents?.length ?? 0) > 0;
}

/** A flow's documents as the platform enforces them: what the manifest declares, plus the
 * handover every gating flow owes.
 *
 * Derived, never configured, so a flow written next week inherits it. Derived here rather than
 * in zz-core because two readers need the same answer: zz-core resolves the chain it gates
 * writes against, and the console draws the stepper, counts the gates and decides whether an
 * initiative is complete.
 *
 * Idempotent: a manifest that declares its own handover is left exactly as it is.
 *
 * DELIBERATE: gated so somebody signs it, but never `closing` or `requiredForClose`. The flow's
 * own closing document still closes the flow, which is what lets the handover be written after
 * the close. */
export function withHandover(documents: readonly FlowDoc[]): FlowDoc[] {
  const list = [...documents];
  if (!list.some((d) => d.gate) || list.some((d) => d.name === "handover.md")) return list;
  return [
    ...list,
    {
      name: "handover.md",
      role: "handover",
      stage: "zz-handover",
      gate: true,
      requires: list.find((d) => d.closing)?.name ?? list[list.length - 1]?.name ?? "",
      sections: ["What this initiative taught", "Recorded for the platform", "Proposed for the team"],
    },
  ];
}

/** Which plugin serves a door, from the only place that states it.
 *
 * A door is a plugin's declared server — its `servers[].path` — so which plugin a call belongs to
 * is a fact about the door the call arrived on: the same for every caller, and knowable before
 * the call is answered. It does not depend on who called, what they had loaded, or when.
 *
 * DELIBERATE: not `DOORS[].name` in the gateway, which looks like the same answer. That map's
 * `name` is prose for a person reading the door index, not an identifier anything resolves.
 *
 * Takes the surface as the telemetry spells it (`core`, `eval`, `manage`) or a full path. Unknown
 * comes back null and is written as null: never guessed at. */
export function pluginForDoor(surface: string): string | null {
  if (!surface) return null;
  const path = surface.startsWith("/") ? surface : `/${surface}/mcp`;
  for (const entry of catalogEntries()) {
    for (const server of entry.manifest.servers ?? []) {
      if (server.path === path) return entry.flow;
    }
  }
  return null;
}

/** The optional plugins on the shelf. Not every catalog entry: the platform's own required
 * plugins live here too, so their description and skills have one home, but they ship as
 * required plugins and must not be packaged a second time as optional ones. */
export function installableFlows(): string[] {
  return catalogEntries()
    .filter((e) => !e.manifest.shelved)
    .map((e) => `${e.owner}/${e.flow}`);
}

/** Every catalog package that can govern an initiative: the ones that declare documents.
 *
 * `isFlow` is the test, so there is one answer to "is this a flow". Ownership does not enter into
 * it: an initiative may be governed by any flow the catalog has, because the platform keeps no
 * record of which ones a team installed. */
export function governingFlows(): string[] {
  return catalogEntries()
    .filter((e) => isFlow(e.manifest))
    .map((e) => e.flow);
}


/** A skill's raw markdown, or null when the flow does not ship that skill. */
export function skillText(flow: string, skill: string): string | null {
  const e = catalogEntry(flow, true);
  if (!e) return null;
  const p = join(e.dir, "skills", skill, "SKILL.md");
  return existsSync(p) ? readFileSync(p, "utf8") : null;
}

/** What a flow is called as a plugin: the trailing `-flow` is dropped.
 *
 * A command is `/<plugin>:<file>`, so the two names are typed together every time, and
 * `sdlc-flow` with skill `sdlc-deck` would give `/sdlc-flow:sdlc-deck`.
 *
 * COUPLED: one rule for every reader — the packager names the plugin with it, the release
 * registers it under it, and a `flow:` subject tag resolves to the release through it.
 *
 * The command half of the name is declared, not derived: see `declaredCommands` in the gateway's
 * packager. */
export function pluginName(flow: string): string {
  return flow.endsWith("-flow") ? flow.slice(0, -"-flow".length) : flow;
}

/** One entry of a plugin's component manifest. `kind: "config"` is part of the declared shape for
 *  a component this catalog schema does not carry yet (deploy/environment declarations, say) —
 *  none is emitted today because nothing in `CatalogManifest` represents one. */
export interface PluginComponent {
  readonly kind: "skill" | "server" | "flow" | "config";
  readonly name: string;
  readonly digest: string;
}

export const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

/** The refusal for a path that is a symlink, or null — `lstat`, so the link itself is judged and
 *  never where it points. A path that does not exist is not this question's business.
 *
 *  Exported for zz-core's package reader, which asks it of the tarball's `package/` directory
 *  before handing that directory here. */
export function symlinkRefusal(path: string): { error: string } | null {
  let linked: boolean;
  try {
    linked = lstatSync(path).isSymbolicLink();
  } catch {
    return null;
  }
  return linked
    ? { error: `${basename(path)} is a symlink; a source's skills and flow.json are read only as real files and directories` }
    : null;
}

/** The components of a plugin directory, read straight off disk: every SKILL.md under its
 *  `skills/` subdirectory (the catalog's own convention) or under the directory itself when it
 *  has none, plus whatever `flow.json` beside it declares — never through zz.skill_version, which
 *  a third party never has a row in.
 *
 *  COUPLED: the one walk behind both `plugin_register` (zz-core, subject-source.ts) and the replay
 *  launcher (packages/tools), so a subject's recorded digest and the digest a replay checks out
 *  against are computed by the same code, and a symlink refused by one is refused by both.
 *
 *  An empty `components` is a directory with nothing to capture; each caller words that refusal
 *  for its own source kind.
 *
 *  DELIBERATE: a top-level `skills` or `flow.json` that is a symlink is refused, not followed and
 *  not skipped. The walk never follows a link it meets, but these two are opened by name, and
 *  `readdirSync`/`readFileSync` follow a link they are handed — a cloned repository or an
 *  extracted tarball carrying `skills -> /` would walk the host's filesystem. Refused rather than
 *  skipped so the caller learns why a source they can see holds skills read as holding none. */
export function pluginDirComponents(dir: string): { components: PluginComponent[] } | { error: string } {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return { error: `${dir} is not a directory` };
  const linked = symlinkRefusal(join(dir, "skills")) ?? symlinkRefusal(join(dir, "flow.json"));
  if (linked) return linked;
  const skillsDir = existsSync(join(dir, "skills")) ? join(dir, "skills") : dir;
  const components: PluginComponent[] = [];
  const walk = (d: string): void => {
    for (const f of readdirSync(d, { withFileTypes: true })) {
      // Never followed: a symlink inside the directory could otherwise read any file on the host.
      if (f.isSymbolicLink()) continue;
      const abs = join(d, f.name);
      if (f.isDirectory()) { walk(abs); continue; }
      if (f.name !== "SKILL.md") continue;
      // The digest is the file's own bytes, not a database row: a third party carries no
      // zz.skill_version, so there is no content_hash column to defer to.
      components.push({ kind: "skill", name: basename(dirname(abs)), digest: sha256(readFileSync(abs, "utf8")) });
    }
  };
  if (existsSync(skillsDir)) walk(skillsDir);

  const flowFile = join(dir, "flow.json");
  if (existsSync(flowFile)) {
    const got = manifestAt(flowFile);
    if (got.manifest) {
      for (const sv of got.manifest.servers ?? []) {
        components.push({ kind: "server", name: sv.name, digest: sha256(`${sv.name}:${sv.path}`) });
      }
      components.push({
        kind: "flow", name: got.manifest.name ?? basename(dir),
        digest: sha256(JSON.stringify(got.manifest)),
      });
    }
  }
  return { components };
}

/** The whole-plugin digest: sha256 over the SORTED per-component digests, never over an order a
 *  walk or a query happened to return them in — two captures of the same release must agree on
 *  this digest however their components came back. */
export function pluginContentDigest(components: readonly PluginComponent[]): string {
  return sha256([...components.map((c) => c.digest)].sort().join("\n"));
}

/** Every file a plugin directory ships, digested — hooks, commands, agents, `.mcp.json`, server
 *  code, everything `pluginDirComponents` does not look at. `pluginContentDigest` covers only the
 *  skills and the manifest, so a source whose hooks changed would still match it; this is what a
 *  replay compares to know it installs the bytes `plugin_register` saw.
 *
 *  sha256 over the sorted `<relative path>\0<sha256 of the bytes>` lines of every regular file.
 *  Content only, never modes or timestamps, which a copy or an extraction does not keep the same.
 *  A `.git` entry at any depth is skipped: it is a clone's own metadata, never plugin content (the
 *  launcher refuses a fetched tree carrying one before it digests anything).
 *
 *  COUPLED: `plugin_register` (zz-core, subject-source.ts) records this as
 *  `release_identity.tree_digest`, and the replay launcher (packages/tools, third-party.ts)
 *  recomputes it over what it fetched.
 *
 *  DELIBERATE: a symlink, a FIFO, a socket or a device anywhere is refused, never followed and
 *  never skipped — a skipped link is content the digest silently does not cover, and a followed
 *  one reads outside the directory.
 *
 *  `unshipped` names entries left out at any depth, for a catalog directory the platform reads
 *  from its image (`IMAGE_UNSHIPPED`). */
export function pluginTreeDigest(dir: string, unshipped?: string): { digest: string } | { error: string } {
  if (!existsSync(dir) || !lstatSync(dir).isDirectory()) return { error: `${dir} is not a directory` };
  const lines: string[] = [];
  const walk = (d: string, rel: string): string | null => {
    for (const f of readdirSync(d, { withFileTypes: true })) {
      if (f.name === ".git" || f.name === unshipped) continue;
      const path = rel ? `${rel}/${f.name}` : f.name;
      if (f.isSymbolicLink()) return `${path} is a symlink; a plugin's files are read only as real files and directories`;
      if (f.isDirectory()) {
        const bad = walk(join(d, f.name), path);
        if (bad) return bad;
        continue;
      }
      if (!f.isFile()) return `${path} is not a regular file`;
      lines.push(`${path}\0${createHash("sha256").update(readFileSync(join(d, f.name))).digest("hex")}`);
    }
    return null;
  };
  const bad = walk(dir, "");
  if (bad) return { error: bad };
  return { digest: sha256(lines.sort().join("\n")) };
}

/** What `COPY catalog /catalog` leaves out of the image, at any depth under the catalog: a flow's
 *  `tests` fixtures. A `local_dir` subject's `tree_digest` is over the files the platform can see,
 *  so it is taken without them on every host — the image, a checkout (`ZZ_CATALOG_DIR`) and the
 *  replay launcher's copy — or the three would never agree on a plugin that has tests.
 *
 *  COUPLED: the `.dockerignore` line that excludes `tests` anywhere under `catalog/`, which
 *  `scripts/gate/checks/image.ts` requires. */
export const IMAGE_UNSHIPPED = "tests";

/** A `.gitattributes` line that sets, unsets or defines a macro over the `filter` attribute. */
const FILTER_ATTRIBUTE = /(^|\s)[-!]?filter(=|\s|$)/m;

/** The first entry under `dir` git would take as an instruction rather than content, named, or
 *  null: a `.git` of any kind at any depth (a repository whose `config` names a filter driver, an
 *  fsmonitor or a hooks path), or a `.gitattributes` that assigns a filter — git-lfs's
 *  `filter=lfs` included. Names compared case-folded: a case-insensitive filesystem opens `.GIT`
 *  for `.git`. Symlinks are not followed; `pluginTreeDigest` refuses them.
 *
 *  COUPLED: the one rule behind both `plugin_register` (zz-core, subject-source.ts), which refuses
 *  such a source at registration, and the replay launcher (packages/tools, third-party.ts), which
 *  refuses such a fetched tree before any git command reads it — so nothing registers that the
 *  launcher would always refuse. `ownGit` passes over `dir`'s own top-level `.git`: a clone
 *  `plugin_register` just made, whose metadata is git's own, not the source's. */
export function gitInstruction(dir: string, opts: { ownGit?: boolean } = {}, rel = ""): string | null {
  for (const f of readdirSync(dir, { withFileTypes: true })) {
    const path = rel ? `${rel}/${f.name}` : f.name;
    const name = f.name.toLowerCase();
    if (name === ".git") {
      if (opts.ownGit && !rel && f.name === ".git") continue;
      return `${path} is git metadata`;
    }
    if (name === ".gitattributes" && f.isFile() && FILTER_ATTRIBUTE.test(readFileSync(join(dir, f.name), "utf8"))) {
      return `${path} assigns a git filter`;
    }
    if (f.isDirectory()) {
      const bad = gitInstruction(join(dir, f.name), {}, path);
      if (bad) return bad;
    }
  }
  return null;
}

// -------------------------------------------------------------------------------------------
// A git source's host. Here rather than in either reader because two of them fetch a caller's
// URL: `plugin_register` on the platform host, and the replay launcher on the operator's.

/** Addresses a git fetch must never reach: loopback, private, carrier-grade NAT, link-local
 *  (cloud metadata lives there), benchmark, multicast and reserved space, in both families. An
 *  IPv4-mapped address arrives here already folded to its IPv4 spelling (`addressResolver`), so
 *  the IPv4 rules answer for it. */
const BLOCKED = new BlockList();
for (const [net, bits] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
  ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["224.0.0.0", 3],
] as const) BLOCKED.addSubnet(net, bits, "ipv4");
for (const [net, bits] of [
  ["::", 127], ["64:ff9b::", 96], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8],
] as const) BLOCKED.addSubnet(net, bits, "ipv6");

/** A git URL, refused unless it is https to a host that resolves only to public addresses.
 *  Every address the name resolves to is checked, not the first: a resolver that answers one
 *  public and one internal address would otherwise pass half the time.
 *
 *  COUPLED: resolved through `addressResolver` (@zz/contracts), the platform's one resolver and
 *  one IPv4-mapped fold. An address that is still not a valid IP after the fold (a mapped address
 *  in hex spelling) is refused rather than guessed at.
 *
 *  RETURNS the `http.curloptResolve` entry that pins git to exactly the addresses checked here.
 *  Without it git resolves the name a second time, and a rebinding host answers that second
 *  lookup with an internal address after passing this one with a public address. An IP-literal
 *  host needs no pin: nothing is resolved. */
export async function publicHttpsUrl(url: string): Promise<{ error: string } | { pin: string[] }> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { error: "the repository is not a URL; only https:// repositories are read" };
  }
  if (parsed.protocol !== "https:") return { error: `only https:// repositories are read, not ${parsed.protocol}` };
  const host = parsed.hostname.replace(/^\[|\]$/g, "");
  const addresses = await addressResolver([host], 0)();
  if (!addresses) return { error: `the host ${host} does not resolve` };
  const internal = [...addresses].some((a) =>
    isIP(a) === 0 || BLOCKED.check(a, isIP(a) === 6 ? "ipv6" : "ipv4"));
  if (internal) {
    return { error: `the host ${host} resolves to a private, loopback or link-local address; only public hosts are read` };
  }
  if (isIP(host) !== 0) return { pin: [] };
  // curl's CURLOPT_RESOLVE shape, `HOST:PORT:ADDR[,ADDR]`, an IPv6 address bracketed. Every
  // checked address is listed, so git may still fail over between them, and only between them.
  const port = parsed.port || "443";
  const list = [...addresses].map((a) => (isIP(a) === 6 ? `[${a}]` : a)).join(",");
  return { pin: ["-c", `http.curloptResolve=${host}:${port}:${list}`] };
}
