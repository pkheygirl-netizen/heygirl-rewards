// app/lib/influencer.service.ts
// Influencer settings (rule 11) and public influencer discount codes (rule 12).
import { db } from "../db.server";
import type { Database } from "../database.types";
import { getAdminForShop } from "./worker-admin.server";
import { createPublicPercentageCode, deleteDiscount, findDiscountByCode, findDiscountIdByCode } from "./discounts.server";

export type InfluencerRateFields = {
  is_influencer: boolean;
  influencer_paused: boolean;
  influencer_multiplier: number | null;
  influencer_referral_rate: number | null;
  influencer_rate_starts_at: string | null;
  influencer_rate_ends_at: string | null;
};

/**
 * Rule 11. Standard points unless the member is an active influencer inside
 * her rate window; then round(standard x multiplier), or the legacy fixed rate
 * when no multiplier is set.
 */
export function effectiveReferralPoints(member: InfluencerRateFields, standardPoints: number, at: Date = new Date()): number {
  const standard = Math.max(0, Math.round(Number(standardPoints) || 0));
  if (!member.is_influencer || member.influencer_paused) return standard;

  const t = at.getTime();
  if (member.influencer_rate_starts_at) {
    const starts = Date.parse(member.influencer_rate_starts_at);
    if (Number.isFinite(starts) && t < starts) return standard;
  }
  if (member.influencer_rate_ends_at) {
    const ends = Date.parse(member.influencer_rate_ends_at);
    if (Number.isFinite(ends) && t > ends) return standard;
  }

  if (member.influencer_multiplier != null) {
    const multiplier = Number(member.influencer_multiplier);
    if (Number.isFinite(multiplier) && multiplier > 0) return Math.round(standard * multiplier);
    return standard;
  }
  if (member.influencer_referral_rate != null) {
    const rate = Number(member.influencer_referral_rate);
    if (Number.isFinite(rate) && rate >= 0) return Math.round(rate);
  }
  return standard;
}

const MAX_MULTIPLIER = 99.99; // numeric(4,2)

function parseDate(v: string | null | undefined): { ok: boolean; value: string | null } {
  if (v === null || v === undefined || v === "") return { ok: true, value: null };
  const t = Date.parse(v);
  if (!Number.isFinite(t)) return { ok: false, value: null };
  return { ok: true, value: new Date(t).toISOString() };
}

export async function setInfluencer(
  memberId: string,
  input: {
    isInfluencer: boolean;
    multiplier?: number | null;
    campaign?: string | null;
    paused?: boolean;
    rateStartsAt?: string | null;
    rateEndsAt?: string | null;
  },
): Promise<{ ok: boolean; reason?: string }> {
  const patch: Database["public"]["Tables"]["members"]["Update"] = { is_influencer: !!input.isInfluencer };

  if (input.multiplier !== undefined) {
    if (input.multiplier === null) {
      patch.influencer_multiplier = null;
    } else {
      const m = Number(input.multiplier);
      if (!Number.isFinite(m) || m <= 0 || m > MAX_MULTIPLIER) return { ok: false, reason: "invalid_multiplier" };
      patch.influencer_multiplier = Math.round(m * 100) / 100;
    }
  }
  if (input.campaign !== undefined) {
    const c = typeof input.campaign === "string" ? input.campaign.trim().slice(0, 80) : "";
    patch.influencer_campaign = c || null;
  }
  if (input.paused !== undefined) patch.influencer_paused = !!input.paused;

  const starts = parseDate(input.rateStartsAt);
  const ends = parseDate(input.rateEndsAt);
  if (!starts.ok || !ends.ok) return { ok: false, reason: "invalid_date" };
  if (input.rateStartsAt !== undefined) patch.influencer_rate_starts_at = starts.value;
  if (input.rateEndsAt !== undefined) patch.influencer_rate_ends_at = ends.value;
  if (starts.value && ends.value && Date.parse(ends.value) <= Date.parse(starts.value)) {
    return { ok: false, reason: "end_before_start" };
  }

  const { data, error } = await db.from("members").update(patch).eq("id", memberId).select("id");
  if (error) {
    console.error("[setInfluencer] update failed:", error.message);
    return { ok: false, reason: "db_error" };
  }
  if (!data || data.length === 0) return { ok: false, reason: "member_not_found" };
  return { ok: true };
}

const CODE_RE = /^[A-Z0-9][A-Z0-9_-]{2,31}$/;

export function normaliseInfluencerCode(code: string): string {
  return String(code ?? "").trim().toUpperCase();
}

