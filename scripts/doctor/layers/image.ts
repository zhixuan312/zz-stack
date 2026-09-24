/**
 * Layer 2 — is what the registry holds what this checkout builds?
 *
 * Asked of the registry, never answered from a local tag: a local tag is this checkout's
 * opinion about somebody else's server. It catches the two things a tag cannot — a version
 * whose push failed halfway, and a number nobody ever built.
 *
 * DELIBERATE: it does not rebuild and compare digests. A rebuild takes minutes and answers a
 * question the gate's `tsc -b` and the release's own build already answer, and the doctor is
 * meant to be run often.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { DASH_IMAGE, DASH_SRC, IMAGE, published, root } from "../../deployment.ts";
import { layer, probe } from "../run.ts";

layer("image", "is what the registry holds what this checkout declares", ["Dockerfile", "services"]);

const version = () => JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;

probe("this version's platform image is published", () => {
  const ref = `${IMAGE}:${version()}`;
  return published(ref) ? null : `${ref} is not in the registry — either nothing built it or a push failed halfway`;
});

probe("this version's console image is published", () => {
  const dashPkg = join(DASH_SRC, "package.json");
  let v;
  try { v = JSON.parse(readFileSync(dashPkg, "utf8")).version; }
  catch { return null; }   // no console checkout beside this repo; layer `host` still checks what runs
  const ref = `${DASH_IMAGE}:${v}`;
  return published(ref) ? null : `${ref} is not in the registry, and the console checkout declares ${v}`;
});
