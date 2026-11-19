// app/lib/points.service.ts
// Membership, tiers, welcome bonus, social awards, expiry and privacy
// requests. Order earning and reversal live in orders.server.ts. Every points
// movement goes through the award_points database function (migration 010).
import { db } from "../db.server";
import type { Database, Json } from "../database.types";
import { notificationQueue, pointsQueue } from "./queue.server";
import { shopifyGraphqlWithRetry } from "./shopify-graphql.server";
import { getAdminForShop } from "./worker-admin.server";
import { getSettings, isEarnRuleEnabled, tierThresholds, type AppSettings } from "./settings.server";
import { recordHeartbeat } from "./heartbeat.server";

export type Tier = "silver" | "gold" | "diamond";
type MemberRow = Database["public"]["Tables"]["members"]["Row"];

const TIER_RANK: Record<string, number> = { silver: 0, gold: 1, diamond: 2 };

export function generateSlug(firstName?: string | null, lastName?: string | null): string {
  const base =
    [firstName, lastName].filter(Boolean).join("-").toLowerCase().replace(/[^a-z0-9-]/g, "") ||
    "member";
  const suffix = Math.floor(1000 + Math.random() * 9000); // 4 digits
  return `${base}-${suffix}`;
}

/** Rule 1: floor(basis x rate x multiplier). The epsilon absorbs binary float noise (e.g. 1.2 x 1000). */
export function computePurchasePoints(basisPkr: number, rate: number, multiplier: number): number {
  const value = Number(basisPkr) * Number(rate) * Number(multiplier);
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.floor(value + 1e-6);
}

export function mapSocialActionType(
  short: "youtube" | "facebook" | "instagram",
): "social_youtube" | "social_facebook" | "social_instagram" {
  return `social_${short}` as const;
}

/** Rule 2: a campaign wins; otherwise Diamond members get 1.2x in their birthday month. */
export function selectMultiplier(
  campaignMultiplier: number | null,
  member: { tier: string; birthday_month: number | null },
  month: number,
): number {
  if (campaignMultiplier != null) return campaignMultiplier;
  if (member.tier === "diamond" && member.birthday_month === month) return 1.2;
  return 1;
}

/** Rule 9: tier by lifetime spend, thresholds from settings. */
export function tierForSpend(spendPkr: number, s: { gold: number; diamond: number }): Tier {
  const spend = Number(spendPkr) || 0;
  if (spend >= s.diamond) return "diamond";
  if (spend >= s.gold) return "gold";
  return "silver";
}

/** Rule 8: Silver points expire `silver_expiry_days` after they are earned; Gold and Diamond never. */
export function expiresAtForTier(
  tier: string,
  settings: Pick<AppSettings, "silver_expiry_days">,
  earnedAt: Date = new Date(),
): string | null {
  if (tier !== "silver") return null;
  return new Date(earnedAt.getTime() + settings.silver_expiry_days * 86_400_000).toISOString();
}

// ── Enrolment ─────────────────────────────────────────────────────────────

export type CustomerInput = {
  id: number | string;
  email?: string | null;
  phone?: string | null;
  first_name?: string | null;
  last_name?: string | null;
};

type ConsentSource = "order" | "signin";

const clean = (v: string | null | undefined): string | null => {
  const t = typeof v === "string" ? v.trim() : "";
  return t ? t : null;
};

async function findMember(shopifyCustomerId: string): Promise<MemberRow | null> {
  const { data, error } = await db
    .from("members")
    .select("*")
    .eq("shopify_customer_id", shopifyCustomerId)
    .maybeSingle();
  if (error) throw new Error(`member lookup failed: ${error.message}`);
  return data;
}

