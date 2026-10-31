/**
 * What one tool result does to the documents the panel already holds. Its own module so the rule can be checked
 * without a page (checks/document-panel.ts).
 *
 *   - "replace": the result brings documents, and the panel draws them;
 *   - "keep": the assistant read on in parts, and the document the person is reading stays;
 *   - "offer": the assistant read a part and the panel holds nothing, so it offers to open the whole document —
 *     never claiming one is shown somewhere else;
 *   - "none": nothing to draw, and no part was read.
 */
type Arrival = "replace" | "keep" | "offer" | "none";

export function arrival(held: number, incoming: number, reading: boolean): Arrival {
  if (incoming > 0) return "replace";
  if (!reading) return "none";
  return held > 0 ? "keep" : "offer";
}
