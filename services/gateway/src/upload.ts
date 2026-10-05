/**
 * /upload/source — a file's bytes reach the platform without passing through a model.
 *
 * Why it is not an MCP tool's argument: an MCP call's arguments ARE the model's own output, so
 * attaching a 600 KB report costs 600 KB of output tokens — twice over, once it is read back to
 * check — and a PDF's bytes cannot be produced that way at all. Here the caller's own shell reads
 * the file and PUTs it. Reading a file is settled work, and settled work belongs in code.
 *
 * `source_upload` on /core/mcp is the other half: it validates the initiative, the title and the
 * `supports` names against the same rules `source_add` applies, and answers with the exact command
 * to run — so a bad name costs one call rather than an upload, and an agent never has to be told
 * this path by hand.
 *
 * Authenticated like every other route, by the caller's own token: this is deliberately NOT under
 * /api/console, whose handler refuses a member PAT with "the console needs a browser sign-in" —
 * and a member with a token is exactly who uploads a file.
 *
 * The write itself is `source_add`'s, reached over the same identity headers every console write
 * uses. This route holds no second implementation of what a source is.
 */
import type { Express, Request, Response } from "express";

import { Mcp, McpError } from "@zz/mcp-client";

import { extract } from "./extract.js";
import { logEvent } from "./events.js";

/** The most one upload may carry. A source is supporting material a person attaches to a piece of
 *  work; past this it is a dataset, and a dataset belongs in a repository the document cites. */
const MAX_BYTES = 16 * 1024 * 1024;

/** The request body, or the sentence that says why it is not one.
 *
 *  express.json is content-type gated, so an `application/octet-stream` body is left unread for
 *  this to consume. It is read as a stream rather than buffered whole, because `Content-Length` is
 *  the client's claim and a stream that ignores it is how a cap becomes a lie. */
function readBody(req: Request): Promise<Buffer | { refusal: string }> {
  return new Promise((resolve) => {
    const declared = Number(req.headers["content-length"] ?? 0);
    if (declared > MAX_BYTES) {
      resolve({ refusal: `${declared} bytes is past this platform's ${MAX_BYTES}-byte limit for one upload.` });
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let over = false;
    req.on("data", (chunk: Buffer) => {
      // Past the cap the rest is read and dropped rather than the socket destroyed: a destroyed
      // request takes the connection with it, and the refusal below would never arrive.
      if (over) return;
      size += chunk.length;
      if (size > MAX_BYTES) { over = true; resolve({ refusal: `the upload passed ${MAX_BYTES} bytes.` }); return; }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", () => resolve({ refusal: "the upload ended before it was complete." }));
  });
}

const one = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

export function mountUpload(app: Express): void {
  app.put("/upload/source", (req: Request, res: Response) => {
    void (async () => {
      const q = req.query as Record<string, unknown>;
      const initiative = one(q.initiative);
      const title = one(q.title);
      const filename = one(q.filename);
      // The global JSON and form parsers are mounted above every route, and curl sends
      // `application/x-www-form-urlencoded` when told nothing else — so a caller who forgot the
      // content type has had their file parsed as a form and thrown away before reaching here.
      // Said plainly, because the alternative is a source that silently holds form fields.
      if (req.body !== undefined) {
        res.status(415).json({ error:
          "send the file itself: this route takes the bytes, so the request must not be " +
          "application/json or a form encoding. `curl --data-binary @<file> -H \"Content-Type: " +
          "application/octet-stream\"` is what source_upload's command uses." });
        return;
      }
      if (!initiative || !title || !filename) {
        res.status(400).json({ error: "initiative, title and filename are required query parameters" });
        return;
      }
      const body = await readBody(req);
      if (!Buffer.isBuffer(body)) { res.status(413).json({ error: body.refusal }); return; }
      if (!body.length) { res.status(400).json({ error: "the upload carried no bytes" }); return; }

      const read = extract(filename, body);
      if ("refusal" in read) { res.status(415).json({ error: read.refusal }); return; }

      // The caller's own identity, forwarded — the gateway never writes a platform table itself,
      // and zz-core reads the author from these headers.
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) {
        if (k.toLowerCase().startsWith("x-zz-") && typeof v === "string") headers[k] = v;
      }
      const core = new Mcp(process.env.CORE_MCP_URL || "http://zz-core:8000/mcp", { headers });
      const supports = one(q.supports);
      let reply: string;
      try {
        reply = await core.call("source_add", {
          initiative, title, content: read.text,
          ...(supports ? { supports } : {}),
          ...(one(q.stage) ? { stage: one(q.stage) } : {}),
        });
      } catch (err) {
        // As in console-write: everything here is "could not reach zz-core", never "zz-core said
        // no" — a refusal comes back as ordinary text beginning with ERROR, read below.
        res.status(502).json({ error: err instanceof McpError ? err.message : "zz-core unreachable" });
        return;
      }
      if (/^ERROR/.test(reply)) { res.status(400).json({ error: reply }); return; }
      logEvent({
        actor: req.zzIdentity!.email, teamSlug: req.zzIdentity!.activeTeam, kind: "source.upload",
        subject: `${initiative}/sources`, detail: { via: "upload", filename, bytes: body.length },
      });
      res.json({ ok: true, result: reply, from: filename, bytes: body.length });
    })().catch((err: unknown) => {
      console.error("source upload failed:", err);
      if (!res.headersSent) res.status(500).json({ error: "the upload could not be completed" });
    });
  });
}