async function insertMember(
  customer: CustomerInput,
  consent: ConsentSource | null,
): Promise<MemberRow | null> {
  const customerId = String(customer.id);
  const now = new Date().toISOString();
  let withContact = true;
  for (let attempt = 0; attempt < 6; attempt++) {
    const { data, error } = await db
      .from("members")
      .insert({
        shopify_customer_id: customerId,
        email: withContact ? clean(customer.email) : null,
        phone: withContact ? clean(customer.phone) : null,
        first_name: clean(customer.first_name),
        last_name: clean(customer.last_name),
        tier: "silver",
        points_balance: 0,
        lifetime_spend_pkr: 0,
        referral_slug: generateSlug(customer.first_name, customer.last_name),
        consent_given: consent !== null,
        consent_given_at: consent !== null ? now : null,
        consent_source: consent,
        // last_seen_ip is no longer written: the proxy's forwarded address is
        // not the shopper's (see clientIp in proxy-auth.server.ts).
      })
      .select("*")
      .single();
    if (!error && data) return data;
    const message = error?.message ?? "";
    if (error?.code === "23505" && !message.includes("referral_slug")) {
      // Usually: another request created the member a moment ago.
      const existing = await findMember(customerId);
      if (existing) return existing;
      // Otherwise some other unique value clashed (for example a database
      // that enforces one member per email). Enrol on the customer id alone
      // rather than fail the order for ever; the clash is logged for the admin.
      if (withContact) {
        console.error(`[insertMember] unique clash for customer ${customerId} (${message}); enrolling without contact details`);
        withContact = false;
        continue;
      }
      return null;
    }
    if (!message.includes("referral_slug")) {
      console.error("[insertMember] insert error:", message);
      return null;
    }
    // slug collision: try again with a new suffix
  }
  console.error("[insertMember] gave up after 5 slug collisions");
  return null;
}

/** Fill in contact details we did not have before (never overwrites a value). */
function missingDetails(member: MemberRow, customer: CustomerInput): Partial<MemberRow> {
  const patch: Partial<MemberRow> = {};
  // A member who opted out, or whose details were erased on request, stays
  // as she is: a later order must not put her name or phone back.
  if (member.opted_out || (member.email ?? "").endsWith("@redacted.invalid")) return patch;
  if (!member.email && clean(customer.email)) patch.email = clean(customer.email);
  if (!member.phone && clean(customer.phone)) patch.phone = clean(customer.phone);
  if (!member.first_name && clean(customer.first_name)) patch.first_name = clean(customer.first_name);
  if (!member.last_name && clean(customer.last_name)) patch.last_name = clean(customer.last_name);
  return patch;
}

/**
 * customers/create webhook: keep a member row for the customer without
 * recording consent. Consent arrives with the first order or sign-in (rule 3).
 * Customers with only a phone number are enrolled too (rule 5).
 */
export async function enrolMember(customer: CustomerInput): Promise<{ enrolled: boolean; reason?: string }> {
  const customerId = String(customer.id);
  const existing = await findMember(customerId);
  if (existing) {
    const patch = missingDetails(existing, customer);
    if (Object.keys(patch).length > 0) await db.from("members").update(patch).eq("id", existing.id);
    return { enrolled: false, reason: "already_member" };
  }
  const created = await insertMember(customer, null);
  return created ? { enrolled: true } : { enrolled: false, reason: "insert_error" };
}

/**
 * Placing an order enrols the customer (rule 3, consent_source 'order').
 * No welcome bonus here: that is for the first sign-in only (rule 4).
 * An opted-out member is returned untouched and is never re-enrolled.
 */
export async function enrolFromOrder(customer: CustomerInput): Promise<MemberRow | null> {
  const customerId = String(customer.id);
  const existing = await findMember(customerId);
  if (!existing) return insertMember(customer, "order");

  const patch: Partial<MemberRow> = missingDetails(existing, customer);
  if (!existing.opted_out && !existing.consent_given) {
    patch.consent_given = true;
    patch.consent_given_at = new Date().toISOString();
    patch.consent_source = "order";
  }
  if (Object.keys(patch).length === 0) return existing;
  const { error } = await db.from("members").update(patch).eq("id", existing.id);
  if (error) throw new Error(`member update failed: ${error.message}`);
  return { ...existing, ...patch };
}

const CUSTOMER_FOR_ENROL = `#graphql
  query HgCustomerForEnrol($id: ID!) {
    customer(id: $id) {
      firstName
      lastName
      defaultEmailAddress { emailAddress }
      defaultPhoneNumber { phoneNumber }
    }
  }`;

