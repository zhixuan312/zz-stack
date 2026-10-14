/**
 * Releases: one row per released platform version, what its changelog published and what a client
 * has to do about it.
 *
 * `scripts/release-record.ts` is the only writer. The release records its own version once its tag
 * is written, and passes every earlier tag with it, so the releases before this table are recorded
 * by the first release that has it. A row is written once and a retry leaves it alone; the one
 * rewrite is `node scripts/release-record.ts --correct <version>`, which an operator runs when a
 * release meets a row that disagrees with its changelog.
 */
import type { TableTarget } from "../scripts/schema/types.ts";

export const RELEASE: Record<string, TableTarget> = {
  release: {
    columns: [
      [
        "version",
        "text",
        false,
        null,
      ],
      [
        "console_version",
        "text",
        true,
        null,
      ],
      [
        "released_at",
        "timestamp with time zone",
        false,
        null,
      ],
      [
        "summary",
        "text",
        false,
        null,
      ],
      [
        "changelog",
        "text",
        false,
        null,
      ],
      [
        "upgrade_notes",
        "text",
        true,
        null,
      ],
      [
        "client_action",
        "text",
        true,
        null,
      ],
    ],
    primaryKey: [
      "version",
    ],
    uniques: [],
    foreignKeys: [],
    checks: [],
    indexes: [],
    comment: "class=current_state; authority=this; question=which platform versions were released, when were they tagged, and what did each one's changelog publish and ask of a client, one row per version written by the release once its tag exists and rewritten only by an operator's explicit correction?",
    columnComments: {
      version: "class=current_state; authority=this; question=which platform version this row records, the v-tag's name without its v?",
      console_version: "class=current_state; authority=this; question=which console version shipped with it, from a console version in the changelog heading or a zz-stack-dashboard subsection, null when the section names none?",
      released_at: "class=current_state; authority=this; question=when was the version's tag created, historical timing evidence for the release and not a measured deployment time, never moved by a retry?",
      summary: "class=current_state; authority=this; question=what one line says what the release did, read from its changelog section, or No changelog entry for a tag with no section?",
      changelog: "class=current_state; authority=this; question=what did the release publish, its changelog section as Markdown without its heading, or No changelog entry for a tag with no section?",
      upgrade_notes: "class=current_state; authority=this; question=what upgrade notes did the section publish, null when it has none?",
      client_action: "class=current_state; authority=this; question=what must a client do for this release, null when the section has no upgrade notes and so nothing is to be done, and Unknown — no recorded upgrade notes for a tag with no section?",
    },
  },
};
