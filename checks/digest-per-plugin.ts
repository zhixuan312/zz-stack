// digestOfPlugin: stable, sensitive to every content field, blind to the server URL, and a
// different identity from the shelf-wide digestOf.
//
// The two answer different questions and must not be collapsed. digestOf says "what did THIS
// PERSON receive" -- the URL is part of that, and it is the runtime's per-person cache key.
// digestOfPlugin says "what IS this plugin" -- a content identity, which two deployments
// running byte-identical code have to agree on.
import { digestOf, digestOfPlugin } from "../services/gateway/dist/package/describe.js";

// SYNTHETIC: these two paths are fields of an in-memory package, never opened — the digest is
// computed over the object. `skill-renames.ts` asserts that every skills/<name>/SKILL.md
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

// The shelf digest KEEPS the URL, and stays order-insensitive.
const withUrl = base(), otherUrl = base();
otherUrl.servers = [{ name: "zz-core", url: "https://another-host.example/core/mcp" }];
if (digestOf([withUrl]) === digestOf([otherUrl])) {
  fail("the shelf digest ignored the server URL — it is a per-person cache key and the URL " +
       "is part of what that person received");
}
const a = base(), b = { ...base(), name: "other" };
if (digestOf([a, b]) !== digestOf([b, a])) fail("digestOf is order-sensitive");
if (digestOf([base()]) === digestOfPlugin(base())) {
  fail("the shelf digest of one plugin equals that plugin's own digest — two identities " +
       "collapsed into one");
}
console.log("PASS");