async function fetchCustomer(shopifyCustomerId: string, shop: string): Promise<CustomerInput> {
  const fallback: CustomerInput = { id: shopifyCustomerId };
  try {
    const admin = await getAdminForShop(shop);
    const data = await shopifyGraphqlWithRetry<{
      customer: {
        firstName: string | null;
        lastName: string | null;
        defaultEmailAddress: { emailAddress: string } | null;
        defaultPhoneNumber: { phoneNumber: string } | null;
      } | null;
    }>(admin, CUSTOMER_FOR_ENROL, { id: `gid://shopify/Customer/${shopifyCustomerId}` });
    if (!data.customer) return fallback;
    return {
      id: shopifyCustomerId,
      email: data.customer.defaultEmailAddress?.emailAddress ?? null,
      phone: data.customer.defaultPhoneNumber?.phoneNumber ?? null,
      first_name: data.customer.firstName,
      last_name: data.customer.lastName,
    };
  } catch (err) {
    // The member is still enrolled; an order webhook fills the details in later.
    console.error("[enrolFromSignin] customer lookup failed:", err instanceof Error ? err.message : err);
    return fallback;
  }
}

/** True when this member should still receive the welcome bonus (rule 4). */
async function welcomeBonusOutstanding(member: MemberRow): Promise<boolean> {
  const { data, error } = await db
    .from("points_ledger")
    .select("action_type, points")
    .eq("member_id", member.id)
    .in("action_type", ["signup", "import"])
    .limit(20);
  if (error) throw new Error(`ledger lookup failed: ${error.message}`);
  const rows = data ?? [];
  if (rows.some((r) => r.action_type === "signup")) return false;
  // Imported with a Smile balance: that balance is their starting point.
  if (rows.some((r) => r.action_type === "import" && r.points > 0)) return false;
  return true;
}

/**
 * Called by the storefront whenever a signed-in customer loads the widget.
 * Enrols (or records consent for) the customer and queues the one-time
 * welcome bonus. No network address is recorded (19 Nov 2026: the address
 * the app sees is a proxy's, not the shopper's).
 * Cheap on repeat calls: two indexed reads and no write.
 */
export async function enrolFromSignin(input: {
  shopifyCustomerId: string;
  shop: string;
}): Promise<{ memberId: string | null; welcomeQueued: boolean; welcomeAwarded?: boolean; reason?: string }> {
  const customerId = String(input.shopifyCustomerId ?? "").trim();
  if (!customerId) return { memberId: null, welcomeQueued: false, reason: "no_customer" };

  let member = await findMember(customerId);
  if (!member) {
    const customer = await fetchCustomer(customerId, input.shop);
    member = await insertMember(customer, "signin");
    if (!member) return { memberId: null, welcomeQueued: false, reason: "enrol_failed" };
  }

  if (member.opted_out) return { memberId: member.id, welcomeQueued: false, reason: "opted_out" };

  const patch: Partial<MemberRow> = {};
  if (!member.consent_given) {
    patch.consent_given = true;
    patch.consent_given_at = new Date().toISOString();
    patch.consent_source = "signin";
  }
  if (Object.keys(patch).length > 0) {
    const { error } = await db.from("members").update(patch).eq("id", member.id);
    if (error) console.error("[enrolFromSignin] member update failed:", error.message);
  }

  if (member.is_blocked) return { memberId: member.id, welcomeQueued: false, reason: "blocked" };

  const settings = await getSettings();
  if (!isEarnRuleEnabled(settings, "signup") || settings.signup_points <= 0) {
    return { memberId: member.id, welcomeQueued: false, reason: "signup_rule_off" };
  }
  if (!(await welcomeBonusOutstanding(member))) return { memberId: member.id, welcomeQueued: false };

  // The bonus is added right here, so the very first answer to the storefront
  // already shows it (a brand-new member never sees a bare 0 while a job is
  // waiting). awardSignup re-checks everything and is idempotent on the
  // ledger key (member, 'signup', customer id): two sign-ins at once pay once,
  // and the welcome email is queued only by the call that wrote the row.
  try {
    const now = await awardSignup(member.id);
    if (now.awarded) return { memberId: member.id, welcomeQueued: false, welcomeAwarded: true };
    // Refused (already given, or blocked / opted out / rule off a moment ago): nothing to queue.
    return now.reason && now.reason !== "already_awarded"
      ? { memberId: member.id, welcomeQueued: false, reason: now.reason }
      : { memberId: member.id, welcomeQueued: false };
  } catch (err) {
    // Fall back to the worker job below; the ledger key keeps it to one bonus.
    console.error("[enrolFromSignin] welcome bonus not added now, queueing it:", err instanceof Error ? err.message : err);
  }

  try {
    // No fixed job id: a failed job with the same id would block this one for
    // as long as failed jobs are kept. The ledger makes the award idempotent.
    await pointsQueue.add("award_signup_points", { memberId: member.id });
  } catch (err) {
    console.error("[enrolFromSignin] welcome bonus enqueue failed:", err instanceof Error ? err.message : err);
    return { memberId: member.id, welcomeQueued: false, reason: "enqueue_failed" };
  }
  return { memberId: member.id, welcomeQueued: true };
}

