/**
 * The consumption half of `checks/document-upload.ts` (AC-4.1, AC-4.2): what a staged upload does
 * when two writes want it, when a keyed write is sent again, when its write fails, and what each
 * file family reads back as — through the gateway's staging route (upload-cases.ts) and a real
 * zz-core child.
 *
 * Races are staged with the order PostgreSQL grants one advisory lock, as the Phase 1 checks stage
 * them; a fault is a trigger created for its case and dropped after it.
 *
 * A helper, not a check: every `.ts` under `checks/` is a check the gate runs, so the case groups
 * that check runs live here, beside the harness they run on.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import type { Mcp } from "@zz/mcp-client";

import { root } from "../deployment.ts";
import { esc, first } from "./normalize-cases.ts";
import type { Core } from "./throwaway-core.ts";
import { exact, expire, type Gateway, rowOf, start, waiting } from "./upload-cases.ts";

const utf8 = (s: string): Buffer => Buffer.from(s, "utf8");
const sha = (b: Buffer): string => createHash("sha256").update(b).digest("hex");

/** A file started and staged with the person's PAT: its upload id. */
async function upload(c: Core, g: Gateway, step: string, filename: string, bytes: Buffer): Promise<string> {
  const s = await start(c, step, filename);
  const route = new RegExp(` ${esc(g.url)}(/upload/\\S+)$`).exec(s.shell)?.[1] ?? c.fail(step, s.shell);
  const a = await g.send("PUT", route, { body: bytes, headers: { authorization: `Bearer ${g.token}` } });
  if (a.status !== 200 || a.json.sha256 !== sha(bytes)) c.fail(step, `staging answered ${a.status} ${a.text.slice(0, 200)}`);
  return s.upload;
}

