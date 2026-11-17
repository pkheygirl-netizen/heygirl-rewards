// app/lib/redemption.service.ts
// Points -> reward code (rule 16), admin cancellation of an active code, and
// the automatic return for an order cancelled before fulfilment (rule 7).
import crypto from "node:crypto";
import { db } from "../db.server";
import { notificationQueue } from "./queue.server";
import { getAdminForShop } from "./worker-admin.server";
import {
  createCustomerAmountOffCode,
  deactivateDiscount,
  findDiscountIdByCode,
  finishPendingCode,
} from "./discounts.server";
import { getSettings, type RedemptionTier } from "./settings.server";
import { expiresAtForTier } from "./points.service";

export type { RedemptionTier };

export async function getRedemptionTiers(): Promise<RedemptionTier[]> {
  return (await getSettings()).redemption_tiers;
}

export function findTier(tiers: RedemptionTier[], points: number): RedemptionTier | null {
  return tiers.find((t) => t.points === points) ?? null;
}

export function validateRedemption(
  balance: number,
  requestedPoints: number,
  tiers: RedemptionTier[],
): { valid: boolean; reason?: string } {
  if (!Number.isInteger(requestedPoints) || requestedPoints <= 0) return { valid: false, reason: "invalid_tier" };
  if (!findTier(tiers, requestedPoints)) return { valid: false, reason: "invalid_tier" };
  if (balance < requestedPoints) return { valid: false, reason: "insufficient_balance" };
  return { valid: true };
}

/** Unguessable, unambiguous (no 0/O/1/I) reward code. */
export function generateCodeValue(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.randomBytes(10);
  let out = "";
  for (const b of bytes) out += alphabet[b % alphabet.length];
  return `REWARD-${out}`;
}

/**
 * Give points back for a reward code, at most once per code for any reason
 * (creation failed, admin cancelled it, order cancelled before fulfilment):
 * the ledger reference is always the code row's id.
 */
async function returnPointsForCode(input: {
  memberId: string;
  tier: string;
  codeId: string;
  points: number;
  reasonNote: string;
  customerNote: string;
  shopifyOrderId?: string | null;
}): Promise<{ returned: boolean }> {
  if (input.points <= 0) return { returned: false };
  const settings = await getSettings();
  const { data, error } = await db.rpc("award_points", {
    p_member_id: input.memberId,
    p_action_type: "redemption_return",
    p_reference_id: input.codeId,
    p_points: input.points,
    p_expires_at: expiresAtForTier(input.tier, settings),
    p_shopify_order_id: input.shopifyOrderId ?? null,
    p_reason_note: input.reasonNote,
    p_customer_note: input.customerNote,
  });
  if (error) throw new Error(`award_points(redemption_return) failed: ${error.message}`);
  return { returned: data?.[0]?.awarded ?? false };
}