/** Worker job: the one-time welcome bonus. Idempotent on (member, 'signup', customer id). */
export async function awardSignup(memberId: string): Promise<{ awarded: boolean; reason?: string }> {
  const { data: member, error } = await db.from("members").select("*").eq("id", memberId).maybeSingle();
  if (error) throw new Error(`member lookup failed: ${error.message}`);
  if (!member) return { awarded: false, reason: "member_not_found" };
  if (member.is_blocked) return { awarded: false, reason: "blocked" };
  if (member.opted_out) return { awarded: false, reason: "opted_out" };

  const settings = await getSettings();
  if (!isEarnRuleEnabled(settings, "signup") || settings.signup_points <= 0) {
    return { awarded: false, reason: "signup_rule_off" };
  }
  if (!(await welcomeBonusOutstanding(member))) return { awarded: false, reason: "already_awarded" };

  const { data, error: rpcErr } = await db.rpc("award_points", {
    p_member_id: member.id,
    p_action_type: "signup",
    p_reference_id: member.shopify_customer_id,
    p_points: settings.signup_points,
    p_expires_at: expiresAtForTier(member.tier, settings),
    p_customer_note: "Welcome bonus",
  });
  if (rpcErr) throw new Error(`award_points failed: ${rpcErr.message}`);
  const awarded = data?.[0]?.awarded ?? false;
  if (awarded) {
    await notificationQueue
      .add("welcome", { memberId: member.id, points: settings.signup_points })
      .catch((err) => console.error("[awardSignup] welcome enqueue failed:", err));
  }
  return { awarded };
}

// ── Opt-out and birthday ──────────────────────────────────────────────────

/** Rule 3: opt-out stops earning, redemption and re-enrolment. Separate from the fraud block. */
export async function setOptOut(memberId: string, optedOut: boolean): Promise<void> {
  const { error } = await db.from("members").update({ opted_out: optedOut }).eq("id", memberId);
  if (error) throw new Error(`could not update opt-out: ${error.message}`);
}

export function isValidBirthday(month: number, day: number): boolean {
  if (!Number.isInteger(month) || !Number.isInteger(day)) return false;
  if (month < 1 || month > 12 || day < 1) return false;
  const daysIn = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]; // 29 Feb allowed
  return day <= daysIn;
}

/**
 * Rule 13: the customer sets day and month once; afterwards only admin can
 * change it. The storefront write is conditional on the birthday still being
 * unset, so two taps cannot both succeed.
 */
export async function setBirthday(
  memberId: string,
  month: number,
  day: number,
  opts: { byAdmin: boolean },
): Promise<{ ok: boolean; reason?: "already_set" | "invalid_date" }> {
  if (!isValidBirthday(month, day)) return { ok: false, reason: "invalid_date" };
  const patch = { birthday_month: month, birthday_day: day, birthday_set_at: new Date().toISOString() };

  if (opts.byAdmin) {
    const { error } = await db.from("members").update(patch).eq("id", memberId);
    if (error) throw new Error(`could not set birthday: ${error.message}`);
    return { ok: true };
  }

  const { data, error } = await db
    .from("members")
    .update(patch)
    .eq("id", memberId)
    .is("birthday_set_at", null)
    .is("birthday_month", null)
    .select("id");
  if (error) throw new Error(`could not set birthday: ${error.message}`);
  if (!data || data.length === 0) return { ok: false, reason: "already_set" };
  return { ok: true };
}

// ── Tiers ─────────────────────────────────────────────────────────────────

/**
 * Rule 9: upgrade when lifetime spend crosses a threshold; never downgrade.
 * The tier change, its tier_history row and clearing the expiry dates happen
 * in one database transaction (upgrade_member_tier). What follows is driven by
 * state, not by "this call did the upgrade": see ensureTierFollowUps.
 */
