import { snippetFor } from "@zz/indexing";
import { check } from "../run.ts";

check("a snippet addresses original bytes and never splits a CJK character or an emoji", () => {
  for (const body of ["这个迁移会破坏旧的模式", "migration 迁移 👨‍👩‍👧 done", "前后"]) {
    const bytes = Buffer.from(body, "utf8");
    for (let start = 0; start < bytes.length; start++) {
      const s = snippetFor(body, { start, end: Math.min(start + 4, bytes.length) });
      if (s.text.includes("\uFFFD")) return `snippet of ${body} at byte ${start} split a character`;
      if (/^zh[0-9a-f]{12}$/.test(s.text.trim())) return "an encoded analyzer term was returned as a citation";
      const slice = bytes.subarray(s.range.start, s.range.end).toString("utf8");
      if (slice !== s.text) return `snippet text does not match the bytes its range names, in ${body}`;
    }
  }
});
