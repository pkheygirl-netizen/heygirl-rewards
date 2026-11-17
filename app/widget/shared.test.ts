import { describe, it, expect } from "vitest";
import { activeCampaign, activeMultiplier, bestCode, campaignNote, discountUrl, esc, fmt, isFinalReferralReply, parsePendingRef, pointsFor, rateText, REF_MAX_AGE_MS, REF_MAX_TRIES, tierProgress } from "./shared";
import { CACHE_PREFIX, earnsNothing, NO_EARN_PREFIX, purgeCache, readCache, readNoEarn, writeCache, writeNoEarn } from "./member-cache";
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

describe("review fixes: shared helpers", () => {
  it("item 5: prints the earning rate without rounding it", () => {
    expect(rateText(1)).toBe("1 point for every Rs. 1 spent");
    expect(rateText(2)).toBe("2 points for every Rs. 1 spent");
    expect(rateText(0.5)).toBe("1 point for every Rs. 2 spent");
    expect(rateText(0.01)).toBe("1 point for every Rs. 100 spent");
    expect(rateText(0.3)).toBe("0.3 points for every Rs. 1 spent");
    expect(rateText(1.5)).toBe("1.5 points for every Rs. 1 spent");
    expect(rateText(0)).toBe("");
  });

  it("item 11: the script picks the campaign in force from current AND next", () => {
    const next = { name: "Black Friday", multiplier: 3, startsAt: "2026-11-20T00:00:01Z", endsAt: "2026-11-30T00:00:00Z" };
    const cfg = makeConfig({ campaign, nextCampaign: next });
    expect(activeCampaign(cfg, T0)!.name).toBe("11.11");
    const later = Date.parse("2026-11-21T00:00:00Z"); // first one over, no save since
    expect(activeCampaign(cfg, later)!.name).toBe("Black Friday");
    expect(activeMultiplier(cfg, later)).toBe(3);
    expect(pointsFor(100000, cfg, later)).toBe(3000);
    expect(campaignNote(cfg, later)).toBe("Black Friday: 3x points until 30 Nov 2026");
    expect(campaignNote(cfg, Date.parse("2026-12-01T00:00:00Z"))).toBe("");
    expect(activeCampaign(makeConfig(), T0)).toBeNull();
  });

  it("item 1: the referral slug is forgotten only on a final answer", () => {
    for (const status of ["recorded", "duplicate", "not_eligible", "already_referred"]) expect(isFinalReferralReply(200, { ok: false, status })).toBe(true);
    for (const error of ["self_referral", "invalid_slug", "disabled"]) expect(isFinalReferralReply(200, { ok: false, error })).toBe(true);
    expect(isFinalReferralReply(400, { ok: false, error: "invalid_slug" })).toBe(true);
    expect(isFinalReferralReply(200, { ok: true, status: "recorded" })).toBe(true);
    // temporary: keep and retry
    expect(isFinalReferralReply(200, { ok: false, status: "try_again" })).toBe(false);
    expect(isFinalReferralReply(200, { ok: false, error: "not_a_member" })).toBe(false);
    expect(isFinalReferralReply(200, { ok: false, error: "program_disabled" })).toBe(false);
    expect(isFinalReferralReply(401, { ok: false, error: "unauthorized" })).toBe(false);
    expect(isFinalReferralReply(403, { ok: false, error: "not_signed_in" })).toBe(false);
    expect(isFinalReferralReply(429, { ok: false, error: "rate_limited" })).toBe(false);
    expect(isFinalReferralReply(500, { ok: false, error: "server_error" })).toBe(false);
    expect(isFinalReferralReply(200, null)).toBe(false);
  });

  it("item 1: a stored slug expires after 30 days or too many tries", () => {
    expect(parsePendingRef(JSON.stringify({ s: "sara-9999", t: T0, n: 3 }), T0 + 1000)).toEqual({ s: "sara-9999", t: T0, n: 3 });
    expect(parsePendingRef("sara-9999", T0)).toEqual({ s: "sara-9999", t: T0, n: 0 }); // value written by the old widget
    expect(parsePendingRef(JSON.stringify({ s: "sara-9999", t: T0, n: 0 }), T0 + REF_MAX_AGE_MS + 1)).toBeNull();
    expect(parsePendingRef(JSON.stringify({ s: "sara-9999", t: T0, n: REF_MAX_TRIES }), T0)).toBeNull();
    expect(parsePendingRef(JSON.stringify({ s: "<script>", t: T0, n: 0 }), T0)).toBeNull();
    expect(parsePendingRef(null, T0)).toBeNull();
  });
});

describe("review fixes: cache", () => {
  it("item 4: remembers a paused program / missing member for the cache lifetime", () => {
    const s = fakeStorage();
    writeCache(s, "42", { member: null, state: "not_enrolled" }, T0);
    expect(readCache(s, "42", T0 + 60_000)).toEqual({ member: null, state: "not_enrolled" });
    expect(readCache(s, "42", T0 + 5 * 60_000 + 1)).toBeNull();
    writeCache(s, "42", { member: null, state: "paused" }, T0);
    expect(readCache(s, "42", T0)).toEqual({ member: null, state: "paused" });
  });

  it("item 6: opted-out and blocked members are flagged as earning nothing, per customer", () => {
    expect(earnsNothing(makeMember({ optedOut: true }))).toBe(true);
    expect(earnsNothing(makeMember({ blocked: true }))).toBe(true);
    expect(earnsNothing(makeMember())).toBe(false);
    expect(earnsNothing({ member: null, state: "paused" })).toBe(false);
    expect(earnsNothing(null)).toBe(false);
    const s = fakeStorage();
    writeNoEarn(s, "42", true);
    expect(readNoEarn(s, "42")).toBe(true);
    expect(readNoEarn(s, "43")).toBe(false);
    writeCache(s, "42", makeMember({ optedOut: true }), T0);
    // the flag outlives the five-minute payload cache
    expect(readCache(s, "42", T0 + 10 * 60_000)).toBeNull();
    expect(readNoEarn(s, "42")).toBe(true);
    purgeCache(s, "43"); // another customer signs in
    expect(s.getItem(NO_EARN_PREFIX + "42")).toBeNull();
    writeNoEarn(s, "43", true);
    writeNoEarn(s, "43", false);
    expect(readNoEarn(s, "43")).toBe(false);
  });
});
