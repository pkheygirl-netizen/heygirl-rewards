import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { redemptionDraftChanges, redemptionDraftText, redemptionEditorKey } from "./redemption-draft";

const SAVED = [{ points: 3000, discount_pkr: 100 }, { points: 22000, discount_pkr: 1000 }];
const row = (points: string, discount_pkr: string, hidden = false) => ({ points, discount_pkr, hidden });

describe("ways to redeem: unsaved changes are hard to miss (item 7)", () => {
  it("a reward added but not saved is named in plain words", () => {
    const rows = [row("3000", "100"), row("22000", "1000"), row("50000", "2500")];
    expect(redemptionDraftChanges(rows, SAVED)).toEqual({ added: 1, changed: 0, removed: 0 });
    expect(redemptionDraftText(rows, SAVED)).toBe("1 new reward not saved yet. Customers will not see this change until you press Save rewards.");
    expect(redemptionDraftText([row("3000", "100"), row("22000", "900", true)], SAVED)).toContain("1 changed reward");
    expect(redemptionDraftText([row("3000", "100")], SAVED)).toContain("1 removed reward");
    expect(redemptionDraftText([row("3000", "100"), row(" 22000 ", "1000")], SAVED)).toBe("");
  });

  it("saving another setting no longer rebuilds the editor (which threw unsaved rows away)", () => {
    expect(redemptionEditorKey(SAVED)).toBe(redemptionEditorKey(SAVED.map((t) => ({ ...t }))));
    expect(redemptionEditorKey(SAVED)).not.toBe(redemptionEditorKey([...SAVED, { points: 50000, discount_pkr: 2500 }]));
    const page = readFileSync("app/routes/app.program.tsx", "utf8");
    expect(page).toContain("key={redemptionEditorKey(d.redemptionTiers)}");
    expect(page).not.toContain("key={`redeem-${d.version}`}");
    // banner with its own Save button, and a warning before leaving the page
    expect(page).toContain('title="Unsaved changes to ways to redeem"');
    expect(page).toMatch(/action=\{\{ content: "Save rewards", onAction: \(\) => props\.onSave\(rows\)/);
    expect(page).toMatch(/window\.addEventListener\("beforeunload", warn\)/);
  });
});
