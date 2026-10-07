/**
 * `upload_start` — how a file reaches a write without passing through the model.
 *
 * Registered from `artifacts.ts` beside the write tools it serves. An argument is the model's own
 * output, so a report already on disk costs its own length in output tokens to send as `content`.
 * This mints an upload instead — a `zz.upload` row for the caller and the team they act for, open
 * for 15 minutes — and answers with the two ways its bytes can arrive, both served by the gateway
 * (services/gateway/src/upload.ts): `shell`, a curl PUT of the file with the person's own token,
 * for an agent that has a shell; and `link`, a page that stages this one upload and nothing else,
 * for a person whose agent has none. The write that names it — `document_write`, `document_edit` or
 * `source_add` with `upload` — consumes it in its own transaction (upload-consume.ts).
 *
 * DELIBERATE: the link's secret is minted here, answered once and stored only as its sha256
 * (`uploadSecretHash`); the act row names the upload and its filename, never the secret or the link.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { mintUploadId, mintUploadSecret, parseCaller, uploadSecretHash, uploadText } from "@zz/contracts";
import { WRITES, requestHeaders, text } from "@zz/mcp-http";
import { z } from "zod";

import { NO_TEAM } from "../document-change.js";
import { platformEvent } from "../indexing.js";
import { db, teamFor } from "../platform-db.js";
import { NO_DB } from "../versions.js";

/** The person's own token, resolved as the client package resolves it (`$ZZ_TOKEN`, then the file
 *  `$ZZ_TOKEN_FILE` names, then `~/.zz/token`), and expanded by the shell that runs the line. */
const TOKEN = '${ZZ_TOKEN:-$(cat "${ZZ_TOKEN_FILE:-$HOME/.zz/token}")}';

/** The filename as one shell word, whatever it holds: the name is the caller's. */
const quoted = (s: string): string => `'${s.replace(/'/g, "'\\''")}'`;

export function registerUploadStartTool(server: McpServer): void {
  server.registerTool(
    "upload_start",
    {
      annotations: WRITES,
      description:
        "Start sending a FILE you already have — a report, minutes, a CSV — instead of writing its " +
        "text out as an argument, which costs its whole length in output tokens. Answers JSON: " +
        "`upload` (the id), `shell` (one command that PUTs the file from the machine it is on, with " +
        "the person's own token — run it where you have a shell, in the file's own directory, since it " +
        "names the file without its path; elsewhere, put the file's path in place of the quoted name), " +
        "`note` (that same rule) and `link` (a page where the person " +
        "picks the file — give it to them where you have no shell; it stages this one file and " +
        "nothing else). Once it is staged, pass `upload` to document_write, document_edit or " +
        "source_add in place of `content`. The file must be UTF-8 plain text of at most 8 MiB, named " +
        ".md, .markdown, .txt, .text, .csv, .tsv, .json, .yaml, .yml, .toml, .xml, .sql, .log, .ini, " +
        ".conf, .rst or .adoc. An upload is open for 15 minutes and is used once.",
      inputSchema: {
        filename: z.string()
          .describe("The file's name without its directory, e.g. 'minutes-2026-10-07.md'. Its extension " +
                    "decides whether the platform takes it."),
      },
    },
    async ({ filename }) => {
      const name = filename.trim();
      if (!name || name.length > 255 || /[/\\]/.test(name)) {
        return text(`ERROR: ${JSON.stringify(filename)} is not a filename — send the name alone, without any ` +
                    "part of the path it sits at");
      }
      // The family's own refusal, asked of no bytes: a file the platform would refuse costs a call,
      // not an upload.
      const format = uploadText(name, new Uint8Array(0));
      if ("code" in format) return text(format.refusal);
      const publicUrl = (process.env.GATEWAY_PUBLIC_URL ?? "").replace(/\/+$/, "");
      if (!publicUrl) {
        return text("ERROR: this deployment sets no GATEWAY_PUBLIC_URL, so there is no address to send the " +
                    "file to. Ask whoever runs it to set that key — every client package this platform hands " +
                    "out embeds the same value — and send the text as `content` until then.");
      }
      const p = db();
      if (!p) return text(NO_DB);
      const who = parseCaller(requestHeaders()).email;
      const team = await teamFor(who);
      if (!team) return text(NO_TEAM);
      const id = mintUploadId();
      const secret = mintUploadSecret();
      // `created_at` and `expires_at` are the table's defaults: the 15 minutes are the database's clock.
      const { rowCount } = await p.query(
        `insert into zz.upload (id, team_id, principal_id, filename, link_secret_hash)
         select $1, t.id, p.id, $4, $5 from zz.team t, zz.principal p
          where t.slug = $2 and lower(p.email) = lower($3)`, [id, team, who, name, uploadSecretHash(secret)]);
      if (!rowCount) return text(`ERROR: ${who} is no principal this platform knows, so no upload can be started for it.`);
      platformEvent({ actor: who, kind: "upload.start", subject: id, team, detail: { filename: name } });
      return text(JSON.stringify({
        upload: id,
        shell: `curl --fail-with-body -T ${quoted(name)} -H "Authorization: Bearer ${TOKEN}" ${publicUrl}/upload/${id}`,
        note: `shell reads ${quoted(name)} from the directory it runs in: run it in the file's own directory, ` +
              "or put the file's path in place of the quoted name.",
        link: `${publicUrl}/u/${secret}`,
      }));
    },
  );
}
