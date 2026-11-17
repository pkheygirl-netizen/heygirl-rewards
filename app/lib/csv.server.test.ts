import { describe, expect, it } from "vitest";
import { csvResponse, fetchAllPages, neutraliseFormula, toCsv } from "./csv.server";

describe("toCsv", () => {
  it("writes header and quotes values containing commas/quotes", () => {
    const csv = toCsv(
      [{ name: "Sara, K", pts: 1200, note: 'says "hi"' }],
      [
        { key: "name", header: "Name" },
        { key: "pts", header: "Points" },
        { key: "note", header: "Note" },
      ] as const,
    );
    expect(csv).toBe('Name,Points,Note\n"Sara, K",1200,"says ""hi"""');
  });

  it("handles empty rows", () => {
    expect(toCsv([], [{ key: "a", header: "A" }] as const)).toBe("A");
  });

  it("neutralises text that a spreadsheet would run as a formula (R2)", () => {
    const csv = toCsv(
      [
        { name: "=HYPERLINK(\"http://evil\",\"x\")", pts: 1 },
        { name: "+92 300 1234567", pts: 2 },
        { name: "-cmd", pts: 3 },
        { name: "@SUM(A1)", pts: 4 },
        { name: "\t=1+1", pts: 5 },
      ],
      [{ key: "name", header: "Name" }, { key: "pts", header: "Points" }] as const,
    );
    const lines = csv.split("\n").slice(1);
    expect(lines[0].startsWith("\"'=HYPERLINK")).toBe(true);
    expect(lines[1]).toBe("+92 300 1234567,2"); // a plain phone number is left as typed (A7)
    expect(lines[2]).toBe("'-cmd,3");
    expect(lines[3]).toBe("'@SUM(A1),4");
    expect(lines[4].startsWith("'\t=1+1")).toBe(true);
  });

  it("does not put an apostrophe on plain phone numbers, but still does on anything else starting with +", () => {
    for (const phone of ["+923001234567", "+92 300 1234567", "+92-300-123-4567", "+1 555 0100"]) {
      expect(neutraliseFormula(phone), phone).toBe(phone);
    }
    for (const risky of ["+1+1", "+SUM(A1)", "+92300*2", "+", "+ 92300", "+92300;=1", "+A1", "+92300\t=1", "+92(300)", "+92300=1"]) {
      expect(neutraliseFormula(risky), risky).toBe(`'${risky}`);
    }
    expect(neutraliseFormula("-923001234567")).toBe("'-923001234567");
  });

  it("leaves number cells alone, so negative points stay numbers", () => {
    const csv = toCsv([{ name: "Sara", pts: -6000 }], [{ key: "name", header: "Name" }, { key: "pts", header: "Points" }] as const);
    expect(csv).toBe("Name,Points\nSara,-6000");
    expect(neutraliseFormula("Sara")).toBe("Sara");
  });

  it("writes blanks for null and yes/no for booleans", () => {
    const csv = toCsv([{ a: null, b: true, c: false, d: undefined }], [
      { key: "a", header: "A" }, { key: "b", header: "B" }, { key: "c", header: "C" }, { key: "d", header: "D" },
    ] as const);
    expect(csv).toBe("A,B,C,D\n,yes,no,");
  });
});

describe("csvResponse", () => {
  it("sends a download with a safe filename and no caching", async () => {
    const res = csvResponse('bad"name\n.csv', "a,b");
    expect(res.headers.get("Content-Disposition")).toBe('attachment; filename="bad_name_.csv"');
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(await res.text()).toContain("a,b");
  });
});

describe("fetchAllPages", () => {
  it("keeps reading until an empty page, so nothing is cut off at 1,000 rows (R1)", async () => {
    const all = Array.from({ length: 2500 }, (_, i) => i);
    const ranges: Array<[number, number]> = [];
    const { rows, truncated } = await fetchAllPages<number>(async (from, to) => {
      ranges.push([from, to]);
      return { data: all.slice(from, to + 1), error: null };
    });
    expect(rows).toHaveLength(2500);
    expect(truncated).toBe(false);
    expect(ranges).toEqual([[0, 999], [1000, 1999], [2000, 2999], [2500, 3499]]);
  });

  it("a short page is not the end: a server that caps each request at 400 rows still exports everything (A8)", async () => {
    const all = Array.from({ length: 1050 }, (_, i) => i);
    const ranges: Array<[number, number]> = [];
    const { rows, truncated } = await fetchAllPages<number>(async (from, to) => {
      ranges.push([from, to]);
      return { data: all.slice(from, Math.min(to + 1, from + 400)), error: null }; // never more than 400 at once
    });
    expect(rows).toEqual(all); // complete, in order, no row twice
    expect(truncated).toBe(false);
    expect(ranges.map((r) => r[0])).toEqual([0, 400, 800, 1050]);
  });

  it("an empty result is one request and no rows", async () => {
    let calls = 0;
    const res = await fetchAllPages<number>(async () => { calls++; return { data: [], error: null }; });
    expect(res).toEqual({ rows: [], truncated: false });
    expect(calls).toBe(1);
  });

  it("stops at the cap and says the export was cut", async () => {
    const { rows, truncated } = await fetchAllPages<number>(
      async (from, to) => ({ data: Array.from({ length: to - from + 1 }, (_, i) => from + i), error: null }),
      { pageSize: 10, maxRows: 25 },
    );
    expect(rows).toHaveLength(25);
    expect(truncated).toBe(true);
  });

  it("throws when a page fails", async () => {
    await expect(fetchAllPages(async () => ({ data: null, error: { message: "boom" } }))).rejects.toThrow("boom");
  });
});