export async function checkAndUpgradeTier(
  memberId: string,
  lifetimeSpendPkr: number,
  currentTier: string,
  ctx: { shopifyOrderId?: string | null; shop?: string | null } = {},
): Promise<string> {
  const settings = await getSettings();
  const target = tierForSpend(lifetimeSpendPkr, tierThresholds(settings));
  let tier = currentTier;
  if ((TIER_RANK[target] ?? 0) > (TIER_RANK[currentTier] ?? 0)) {
    const { error } = await db.rpc("upgrade_member_tier", {
      p_member_id: memberId,
      p_to_tier: target,
      p_shopify_order_id: ctx.shopifyOrderId ?? null,
    });
    if (error) throw new Error(`tier upgrade failed: ${error.message}`);
    tier = target; // upgraded now, or a moment ago by another job
  }
  if (tier !== "silver") await ensureTierFollowUps(memberId, ctx.shop ?? null);
  return tier;
}

/**
 * Make sure a Gold / Diamond member has what the upgrade owes her. Looks only
 * at what exists, so it can run any number of times and finishes whatever an
 * interrupted job left undone:
 *   - no expiry dates on her live points (rule 8)
 *   - a tier reward code for every upgrade recorded in tier_history (rule 9)
 * A queueing failure is thrown, never swallowed, so the calling job is retried.
 */
export async function ensureTierFollowUps(memberId: string, shop?: string | null): Promise<{ queued: boolean }> {
  const { data: member, error } = await db
    .from("members")
    .select("id, tier, is_blocked, opted_out")
    .eq("id", memberId)
    .maybeSingle();
  if (error) throw new Error(`member lookup failed: ${error.message}`);
  if (!member || member.tier === "silver") return { queued: false };

  const { error: expErr } = await db
    .from("points_ledger")
    .update({ expires_at: null })
    .eq("member_id", memberId)
    .eq("expired", false)
    .not("expires_at", "is", null);
  if (expErr) throw new Error(`clearing expiry failed: ${expErr.message}`);

  if (member.is_blocked || member.opted_out) return { queued: false };

  const { data: historyRows, error: histErr } = await db
    .from("tier_history")
    .select("from_tier, to_tier")
    .eq("member_id", memberId);
  if (histErr) throw new Error(`tier history lookup failed: ${histErr.message}`);
  const history = historyRows ?? [];
  // Only upgrades this version recorded earn a code (members who were already
  // Gold before v3 have no history row and are not suddenly sent one).
  const reachedGold = history.some((h) => h.to_tier === "gold" || (h.to_tier === "diamond" && h.from_tier === "silver"));
  const reachedDiamond = history.some((h) => h.to_tier === "diamond");

  const settings = await getSettings();
  const owedGold = reachedGold && settings.tier_reward_gold_free_shipping;
  const owedDiamond = reachedDiamond && member.tier === "diamond" && settings.tier_reward_diamond_pkr > 0;
  // The program switch is not read: it only pauses redeeming (rule 20).
  if (!owedGold && !owedDiamond) return { queued: false };

  const keys = [`tier_gold:${memberId}`, `tier_diamond:${memberId}`];
  const { data: codes, error: codesErr } = await db.from("loyalty_codes").select("issue_key").in("issue_key", keys);
  if (codesErr) throw new Error(`tier code lookup failed: ${codesErr.message}`);
  const have = new Set((codes ?? []).map((c) => c.issue_key));
  const missingGold = owedGold && !have.has(keys[0]);
  const missingDiamond = owedDiamond && !have.has(keys[1]);
  if (!missingGold && !missingDiamond) return { queued: false };

  await pointsQueue.add("issue_tier_reward", {
    memberId,
    fromTier: missingGold ? "silver" : "gold",
    toTier: missingDiamond ? "diamond" : "gold",
    shop: shop ?? null,
  });
  return { queued: true };
}

// ── Social follows (rule 15) ──────────────────────────────────────────────

