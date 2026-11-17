import { describe, it, expect } from "vitest";
import { activeMultiplier, bestCode, discountUrl, esc, fmt, pointsFor, tierProgress } from "./shared";
import { CACHE_PREFIX, purgeCache, readCache, writeCache } from "./member-cache";
import { makeConfig, makeMember } from "./test-fixtures";

const T0 = Date.parse("2026-11-16T10:00:00Z");
const campaign = { name: "11.11", multiplier: 2, startsAt: "2026-11-10T00:00:00Z", endsAt: "2026-11-20T00:00:00Z" };

describe("shared helpers", () => {
  it("formats with western grouping and escapes html", () => {
    expect(fmt(100000)).toBe("100,000");
    expect(fmt(-1500)).toBe("-1,500");
    expect(fmt(999)).toBe("999");
    expect(esc(`<b a="1">'&`)).toBe("&lt;b a=&quot;1&quot;&gt;&#39;&amp;");
  });

  it("applies the campaign multiplier only inside its dates", () => {
    const cfg = makeConfig({ campaign });
    expect(activeMultiplier(cfg, T0)).toBe(2);
    expect(activeMultiplier(cfg, Date.parse("2026-11-09T23:59:59Z"))).toBe(1);
    expect(activeMultiplier(cfg, Date.parse("2026-11-20T00:00:01Z"))).toBe(1);
    expect(activeMultiplier(makeConfig(), T0)).toBe(1);
  });

  it("computes floor(rupees x rate x multiplier) from paisa", () => {
    expect(pointsFor(249950, makeConfig(), T0)).toBe(2499);
    expect(pointsFor(249950, makeConfig({ campaign }), T0)).toBe(4999);
    expect(pointsFor(250000, makeConfig({ campaign: { ...campaign, multiplier: 1.2 } }), T0)).toBe(3000);
    const off = makeConfig();
    off.earnRules.purchase.enabled = false;
    expect(pointsFor(249950, off, T0)).toBe(0);
  });

  it("tier progress uses the real thresholds, not the nudge distances", () => {
    const tiers = { gold: 50000, diamond: 100000 };
    expect(tierProgress(5000, "silver", tiers)).toMatchObject({ next: "gold", pct: 10, remaining: 45000, target: 50000 });
    expect(tierProgress(75000, "gold", tiers)).toMatchObject({ next: "diamond", pct: 50, remaining: 25000 });
    expect(tierProgress(200000, "diamond", tiers)).toMatchObject({ next: null, pct: 100, remaining: 0 });
    // Tiers are never taken away: a Gold member below the Gold line stays Gold.
    expect(tierProgress(10000, "gold", tiers)).toMatchObject({ tier: "gold", next: "diamond", pct: 0 });
  });

  it("builds a safe discount link and picks the best code", () => {
    expect(discountUrl("REWARD-AB12", "/cart?x=1")).toBe("/discount/REWARD-AB12?redirect=%2Fcart%3Fx%3D1");
    expect(discountUrl("A", "//evil.example")).toBe("/discount/A?redirect=%2F");
    expect(bestCode([{ discountPkr: 0 }, { discountPkr: 250 }, { discountPkr: 100 }])).toEqual({ discountPkr: 250 });
    expect(bestCode([])).toBeNull();
  });
});

function fakeStorage(): Storage {
  const m = new Map<string, string>();
  return {
    get length() { return m.size; },
    key: (i: number) => Array.from(m.keys())[i] ?? null,
    getItem: (k: string) => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
    clear: () => m.clear(),
  };
}

describe("member cache", () => {
  it("is keyed by customer id and lasts five minutes", () => {
    const s = fakeStorage();
    const d = makeMember();
    writeCache(s, "42", d, T0);
    expect(readCache(s, "42", T0 + 4 * 60_000)).toEqual(d);
    expect(readCache(s, "42", T0 + 5 * 60_000 + 1)).toBeNull();
    expect(readCache(s, "43", T0)).toBeNull();
  });

  it("drops other customers' entries, and everything on sign-out", () => {
    const s = fakeStorage();
    writeCache(s, "42", makeMember(), T0);
    writeCache(s, "43", makeMember(), T0);
    s.setItem("unrelated", "1");
    purgeCache(s, "42");
    expect(s.getItem(CACHE_PREFIX + "43")).toBeNull();
    expect(s.getItem(CACHE_PREFIX + "42")).not.toBeNull();
    purgeCache(s, null);
    expect(s.getItem(CACHE_PREFIX + "42")).toBeNull();
    expect(s.getItem("unrelated")).toBe("1");
  });

  it("ignores corrupt entries", () => {
    const s = fakeStorage();
    s.setItem(CACHE_PREFIX + "42", "{not json");
    expect(readCache(s, "42", T0)).toBeNull();
  });
});