/** One public percentage code per influencer (rule 12). */
export async function createInfluencerCode(input: {
  memberId: string;
  code: string;
  percentOff: number;
  shop: string;
}): Promise<{ ok: boolean; reason?: string }> {
  const code = normaliseInfluencerCode(input.code);
  if (!CODE_RE.test(code)) return { ok: false, reason: "invalid_code" };
  const percent = Math.round(Number(input.percentOff));
  if (!Number.isFinite(percent) || percent < 1 || percent > 90) return { ok: false, reason: "invalid_percent" };

  const { data: member, error } = await db
    .from("members")
    .select("id, first_name, last_name, is_influencer, influencer_code")
    .eq("id", input.memberId)
    .maybeSingle();
  if (error) return { ok: false, reason: "db_error" };
  if (!member) return { ok: false, reason: "member_not_found" };
  if (!member.is_influencer) return { ok: false, reason: "not_an_influencer" };
  if (member.influencer_code) return { ok: false, reason: "code_exists" };

  const { data: clash } = await db.from("members").select("id").eq("influencer_code", code).maybeSingle();
  if (clash) return { ok: false, reason: "code_taken" };
  // A reward code must never be mistaken for an influencer code.
  const { data: rewardClash } = await db.from("loyalty_codes").select("id").eq("code", code).maybeSingle();
  if (rewardClash) return { ok: false, reason: "code_taken" };

  let admin;
  try {
    admin = await getAdminForShop(input.shop);
  } catch (err) {
    console.error("[createInfluencerCode] no admin client:", err instanceof Error ? err.message : err);
    return { ok: false, reason: "shopify_unavailable" };
  }

  const name = [member.first_name, member.last_name].filter(Boolean).join(" ") || "influencer";
  const title = influencerCodeTitle(code, name, percent);
  let created = await createPublicPercentageCode(admin, { code, title, percentOff: percent });
  if (!created.ok && (created.reason === "request_failed" || created.reason === "code_taken")) {
    // An unclear failure may still have created the code, and a "taken" code may
    // be one this app made for her on an earlier unclear attempt. Adopt it only
    // when its title is exactly the one this function writes (same code, name
    // and percentage); anything else is a different discount and is left alone.
    try {
      const existing = await findDiscountByCode(admin, code);
      if (existing && existing.title === title) created = { ok: true, discountId: existing.id };
    } catch (err) {
      console.error("[createInfluencerCode] lookup after a failed create failed:", err instanceof Error ? err.message : err);
    }
  }
  if (!created.ok) return { ok: false, reason: created.reason === "code_taken" ? "code_taken" : "shopify_error" };

  const { data: saved, error: saveErr } = await db
    .from("members")
    .update({ influencer_code: code, influencer_code_percent: percent, influencer_code_discount_id: created.discountId })
    .eq("id", member.id)
    .is("influencer_code", null)
    .select("id");
  if (saveErr || !saved || saved.length === 0) {
    // Do not leave a live public code that the app does not know about.
    console.error("[createInfluencerCode] saving failed, removing the Shopify code:", saveErr?.message ?? "no row updated");
    await deleteDiscount(admin, created.discountId);
    return { ok: false, reason: saveErr?.code === "23505" ? "code_taken" : "db_error" };
  }
  return { ok: true };
}

/** The exact title given to an influencer's Shopify discount; used to recognise our own code. */
export function influencerCodeTitle(code: string, name: string, percent: number): string {
  return `Influencer ${code} (${name}) ${percent}% off`;
}

export async function removeInfluencerCode(input: { memberId: string; shop: string }): Promise<{ ok: boolean; reason?: string }> {
  const { data: member, error } = await db
    .from("members")
    .select("id, influencer_code, influencer_code_discount_id")
    .eq("id", input.memberId)
    .maybeSingle();
  if (error) return { ok: false, reason: "db_error" };
  if (!member) return { ok: false, reason: "member_not_found" };
  if (!member.influencer_code) return { ok: false, reason: "no_code" };

  let admin;
  try {
    admin = await getAdminForShop(input.shop);
  } catch (err) {
    console.error("[removeInfluencerCode] no admin client:", err instanceof Error ? err.message : err);
    return { ok: false, reason: "shopify_unavailable" };
  }

  // Shopify first: only forget the code once it can no longer be used.
  let discountId = member.influencer_code_discount_id;
  try {
    if (!discountId) discountId = await findDiscountIdByCode(admin, member.influencer_code);
  } catch (err) {
    console.error("[removeInfluencerCode] lookup failed:", err instanceof Error ? err.message : err);
    return { ok: false, reason: "shopify_error" };
  }
  if (discountId) {
    const removed = await deleteDiscount(admin, discountId);
    if (!removed.ok) {
      // Already gone in Shopify (deleted by hand) is fine; anything else is not.
      let stillThere = true;
      try {
        stillThere = (await findDiscountIdByCode(admin, member.influencer_code)) !== null;
      } catch {
        stillThere = true;
      }
      if (stillThere) return { ok: false, reason: "shopify_error" };
    }
  }

  const { error: saveErr } = await db
    .from("members")
    .update({ influencer_code: null, influencer_code_percent: null, influencer_code_discount_id: null })
    .eq("id", member.id);
  if (saveErr) return { ok: false, reason: "db_error" };
  return { ok: true };
}

/** The influencer an order's discount codes point at, if any (case-insensitive). */
export async function findInfluencerByCodes(codes: string[]): Promise<{ id: string; shopify_customer_id: string } | null> {
  const wanted = Array.from(new Set(codes.map(normaliseInfluencerCode).filter(Boolean)));
  if (wanted.length === 0) return null;
  const { data, error } = await db
    .from("members")
    .select("id, shopify_customer_id, is_influencer")
    .in("influencer_code", wanted)
    .limit(1);
  if (error) throw new Error(`influencer lookup failed: ${error.message}`);
  const hit = (data ?? []).find((m) => m.is_influencer);
  return hit ? { id: hit.id, shopify_customer_id: hit.shopify_customer_id } : null;
}