export async function awardSocial(socialActionId: string): Promise<{ awarded: boolean; reason?: string }> {
  const { data: row, error: rowErr } = await db
    .from("social_actions")
    .select("id, member_id, action_type, status")
    .eq("id", socialActionId)
    .maybeSingle();
  if (rowErr) throw new Error(`social action lookup failed: ${rowErr.message}`);
  if (!row) return { awarded: false, reason: "not_found" };
  if (row.status !== "pending") return { awarded: false, reason: "not_pending" };

  const platform = row.action_type as "youtube" | "facebook" | "instagram";
  const { data: member, error: memberErr } = await db
    .from("members")
    .select("id, tier, is_blocked, opted_out")
    .eq("id", row.member_id)
    .maybeSingle();
  // A failed read is not "no member": the claim must not be voided for it.
  if (memberErr) throw new Error(`member lookup failed: ${memberErr.message}`);
  const settings = await getSettings();

  const void_ = async (reason: string) => {
    await db.from("social_actions").update({ status: "voided" }).eq("id", socialActionId);
    return { awarded: false, reason };
  };
  if (!member) return void_("member_not_found");
  if (member.is_blocked) return void_("blocked");
  if (member.opted_out) return void_("opted_out");
  // The platform's own switch (rule 17); the program switch never voids a claim (rule 20).
  if (!isEarnRuleEnabled(settings, platform)) return void_("rule_off");

  const perPlatform = Number(settings[`social_points_${platform}` as const]);
  const points = Number.isFinite(perPlatform) ? perPlatform : settings.social_points;
  if (points <= 0) return void_("zero_points");

  const { data, error } = await db.rpc("award_points", {
    p_member_id: row.member_id,
    p_action_type: mapSocialActionType(platform),
    p_reference_id: socialActionId,
    p_points: points,
    p_expires_at: expiresAtForTier(member.tier, settings),
  });
  if (error) throw new Error(`award_points failed: ${error.message}`);
  const awarded = data?.[0]?.awarded ?? false;
  // Mark awarded on a replay too, so the row cannot stay pending for ever.
  await db.from("social_actions").update({ status: "awarded", points_awarded: points }).eq("id", socialActionId);
  if (awarded) {
    await notificationQueue
      .add("points_earned", { memberId: row.member_id, points, reason: `Following us on ${platform}` })
      .catch((err) => console.error("[awardSocial] notification enqueue failed:", err));
  }
  return { awarded };
}

/** How long after `pending_until` a claim is left to its own delayed job. */
export const SOCIAL_SWEEP_GRACE_MS = 60 * 60 * 1000;

/**
 * Cron safety net for social claims. The delayed BullMQ job is normally what
 * awards a `social_actions` row; if Redis loses that job (a flush, a restore
 * from an older snapshot) nothing else would, and the row would stay pending
 * for ever. This awards every row still pending more than an hour past its
 * `pending_until` through awardSocial, the same path the job uses: the ledger
 * write is idempotent on the claim id, so a job that turns up late, or a
 * second sweep, cannot pay twice. A row that fails is left pending and tried
 * again on the next run.
 */
export async function awardOverdueSocialActions(
  now: Date = new Date(),
  batchSize = 200,
): Promise<{ awarded: number; closed: number; failed: number }> {
  const cutoff = new Date(now.getTime() - SOCIAL_SWEEP_GRACE_MS).toISOString();
  const { data: rows, error } = await db
    .from("social_actions")
    .select("id")
    .eq("status", "pending")
    .lt("pending_until", cutoff)
    .order("pending_until", { ascending: true })
    .limit(batchSize);
  if (error) throw new Error(`overdue social claim query failed: ${error.message}`);

  const out = { awarded: 0, closed: 0, failed: 0 };
  for (const row of rows ?? []) {
    try {
      const r = await awardSocial(String(row.id));
      if (r.awarded) out.awarded++;
      else out.closed++; // voided (blocked, rule off...) or already in the ledger
    } catch (err) {
      out.failed++;
      console.error("[awardOverdueSocialActions] claim", row.id, "failed:", err instanceof Error ? err.message : err);
    }
  }
  return out;
}

// ── Expiry (rule 8) ───────────────────────────────────────────────────────

/**
 * Expire every overdue tranche of Silver members, whatever earned it. The
 * database removes exactly what is left in the tranche (never points earned
 * elsewhere) and marks it expired in the same transaction.
 */
