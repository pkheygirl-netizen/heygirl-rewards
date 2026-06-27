import { describe, it, expect } from "vitest";
import { toCsv } from "./csv.server";

describe("toCsv", () => {
  it("writes header and quotes values containing commas/quotes", () => {
    const csv = toCsv(
      [{ name: 'Sara, K', pts: 1200, note: 'says "hi"' }],
      [
        { key: "name", header: "Name" },
        { key: "pts", header: "Points" },
        { key: "note", header: "Note" },
      ] as const,
    );
    expect(csv).toBe('Name,Points,Note\n"Sara, K",1200,"says ""hi"""');
  });

  it("handles empty rows", () => {
    const csv = toCsv([], [{ key: "a", header: "A" }] as const);
    expect(csv).toBe("A");
  });
});
