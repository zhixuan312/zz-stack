#!/usr/bin/env node
/**
 * checks/document-upload.ts — Phase 4's acceptance, through a real zz-core on a throwaway database
 * and the gateway's own built staging routes driven in this process: a plain-text file becomes a
 * document, a whole-body change or a source by the shell route, the link page and the ChatGPT
 * `file` route, held to the request key, the format, size and envelope rules, the guards and the
 * write's own records; the field and tag rules, named metadata and a source's supports/stage are
 * typed content's cases, not repeated for a file (AC-4.1, AC-4.2). The handlers' order — a keyed
 * retry replays before a `file` is fetched — is held by the gate's documents-guards rule.
 *
 *   node checks/document-upload.ts   # needs Docker, curl, openssl and a built tree (`npm run build`)
 *
 * What it establishes, one line per case:
 *
 *   - the shell route: `upload_start` names a `/upload/` route and a `/u/` link the gateway serves;
 *     its `shell` line, run as answered with the person's own PAT, stages a file, and
 *     `document_write`, `document_edit` and `source_add` each store it byte for byte, consumed in
 *     the write's commit; a refusal reaches the shell as JSON with a failing status;
 *   - the link page: it opens ready for its file under its own policy; its PUT stages as `link`
 *     with no principal and writes nothing else; its secret, as a bearer token or a console cookie,
 *     reads no team document, stages no other upload and approves nothing, and its path answers
 *     nothing but GET and PUT; each write takes a link-staged file byte for byte;
 *   - the rules: 8 MiB + 1 refused at staging, 8 MiB staged and its stored form refused in the
 *     write and left unconsumed; invalid UTF-8, another extension and an unsupported format refused
 *     by name; a byte-order mark removed and said; an immutable binding — the same bytes answer it,
 *     other bytes conflict; nothing stages or is consumed after expiry; another person's token
 *     stages nothing, and another person or another team consumes nothing;
 *   - consumption: two writes after one upload — one lands, the other is UPLOAD_USED; a keyed write
 *     replays once its upload is consumed, expired and deleted, while an independent one is refused
 *     each time; a fault at the consumption or at the commit's last statement leaves the upload
 *     unconsumed until it expires, and the sweep then takes its body; two identical keyed
 *     `source_add` calls in flight file one source; a keyed no-change consumes and is recorded;
 *   - the families: a `.yaml` opening with `---`, a `.csv` and an `.xml` holding `<script>` read
 *     back byte for byte through `document_read`, the stored revision, the console's document read
 *     and the panel's payload; the panel's renderer shows the `<script>` as text; the dashboard's
 *     safe-markdown rendering is cited for the console; an `edits` change to a literal CSV and to
 *     a non-envelope YAML applies exactly; an envelope-shaped `.yaml` is refused into a document
 *     with its way out and taken as a source; the details name `staged via` and by whom;
 *   - the ChatGPT `file` route, in process with `fileSource`'s options: a fetched file becomes a
 *     document, a whole body and a source byte for byte; a keyed write whose URL now answers 404
 *     replays without fetching, while unkeyed it is FILE_UNAVAILABLE; an unsupported format is
 *     refused before any fetch, and 8 MiB + 1 and invalid UTF-8 are refused.
 *
 * The case groups live in `scripts/schema/upload-cases.ts`, `upload-rule-cases.ts` and
 * `upload-file-cases.ts`. Expiry is `expires_at` moved on the throwaway database; a fault is a
 * trigger, as Phase 1's checks inject one. The gateway listens before the zz-core child starts,
 * so the child's `GATEWAY_PUBLIC_URL` is the gateway the cases stage through.
 *
 * Exit 0: every case held — one line per case, then the final line.
 * Exit 1: a case failed — the case and what was found, then zz-core's last output.
 * Exit 2: Docker is not available — the check could not run, and that is not a pass.
 */
import { withThrowawayCore } from "../scripts/schema/throwaway-core.ts";
import { linkRoute, listenGateway, shellRoute, stagingRules } from "../scripts/schema/upload-cases.ts";
import { fileRoute } from "../scripts/schema/upload-file-cases.ts";
import { consumers, families } from "../scripts/schema/upload-rule-cases.ts";

const NAME = "document-upload";

const gateway = await listenGateway();
// Read by the child's `upload_start`: the routes it answers are this listener's.
process.env.GATEWAY_PUBLIC_URL = gateway.url;
try {
  process.exitCode = await withThrowawayCore(NAME,
    `${NAME}: a plain-text file becomes a document, a whole body or a source through the shell, the link and the ChatGPT file route, byte for byte, consumed once in its write: ok`,
    async (c) => {
      const g = await gateway.attach(c);
      try {
        await shellRoute(c, g);
        await linkRoute(c, g);
        await stagingRules(c, g);
        await consumers(c, g, c.client());
        await families(c, g);
        await fileRoute(c, g);
      } finally {
        await g.end();
      }
    });
} finally {
  await gateway.stop();
  delete process.env.GATEWAY_PUBLIC_URL;
}