export async function redeemPoints(input: {
  memberId: string;
  points: number;
  shop: string;
}): Promise<{ ok: true; code: string; discountPkr: number; expiresAt: string } | { ok: false; reason: string }> {
  const requested = Number(input.points);
  const settings = await getSettings();
  if (!settings.program_enabled) return { ok: false, reason: "program_disabled" };

  const { data: member, error: memberErr } = await db
    .from("members")
    .select("id, shopify_customer_id, tier, points_balance, is_blocked, opted_out")
    .eq("id", input.memberId)
    .maybeSingle();
  if (memberErr) throw new Error(`member lookup failed: ${memberErr.message}`);
  if (!member) return { ok: false, reason: "member_not_found" };
  if (member.is_blocked) return { ok: false, reason: "blocked" };
  if (member.opted_out) return { ok: false, reason: "opted_out" };

  const validation = validateRedemption(member.points_balance, requested, settings.redemption_tiers);
  if (!validation.valid) return { ok: false, reason: validation.reason ?? "invalid_tier" };
  const tier = findTier(settings.redemption_tiers, requested)!;

  // Shopify first needs an admin client; fail before touching the balance.
  let admin;
  try {
    admin = await getAdminForShop(input.shop);
  } catch (err) {
    console.error("[redeemPoints] no admin client:", err instanceof Error ? err.message : err);
    return { ok: false, reason: "shopify_unavailable" };
  }

  const code = generateCodeValue();
  const expiresAt = new Date(Date.now() + settings.reward_code_expiry_days * 86_400_000).toISOString();

  // 1. pending row: gives the deduction a stable reference
  const { data: codeRow, error: insertErr } = await db
    .from("loyalty_codes")
    .insert({
      member_id: member.id,
      code,
      kind: "reward",
      discount_amount: tier.discount_pkr,
      discount_amount_pkr: tier.discount_pkr,
      points_spent: requested,
      status: "pending",
      expires_at: expiresAt,
    })
    .select("id")
    .single();
  if (insertErr || !codeRow) {
    console.error("[redeemPoints] could not create the code row:", insertErr?.message);
    return { ok: false, reason: "db_error" };
  }

  // 2. deduct: the database refuses when the balance is too low (no clamp)
  const { data: rpcData, error: rpcErr } = await db.rpc("award_points", {
    p_member_id: member.id,
    p_action_type: "redemption",
    p_reference_id: String(codeRow.id),
    p_points: -requested,
    p_reason_note: `redeemed ${requested} pts for Rs.${tier.discount_pkr} off`,
    p_customer_note: `Reward: Rs. ${tier.discount_pkr} off`,
  });
  if (rpcErr || !(rpcData?.[0]?.awarded ?? false)) {
    await db.from("loyalty_codes").delete().eq("id", codeRow.id).eq("status", "pending");
    if (rpcErr) throw new Error(`award_points(redemption) failed: ${rpcErr.message}`);
    return { ok: false, reason: "insufficient_balance" };
  }

  // 3. create the discount; on failure give the points straight back
  const created = await createCustomerAmountOffCode(admin, {
    code,
    title: `HeyGirl Rewards: Rs. ${tier.discount_pkr} off`,
    amountPkr: tier.discount_pkr,
    shopifyCustomerId: member.shopify_customer_id,
    endsAt: new Date(expiresAt),
  });
  if (!created.ok) {
    try {
      await returnPointsForCode({
        memberId: member.id,
        tier: member.tier,
        codeId: String(codeRow.id),
        points: requested,
        reasonNote: `auto return: Shopify discount not created (${created.reason})`,
        customerNote: "Reward could not be created, points returned",
      });
      await db
        .from("loyalty_codes")
        .update({ status: "cancelled", cancelled_at: new Date().toISOString() })
        .eq("id", codeRow.id);
    } catch (err) {
      // Keep the pending row as evidence; the admin sees it and can adjust.
      console.error("[redeemPoints] RETURN FAILED, manual adjustment needed for code row", codeRow.id, err instanceof Error ? err.message : err);
    }
    return { ok: false, reason: "shopify_error" };
  }

  // 4. activate
  const { error: updErr } = await db
    .from("loyalty_codes")
    .update({ status: "active", shopify_discount_id: created.discountId })
    .eq("id", codeRow.id);
  if (updErr) console.error("[redeemPoints] code created but row not activated:", codeRow.id, updErr.message);

  await notificationQueue
    .add("reward_code_issued", { memberId: member.id, code, discountPkr: tier.discount_pkr, expiresAt, kind: "reward" })
    .catch((err) => console.error("[redeemPoints] notification enqueue failed:", err));

  return { ok: true, code, discountPkr: tier.discount_pkr, expiresAt };
}

/**
 * Admin cancels an ACTIVE reward code: deactivate it in Shopify first, and only
 * then return the points. If Shopify reports the code was already used, it is
 * marked used and nothing is returned.
 */
