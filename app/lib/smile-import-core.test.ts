import { describe, expect, it } from "vitest";
import {
  CsvParser, SMILE_HEADER, computeTotals, mapVipTier, normaliseEmail, parseCsv, parseCsvStream, parsePoints,
  planFile, toReportLine, validateHeader, type TotalsRow,
} from "./smile-import-core";
import { toCsv } from "./csv.server";
import { REPORT_COLUMNS } from "./smile-import-core";

const HEAD = SMILE_HEADER.join(",");
const line = (id: string, email: string, points: string, over: { status?: string; vip?: string } = {}) =>
  `${id},Test,Person,${email},${over.status ?? "member"},${points},https://example.test/r,${over.vip ?? ""},1990-01-01`;

describe("CSV parser", () => {
  it("reads quoted commas, doubled quotes and line breaks inside quotes", () => {
    expect(parseCsv('a,"b,c","say ""hi""","two\nlines"\n1,2,3,4\n')).toEqual([
      ["a", "b,c", 'say "hi"', "two\nlines"],
      ["1", "2", "3", "4"],
    ]);
  });

  it("strips a byte-order mark and accepts CRLF, LF and a missing final line break", () => {
    expect(parseCsv("﻿x,y\r\n1,2\r\n3,4")).toEqual([["x", "y"], ["1", "2"], ["3", "4"]]);
    expect(parseCsv("x,y\n1,2\n")).toEqual([["x", "y"], ["1", "2"]]);
  });

  it("keeps empty fields and skips blank lines", () => {
    expect(parseCsv('a,,c\n\n"",x,\n')).toEqual([["a", "", "c"], ["", "x", ""]]);
  });

  it("gives the same result whatever the chunk boundaries are", () => {
    const text = '﻿id,name,pts\r\n1,"Khan, A","12,500"\r\n2,"say ""x""",0\r\n';
    const whole = parseCsv(text);
    for (let size = 1; size <= 7; size++) {
      const p = new CsvParser();
      const got: string[][] = [];
      for (let i = 0; i < text.length; i += size) got.push(...p.push(text.slice(i, i + size)));
      got.push(...p.end());
      expect(got).toEqual(whole);
    }
  });

  it("decodes a byte stream, including a multi-byte character split across chunks", async () => {
    const bytes = new TextEncoder().encode('﻿a,b\nعائشہ,"1,000"\n');
    const chunks = [bytes.slice(0, 9), bytes.slice(9, 10), bytes.slice(10)];
    const got: string[][] = [];
    for await (const rec of parseCsvStream(chunks)) got.push(rec);
    expect(got).toEqual([["a", "b"], ["عائشہ", "1,000"]]);
  });

  it("refuses a file that ends inside a quoted field", () => {
    expect(() => parseCsv('a,"unfinished')).toThrow(/quoted field/);
  });
});

describe("field rules", () => {
  it("parses points with thousands separators, negatives and blanks", () => {
    expect(parsePoints("12,500")).toBe(12500);
    expect(parsePoints(" 1,234,567 ")).toBe(1234567);
    expect(parsePoints("-300")).toBe(-300);
    expect(parsePoints("0")).toBe(0);
    expect(parsePoints("")).toBe(0);
    expect(parsePoints("1,250.00")).toBe(1250);
    expect(parsePoints("12.5")).toBeNull();
    expect(parsePoints("abc")).toBeNull();
    expect(parsePoints("=1+1")).toBeNull();
  });

  it("normalises e-mails and maps VIP tier names", () => {
    expect(normaliseEmail("  Ayesha@Example.COM ")).toBe("ayesha@example.com");
    expect(normaliseEmail("   ")).toBeNull();
    expect(mapVipTier("HeyGirl GOLD")).toBe("gold");
    expect(mapVipTier("Diamond Girl")).toBe("diamond");
    expect(mapVipTier("Silver")).toBeNull();
    expect(mapVipTier("")).toBeNull();
  });

  it("accepts only the exact Smile header", () => {
    expect(validateHeader([...SMILE_HEADER]).ok).toBe(true);
    expect(validateHeader(["Email", "Points"]).ok).toBe(false);
    expect(validateHeader(undefined).ok).toBe(false);
  });
});

