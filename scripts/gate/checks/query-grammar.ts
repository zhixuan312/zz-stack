import { parseQuery } from "@zz/indexing";
import { check } from "../run.ts";

check("query grammar survives a Chinese query with a phrase and an exclusion", () => {
  const q = parseQuery('"审批流程" -测试 迁移 OR 模式');
  const phrases = q.clauses.filter((c) => c.kind === "phrase").map((c) => c.text);
  if (!phrases.includes("审批流程")) return 'the quoted phrase "审批流程" did not survive parsing';
  const excluded = q.clauses.filter((c) => c.kind === "exclude").map((c) => c.text);
  if (!excluded.includes("测试")) return "the exclusion -测试 did not survive parsing";
  if (!q.clauses.some((c) => c.kind === "alternation")) return "the explicit OR did not survive parsing";
  const run = parseQuery("这个迁移会破坏旧的模式");
  if (run.clauses.length !== 1) return `an unspaced Han run parsed into ${run.clauses.length} clauses, not 1`;
  const ident = parseQuery("primary_evidence-000037.txt");
  if (ident.clauses.some((c) => c.kind === "exclude")) return "a hyphen inside an identifier was read as an exclusion operator";
  if (ident.clauses.length !== 1) return `an identifier parsed into ${ident.clauses.length} clauses, not 1`;
});