/** Two writes after one upload, a keyed write sent again, and a write that fails at its commit. */
export async function consumers(c: Core, g: Gateway, second: Mcp): Promise<void> {
  const I = await c.open("consumers");
  let step = "two writes consuming one upload, released together on their documents' locks: one lands, the other is UPLOAD_USED";
  const once = await upload(c, g, step, "once.md", utf8("# Once\n"));
  const [pa, pb] = [`${I}/once-a.md`, `${I}/once-b.md`];
  for (const p of [pa, pb]) await c.hold(c.docKey(p));
  let calls: Promise<string>[];
  try {
    calls = [c.call(step, "document_write", { path: pa, upload: once }),
             c.call(step, "document_write", { path: pb, upload: once }, second)];
    for (const p of [pa, pb]) await c.waiters(step, c.docKey(p), 1);
  } finally {
    for (const p of [pa, pb]) await c.release(c.docKey(p));
  }
  const replies = await Promise.all(calls);
  const docs = (await c.sql.query<{ n: number }>(
    "select count(*)::int as n from zz.doc d join zz.initiative i on i.id = d.initiative_id where i.slug = $1 and d.path like 'once-%'", [I])).rows[0].n;
  if (replies.filter((r) => !r.startsWith("ERROR")).length !== 1 || docs !== 1
      || replies.filter((r) => /^ERROR: UPLOAD_USED — /.test(r)).length !== 1) c.fail(step, replies.join("\n---\n"));
  c.pass(step);

  step = "a keyed write replays its first receipt once its upload is consumed and its body gone, once it has expired, and once its row is deleted, while an independent write is refused each time";
  const id = await upload(c, g, step, "keyed.md", utf8("# Keyed\n"));
  const keyed = { path: `${I}/keyed.md`, upload: id, request_id: "keyed-1" };
  const landed = await c.ok(step, "document_write", keyed);
  const independent = (n: number) => ({ path: `${I}/keyed-${n}.md`, upload: id, request_id: `independent-${n}` });
  const states: [string, () => Promise<unknown>, RegExp][] = [
    ["consumed", async () => undefined, /^ERROR: UPLOAD_USED — /],
    // Consumed before expired: a used upload is used, whether or not its window has also run out.
    ["expired", () => expire(c, id), /^ERROR: UPLOAD_USED — /],
    ["deleted", () => c.sql.query("delete from zz.upload where id = $1", [id]), /^ERROR: FORBIDDEN — /],
  ];
  for (const [n, [state, reach, refusal]] of states.entries()) {
    await reach();
    const again = await c.ok(`${step}: ${state}`, "document_write", keyed);
    if (first(again) !== `${first(landed)} (replayed)`) c.fail(`${step}: ${state}`, `first:\n${landed}\nagain:\n${again}`);
    await c.refused(`${step}: ${state}`, "document_write", independent(n), refusal);
  }
  if ((await rowOf(c, id)) !== undefined) c.fail(step, "the deleted row came back");
  c.pass(step);

  step = "a fault at the consumption, or at the write's last statement, leaves the upload unconsumed until it expires, and the sweep then takes its body and keeps the row";
  const kept = await upload(c, g, step, "kept.md", utf8("# Kept\n"));
  const k = `${I}/kept.md`;
  await c.sql.query(`create function zz.upload_fault() returns trigger language plpgsql as $$
                       begin raise exception 'injected at %', tg_argv[0]; end $$`);
  try {
    for (const [at, table, when] of [["the consumption", "zz.upload", "before update on zz.upload for each row"],
                                     ["the event row", "zz.event", "before insert on zz.event for each row when (new.kind like 'document.%')"]]) {
      await c.sql.query(`create trigger upload_fault ${when} execute function zz.upload_fault('${at}')`);
      try {
        await c.refused(`${step}: ${at}`, "document_write", { path: k, upload: kept }, new RegExp(`^ERROR: ${esc(k)} could not be written: injected at ${at}`));
      } finally {
        await c.sql.query(`drop trigger upload_fault on ${table}`);
      }
      await waiting(c, `${step}: ${at}`, kept);
    }
  } finally {
    await c.sql.query("drop function zz.upload_fault()");
  }
  if ((await c.call(step, "document_read", { path: k })).startsWith("ERROR") === false) c.fail(step, "a failed write left a document");
  await expire(c, kept);
  await c.refused(step, "document_write", { path: k, upload: kept }, /^ERROR: UPLOAD_EXPIRED — /);
  const swept = await g.sweep();
  const after = await rowOf(c, kept);
  if (swept < 1 || !after || after.body !== null || after.consumed || after.sha256 !== sha(utf8("# Kept\n"))) {
    c.fail(step, `swept ${swept}; the row: ${JSON.stringify({ ...after, body: !!after?.body })}`);
  }
  c.pass(step);

  step = "two identical keyed source_add calls carrying one upload, in flight together, file one source and consume the upload once";
  const twin = { initiative: I, title: "Twin source", upload: await upload(c, g, step, "twin.txt", utf8("said once\n")), request_id: "twin-1" };
  const principal = (await c.sql.query<{ id: string }>("select id::text as id from zz.principal where email = $1", [c.email])).rows[0].id;
  // COUPLED: the request's own lock, as saveDocument takes it for a source.
  const key = `req:${c.team}/${principal}/${I}/sources/twin-1`;
  await c.hold(key);
  let a: Promise<string>;
  let b: Promise<string>;
  try {
    a = c.call(step, "source_add", twin);
    await c.waiters(step, key, 1);
    b = c.call(step, "source_add", twin, second);
    await c.waiters(step, key, 2);
  } finally {
    await c.release(key);
  }
  const both = (await Promise.all([a, b])).map(first).sort();
  const filed = (await c.sql.query<{ n: number }>(
    `select count(*)::int as n from zz.doc d join zz.initiative i on i.id = d.initiative_id
      where i.slug = $1 and d.path like 'sources/%twin-source%'`, [I])).rows[0].n;
  const used = await rowOf(c, twin.upload);
  if (!/^source recorded: \S+$/.test(both[0]) || both[1] !== `${both[0]} (replayed)` || filed !== 1 || !used?.consumed) {
    c.fail(step, `${both.join("\n")}; ${filed} sources; consumed ${String(used?.consumed)}`);
  }
  c.pass(step);

  step = "a keyed upload that changes nothing is consumed and recorded; unkeyed, it consumes nothing";
  const same = utf8("# Same\n\nunchanged\n");
  const s = `${I}/same.md`;
  await c.ok(step, "document_write", { path: s, upload: await upload(c, g, step, "same.md", same) });
  const unkeyed = await upload(c, g, step, "same.md", same);
  let said = await c.ok(step, "document_edit", { path: s, upload: unkeyed });
  if (first(said) !== `edited: ${s} — v1 (no change)`) c.fail(step, said);
  await waiting(c, step, unkeyed);
  said = await c.ok(step, "document_edit", { path: s, upload: unkeyed, request_id: "same-1" });
  const recorded = (await c.sql.query<{ n: number }>("select count(*)::int as n from zz.doc_request where request_id = 'same-1'")).rows[0].n;
  const consumed = await rowOf(c, unkeyed);
  if (first(said) !== `edited: ${s} — v1 (no change)` || !consumed?.consumed || consumed.operation !== `document_edit ${s}` || recorded !== 1) {
    c.fail(step, `${said}; ${recorded} request rows; ${JSON.stringify({ ...consumed, body: !!consumed?.body })}`);
  }
  c.pass(step);
}