export async function expireSilverPoints(
  now: Date = new Date(),
  batchSize = 500,
): Promise<{ membersAffected: number; pointsExpired: number; tranches: number }> {
  const { data: tranches, error } = await db
    .from("points_ledger")
    .select("id, member_id, points_remaining, members!inner(tier)")
    .gt("points", 0)
    .gt("points_remaining", 0) // nothing left = nothing to expire, and no 0-point row
    .eq("expired", false)
    .lt("expires_at", now.toISOString())
    .eq("members.tier", "silver")
    .order("expires_at", { ascending: true })
    .limit(batchSize); // bounded per run; the next run picks up the rest
  if (error) throw new Error(`expiry query failed: ${error.message}`);

  // Overdue tranches that were spent in full are simply closed.
  const { data: spent, error: spentErr } = await db
    .from("points_ledger")
    .select("id, members!inner(tier)")
    .gt("points", 0)
    .eq("points_remaining", 0)
    .eq("expired", false)
    .lt("expires_at", now.toISOString())
    .eq("members.tier", "silver")
    .limit(batchSize);
  if (spentErr) throw new Error(`expiry query failed: ${spentErr.message}`);
  if ((spent ?? []).length > 0) {
    const { error: closeErr } = await db
      .from("points_ledger")
      .update({ expired: true })
      .in("id", (spent ?? []).map((t) => t.id));
    if (closeErr) throw new Error(`closing spent tranches failed: ${closeErr.message}`);
  }

  const affected = new Set<string>();
  let total = 0;
  let count = 0;
  for (const t of tranches ?? []) {
    const tier = (t as unknown as { members?: { tier?: string } | null }).members?.tier;
    if (tier !== "silver") continue; // belt and braces
    const { data, error: rpcErr } = await db.rpc("award_points", {
      p_member_id: t.member_id,
      p_action_type: "expiry",
      p_reference_id: String(t.id),
      p_points: -(t.points_remaining ?? 0),
      p_reason_note: "expiry",
      p_customer_note: "Points expired",
    });
    if (rpcErr) throw new Error(`award_points(expiry) failed: ${rpcErr.message}`);
    // Counted either way: the database closes the tranche even when the
    // member's balance was already zero (and then writes no ledger row).
    count++;
    if (data?.[0]?.awarded) {
      affected.add(t.member_id);
      total += t.points_remaining ?? 0;
    }
  }
  return { membersAffected: affected.size, pointsExpired: total, tranches: count };
}

// ── Privacy webhooks ──────────────────────────────────────────────────────

/**
 * customers/redact: strip the personal details and keep the non-identifying
 * transaction rows (ledger rows reference the member and cannot be deleted).
 */
export async function redactCustomer(shopifyCustomerId: string): Promise<{ redacted: boolean }> {
  const customerId = String(shopifyCustomerId);
  const { data: member } = await db
    .from("members")
    .select("id")
    .eq("shopify_customer_id", customerId)
    .maybeSingle();
  if (!member) return { redacted: false };

  const placeholder = `redacted-${member.id}@redacted.invalid`;
  const { error } = await db
    .from("members")
    .update({
      email: placeholder,
      phone: null,
      first_name: null,
      last_name: null,
      birthday_day: null,
      birthday_month: null,
      last_seen_ip: null,
      consent_given: false,
      consent_given_at: null,
      opted_out: true, // never re-enrol a redacted customer
    })
    .eq("id", member.id);
  if (error) throw new Error(`redaction failed: ${error.message}`);

  await db.from("referrals").update({ referrer_ip: null, referred_ip: null }).eq("referrer_member_id", member.id);
  await db
    .from("referrals")
    .update({ referred_ip: null, referrer_ip: null, referred_email: placeholder })
    .eq("referred_shopify_customer_id", customerId);
  await db.from("staff_notes").delete().eq("member_id", member.id);

  return { redacted: true };
}

/**
 * shop/redact (rule 18): never deletes anything. The request is recorded in
 * gdpr_requests and raised as an alert heartbeat for the admin's system-health
 * view. Erasing the data is a separate, manual step (see README).
 */
export async function recordShopRedactRequest(shop: string, payload: unknown): Promise<{ recorded: boolean }> {
  const { error } = await db.from("gdpr_requests").insert({
    type: "shop_redact",
    shopify_customer_id: null,
    payload: { shop, received_at: new Date().toISOString(), payload: (payload ?? null) as Json } as Json,
  });
  if (error) throw new Error(`could not record shop/redact: ${error.message}`);
  await recordHeartbeat("alert:shop_redact", {
    shop,
    message: "Shopify asked for this shop's data to be erased. Nothing was deleted. See the README runbook.",
  });
  return { recorded: true };
}
