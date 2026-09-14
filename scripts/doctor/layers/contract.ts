/**
 * LAYER 5 — is the live surface the one the source declares?
 *
 * The layer the 0.26.1 restructure needed and did not have. Sixty-nine files moved, and the
 * proof that no door had silently lost its tools was a manual diff of one captured tools/list
 * against a rebuilt binary — done once, by hand, because nothing could do it. A door that
 * fails to mount does not 500: it answers 200 with a shorter list, and every probe in the
 * `doors` layer stays green.
 *
 * SOURCE IS THE DECLARATION, THE DEPLOYMENT IS THE FACT, and this compares them by NAME rather
 * than by count. A count passes a tool that was renamed, passes one deleted while another was
 * added, and can only ever notice the single case of a door that lost one and gained nothing.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { asExecError, envToken, initFrame, publicUrl, root, run } from "../../deployment.ts";
import { zzCoreTools } from "../../gate/read.ts";
import { layer, probe } from "../run.ts";

/** The three shapes this file actually reads off a live MCP frame. Every field is optional —
 *  the transport may answer with a JSON-RPC error, a frame missing the result a caller asked
 *  for, or this file's own `unreachable` marker — so the honest type is one no live answer can
 *  fail to satisfy, rather than a schema nothing here validates. */
interface McpFrame {
  unreachable?: string;
  error?: unknown;
  result?: {
    tools?: { name: string }[];
    serverInfo?: { version?: string };
  };
}

layer("contract", "is the live surface the one the source declares", ["services/zz-core/src", "packages/contracts/src"]);

function url() {
  const u = publicUrl({ quiet: true });
  if (!u) throw new Error("no address to probe — ZZ_PUBLIC_URL is unset and the host could not be asked");
  return u;
}
function token() {
  const t = envToken();
  if (!t) throw new Error("no ZZ_TOKEN — the tool list cannot be asked for");
  return t;
}

/** One MCP call, parsed. The transport may answer as SSE or as plain JSON, so the last
 *  non-empty line is taken and the `data: ` prefix dropped if it is there. */
function mcp(path: string, body: string): McpFrame {
  // THE PRECONDITIONS ARE RESOLVED OUTSIDE THE try, and that placement is the whole rule.
  //
  // With them inside it, a `url()` that could not find an address was caught by the catch
  // below and returned as "the door could not be reached" — a DISAGREEMENT — so an unreachable
  // host produced two verdicts saying the platform's contract was wrong when nothing had
  // looked at the platform at all. A catch wide enough to cover not knowing where to look will
  // eventually report what you were looking for as broken.
  const addr = url(), bearer = token();
  let out: string;
  // From here on a throw is the platform's answer, not a missing precondition, so it is
  // RETURNED. A door that is down, or a Caddy 502 in front of it, must not become `unknown` —
  // a release does not roll back on `unknown`.
  try {
    out = run("curl", ["-s", "-m", "30",
      "-H", `Authorization: Bearer ${bearer}`, "-H", "content-type: application/json",
      "-H", "accept: application/json, text/event-stream",
      "-d", body, `${addr}${path}`]);
  } catch (err) {
    const e = asExecError(err);
    return { unreachable: `the door could not be reached: ${(e.stderr ?? e.message).trim().slice(0, 160)}` };
  }
  const line = out.split("\n").map((l) => l.trim()).filter(Boolean).pop() ?? "";
  // AND THE PARSE IS DEFENSIVE, for the same reason one layer down. A 502 hands back an HTML
  // error page; JSON.parse throws SyntaxError on it, the runner would call that the doctor's
  // own bug, and the misattribution this whole design exists to eliminate would be pointing
  // the other way — at a platform that really was broken.
  try {
    const parsed: unknown = JSON.parse(line.replace(/^data:\s*/, ""));
    return parsed && typeof parsed === "object" ? (parsed as McpFrame)
      : { unreachable: `the door answered ${JSON.stringify(parsed)}, which is not an MCP frame` };
  } catch {
    return { unreachable: `the door answered something that is not JSON: ${(line || "(empty)").slice(0, 160)}` };
  }
}

