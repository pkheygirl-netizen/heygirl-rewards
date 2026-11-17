import { describe, it, expect } from "vitest";
import { earnList, errorText, guestHome, historyRows, instagramHandle, redeemList, referTab, rewardsTab, stateMessage, tiersView, type Ctx } from "./views";
import { makeConfig, makeMember } from "./test-fixtures";

const ctx = (over: Partial<Ctx> = {}): Ctx => ({ cfg: makeConfig(), member: null, loginUrl: "/customer_authentication/login", path: "/", origin: "https://shop.example", ...over });

describe("guest preview (config only)", () => {
  it("uses the login route, config numbers and the Refer & Earn heading", () => {
    const h = guestHome(ctx());
    expect(h).toContain('href="/customer_authentication/login"');
    expect(h).toContain("Refer &amp; Earn");
    expect(h).toContain("6,000 points");
    expect(h).toContain('data-go="earn"');
    expect(h).toContain('data-go="redeem"');
    expect(h).not.toMatch(/[\u{1F300}-\u{1FAFF}]/u); // no emoji icons
  });

  it("lists only enabled earn rules, with points from config", () => {
    const cfg = makeConfig({ signupPoints: 1500 });
    cfg.earnRules.review.enabled = false;
    cfg.social.facebook.enabled = false;
    const h = earnList(ctx({ cfg }));
    expect(h).toContain("1,500 points");
    expect(h).not.toContain("Post a review");
    expect(h).not.toContain("Facebook");
    expect(h).toContain("Follow on Instagram");
    expect(h).not.toContain("<button"); // guests get no action buttons
  });

  it("derives the review tag from the Instagram URL in settings", () => {
    expect(instagramHandle(makeConfig())).toBe("@heygirl.pk");
    expect(earnList(ctx())).toContain("tag @heygirl.pk");
  });
});

describe("member views", () => {
  it("social rows carry the profile URL to open before claiming", () => {
    const h = earnList(ctx({ member: makeMember({}, { social: { instagram: "available", facebook: "claimed", youtube: "available" } }) }));
    expect(h).toContain('data-act="social" data-p="instagram" data-url="https://instagram.com/heygirl.pk"');
    expect(h).not.toContain('data-p="facebook"');
  });

  it("shows birthday entry once, review claim only when eligible", () => {
    const can = earnList(ctx({ member: makeMember({ canSetBirthday: true }, { review: { eligible: true, pending: 0 } }) }));
    expect(can).toContain('data-form="birthday"');
    expect(can).toContain('data-act="review"');
    const set = earnList(ctx({ member: makeMember({ canSetBirthday: false, birthday: { month: 3, day: 12 } }) }));
    expect(set).not.toContain('data-form="birthday"');
    expect(set).toContain("12 March");
    expect(set).not.toContain('data-act="review"');
  });

  it("redeem buttons only on affordable tiers", () => {
    const h = redeemList(ctx({ member: makeMember({ pointsBalance: 4500 }) }));
    expect(h).toContain('data-act="redeem" data-points="3000" data-pkr="100"');
    expect(h).not.toContain('data-points="6000"');
    expect(h).toContain("1,500 more");
  });

  it("rewards tab shows pending points, next expiry and Refer & Earn above the link", () => {
    const m = makeMember({ pendingPoints: 1200 }, { nextExpiry: { points: 800, at: "2026-12-01T10:00:00Z" } });
    const h = rewardsTab(ctx({ member: m }));
    expect(h).toContain("1,200 points</strong> pending");
    expect(h).toContain("800 points</strong> will expire on 1 Dec 2026");
    expect(h.indexOf("Refer &amp; Earn")).toBeGreaterThan(-1);
    expect(h.indexOf("Refer &amp; Earn")).toBeLessThan(h.indexOf("https://shop.example/?ref=aisha-1234"));
  });

  it("tiers tab puts Your progress first and uses real thresholds", () => {
    const h = tiersView(ctx({ member: makeMember({ lifetimeSpendPkr: 5000 }) }));
    expect(h.indexOf("Your progress")).toBe(h.indexOf("<h3") + '<h3 class="hg-h">'.length);
    expect(h).toContain('aria-valuenow="10"');
    expect(h).toContain("Spend Rs. 45,000 more to reach Gold (Rs. 50,000 in total)");
    expect(h.indexOf("Your progress")).toBeLessThan(h.indexOf("Everyone starts here"));
  });

  it("refer tab renders for influencers and before the summary loads", () => {
    const m = makeMember({ isInfluencer: true });
    expect(() => referTab(ctx({ member: m }), null)).not.toThrow();
    const h = referTab(ctx({ member: m }), { rewardPoints: 9000, total: 3, completed: 1, pointsEarned: 9000, rows: [{ status: "pending", at: "2026-11-01T00:00:00Z" }] });
    expect(h).toContain("9,000 points");
    expect(h).toContain("Waiting for their first order");
    expect(h).toContain("Refer &amp; Earn");
  });

  it("history rows use readable labels, signs and only the customer note", () => {
    const h = historyRows([
      { id: "1", type: "referral_earned", label: "Friend referred", points: 6000, at: "2026-11-01T00:00:00Z", note: null },
      { id: "2", type: "refund_deduction", label: "Order refunded", points: -500, at: "2026-11-02T00:00:00Z", note: "Order #1001 <b>" },
    ]);
    expect(h).toContain("Friend referred");
    expect(h).toContain("+6,000");
    expect(h).toContain("−500");
    expect(h).toContain("Order #1001 &lt;b&gt;");
    expect(h).not.toContain("referral_earned");
  });

  it("gives opted-out and blocked members a clear state", () => {
    expect(stateMessage(ctx({ member: makeMember({ optedOut: true }) }))).toContain("opted out");
    expect(stateMessage(ctx({ member: makeMember({ blocked: true }) }))).toContain("on hold");
    expect(stateMessage(ctx())).toContain('data-act="retry"');
  });

  it("maps the single `error` field to a message, with a fallback", () => {
    expect(errorText("insufficient_points")).toContain("enough points");
    expect(errorText("something_new")).toContain("Something went wrong");
    expect(errorText(undefined)).toContain("Something went wrong");
  });
});
