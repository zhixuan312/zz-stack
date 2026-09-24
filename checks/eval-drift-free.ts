#!/usr/bin/env node
// Shipped zz-plugin-eval text must not describe the removed ablation evidence.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
const roots = ["catalog/zz/zz-plugin-eval", "marketplace/zz-plugin-eval", "services/zz-core/src/eval/plugin-eval.ts"];
const banned = [/ablation/i, /case block/i, /case suite/i, /two kinds of evidence/i];
const files: string[] = [];
const walk = (p: string) => statSync(p).isDirectory() ? readdirSync(p).forEach((n) => walk(join(p, n))) : files.push(p);
roots.forEach(walk);
// The profile skill's historical note about the removed block is allowed; everything else is not.
const allowed = /zz-plugin-profile\/SKILL\.md$/;
const hits = files.filter((f) => !allowed.test(f)).flatMap((f) =>
  readFileSync(f, "utf8").split("\n").map((l, i) => [f, i + 1, l] as const).filter(([, , l]) => banned.some((b) => b.test(l))));
if (hits.length) { hits.forEach(([f, n, l]) => console.error(`FAIL ${f}:${n}: ${l.trim()}`)); process.exit(1); }
console.log("ok eval-drift-free");
