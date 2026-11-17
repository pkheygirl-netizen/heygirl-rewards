import { beforeEach, describe, expect, it, vi } from "vitest";

const send = vi.hoisted(() => ({ email: vi.fn(), whatsapp: vi.fn() }));
vi.mock("../db.server", async () => (await import("./testing/harness")).dbModule());
vi.mock("./email.service", async (orig) => ({ ...(await orig<typeof import("./email.service")>()), sendEmail: send.email }));
vi.mock("./whatsapp.service", async (orig) => ({
  ...(await orig<typeof import("./whatsapp.service")>()),
  getWhatsAppProvider: () => ({ name: "test", send: send.whatsapp }),
}));

import { h, resetHarness, seedMember } from "./testing/harness";
import { bustSettingsCache } from "./settings.server";
import { BRAND_GOLD } from "./email.service";
import {
  buildNotification,
  formatDatePk,
  NOTIFICATION_EVENTS,
  notifyMember,
  resolveEvent,
  rewardsPageUrl,
} from "./notifications.service";

const ctx = { programName: "HeyGirl.pk Rewards", firstName: "Sara", rewardsUrl: "https://www.example.com/pages/rewards" };
const sample: Record<string, Record<string, unknown>> = {
  welcome: { points: 1000 },
  points_earned: { points: 2500, reason: "Order #1001" },
  reward_code_issued: { code: "REWARD-ABC", discountPkr: 250, expiresAt: "2026-12-16T00:00:00Z", kind: "reward" },
  tier_upgrade: { newTier: "gold", codes: [{ code: "GOLD-1", freeShipping: true }] },
  birthday: { code: "BDAY-1", discountPkr: 500, expiresAt: "2026-12-01T00:00:00Z" },
  referral_completed: { points: 6000 },
  points_expiring: { expiringPoints: 1200, expiresAt: "2026-12-10T00:00:00Z" },
  review_released: { points: 3000 },
};

beforeEach(() => {
  resetHarness();
  bustSettingsCache();
  send.email.mockReset().mockResolvedValue({ sent: true });
  send.whatsapp.mockReset().mockResolvedValue({ sent: false, reason: "whatsapp_not_configured" });
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

describe("event list (rule 19)", () => {
  it("covers the eight events", () => {
    expect([...NOTIFICATION_EVENTS]).toEqual([
      "welcome", "points_earned", "reward_code_issued", "tier_upgrade", "birthday", "referral_completed", "points_expiring", "review_released",
    ]);
  });

  it.each(NOTIFICATION_EVENTS.map((e) => [e]))("%s uses the one branded layout", (event) => {
    const n = buildNotification(event, sample[event], ctx);
    expect(n.subject.length).toBeGreaterThan(5);
    expect(n.html).toContain("<!DOCTYPE html>");
    expect(n.html).toContain('lang="en"');
    expect(n.html).toContain(BRAND_GOLD);
    expect(n.html).toContain("HeyGirl.pk Rewards");
    expect(n.html).toContain("Hi Sara,");
    expect(n.html).toContain("https://www.example.com/pages/rewards");
    expect(n.text).toContain("Hi Sara,");
    expect(n.whatsapp.template).toBe(`hg_${event}`);
    expect(n.whatsapp.params[0]).toBe("Sara");
  });

  it("content details", () => {
    expect(buildNotification("welcome", sample.welcome, ctx).subject).toContain("1,000 points");
    const reward = buildNotification("reward_code_issued", sample.reward_code_issued, ctx);
    expect(reward.html).toContain("REWARD-ABC");
    expect(reward.html).toContain("Rs. 250 off");
    expect(reward.html).toContain("16 December 2026");
    const friend = buildNotification("reward_code_issued", { code: "WELCOME-1", kind: "referral_friend" }, ctx);
    expect(friend.subject).toContain("free shipping");
    const tier = buildNotification("tier_upgrade", sample.tier_upgrade, ctx);
    expect(tier.subject).toBe("You are now a Gold member");
    expect(tier.html).toContain("Free shipping code: GOLD-1");
    expect(buildNotification("points_expiring", sample.points_expiring, ctx).subject).toContain("10 December 2026");
  });

  it("customer-supplied text is escaped; no button without a store address", () => {
    const n = buildNotification("welcome", { points: 5 }, { ...ctx, firstName: "<script>alert(1)</script>", rewardsUrl: null });
    expect(n.html).not.toContain("<script>");
    expect(n.html).toContain("&lt;script&gt;");
    expect(n.html).not.toContain("<a href");
  });

  it("dates are shown in Pakistan time", () => {
    expect(formatDatePk("2026-11-30T20:00:00Z")).toBe("1 December 2026"); // already 1 Dec in Karachi
    expect(formatDatePk("nonsense")).toBe("");
  });

  it("pre-v3 job names still resolve; unknown names do not", () => {
    expect(resolveEvent("redemption_confirmed")).toBe("reward_code_issued");
    expect(resolveEvent("expiry_warning")).toBe("points_expiring");
    expect(resolveEvent("birthday_reward")).toBe("birthday");
    expect(resolveEvent("welcome")).toBe("welcome");
    expect(resolveEvent("made_up")).toBeNull();
  });

  it("rewardsPageUrl needs an https STOREFRONT_URL", () => {
    expect(rewardsPageUrl({ STOREFRONT_URL: "https://www.heygirl.pk/" })).toBe("https://www.heygirl.pk/pages/rewards");
    expect(rewardsPageUrl({ STOREFRONT_URL: "http://x" })).toBeNull();
    expect(rewardsPageUrl({})).toBeNull();
  });
});

describe("notifyMember", () => {
  it("emails a member with an address; WhatsApp goes through the provider when there is a phone", async () => {
    const m = seedMember(h.db, { email: "sara@example.com", phone: "+923001234567", first_name: "Sara" });
    const r = await notifyMember(String(m.id), "welcome", { points: 1000 });
    expect(r).toEqual({ email: true, whatsapp: false });
    expect(send.email).toHaveBeenCalledWith(expect.objectContaining({ to: "sara@example.com", subject: expect.stringContaining("Welcome") }));
    expect(send.whatsapp).toHaveBeenCalledWith(expect.objectContaining({ to: "+923001234567", template: "hg_welcome" }));
  });

  it("phone-only member: no email attempted", async () => {
    const m = seedMember(h.db, { email: null, phone: "03001234567" });
    await notifyMember(String(m.id), "points_earned", { points: 10 });
    expect(send.email).not.toHaveBeenCalled();
    expect(send.whatsapp).toHaveBeenCalled();
  });

  it("nothing is sent to opted-out or redacted members, unknown members or unknown events", async () => {
    const out = seedMember(h.db, { opted_out: true, phone: "0300" });
    expect(await notifyMember(String(out.id), "welcome", {})).toMatchObject({ email: false, reason: "opted_out" });
    const redacted = seedMember(h.db, { email: "redacted-1@redacted.invalid" });
    expect(await notifyMember(String(redacted.id), "welcome", {})).toEqual({ email: false, whatsapp: false });
    expect(await notifyMember("missing", "welcome", {})).toMatchObject({ reason: "member_not_found" });
    expect(await notifyMember(String(out.id), "nope", {})).toMatchObject({ reason: "unknown_event" });
    expect(send.email).not.toHaveBeenCalled();
    expect(send.whatsapp).not.toHaveBeenCalled();
  });
});