export async function cancelRewardCode(input: {
  codeId: string;
  shop: string;
  actor: string;
}): Promise<{ ok: boolean; pointsReturned: number; reason?: string }> {
  const { data: row, error } = await db
    .from("loyalty_codes")
    .select("id, member_id, code, kind, status, points_spent, shopify_discount_id")
    .eq("id", input.codeId)
    .maybeSingle();
  if (error) throw new Error(`code lookup failed: ${error.message}`);
  if (!row) return { ok: false, pointsReturned: 0, reason: "not_found" };
  if (row.kind !== "reward") return { ok: false, pointsReturned: 0, reason: "not_a_reward_code" };
  if (row.status !== "active") return { ok: false, pointsReturned: 0, reason: "not_active" };

  let admin;
  try {
    admin = await getAdminForShop(input.shop);
  } catch (err) {
    console.error("[cancelRewardCode] no admin client:", err instanceof Error ? err.message : err);
    return { ok: false, pointsReturned: 0, reason: "shopify_unavailable" };
  }

  let discountId = row.shopify_discount_id;
  // Rows from before v3 hold a price-rule id, which the new mutation does not accept.
  if (!discountId || !discountId.includes("DiscountCodeNode")) {
    try {
      discountId = await findDiscountIdByCode(admin, row.code);
    } catch (err) {
      console.error("[cancelRewardCode] lookup failed:", err instanceof Error ? err.message : err);
      return { ok: false, pointsReturned: 0, reason: "shopify_error" };
    }
  }
  if (!discountId) return { ok: false, pointsReturned: 0, reason: "discount_not_found" };

  const deactivated = await deactivateDiscount(admin, discountId);
  if (!deactivated.ok) return { ok: false, pointsReturned: 0, reason: "shopify_error" };

  if (deactivated.usageCount > 0) {
    await db
      .from("loyalty_codes")
      .update({ status: "used", used_at: new Date().toISOString() })
      .eq("id", row.id)
      .eq("status", "active");
    return { ok: false, pointsReturned: 0, reason: "already_used" };
  }

  // Conditional on still being active: a webhook may have marked it used meanwhile.
  const { data: cancelled, error: updErr } = await db
    .from("loyalty_codes")
    .update({ status: "cancelled", cancelled_at: new Date().toISOString(), shopify_discount_id: discountId })
    .eq("id", row.id)
    .eq("status", "active")
    .select("id");
  if (updErr) throw new Error(`could not cancel the code: ${updErr.message}`);
  if (!cancelled || cancelled.length === 0) return { ok: false, pointsReturned: 0, reason: "not_active" };

  const { data: member } = await db.from("members").select("id, tier").eq("id", row.member_id).maybeSingle();
  const { returned } = await returnPointsForCode({
    memberId: row.member_id,
    tier: member?.tier ?? "silver",
    codeId: String(row.id),
    points: row.points_spent,
    reasonNote: `reward code ${row.code} cancelled by ${input.actor || "admin"}`,
    customerNote: "Reward cancelled, points returned",
  });
  return { ok: true, pointsReturned: returned ? row.points_spent : 0 };
}

/**
 * Rule 7: an order that used a reward code was cancelled BEFORE fulfilment.
 * The redeemed points come back; the code stays used.
 */
export async function returnRedemptionsForCancelledOrder(
  shopifyOrderId: string,
): Promise<{ returned: number; codes: number }> {
  const { data: codes, error } = await db
    .from("loyalty_codes")
    .select("id, member_id, code, points_spent")
    .eq("shopify_order_id", String(shopifyOrderId))
    .eq("kind", "reward")
    .eq("status", "used");
  if (error) throw new Error(`code lookup failed: ${error.message}`);

  let total = 0;
  let count = 0;
  for (const c of codes ?? []) {
    const { data: member } = await db.from("members").select("id, tier").eq("id", c.member_id).maybeSingle();
    if (!member) continue;
    const { returned } = await returnPointsForCode({
      memberId: c.member_id,
      tier: member.tier,
      codeId: String(c.id),
      points: c.points_spent,
      reasonNote: `order ${shopifyOrderId} cancelled before fulfilment; code ${c.code} stays used`,
      customerNote: "Order cancelled, reward points returned",
      shopifyOrderId: String(shopifyOrderId),
    });
    if (returned) {
      total += c.points_spent;
      count++;
    }
  }
  return { returned: total, codes: count };
}

export const PENDING_CODE_GRACE_MS = 10 * 60 * 1000;

/**
 * Cron sweep (every 10 minutes): nothing may stay `pending` for good.
 *   automatic codes (birthday, friend, tier): the discount is created (or
 *     adopted) and the member is told, as the original job would have done
 *   reward codes: redeemPoints died between taking the points and creating
 *     the discount. If Shopify has the code it is activated; if not, the
 *     points go back and the row is cancelled. If the points were never
 *     taken, the row is just cancelled.
 * Rows younger than ten minutes are left alone: their own job may still be running.
 */
