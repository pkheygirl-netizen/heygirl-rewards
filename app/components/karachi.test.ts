import { describe, expect, it } from "vitest";
import {
  fmtAge, fmtChange, fmtDate, fmtDateTime, fmtInt, fmtPercent, fmtPkr, fmtSigned, karachiDateToUtcIso,
  karachiLocalToUtcIso, parsePeriodKey, periodRange, startOfKarachiDay, tierLabel, utcIsoToKarachiDate,
  utcIsoToKarachiLocal,
} from "./karachi";

describe("Karachi time", () => {
  it("midnight in Karachi is 19:00 UTC the day before (R6)", () => {
    expect(karachiLocalToUtcIso("2026-11-16T00:00")).toBe("2026-11-15T19:00:00.000Z");
    expect(karachiLocalToUtcIso("2026-11-16T23:59")).toBe("2026-11-16T18:59:00.000Z");
  });

  it("round-trips a stored instant back to the same wall-clock text", () => {
    const iso = karachiLocalToUtcIso("2026-03-01T09:30")!;
    expect(utcIsoToKarachiLocal(iso)).toBe("2026-03-01T09:30");
  });

  it("rejects text that is not a real date and time", () => {
    for (const bad of ["", "tomorrow", "2026-02-31T10:00", "2026-13-01T10:00", "2026-01-01T24:00", "2026-01-01"]) {
      expect(karachiLocalToUtcIso(bad)).toBeNull();
    }
  });

  it("turns a calendar date into its start, or its exclusive end", () => {
    expect(karachiDateToUtcIso("2026-11-16", "start")).toBe("2026-11-15T19:00:00.000Z");
    expect(karachiDateToUtcIso("2026-11-16", "end")).toBe("2026-11-16T19:00:00.000Z");
    expect(utcIsoToKarachiDate("2026-11-16T19:00:00.000Z", "end")).toBe("2026-11-16");
    expect(utcIsoToKarachiDate("2026-11-15T19:00:00.000Z", "start")).toBe("2026-11-16");
    expect(karachiDateToUtcIso("16/11/2026")).toBeNull();
  });

  it("finds the start of the Karachi day for a late-evening UTC time", () => {
    // 20:00 UTC on the 15th is already 01:00 on the 16th in Karachi
    expect(startOfKarachiDay(new Date("2026-11-15T20:00:00Z")).toISOString()).toBe("2026-11-15T19:00:00.000Z");
    expect(startOfKarachiDay(new Date("2026-11-15T18:59:00Z")).toISOString()).toBe("2026-11-14T19:00:00.000Z");
  });
});

describe("periodRange", () => {
  const now = new Date("2026-11-16T10:00:00Z"); // 15:00 on 16 Nov in Karachi

  it("last 7 days ends at the end of today and is compared with the 7 days before", () => {
    const p = periodRange("7d", now);
    expect(p.to).toBe("2026-11-16T19:00:00.000Z");
    expect(p.from).toBe("2026-11-09T19:00:00.000Z");
    expect(p.prevTo).toBe(p.from);
    expect(p.prevFrom).toBe("2026-11-02T19:00:00.000Z");
  });

  it("this month starts on the 1st in Karachi and compares with the same days of last month", () => {
    const p = periodRange("month", now);
    expect(p.from).toBe("2026-10-31T19:00:00.000Z");
    expect(p.prevFrom).toBe("2026-09-30T19:00:00.000Z");
    expect(new Date(p.prevTo).getTime() - new Date(p.prevFrom).getTime())
      .toBe(new Date(p.to).getTime() - new Date(p.from).getTime());
  });

  it("the comparison never runs past the end of a shorter previous month", () => {
    const p = periodRange("month", new Date("2026-03-31T10:00:00Z"));
    expect(p.prevFrom).toBe("2026-01-31T19:00:00.000Z"); // 1 Feb
    expect(p.prevTo).toBe(p.from); // capped at 1 Mar
  });

  it("uses the Karachi month when UTC is still in the previous month", () => {
    // 20:00 UTC on 31 Oct is 01:00 on 1 Nov in Karachi
    expect(periodRange("month", new Date("2026-10-31T20:00:00Z")).from).toBe("2026-10-31T19:00:00.000Z");
  });

  it("falls back to 30 days for unknown keys, and allows 90 days only where asked", () => {
    expect(parsePeriodKey("nonsense")).toBe("30d");
    expect(parsePeriodKey(null)).toBe("30d");
    expect(parsePeriodKey("90d")).toBe("30d");
    expect(parsePeriodKey("90d", true)).toBe("90d");
    expect(parsePeriodKey("month")).toBe("month");
  });
});

describe("formatting", () => {
  it("formats dates and times in Karachi time", () => {
    expect(fmtDate("2026-11-15T20:30:00Z")).toBe("16 Nov 2026");
    expect(fmtDateTime("2026-11-15T20:30:00Z")).toBe("16 Nov 2026, 1:30 am");
    expect(fmtDateTime("2026-11-16T07:05:00Z")).toBe("16 Nov 2026, 12:05 pm");
    expect(fmtDate(null)).toBe("");
    expect(fmtDate("not a date")).toBe("");
  });

  it("formats numbers, money and change", () => {
    expect(fmtInt(1234567)).toBe("1,234,567");
    expect(fmtInt(-4500)).toBe("-4,500");
    expect(fmtInt(null)).toBe("0");
    expect(fmtPkr(386000)).toBe("Rs.386,000");
    expect(fmtSigned(250)).toBe("+250");
    expect(fmtSigned(-250)).toBe("-250");
    expect(fmtPercent(0.1449)).toBe("14%");
    expect(fmtPercent(Number.NaN)).toBe("0%");
    expect(fmtChange(112, 100)).toEqual({ text: "up 12% on previous period", tone: "up" });
    expect(fmtChange(50, 100).tone).toBe("down");
    expect(fmtChange(5, 0).text).toBe("no earlier data to compare");
    expect(fmtChange(0, 0).text).toBe("no change");
  });

  it("describes ages and tiers", () => {
    const now = new Date("2026-11-16T10:00:00Z");
    expect(fmtAge("2026-11-16T09:58:00Z", now)).toBe("2 minutes");
    expect(fmtAge("2026-11-16T07:00:00Z", now)).toBe("3 hours");
    expect(fmtAge("2026-11-19T10:00:00Z", now)).toBe("3 days");
    expect(tierLabel("gold")).toBe("Gold");
    expect(tierLabel("unknown")).toBe("Silver");
  });
});
