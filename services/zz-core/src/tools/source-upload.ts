/**
 * `source_upload` — how to attach a file, rather than its text.
 *
 * Registered from `artifacts.ts` beside `source_add`, which it exists for the sake of: `source_add`
 * takes the material as an argument, and an argument is the model's own output. A report you
 * already have therefore costs its own length in output tokens to attach, and a PDF's bytes cannot
 * be produced that way at all.
 *
 * This answers with a command instead. The caller's shell reads the file and PUTs it to
 * `/upload/source` on the gateway (services/gateway/src/upload.ts), which turns it into the text a
 * source holds and writes it through `source_add`'s own path.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { READS, text } from "@zz/mcp-http";
import { z } from "zod";

import { PLAIN_TOKEN, safeName, titleSlug } from "../paths.js";

export function registerSourceUploadTool(server: McpServer): void {
  /* Read-only, because it changes nothing: it answers a question about how, and the only work it
   * does is check the three names against the rules `source_add` applies — an initiative that is a
   * path segment, a title that slugs, `supports` entries that are document names — so a bad one
   * costs a call rather than an upload.
   *
   * Everything past that is decided where the bytes land, which is the only place that has them:
   * membership, whether the initiative is open, and whether the file is a format the platform
   * reads. A refusal from there is `source_add`'s, unchanged. */
  server.registerTool(
    "source_upload",
    {
      annotations: READS,
      description:
        "How to attach a FILE as a source — minutes as a PDF, a report as a .docx, a page of " +
        "Markdown — when you have the file rather than the words. Answers with one command to " +
        "run, which sends the file from the machine it is on, so its bytes never pass through " +
        "you: text you would otherwise have to produce as output tokens, and cannot produce at " +
        "all if it is a PDF. Prefer this over source_add for anything long, and always for a " +
        "file. source_add is still the tool for words you have.",
      inputSchema: {
        initiative: z.string(),
        title: z.string(),
        filename: z.string()
          .describe("The name of the file you are about to send, e.g. 'handover-2026-10.docx'. " +
                    "Its extension decides how the platform reads it, and the answer names the " +
                    "formats it cannot."),
        supports: z.union([z.string(), z.array(z.string())]).optional()
          .describe("Document(s) this material bears on, the same as source_add's."),
        stage: z.string().optional()
          .describe("The flow stage this file is the output of, when it is one — the same as " +
                    "source_add's."),
      },
    },
    async ({ initiative, title, filename, supports, stage }) => {
      const badInitiative = safeName(initiative, "initiative");
      if (badInitiative) return text(badInitiative);
      const badTitle = titleSlug(title, "source");
      if (badTitle) return text(badTitle);
      // The same split source_add applies, and the same rule per entry: these are written into
      // YAML and read back by a comma-splitter.
      const list = (Array.isArray(supports) ? supports : supports ? supports.split(",") : [])
        .map((x) => x.trim()).filter(Boolean);
      for (const d of list) {
        if (!PLAIN_TOKEN.test(d)) {
          return text(`ERROR: supports entry "${d}" must be a document name — ` +
                      "letters, digits, dot, dash or underscore, nothing else");
        }
      }
      if (!filename.trim() || /[/\\]/.test(filename)) {
        return text(`ERROR: "${filename}" is not a filename — send the name alone, without any ` +
                    "part of the path it sits at");
      }
      const publicUrl = (process.env.GATEWAY_PUBLIC_URL ?? "").replace(/\/+$/, "");
      if (!publicUrl) {
        return text("ERROR: this deployment sets no GATEWAY_PUBLIC_URL, so there is no address to " +
                    "send the file to and no command to give you. Ask whoever runs it to set that " +
                    "key — every client package this platform hands out embeds the same value.");
      }
      const q = new URLSearchParams({ initiative, title, filename: filename.trim() });
      if (list.length) q.set("supports", list.join(","));
      if (stage) q.set("stage", stage);
      return text(
        `Run this from the machine that holds the file — ${filename}, read and sent by the shell, ` +
        "so nothing about it passes through you:\n\n" +
        "  TOKEN=\"${ZZ_TOKEN:-$(cat ~/.zz/token)}\"\n" +
        `  curl -fsS -X PUT --data-binary @${filename} \\\n` +
        `    -H "Authorization: Bearer $TOKEN" \\\n` +
        `    -H "Content-Type: application/octet-stream" \\\n` +
        `    "${publicUrl}/upload/source?${q.toString()}"\n\n` +
        "The token is the person's own, resolved the way zz-mcp-headers.sh resolves it — `ZZ_TOKEN`, " +
        "then `~/.zz/token`, which the install step writes. The content type matters: curl sends a " +
        "form encoding when told nothing else, and the gateway parses that before this route sees it.\n\n" +
        "It answers with the source `source_add` would have written, at the path its title slugs " +
        "to, or with the reason it refused — a format the platform cannot read comes back naming " +
        "the ones it can.",
      );
    },
  );
}
