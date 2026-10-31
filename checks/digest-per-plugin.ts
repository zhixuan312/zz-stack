// digestOfPlugin: stable, sensitive to every content field, blind to the server URL. digestOf:
// the same plugin as a person received it, URL included, and each plugin's own — so the version a
// plugin ships under moves only when that plugin does.
//
// DELIBERATE: they are different identities and the two must not be collapsed. digestOf answers
// "what did this person receive of this plugin", so the URL is part of it and it serves as the
// runtime's cache key. digestOfPlugin answers "what is this plugin" — a content identity two
// deployments running byte-identical code have to agree on.
import { readdirSync, readFileSync } from "node:fs";
import { digestOf, digestOfPlugin } from "../services/gateway/dist/package/describe.js";

// SYNTHETIC: these two paths are fields of an in-memory package, never opened — the digest is
// computed over the object. `skill-paths.ts` asserts that every skills/<name>/SKILL.md
// literal in a script resolves on disk, and these are the exception it makes you declare.
interface Plugin {
  name: string; description: string; required: boolean;
  servers: { name: string; url: string }[];
  files: { path: string; content: string }[];
}
const base = (): Plugin => ({
  name: "demo", description: "a demo plugin", required: false,
  servers: [{ name: "zz-core", url: "http://x/core/mcp" }],
  files: [{ path: "skills/a/SKILL.md", content: "hello" }],   // SYNTHETIC:
});
const fail = (m: string): never => { console.error("FAIL: " + m); process.exit(1); };

const d0 = digestOfPlugin(base());
if (!/^[0-9a-f]{8}$/.test(d0)) fail(`not an 8-hex digest: ${d0}`);
if (digestOfPlugin(base()) !== d0) fail("not stable across two identical inputs");

const mutations: [string, (p: Plugin) => void][] = [
  ["name",         (p) => { p.name = "demo2"; }],
  ["description",  (p) => { p.description += "!"; }],
  ["required",     (p) => { p.required = true; }],
  ["server name",  (p) => { p.servers[0].name = "other"; }],
  ["file path",    (p) => { p.files[0].path = "skills/b/SKILL.md"; }],   // SYNTHETIC:
  ["file content", (p) => { p.files[0].content = "goodbye"; }],
];
for (const [what, mutate] of mutations) {
  const p = base(); mutate(p);
  if (digestOfPlugin(p) === d0) fail(`digest did not move when ${what} changed`);
}

// The deployment's own address is not content.
const elsewhere = base();
elsewhere.servers[0].url = "https://another-host.example/core/mcp";
if (digestOfPlugin(elsewhere) !== d0) {
  fail("the per-plugin digest moved when only the server URL changed — it is a content " +
       "identity and the deployment base is not content");
}

// The received digest KEEPS the URL.
const withUrl = base(), otherUrl = base();
otherUrl.servers = [{ name: "zz-core", url: "https://another-host.example/core/mcp" }];
if (digestOf(withUrl) === digestOf(otherUrl)) {
  fail("the received digest ignored the server URL — it is the runtime's cache key and the URL " +
       "is part of what that person received");
}
if (digestOf(base()) === digestOfPlugin(base())) {
  fail("a plugin's received digest equals its own content digest — two identities collapsed into one");
}

// The committed shelf: every plugin ships under its own suffix, so a change to one plugin does
// not re-version the others.
const suffixes = new Map<string, string>();
for (const name of readdirSync("marketplace")) {
  let manifest: { version?: string };
  try {
    manifest = JSON.parse(readFileSync(`marketplace/${name}/.claude-plugin/plugin.json`, "utf8"));
  } catch { continue; }
  suffixes.set(name, String(manifest.version).split("+")[1] ?? "");
}
if (suffixes.size > 1 && new Set(suffixes.values()).size === 1) {
  fail(`every plugin on the committed shelf ships under one suffix (${[...suffixes.values()][0]}), ` +
       "so a change to any plugin re-versions all of them");
}
console.log("PASS");
