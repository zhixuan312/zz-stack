#!/usr/bin/env node
// Candidate build isolation: a sandboxed build command must not read the CLI's own process. Under
// bwrap, a command sharing the CLI's PID namespace could read `/proc/<cli pid>/environ` — same uid
// — and every token in it; every bwrap command starts in fresh namespaces with only the network
// shared back (on values everywhere, live on Linux with a working bwrap). Under Seatbelt, the
// profile denies process-info on anything outside the sandbox (live on macOS: the CLI's path is
// readable unsandboxed and refused inside, its environment unreadable inside, and the command's
// own children still visible).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { spawn, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const load = (p: string) => import(pathToFileURL(join(process.cwd(), p)).href);
const sandbox = await load("packages/tools/dist/candidate/sandbox.js");
const { detectSandbox } = sandbox;

const spec = { denyRead: [], allowRead: [], writable: ["/tmp/h"] };
const bw: string[] = sandbox.bwrapArgs(spec, "/tmp/h");
assert.deepEqual([...sandbox.BWRAP_NAMESPACES], ["--unshare-all", "--share-net", "--die-with-parent"]);
assert.ok(bw.includes("--unshare-all"), "every namespace is fresh — the PID one included");
assert.ok(bw.includes("--share-net"), "only the network is shared back: npm ci needs its registry");
assert.ok(!bw.includes("--share-pid") && !bw.includes("--unshare-net"));
assert.ok(bw.indexOf("--unshare-all") < bw.indexOf("--proc"), "the fresh /proc is mounted inside the fresh PID namespace");
assert.deepEqual(bw.slice(bw.indexOf("--proc"), bw.indexOf("--proc") + 2), ["--proc", "/proc"]);

if (process.platform !== "linux" || detectSandbox() !== "bwrap") {
  console.log(`  (live half not run: needs Linux with a working bwrap; this is ${process.platform})`);
} else {
  const c = sandbox.sandboxedCommand("bwrap", { denyRead: [], allowRead: [], writable: [tmpdir()] },
    "/bin/sh", ["-c", `test -e /proc/${process.pid} && echo visible || echo hidden`], tmpdir());
  const seen = execFileSync(c.file, c.argv, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  assert.equal(seen, "hidden", "the CLI's own pid is not in the build's /proc");
}

// ---- Seatbelt, on values: process-info denied, then re-allowed only within the sandbox.
const profile: string = sandbox.seatbeltProfile(spec);
assert.ok(profile.indexOf("(deny process-info*)") > profile.indexOf("(allow default)") &&
  profile.indexOf("(allow process-info* (target same-sandbox))") > profile.indexOf("(deny process-info*)"),
  "process-info is denied after allow default, and only the sandbox's own processes come back");

// ---- Seatbelt, live: a stand-in CLI process holding a marker in its environment. python3's ctypes
// is the probe (node has no sysctl/proc_pidpath), so a host without python3 skips this half.
const PROBE = `
import ctypes, subprocess, sys
libc = ctypes.CDLL(None)
pid = int(sys.argv[1])
buf = ctypes.create_string_buffer(4096)
path = buf.value.decode() if libc.proc_pidpath(pid, buf, 4096) > 0 else "denied"
mib = (ctypes.c_int * 3)(1, 49, pid); size = ctypes.c_size_t(1 << 20); args = ctypes.create_string_buffer(size.value)
env = "readable" if libc.sysctl(mib, 3, args, ctypes.byref(size), None, 0) == 0 and b"ZZ_PARENT_MARKER=" in args.raw[:size.value] else "hidden"
child = subprocess.Popen(["/bin/sleep", "5"])
cbuf = ctypes.create_string_buffer(4096)
own = "visible" if libc.proc_pidpath(child.pid, cbuf, 4096) > 0 else "denied"
child.kill()
print(path, env, own)
`;
if (process.platform !== "darwin" || detectSandbox() !== "sandbox-exec" || spawnSync("python3", ["-c", "1"]).status !== 0) {
  console.log("  (Seatbelt live half not run: needs macOS with sandbox-exec and python3)");
} else {
  const parent = spawn("/bin/sleep", ["30"], { env: { ZZ_PARENT_MARKER: "zz-not-a-token" }, stdio: "ignore" });
  try {
    const probe = (sandboxed: boolean) => {
      const argv = ["-c", PROBE, String(parent.pid)];
      const c = sandboxed
        ? sandbox.sandboxedCommand("sandbox-exec", { denyRead: [], allowRead: [], writable: [tmpdir()] }, "python3", argv, tmpdir())
        : { file: "python3", argv };
      return execFileSync(c.file, c.argv, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim().split(" ");
    };
    const [openPath, , openOwn] = probe(false);
    assert.equal(openPath, "/bin/sleep", "control: unsandboxed, the parent's process info is readable — the probe works");
    assert.equal(openOwn, "visible");
    const [path, env, own] = probe(true);
    assert.equal(path, "denied", "inside the sandbox, the parent's process info is refused");
    assert.equal(env, "hidden", "inside the sandbox, the parent's environment is unreadable");
    assert.equal(own, "visible", "the sandboxed command still sees its own children");
  } finally {
    parent.kill();
  }
}

console.log("ok candidate-bwrap-pid");
