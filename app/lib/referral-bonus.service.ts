// app/lib/referral-bonus.service.ts
// The referred friend's free-shipping code, issued when the referral is
// recorded at her first sign-in (rule 10), not after her first order.
import { db } from "../db.server";
import { getAdminForShop } from "./worker-admin.server";
import { issueAutomaticCode } from "./discounts.server";
import { getSettings } from "./settings.server";
import { notificationQueue } from "./queue.server";

export async function issueReferralFriendCode(
  referralId: string,
  shop?: string | null,
): Promise<{ issued: boolean; code?: string; codeId?: string; reason?: string }> {
  // No program-switch check: it only pauses redeeming points (rule 20).
  const settings = await getSettings();
  if (!settings.referral_friend_free_shipping) return { issued: false, reason: "disabled" };

  const { data: referral, error } = await db
    .from("referrals")
    .select("id, status, referred_shopify_customer_id, friend_code_id")
    .eq("id", referralId)
    .maybeSingle();
  if (error) throw new Error(`referral lookup failed: ${error.message}`);
  if (!referral || !referral.referred_shopify_customer_id) return { issued: false, reason: "referral_not_found" };
  if (referral.status === "blocked" || referral.status === "rejected") return { issued: false, reason: "referral_closed" };

  const { data: friend } = await db
    .from("members")
    .select("id, shopify_customer_id, is_blocked, opted_out")
    .eq("shopify_customer_id", referral.referred_shopify_customer_id)
    .maybeSingle();
  if (!friend) return { issued: false, reason: "member_not_found" };
  if (friend.is_blocked) return { issued: false, reason: "blocked" };
  if (friend.opted_out) return { issued: false, reason: "opted_out" };

  const admin = await getAdminForShop(shop ?? undefined);
  const result = await issueAutomaticCode({
    admin,
    memberId: friend.id,
    shopifyCustomerId: friend.shopify_customer_id,
    kind: "referral_friend",
    issueKey: `referral_friend:${referral.id}`,
    title: "HeyGirl Rewards: friend welcome, free shipping",
    discountPkr: 0,
    freeShipping: true,
    expiryDays: settings.reward_code_expiry_days,
  });

  if (!result.issued) {
    if (result.reason === "already_issued") {
      if (!referral.friend_code_id && result.codeId) {
        await db.from("referrals").update({ friend_code_id: result.codeId }).eq("id", referral.id);
      }
      return { issued: false, reason: "already_issued", code: result.code, codeId: result.codeId };
    }
    return { issued: false, reason: result.reason };
  }

  await db.from("referrals").update({ friend_code_id: result.codeId }).eq("id", referral.id);
  await notificationQueue
    .add("reward_code_issued", {
      memberId: friend.id,
      code: result.code,
      kind: "referral_friend",
      freeShipping: true,
      expiresAt: result.expiresAt,
    })
    .catch((err) => console.error("[issueReferralFriendCode] notification enqueue failed:", err));
  return { issued: true, code: result.code, codeId: result.codeId };
}