probe("every tool the source registers is on the live door", () => {
  // The initialize handshake first: the doors are stateless, but a server that throws at
  // construction answers the handshake with an error rather than a tool list, and "0 tools"
  // and "the server would not start" are different diagnoses.
  // BOTH OF ZZ-CORE'S DOORS, AND THE UNION OF WHAT THEY SERVE. The service mounts two MCP
  // endpoints — the gateway publishes them as /core/mcp and /eval/mcp — and `zzCoreTools()`
  // below reads the whole of services/zz-core/src, so it declares the tools of both. Asking
  // only the core door would therefore report the ten `plugin_*` tools as missing on every
  // healthy deployment: three whole files at once, which is exactly the shape this probe
  // treats as a dropped register call. A monitor that cries wolf on a correct release is worse
  // than no monitor, because the next real one is read past.
  const DOORS = ["/core/mcp", "/eval/mcp"];
  const names: string[] = [];
  for (const door of DOORS) {
    const hello = mcp(door, initFrame("doctor"));
    if (hello.unreachable) return `${door}: ${hello.unreachable}`;
    if (hello.error) return `${door} refused initialize: ${JSON.stringify(hello.error).slice(0, 200)}`;

    const live = mcp(door, JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }));
    if (live.unreachable) return `${door}: ${live.unreachable}`;
    const served = (live?.result?.tools ?? []).map((t) => t.name);
    // Per door, not on the union: one door mounting empty is invisible in a union the other
    // door fills, and an empty door is the failure this whole probe exists to catch.
    if (!served.length) return `${door} lists no tools at all — a door that failed to mount answers 200 with an empty list`;
    names.push(...served);
  }

  // The source side, file by file, so the ANSWER names the module a missing tool came from —
  // which is the whole diagnosis when a register<Door>Tools call is dropped from a builder.
  const declared = zzCoreTools();
  const coreDoor = new Set(names);
  // Only the tools zz-core is supposed to carry: /manage/mcp holds the rest, and its list is
  // the caller's role rather than a fixed set, so it is not comparable this way.
  const missing = declared.filter((t) => !coreDoor.has(t.name));
  const byFile = new Map();
  for (const t of missing) byFile.set(t.file, [...(byFile.get(t.file) ?? []), t.name]);
  // A tool declared in source and absent from BOTH zz-core doors is normal — it may be a
  // /manage door tool. What is NOT normal is a whole file's worth going missing at once, which is what a
  // dropped register call looks like and what a per-tool comparison would drown in noise.
  //
  // WHAT THIS CANNOT SEE, said plainly because a proxy presented as a judge is the failure the
  // gate exists to refuse: `ns.length > 1` means a door module holding exactly ONE tool could
  // be dropped from buildServer and pass here. Every door module today holds several, so the
  // blind spot is empty rather than merely unlikely — but it is a property of the code, not of
  // the check, and the day somebody writes a one-tool door is the day this stops covering it.
  // Nor can it see WHICH of zz-core's two doors a tool is on: the lists are unioned, so a tool
  // that moved from one to the other reads as present. checks/eval-door.mjs holds that offline,
  // against the builders themselves.
  const wholeFiles = [...byFile].filter(([file, ns]) =>
    ns.length === declared.filter((t) => t.file === file).length && ns.length > 1);
  return wholeFiles.length
    ? `zz-core's doors (${DOORS.join(", ")}) carry ${names.length} tools between them and are ` +
      "missing EVERY tool from " +
      wholeFiles.map(([f, ns]) => `${f} (${ns.join(", ")})`).join("; ") +
      " — that is the shape of a register call dropped from a builder. A tool MOVED between " +
      "these two doors is invisible here, because both are asked and their lists are unioned."
    : null;
});

probe("the live door is running this version", () => {
  const want = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
  // THE HANDSHAKE, not a package download. This used to `curl /pkg/claude-code.tgz | tar xzO`
  // a plugin.json out of the archive and read its version prefix — the only way to ask the
  // running image what it thought it was, back when the package was the thing it served.
  // `/pkg` went with Codex and Hermes on 2026-09-12; `serverInfo.version` answers the same
  // question in one frame, from the same `serviceVersion` read, with no archive in the middle.
  const hello = mcp("/core/mcp", initFrame("doctor"));
  if (hello.unreachable) return hello.unreachable;
  if (hello.error) return `the door refused initialize: ${JSON.stringify(hello.error).slice(0, 200)}`;
  const live = hello?.result?.serverInfo?.version;
  if (!live) return "the handshake carried no serverInfo.version";
  return live === want ? null : `the door reports "${live}", this checkout is ${want}`;
});
