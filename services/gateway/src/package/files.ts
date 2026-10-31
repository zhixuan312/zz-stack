/**
 * The one walk that turns a directory into package files. The package ships what it returns and
 * `plugin-lock.ts` digests what it returns, so the files a person installs and the digest that names
 * them cannot come from two readings of one tree.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { PackageFile } from "../client-package.js";

/** The platform's own skills, which the baseline plugin (zz-core) carries. Overridable because the
 *  gate builds real packages on a developer's machine where /skills does not exist. */
export const SKILLS_DIR = process.env.ZZ_SKILLS_DIR || "/skills";

/** Every file under `root`, as package files rooted at `prefix`; nothing when `root` is absent.
 *
 * Directories only at the top level: a stray file there (a README, an editor's leftover) would make
 * the walk throw ENOTDIR and take package building down for everyone. */
export function walkTree(root: string, prefix: string): PackageFile[] {
  if (!existsSync(root)) return [];
  const out: PackageFile[] = [];
  const walk = (dir: string, rel: string): void => {
    for (const f of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, f.name);
      if (f.isDirectory()) walk(abs, `${rel}/${f.name}`);
      else out.push({ path: `${prefix}/${rel}/${f.name}`, content: readFileSync(abs, "utf8") });
    }
  };
  for (const e of readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (e.isDirectory()) walk(join(root, e.name), e.name);
  }
  return out;
}
