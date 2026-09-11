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

import { envToken, initFrame, publicUrl, root, run } from "../../deployment.mjs";
import { zzCoreTools } from "../../gate/read.mjs";
import { layer, probe } from "../run.mjs";

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
function mcp(path, body) {
  // THE PRECONDITIONS ARE RESOLVED OUTSIDE THE try, and that placement is the whole rule.
  //
  // With them inside it, a `url()` that could not find an address was caught by the catch
  // below and returned as "the door could not be reached" — a DISAGREEMENT — so an unreachable
  // host produced two verdicts saying the platform's contract was wrong when nothing had
  // looked at the platform at all. A catch wide enough to cover not knowing where to look will
  // eventually report what you were looking for as broken.
  const addr = url(), bearer = token();
  let out;
  // From here on a throw is the platform's answer, not a missing precondition, so it is
  // RETURNED. A door that is down, or a Caddy 502 in front of it, must not become `unknown` —
  // a release does not roll back on `unknown`.
  try {
    out = run("curl", ["-s", "-m", "30",
      "-H", `Authorization: Bearer ${bearer}`, "-H", "content-type: application/json",
      "-H", "accept: application/json, text/event-stream",
      "-d", body, `${addr}${path}`]);
  } catch (err) {
    return { unreachable: `the door could not be reached: ${String(err.stderr ?? err.message ?? err).trim().slice(0, 160)}` };
  }
  const line = out.split("\n").map((l) => l.trim()).filter(Boolean).pop() ?? "";
  // AND THE PARSE IS DEFENSIVE, for the same reason one layer down. A 502 hands back an HTML
  // error page; JSON.parse throws SyntaxError on it, the runner would call that the doctor's
  // own bug, and the misattribution this whole design exists to eliminate would be pointing
  // the other way — at a platform that really was broken.
  try {
    const parsed = JSON.parse(line.replace(/^data:\s*/, ""));
    return parsed && typeof parsed === "object" ? parsed : { unreachable: `the door answered ${JSON.stringify(parsed)}, which is not an MCP frame` };
  } catch {
    return { unreachable: `the door answered something that is not JSON: ${(line || "(empty)").slice(0, 160)}` };
  }
}

probe("every tool the source registers is on the live door", () => {
  // The initialize handshake first: the doors are stateless, but a server that throws at
  // construction answers the handshake with an error rather than a tool list, and "0 tools"
  // and "the server would not start" are different diagnoses.
  const hello = mcp("/core/mcp", initFrame("doctor"));
  if (hello.unreachable) return hello.unreachable;
  if (hello.error) return `the door refused initialize: ${JSON.stringify(hello.error).slice(0, 200)}`;

  const live = mcp("/core/mcp", JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }));
  if (live.unreachable) return live.unreachable;
  const names = (live?.result?.tools ?? []).map((t) => t.name);
  if (!names.length) return "the live door lists no tools at all — a door that failed to mount answers 200 with an empty list";

  // The source side, file by file, so the ANSWER names the module a missing tool came from —
  // which is the whole diagnosis when a register<Door>Tools call is dropped from buildServer.
  const declared = zzCoreTools();
  const coreDoor = new Set(names);
  // Only the tools this door is supposed to carry: /manage/mcp holds the rest, and its list is
  // the caller's role rather than a fixed set, so it is not comparable this way.
  const missing = declared.filter((t) => !coreDoor.has(t.name));
  const byFile = new Map();
  for (const t of missing) byFile.set(t.file, [...(byFile.get(t.file) ?? []), t.name]);
  // A tool declared in source and absent from /core/mcp is normal — it may be a /manage door
  // tool. What is NOT normal is a whole file's worth going missing at once, which is what a
  // dropped register call looks like and what a per-tool comparison would drown in noise.
  //
  // WHAT THIS CANNOT SEE, said plainly because a proxy presented as a judge is the failure the
  // gate exists to refuse: `ns.length > 1` means a door module holding exactly ONE tool could
  // be dropped from buildServer and pass here. Every door module today holds several, so the
  // blind spot is empty rather than merely unlikely — but it is a property of the code, not of
  // the check, and the day somebody writes a one-tool door is the day this stops covering it.
  const wholeFiles = [...byFile].filter(([file, ns]) =>
    ns.length === declared.filter((t) => t.file === file).length && ns.length > 1);
  return wholeFiles.length
    ? `the live /core/mcp door carries ${names.length} tools and is missing EVERY tool from ` +
      wholeFiles.map(([f, ns]) => `${f} (${ns.join(", ")})`).join("; ") +
      " — that is the shape of a register call dropped from buildServer, not of a tool moved between doors"
    : null;
});

probe("the client package carries this version", () => {
  const want = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
  // The package is generated live from the catalog INSIDE the image, so its version prefix is
  // the running code's own answer rather than anything this checkout can compute.
  const addr = url(), bearer = token();   // preconditions first — see mcp() above
  let out;
  // `curl -f` exits non-zero on any HTTP error, so a 401, a 500 and a dead route all throw —
  // each of which is the platform's answer, not a probe that could not run.
  try {
    out = run("bash", ["-c",
      `curl -fsSL -H "Authorization: Bearer $ZZ_DOCTOR_TOKEN" ${addr}/pkg/claude-code.tgz `
      + `| tar xzO zz-platform/zz/.claude-plugin/plugin.json 2>/dev/null `
      + `| node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).version))'`],
      { env: { ...process.env, ZZ_DOCTOR_TOKEN: bearer } });
  } catch (err) {
    return `the package route did not serve a package: ${String(err.stderr ?? err.message ?? err).trim().slice(0, 160)}`;
  }
  if (!out) return "the package served no version";
  return out.startsWith(`${want}+`) ? null : `the package reports "${out}", this checkout is ${want}`;
});