/** What each family reads back as, what an edit does to it, and what a receipt says of it. */
export async function families(c: Core, g: Gateway): Promise<void> {
  const I = await c.open("families");
  let step = "a .yaml opening with ---, a .csv and an .xml holding <script> are each stored byte for byte — read, stored revision and console read — and the panel is handed that body";
  const files: [string, Buffer][] = [
    ["list.yaml", utf8("---\n- one\n- two: 2\n")],
    ["data.csv", utf8("id,note\r\n1,\"<b>bold</b>, quoted\"\r\n2,\r\n")],
    ["feed.xml", utf8('<?xml version="1.0"?>\n<feed>\n<script>alert(document.cookie)</script>\n</feed>\n')],
  ];
  const panels: Record<string, string> = {};
  for (const [name, bytes] of files) {
    const d = `${I}/${name.replace(".", "-")}.md`;
    await c.ok(step, "document_write", { path: d, upload: await upload(c, g, step, name, bytes) });
    await exact(c, g, step, d, bytes);
    const env = await c.mcp.rpc("tools/call", { name: "document_present", arguments: { path: d } });
    const panel = (env.result?._meta?.["zz-core/documents"] as { body?: string }[] | undefined)?.[0];
    // COUPLED: `presentedBody` (review-context.ts) — a presentation shows the body without the
    // blank space around it, the rule its snapshot identity is taken by.
    if (panel?.body !== bytes.toString("utf8").trim()) c.fail(step, `the panel was handed ${JSON.stringify(panel?.body?.slice(0, 200))} for ${name}`);
    panels[name] = panel.body;
  }
  c.pass(step);

  step = "the panel's renderer shows the .xml's <script> as text and runs none";
  const { renderMarkdown } = (await import(pathToFileURL(join(root, "services/zz-core/app/render.ts")).href)) as
    { renderMarkdown: (body: string) => { html: string } };
  const html = renderMarkdown(panels["feed.xml"]).html;
  if (/<script/i.test(html) || !html.includes("&lt;script&gt;alert(document.cookie)&lt;/script&gt;")) c.fail(step, html.slice(0, 400));
  c.pass(step);

  // COUPLED: zz-stack-dashboard renders a document's body through Prose — react-markdown with no
  // raw-HTML plugin, so `<script>` is text, and URLs through `safeMarkdownUrl`. Cited, not run: the
  // dashboard's own check holds it, and checks/document-panel.ts already needs the checkout here.
  step = "the console renders that body through the dashboard's safe markdown — Prose with no raw-HTML plugin, URLs through safeMarkdownUrl (cited)";
  const dash = join(root, "..", "zz-stack-dashboard", "src");
  const prose = join(dash, "components/patterns/prose/index.tsx");
  const policy = join(dash, "lib/safe-markdown.ts");
  if (!existsSync(prose) || !existsSync(policy)) c.fail(step, `the dashboard is not checked out beside this repository (${dash})`);
  const proseText = readFileSync(prose, "utf8");
  if (/rehype-raw|rehypePlugins/.test(proseText) || !/<ReactMarkdown [^>]*urlTransform=\{safeMarkdownUrl\}/.test(proseText)) {
    c.fail(step, "Prose renders raw HTML, or no longer routes URLs through safeMarkdownUrl");
  }
  c.pass(step);

  step = "an edits change to a document holding a literal CSV, and to one holding a non-envelope YAML, applies exactly";
  for (const [name, find, replace] of [["data.csv", "2,\r\n", "2,two\r\n"], ["list.yaml", "- one\n", "- uno\n"]]) {
    const d = `${I}/${name.replace(".", "-")}.md`;
    const was = files.find(([n]) => n === name)![1].toString("utf8");
    await c.ok(step, "document_edit", { path: d, edits: [{ find, replace }] });
    await exact(c, g, step, d, utf8(was.replace(find, replace)));
  }
  c.pass(step);

  step = "an envelope-shaped .yaml upload is refused into a document by name with its way out, left unconsumed, and source_add takes it byte for byte";
  const shaped = utf8("---\nkey: value\n---\nrest: here\n");
  const id = await upload(c, g, step, "config.yaml", shaped);
  await c.refused(step, "document_write", { path: `${I}/config.md`, upload: id },
    /^ERROR: UNSUPPORTED_METADATA — "config\.yaml" opens with .*source_add with this `upload`.*start the file with another line/s);
  await waiting(c, step, id);
  await exact(c, g, step, await c.source(step, { initiative: I, title: "Config", upload: id }), shaped);
  c.pass(step);

  step = "the receipt's details name how the file was staged and by whom: token by the person, link by nobody";
  const tokenSaid = await c.ok(step, "document_write", { path: `${I}/by-token.md`, upload: await upload(c, g, step, "by-token.md", utf8("# Token\n")) });
  const s = await start(c, step, "by-link.md");
  const linkBytes = utf8("# Link\n");
  const staged = await g.send("PUT", new URL(s.link).pathname, { body: linkBytes, headers: { "x-filename": "by-link.md" } });
  if (staged.status !== 200) c.fail(step, `the link answered ${staged.status}`);
  const linkSaid = await c.ok(step, "document_write", { path: `${I}/by-link.md`, upload: s.upload });
  const detailsOf = async (said: string, path: string) =>
    c.ok(step, "document_read", { path, details_ref: /details: `(dr_[a-z2-7]{26})`/.exec(said)?.[1] ?? c.fail(step, `no details_ref in: ${said}`) });
  const byToken = await detailsOf(tokenSaid, `${I}/by-token.md`);
  const byLink = await detailsOf(linkSaid, `${I}/by-link.md`);
  if (!new RegExp(`^upload: up_[a-z2-7]{26} — "by-token\\.md", 8 bytes, sha256 [0-9a-f]{64}, staged via token by ${esc(c.email)}$`, "m").test(byToken)
      || !new RegExp(`^upload: ${s.upload} — "by-link\\.md", 7 bytes, sha256 ${sha(linkBytes)}, staged via link$`, "m").test(byLink)) {
    c.fail(step, `token details:\n${byToken}\nlink details:\n${byLink}`);
  }
  c.pass(step);
}
