import { describe, expect, it } from "vitest";
import { vi } from "vitest";
import { FormReader, GENERIC_ERROR, UserError, errorMessage, firstError, invalid, reasonText } from "./admin-validate.server";
import { formOf } from "./admin-test-helpers";

describe("FormReader.int", () => {
  it("rejects blank instead of saving 0 (R3)", () => {
    const r = new FormReader(formOf({ signup_points: "" }));
    r.int("signup_points", "Points given", 0, 50000);
    expect(r.ok).toBe(false);
    expect(r.errors.signup_points).toBe("Points given is required.");
  });

  it("rejects a missing field, text, decimals and exponent notation", () => {
    for (const bad of ["abc", "12.5", "1e3", " ", "0x10", "1,000"]) {
      const r = new FormReader(formOf({ n: bad }));
      r.int("n", "N", 0, 100000);
      expect(r.ok, bad).toBe(false);
    }
    const missing = new FormReader(formOf({}));
    missing.int("n", "N", 0, 10);
    expect(missing.errors.n).toBe("N is required.");
  });

  it("rejects negatives and values above the maximum, naming the range", () => {
    const r = new FormReader(formOf({ a: "-5", b: "50001" }));
    r.int("a", "A", 0, 50000);
    r.int("b", "B", 0, 50000);
    expect(r.errors.a).toBe("A must be between 0 and 50,000.");
    expect(r.errors.b).toBe("B must be between 0 and 50,000.");
  });

  it("accepts the bounds and trims spaces", () => {
    const r = new FormReader(formOf({ a: " 0 ", b: "50000" }));
    expect(r.int("a", "A", 0, 50000)).toBe(0);
    expect(r.int("b", "B", 0, 50000)).toBe(50000);
    expect(r.ok).toBe(true);
  });
});

describe("FormReader other fields", () => {
  it("reads decimals with a limit on decimal places", () => {
    const r = new FormReader(formOf({ ok: "1.25", many: "1.255", neg: "-1", blank: "" }));
    expect(r.decimal("ok", "Rate", 0.1, 10, 2)).toBe(1.25);
    r.decimal("many", "Rate", 0.1, 10, 2);
    r.decimal("neg", "Rate", 0.1, 10, 2);
    r.decimal("blank", "Rate", 0.1, 10, 2);
    expect(Object.keys(r.errors).sort()).toEqual(["blank", "many", "neg"]);
  });

  it("refuses text that is too long rather than cutting it", () => {
    const r = new FormReader(formOf({ t: "x".repeat(11), req: "" }));
    expect(r.text("t", "Tagline", { max: 10 })).toBe("");
    r.text("req", "Name", { max: 10, required: true });
    expect(r.errors.t).toContain("10 characters or fewer");
    expect(r.errors.req).toBe("Name is required.");
  });

  it("accepts only http(s) links", () => {
    const r = new FormReader(formOf({ a: "https://instagram.com/heygirl.pk", b: "javascript:alert(1)", c: "instagram.com/x", d: "" }));
    expect(r.url("a", "Link")).toBe("https://instagram.com/heygirl.pk");
    r.url("b", "Link");
    r.url("c", "Link");
    expect(r.url("d", "Link")).toBe("");
    r.url("d", "Link", { required: true });
    expect(Object.keys(r.errors).sort()).toEqual(["b", "c", "d"]);
  });

  it("reads Karachi dates and times", () => {
    const r = new FormReader(formOf({ s: "2026-11-16T00:00", bad: "soon", d: "2026-11-16", none: "" }));
    expect(r.karachiDateTime("s", "Start")).toBe("2026-11-15T19:00:00.000Z");
    r.karachiDateTime("bad", "End");
    expect(r.karachiDate("d", "Date", "end")).toBe("2026-11-16T19:00:00.000Z");
    expect(r.karachiDate("none", "Date", "start")).toBeNull();
    expect(r.errors).toEqual({ bad: "End is not a valid date and time." });
  });

  it("reads booleans and choices", () => {
    const r = new FormReader(formOf({ on: "true", off: "false", dir: "remove", bad: "sideways" }));
    expect(r.bool("on")).toBe(true);
    expect(r.bool("off")).toBe(false);
    expect(r.bool("absent")).toBe(false);
    expect(r.oneOf("dir", "Direction", ["add", "remove"] as const)).toBe("remove");
    r.oneOf("bad", "Direction", ["add", "remove"] as const);
    expect(r.errors.bad).toBeTruthy();
  });

  it("keeps the first message for a field", () => {
    const r = new FormReader(formOf({}));
    r.fail("x", "first");
    r.fail("x", "second");
    expect(firstError(r.errors)).toBe("first");
    expect(invalid(r.errors)).toEqual({ ok: false, error: "first", errors: { x: "first" } });
  });
});

describe("messages", () => {
  it("turns service reasons into sentences and never shows a stack", () => {
    expect(reasonText("code_taken")).toContain("already in use");
    expect(reasonText("something_new", "Not saved.")).toBe("Not saved. (something new)");
    expect(reasonText(undefined, "Not saved.")).toBe("Not saved.");
  });

  it("never shows raw database or system error text to staff; it is logged instead (A10)", () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const raw = 'could not save the note: insert or update on table "staff_notes" violates foreign key constraint "staff_notes_member_id_fkey" DETAIL: Key (member_id)=(abc) is not present';
    expect(errorMessage(new Error(raw))).toBe(GENERIC_ERROR);
    expect(errorMessage(new Error(raw))).not.toMatch(/staff_notes|constraint|member_id/);
    expect(errorMessage("a thrown string with select * from members")).toBe(GENERIC_ERROR);
    expect(errorMessage({})).toBe(GENERIC_ERROR);
    // the detail is kept for the developer, on the server
    expect(log.mock.calls.some((c) => String(c[1]).includes("staff_notes_member_id_fkey"))).toBe(true);
    log.mockRestore();
  });

  it("shows a message that was written for staff", () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(errorMessage(new UserError("Write a note before saving."))).toBe("Write a note before saving.");
    expect(errorMessage(new UserError("x".repeat(500))).length).toBe(300);
    expect(log).not.toHaveBeenCalled();
    log.mockRestore();
  });
});
