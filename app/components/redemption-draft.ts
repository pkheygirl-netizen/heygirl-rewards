// app/components/redemption-draft.ts
// What is unsaved in the "Ways to redeem" editor (Program page). The editor
// only writes when "Save rewards" is pressed; on the dev store a reward added
// without pressing it never reached customers (owner report, 18 Nov 2026), so
// the page now says plainly what is not saved yet.
export type DraftRow = { points: string; discount_pkr: string; hidden: boolean };
export type SavedRow = { points: number; discount_pkr: number; hidden?: boolean };

const same = (a: DraftRow, b: SavedRow) =>
  a.points.trim() === String(b.points) && a.discount_pkr.trim() === String(b.discount_pkr) && a.hidden === (b.hidden === true);

/** Counts of rows added, changed and removed compared with what is saved. */
export function redemptionDraftChanges(rows: DraftRow[], saved: SavedRow[]): { added: number; changed: number; removed: number } {
  const added = Math.max(0, rows.length - saved.length);
  const removed = Math.max(0, saved.length - rows.length);
  let changed = 0;
  for (let i = 0; i < Math.min(rows.length, saved.length); i++) if (!same(rows[i], saved[i])) changed++;
  return { added, changed, removed };
}

/** One plain sentence for the unsaved-changes banner ("" when nothing is unsaved). */
export function redemptionDraftText(rows: DraftRow[], saved: SavedRow[]): string {
  const c = redemptionDraftChanges(rows, saved);
  const parts: string[] = [];
  if (c.added) parts.push(`${c.added} new reward${c.added === 1 ? "" : "s"}`);
  if (c.changed) parts.push(`${c.changed} changed reward${c.changed === 1 ? "" : "s"}`);
  if (c.removed) parts.push(`${c.removed} removed reward${c.removed === 1 ? "" : "s"}`);
  if (!parts.length) return "";
  return `${parts.join(", ")} not saved yet. Customers will not see ${c.added + c.changed + c.removed === 1 ? "this change" : "these changes"} until you press Save rewards.`;
}

/**
 * React key for the editor: the SAVED reward table, not the settings version.
 * Saving any other setting on the page changes the version; keyed on it, the
 * editor was rebuilt and silently threw away rows not saved yet.
 */
export function redemptionEditorKey(saved: SavedRow[]): string {
  return "redeem-" + JSON.stringify(saved.map((t) => [t.points, t.discount_pkr, t.hidden === true]));
}