export async function sweepPendingCodes(
  now: Date = new Date(),
  shop?: string | null,
): Promise<{ finished: number; returned: number; cancelled: number; failed: number }> {
  const cutoff = new Date(now.getTime() - PENDING_CODE_GRACE_MS).toISOString();
  const { data: rows, error } = await db
    .from("loyalty_codes")
    .select("id, member_id, code, kind, expires_at, discount_amount_pkr, points_spent, issue_key")
    .eq("status", "pending")
    .lt("created_at", cutoff)
    .order("created_at", { ascending: true })
    .limit(200);
  if (error) throw new Error(`pending code query failed: ${error.message}`);
  const out = { finished: 0, returned: 0, cancelled: 0, failed: 0 };
  if (!rows || rows.length === 0) return out;

  const admin = await getAdminForShop(shop ?? undefined); // throws: the cron run is marked failed and retried
  for (const row of rows) {
    try {
      const { data: member } = await db
        .from("members")
        .select("id, shopify_customer_id, tier, is_blocked, opted_out")
        .eq("id", row.member_id)
        .maybeSingle();
      const cancel = async () =>
        db.from("loyalty_codes").update({ status: "cancelled", cancelled_at: new Date().toISOString() }).eq("id", row.id).eq("status", "pending");

      if (row.kind === "reward") {
        const { data: deduction } = await db
          .from("points_ledger")
          .select("id")
          .eq("member_id", row.member_id)
          .eq("action_type", "redemption")
          .eq("reference_id", String(row.id))
          .maybeSingle();
        if (!deduction || !member) {
          await cancel(); // the points were never taken
          out.cancelled++;
          continue;
        }
        const existingId = await findDiscountIdByCode(admin, row.code);
        if (existingId) {
          // The discount was created; only the last step was missed.
          await db.from("loyalty_codes").update({ status: "active", shopify_discount_id: existingId }).eq("id", row.id).eq("status", "pending");
          await notificationQueue.add("reward_code_issued", {
            memberId: row.member_id, code: row.code, discountPkr: row.discount_amount_pkr, expiresAt: row.expires_at, kind: "reward",
          });
          out.finished++;
          continue;
        }
        await returnPointsForCode({
          memberId: row.member_id,
          tier: member.tier,
          codeId: String(row.id),
          points: row.points_spent,
          reasonNote: "auto return: reward code was never created in Shopify (found by the pending-code sweep)",
          customerNote: "Reward could not be created, points returned",
        });
        await cancel();
        out.returned++;
        continue;
      }

      // automatic kinds
      if (!member || member.is_blocked || member.opted_out) {
        await cancel();
        out.cancelled++;
        continue;
      }
      const done = await finishPendingCode(admin, row, member.shopify_customer_id);
      if (!done.ok) {
        if (done.reason === "expired") out.cancelled++;
        else out.failed++; // stays pending; the next sweep tries again
        continue;
      }
      await notificationQueue.add(row.kind === "birthday" ? "birthday" : "reward_code_issued", {
        memberId: row.member_id,
        code: row.code,
        discountPkr: row.discount_amount_pkr,
        expiresAt: row.expires_at,
        kind: row.kind,
        freeShipping: done.freeShipping,
      });
      if (row.kind === "referral_friend" && row.issue_key) {
        await db.from("referrals").update({ friend_code_id: row.id }).eq("id", row.issue_key.replace(/^referral_friend:/, ""));
      }
      out.finished++;
    } catch (err) {
      console.error("[sweepPendingCodes] row", row.id, "failed:", err instanceof Error ? err.message : err);
      out.failed++;
    }
  }
  return out;
}

export async function getActiveLoyaltyCodes(shopifyCustomerId: string): Promise<
  Array<{ id: string; code: string; kind: string; discount_amount_pkr: number; expires_at: string | null; status: string }>
> {
  const { data: member } = await db
    .from("members")
    .select("id")
    .eq("shopify_customer_id", String(shopifyCustomerId))
    .maybeSingle();
  if (!member) return [];

  const { data } = await db
    .from("loyalty_codes")
    .select("id, code, kind, discount_amount_pkr, expires_at, status")
    .eq("member_id", member.id)
    .eq("status", "active")
    .order("created_at", { ascending: false })
    .limit(50);
  return data ?? [];
}