describe("file plan", () => {
  const plan = (lines: string[]) => {
    const res = planFile(parseCsv([HEAD, ...lines].join("\r\n")));
    if (!res.ok) throw new Error(res.error);
    return res.rows;
  };

  it("rejects a file with another header", () => {
    expect(planFile(parseCsv("Email,Points\na@b.co,5")).ok).toBe(false);
  });

  it("clamps a negative balance to 0 and keeps the file value", () => {
    const [row] = plan([line("1", "a@example.com", "-250")]);
    expect(row).toMatchObject({ state: "pending", file_points: -250, points: 0 });
  });

  it("imports zero-point rows and keeps quoted thousands", () => {
    const rows = plan([line("1", "a@example.com", "0", { status: "candidate" }), line("2", "b@example.com", '"12,500"')]);
    expect(rows.map((r) => [r.state, r.points, r.smile_status])).toEqual([["pending", 0, "candidate"], ["pending", 12500, "member"]]);
  });

  it("sends rows with no e-mail or a broken e-mail to unmatched", () => {
    const rows = plan([line("1", "", "500"), line("2", "not-an-email", "10"), line("3", "   ", "0")]);
    expect(rows.map((r) => [r.state, r.reason])).toEqual([
      ["unmatched", "no_email"], ["unmatched", "invalid_email"], ["unmatched", "no_email"],
    ]);
  });

  it("keeps the duplicate e-mail with the most points (case and spaces ignored), never the sum", () => {
    const rows = plan([
      line("1", "dup@example.com", "100"),
      line("2", " DUP@Example.com ", '"2,000"'),
      line("3", "dup@example.com", '"2,000"'),
      line("4", "dup@example.com", "50"),
    ]);
    expect(rows.map((r) => r.state)).toEqual(["duplicate", "pending", "duplicate", "duplicate"]);
    expect(rows.filter((r) => r.state === "pending").reduce((s, r) => s + r.points, 0)).toBe(2000);
    expect(rows[0].reason).toBe("duplicate_email");
  });

  it("marks unreadable rows invalid without stopping", () => {
    const rows = plan(["1,only,three", line("", "a@example.com", "5"), line("7", "b@example.com", "lots"), line("8", "c@example.com", "1"), line("8", "d@example.com", "1")]);
    expect(rows.map((r) => r.reason)).toEqual(["wrong_column_count", "no_smile_id", "points_not_a_number", null, "duplicate_smile_id"]);
    expect(rows[3].state).toBe("pending");
  });

  it("stores no name, date of birth or referral url", () => {
    const [row] = plan([line("1", "a@example.com", "5")]);
    expect(JSON.stringify(row)).not.toMatch(/Test|Person|1990|example\.test/);
  });
});

describe("totals and reconciliation", () => {
  const row = (over: Partial<TotalsRow>): TotalsRow => ({
    state: "imported", reason: null, file_points: 0, points: 0, smile_status: "member", ...over,
  });

  it("explains every difference between the file total and the imported total", () => {
    const t = computeTotals([
      row({ file_points: 1000, points: 1000, points_awarded: 1000, member_existed: false }),
      row({ file_points: 0, points: 0, points_awarded: 0, member_existed: true, smile_status: "candidate" }),
      row({ file_points: -300, points: 0, points_awarded: 0, member_existed: false }),
      row({ state: "unmatched", reason: "no_email", file_points: 400, points: 400 }),
      row({ state: "unmatched", reason: "no_shopify_customer", file_points: 250, points: 250 }),
      row({ state: "duplicate", reason: "duplicate_email", file_points: 50, points: 50 }),
      row({ state: "skipped", reason: "already_imported", file_points: 70, points: 70, member_existed: true }),
      row({ state: "error", reason: "award_failed", file_points: 30, points: 30 }),
      row({ state: "invalid", reason: "points_not_a_number" }),
    ]);
    expect(t.rows).toBe(9);
    expect(t.invalid).toBe(1);
    expect(t.filePoints).toBe(1000 - 300 + 400 + 250 + 50 + 70 + 30);
    expect(t.importedPoints).toBe(1000);
    expect(t.imported).toBe(3);
    expect(t.matched).toBe(5);
    expect(t.membersToCreate).toBe(2);
    expect(t.membersToUpdate).toBe(1);
    expect(t.zeroPointMembers).toBe(2);
    const byKey = Object.fromEntries(t.differences.map((d) => [d.key, d.points]));
    expect(byKey).toEqual({ negative: -300, no_email: 400, no_shopify_customer: 250, duplicate_email: 50, already_imported: 70, error: 30 });
    expect(t.filePoints - t.importedPoints).toBe(t.differences.reduce((s, d) => s + d.points, 0));
    expect(t.unexplained).toBe(0);
    expect(t.byStatus).toMatchObject({ member: { rows: 7 }, candidate: { rows: 1, points: 0 } });
  });

  it("dry run: nothing imported yet, the whole total is waiting", () => {
    const t = computeTotals([
      row({ state: "matched", file_points: 500, points: 500, member_existed: false }),
      row({ state: "matched", file_points: 0, points: 0, member_existed: true }),
      row({ state: "pending", file_points: 20, points: 20 }),
    ]);
    expect(t).toMatchObject({ pointsToImport: 500, membersToCreate: 1, membersToUpdate: 1, waitingForLookup: 1, importedPoints: 0, unexplained: 0 });
    expect(t.differences).toEqual([{ key: "waiting", label: "Not imported yet", rows: 3, points: 520 }]);
  });

  it("flags a row that received fewer points than planned", () => {
    const t = computeTotals([row({ file_points: 100, points: 100, points_awarded: 60 })]);
    expect(t.differences).toEqual([expect.objectContaining({ key: "short", points: 40 })]);
    expect(t.unexplained).toBe(0);
  });
});

describe("report", () => {
  it("is safe against spreadsheet formulas in the e-mail and id columns", () => {
    const csv = toCsv(
      [toReportLine({ row_number: 1, smile_customer_id: "=HYPERLINK(1)", email: "+cmd@example.com", smile_status: "member", file_points: -5, state: "unmatched", reason: "no_shopify_customer" })],
      REPORT_COLUMNS,
    );
    const body = csv.split("\n")[1];
    expect(body.startsWith("2,'=HYPERLINK(1),'+cmd@example.com,member,-5,Unmatched,")).toBe(true);
  });
});
