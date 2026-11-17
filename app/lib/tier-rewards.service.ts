// app/lib/tier-rewards.service.ts
// Rule 9: on upgrade issue once: Gold -> free-shipping code, Diamond -> a
// Rs. `tier_reward_diamond_pkr` code. A member who jumps from Silver straight
// to Diamond passed Gold on the way and receives both.
import { db } from "../db.server";
import { getAdminForShop } from "./worker-admin.server";
import { issueAutomaticCode } from "./discounts.server";
import { getSettings } from "./settings.server";

export type TierRewardCode = { kind: "tier_gold" | "tier_diamond"; code: string; discountPkr: number; freeShipping: boolean; expiresAt: string };

const RANK: Record<string, number> = { silver: 0, gold: 1, diamond: 2 };

export async function issueTierRewards(input: {
  memberId: string;
  fromTier?: string | null;
  toTier: string;
  shop?: string | null;
}): Promise<{ issued: TierRewardCode[]; reason?: string }> {
  const settings = await getSettings();
  if (!settings.program_enabled) return { issued: [], reason: "program_disabled" };

  const { data: member, error } = await db
    .from("members")
    .select("id, shopify_customer_id, tier, is_blocked, opted_out")
    .eq("id", input.memberId)
    .maybeSingle();
  if (error) throw new Error(`member lookup failed: ${error.message}`);
  if (!member) return { issued: [], reason: "member_not_found" };
  if (member.is_blocked) return { issued: [], reason: "blocked" };
  if (member.opted_out) return { issued: [], reason: "opted_out" };

  const from = RANK[input.fromTier ?? "silver"] ?? 0;
  const to = RANK[input.toTier] ?? 0;
  const wantGold = from < 1 && to >= 1 && settings.tier_reward_gold_free_shipping;
  const wantDiamond = from < 2 && to >= 2 && settings.tier_reward_diamond_pkr > 0;
  if (!wantGold && !wantDiamond) return { issued: [], reason: "nothing_to_issue" };

  const admin = await getAdminForShop(input.shop ?? undefined);
  const issued: TierRewardCode[] = [];
  let failed = false;

  if (wantGold) {
    const r = await issueAutomaticCode({
      admin,
      memberId: member.id,
      shopifyCustomerId: member.shopify_customer_id,
      kind: "tier_gold",
      issueKey: `tier_gold:${member.id}`,
      title: "HeyGirl Rewards: Gold tier, free shipping",
      discountPkr: 0,
      freeShipping: true,
      expiryDays: settings.reward_code_expiry_days,
    });
    if (r.issued) issued.push({ kind: "tier_gold", code: r.code, discountPkr: 0, freeShipping: true, expiresAt: r.expiresAt });
    // A retried job: the code exists already; still include it in the email.
    else if (r.reason === "already_issued" && r.code) issued.push({ kind: "tier_gold", code: r.code, discountPkr: 0, freeShipping: true, expiresAt: "" });
    else if (r.reason !== "already_issued") failed = true;
  }
  if (wantDiamond) {
    const r = await issueAutomaticCode({
      admin,
      memberId: member.id,
      shopifyCustomerId: member.shopify_customer_id,
      kind: "tier_diamond",
      issueKey: `tier_diamond:${member.id}`,
      title: `HeyGirl Rewards: Diamond tier, Rs. ${settings.tier_reward_diamond_pkr} off`,
      discountPkr: settings.tier_reward_diamond_pkr,
      freeShipping: false,
      expiryDays: settings.reward_code_expiry_days,
    });
    if (r.issued) {
      issued.push({ kind: "tier_diamond", code: r.code, discountPkr: r.discountPkr, freeShipping: false, expiresAt: r.expiresAt });
    } else if (r.reason === "already_issued" && r.code) {
      issued.push({ kind: "tier_diamond", code: r.code, discountPkr: settings.tier_reward_diamond_pkr, freeShipping: false, expiresAt: "" });
    } else if (r.reason !== "already_issued") failed = true;
  }

  // A failure leaves a pending row; throwing makes the job retry and finish it.
  if (failed) throw new Error("tier reward code could not be created in Shopify; will retry");
  return { issued };
}
