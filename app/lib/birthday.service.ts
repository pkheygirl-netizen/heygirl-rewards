// app/lib/birthday.service.ts
// Rule 13: on the 1st (Asia/Karachi) each member whose birthday falls in the
// month gets one code, sized by tier. Issue is idempotent per member and year
// (issue_key `birthday:<member>:<year>`) and survives a failed Shopify call.
import { db } from "../db.server";
import { getAdminForShop } from "./worker-admin.server";
import { issueAutomaticCode } from "./discounts.server";
import { getSettings, isEarnRuleEnabled, karachiMonthStart, karachiParts, type AppSettings } from "./settings.server";

export function birthdayDiscountForTier(
  tier: string,
  s: Pick<AppSettings, "birthday_reward_silver_pkr" | "birthday_reward_gold_pkr" | "birthday_reward_diamond_pkr">,
): number {
  if (tier === "diamond") return s.birthday_reward_diamond_pkr;
  if (tier === "gold") return s.birthday_reward_gold_pkr;
  return s.birthday_reward_silver_pkr;
}

export async function birthdayDiscountPkr(tier: string): Promise<number> {
  return birthdayDiscountForTier(tier, await getSettings());
}

/** Members to reward this month: right month, set before the month began, not blocked, not opted out. */
export async function listBirthdayMemberIds(now: Date = new Date()): Promise<string[]> {
  const { year, month } = karachiParts(now);
  const monthStart = karachiMonthStart(year, month).toISOString();
  // The job runs every day of the month (so a missed 1st is caught up); members
  // who already have this year's code, issued or still pending, are left out.
  const yearStart = karachiMonthStart(year, 1).toISOString();
  const done = new Set<string>();
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db
      .from("loyalty_codes")
      .select("member_id")
      .eq("kind", "birthday")
      .gte("created_at", yearStart)
      .order("id", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`birthday code query failed: ${error.message}`);
    for (const c of data ?? []) done.add(c.member_id);
    if (!data || data.length < PAGE) break;
  }

  const ids: string[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db
      .from("members")
      .select("id")
      .eq("birthday_month", month)
      .eq("is_blocked", false)
      .eq("opted_out", false)
      .lt("birthday_set_at", monthStart)
      .order("id", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`birthday query failed: ${error.message}`);
    for (const m of data ?? []) if (!done.has(m.id)) ids.push(m.id);
    if (!data || data.length < PAGE) break;
  }
  return ids;
}

export async function issueBirthdayReward(
  memberId: string,
  opts: { shop?: string | null; now?: Date } = {},
): Promise<{ issued: boolean; code?: string; discountPkr?: number; expiresAt?: string; reason?: string }> {
  const now = opts.now ?? new Date();
  const settings = await getSettings();
  if (!isEarnRuleEnabled(settings, "birthday")) return { issued: false, reason: "disabled" };

  const { data: member, error } = await db
    .from("members")
    .select("id, shopify_customer_id, tier, birthday_month, birthday_set_at, is_blocked, opted_out")
    .eq("id", memberId)
    .maybeSingle();
  if (error) throw new Error(`member lookup failed: ${error.message}`);
  if (!member) return { issued: false, reason: "member_not_found" };
  if (member.is_blocked) return { issued: false, reason: "blocked" };
  if (member.opted_out) return { issued: false, reason: "opted_out" };

  const { year, month } = karachiParts(now);
  if (member.birthday_month !== month) return { issued: false, reason: "not_birthday_month" };
  // A birthday first entered during its own month starts next year.
  const monthStart = karachiMonthStart(year, month).getTime();
  if (!member.birthday_set_at || Date.parse(member.birthday_set_at) >= monthStart) {
    return { issued: false, reason: "set_this_month" };
  }

  const discountPkr = birthdayDiscountForTier(member.tier, settings);
  if (discountPkr <= 0) return { issued: false, reason: "zero_reward" };

  const admin = await getAdminForShop(opts.shop ?? undefined);
  const result = await issueAutomaticCode({
    admin,
    memberId: member.id,
    shopifyCustomerId: member.shopify_customer_id,
    kind: "birthday",
    issueKey: `birthday:${member.id}:${year}`,
    title: `HeyGirl Rewards: birthday gift, Rs. ${discountPkr} off`,
    discountPkr,
    freeShipping: false,
    expiryDays: settings.reward_code_expiry_days,
  });
  if (!result.issued) {
    if (result.reason === "already_issued") return { issued: false, reason: "already_issued", code: result.code };
    // Leave the pending row in place and let the job retry: nothing is lost.
    throw new Error(`birthday code not created (${result.reason}); will retry`);
  }
  return { issued: true, code: result.code, discountPkr: result.discountPkr, expiresAt: result.expiresAt };
}
