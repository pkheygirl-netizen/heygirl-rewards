// app/lib/admin-members.server.ts
// Customers list and the full-page customer profile.
import { adb, num, rpcObject, rpcRows, str, strOrNull, shopifyNumericId, memberName, UUID_RE, type Row } from "./admin-db.server";
import { FormReader, UserError, type FieldErrors } from "./admin-validate.server";
import { ADJUST_LIMITS, NOTE_MAX, previewBalance } from "../components/admin-constants";

export type Tier = "silver" | "gold" | "diamond";
const TIERS: readonly Tier[] = ["silver", "gold", "diamond"];

// ── list ─────────────────────────────────────────────────────────────────────

export const CUSTOMER_SORTS = ["joined", "points", "spend", "name"] as const;
export type CustomerSort = (typeof CUSTOMER_SORTS)[number];

export type CustomerFilters = {
  query: string;
  tier: Tier | null;
  hasPoints: boolean | null;
  blocked: boolean | null;
  optedOut: boolean | null;
  influencer: boolean | null;
  sort: CustomerSort;
  desc: boolean;
  page: number;
};

function tri(v: string | null): boolean | null {
  return v === "yes" ? true : v === "no" ? false : null;
}

/** Pure: URL query string → filters, with anything unexpected dropped. */
export function parseCustomerFilters(sp: URLSearchParams): CustomerFilters {
  const tier = sp.get("tier");
  const sort = sp.get("sort");
  const page = Number(sp.get("page") ?? "0");
  return {
    query: (sp.get("q") ?? "").trim().slice(0, 100),
    tier: (TIERS as readonly string[]).includes(tier ?? "") ? (tier as Tier) : null,
    hasPoints: tri(sp.get("points")),
    blocked: tri(sp.get("blocked")),
    optedOut: tri(sp.get("optedout")),
    influencer: tri(sp.get("influencer")),
    sort: (CUSTOMER_SORTS as readonly string[]).includes(sort ?? "") ? (sort as CustomerSort) : "joined",
    desc: sp.get("dir") !== "asc",
    page: Number.isInteger(page) && page > 0 && page < 100000 ? page : 0,
  };
}

export type CustomerRow = {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  tier: Tier;
  pointsBalance: number;
  lifetimeSpendPkr: number;
  isBlocked: boolean;
  optedOut: boolean;
  isInfluencer: boolean;
  enrolledAt: string;
};

function toCustomerRow(r: Row): CustomerRow {
  return {
    id: str(r.id),
    name: str(r.name) || "Customer",
    email: strOrNull(r.email),
    phone: strOrNull(r.phone),
    tier: (TIERS as readonly string[]).includes(str(r.tier)) ? (str(r.tier) as Tier) : "silver",
    pointsBalance: num(r.points_balance),
    lifetimeSpendPkr: Math.round(num(r.lifetime_spend_pkr)),
    isBlocked: r.is_blocked === true,
    optedOut: r.opted_out === true,
    isInfluencer: r.is_influencer === true,
    enrolledAt: str(r.enrolled_at),
  };
}

/**
 * Search, filter, sort and page in the database. The search text is passed as a
 * parameter and matched as plain text, so brackets, commas and percent signs in
 * a name or email are safe (the old PostgREST `or()` filter broke on them).
 */
export async function searchCustomers(
  f: Partial<CustomerFilters>, pageSize = 25, offset?: number,
): Promise<{ customers: CustomerRow[]; total: number }> {
  const rows = await rpcRows("admin_search_members", {
    p_query: f.query ? f.query : null,
    p_tier: f.tier ?? null,
    p_has_points: f.hasPoints ?? null,
    p_blocked: f.blocked ?? null,
    p_opted_out: f.optedOut ?? null,
    p_influencer: f.influencer ?? null,
    p_sort: f.sort ?? "joined",
    p_desc: f.desc ?? true,
    p_limit: pageSize,
    // An explicit row offset (exports) wins over the page number (the list).
    p_offset: offset ?? (f.page ?? 0) * pageSize,
  });
  return { customers: rows.map(toCustomerRow), total: rows.length ? num(rows[0].total_count) : 0 };
}

// ── profile ──────────────────────────────────────────────────────────────────

export type RewardCode = {
  id: string;
  code: string;
  kind: string;
  kindLabel: string;
  status: string;
  discountPkr: number;
  pointsSpent: number;
  expiresAt: string | null;
  usedAt: string | null;
  createdAt: string;
  orderId: string | null;
  /** Only an unused reward code bought with points can be cancelled for a return. */
  canCancel: boolean;
};

const KIND_LABELS: Record<string, string> = {
  reward: "Reward",
  birthday: "Birthday",
  referral_friend: "Referred friend",
  tier_gold: "Gold reward",
  tier_diamond: "Diamond reward",
};

export function toRewardCode(r: Row): RewardCode {
  const kind = str(r.kind) || "reward";
  const status = str(r.status);
  return {
    id: str(r.id),
    code: str(r.code),
    kind,
    kindLabel: KIND_LABELS[kind] ?? kind,
    status,
    discountPkr: num(r.discount_amount_pkr),
    pointsSpent: num(r.points_spent),
    expiresAt: strOrNull(r.expires_at),
    usedAt: strOrNull(r.used_at),
    createdAt: str(r.created_at),
    orderId: strOrNull(r.shopify_order_id),
    canCancel: kind === "reward" && status === "active",
  };
}

export type StaffNote = { id: string; note: string; author: string | null; createdAt: string };

export type CustomerProfile = {
  id: string;
  shopifyCustomerId: string;
  shopifyNumericId: string;
  name: string;
  firstName: string | null;
  email: string | null;
  phone: string | null;
  tier: Tier;
  pointsBalance: number;
  pendingPoints: number;
  lifetimeSpendPkr: number;
  enrolledAt: string;
  consentSource: string | null;
  isBlocked: boolean;
  optedOut: boolean;
  referralsBlocked: boolean;
  importedFromSmile: boolean;
  birthdayMonth: number | null;
  birthdayDay: number | null;
  birthdaySetAt: string | null;
  referralSlug: string;
  referrals: { completed: number; pending: number; held: number };
  /** overdue = the date has passed but the nightly job has not removed the points yet */
  nextExpiry: { points: number; at: string; overdue: boolean } | null;
  influencer: {
    isInfluencer: boolean;
    paused: boolean;
    multiplier: number | null;
    legacyRate: number | null;
    campaign: string | null;
    rateStartsAt: string | null;
    rateEndsAt: string | null;
    code: string | null;
    codePercent: number | null;
  };
};

const PROFILE_COLS =
  "id, shopify_customer_id, first_name, last_name, email, phone, tier, points_balance, lifetime_spend_pkr, " +
  "enrolled_at, consent_source, is_blocked, opted_out, referrals_blocked, imported_from_smile, " +
  "birthday_month, birthday_day, birthday_set_at, referral_slug, is_influencer, influencer_paused, " +
  "influencer_multiplier, influencer_referral_rate, influencer_campaign, influencer_rate_starts_at, " +
  "influencer_rate_ends_at, influencer_code, influencer_code_percent";

function nullableNum(v: unknown): number | null {
  return v === null || v === undefined || v === "" ? null : num(v);
}

export async function getCustomerProfile(memberId: string): Promise<CustomerProfile | null> {
  if (!UUID_RE.test(memberId)) return null;
  const [memberRes, summary] = await Promise.all([
    adb().from("members").select(PROFILE_COLS).eq("id", memberId).maybeSingle(),
    rpcObject("admin_member_summary", { p_member: memberId }),
  ]);
  if (memberRes.error) throw new Error(`could not read the customer: ${memberRes.error.message}`);
  const m = memberRes.data as Row | null;
  if (!m) return null;
  const next = summary.next_expiry as Row | null | undefined;
  return {
    id: str(m.id),
    shopifyCustomerId: str(m.shopify_customer_id),
    shopifyNumericId: shopifyNumericId(m.shopify_customer_id),
    name: memberName(m),
    firstName: strOrNull(m.first_name),
    email: strOrNull(m.email),
    phone: strOrNull(m.phone),
    tier: (TIERS as readonly string[]).includes(str(m.tier)) ? (str(m.tier) as Tier) : "silver",
    pointsBalance: num(m.points_balance),
    pendingPoints: num(summary.pending_points),
    lifetimeSpendPkr: Math.round(num(m.lifetime_spend_pkr)),
    enrolledAt: str(m.enrolled_at),
    consentSource: strOrNull(m.consent_source),
    isBlocked: m.is_blocked === true,
    optedOut: m.opted_out === true,
    referralsBlocked: m.referrals_blocked === true,
    importedFromSmile: m.imported_from_smile === true,
    birthdayMonth: nullableNum(m.birthday_month),
    birthdayDay: nullableNum(m.birthday_day),
    birthdaySetAt: strOrNull(m.birthday_set_at),
    referralSlug: str(m.referral_slug),
    referrals: {
      completed: num(summary.referrals_completed),
      pending: num(summary.referrals_pending),
      held: num(summary.referrals_held),
    },
    nextExpiry: next && next.at
      ? { points: num(next.points), at: str(next.at), overdue: new Date(str(next.at)).getTime() < Date.now() }
      : null,
    influencer: {
      isInfluencer: m.is_influencer === true,
      paused: m.influencer_paused === true,
      multiplier: nullableNum(m.influencer_multiplier),
      legacyRate: nullableNum(m.influencer_referral_rate),
      campaign: strOrNull(m.influencer_campaign),
      rateStartsAt: strOrNull(m.influencer_rate_starts_at),
      rateEndsAt: strOrNull(m.influencer_rate_ends_at),
      code: strOrNull(m.influencer_code),
      codePercent: nullableNum(m.influencer_code_percent),
    },
  };
}

export async function listRewardCodes(memberId: string, limit = 50): Promise<RewardCode[]> {
  const { data, error } = await adb()
    .from("loyalty_codes")
    .select("id, code, kind, status, discount_amount_pkr, points_spent, expires_at, used_at, created_at, shopify_order_id")
    .eq("member_id", memberId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error(`could not read reward codes: ${error.message}`);
  return ((data ?? []) as Row[]).map(toRewardCode);
}

/** A code belongs to this customer? Checked before cancelling from her profile. */
export async function codeBelongsTo(codeId: string, memberId: string): Promise<boolean> {
  if (!UUID_RE.test(codeId)) return false;
  const { data, error } = await adb()
    .from("loyalty_codes").select("id").eq("id", codeId).eq("member_id", memberId).maybeSingle();
  if (error) throw new Error(`could not read the code: ${error.message}`);
  return Boolean(data);
}

// ── tier progress ────────────────────────────────────────────────────────────

export type TierProgress = {
  tier: Tier;
  nextTier: "gold" | "diamond" | null;
  nextThresholdPkr: number | null;
  remainingPkr: number;
  /** 0-100 towards the next tier; 100 at the top tier */
  percent: number;
};

/**
 * Progress from settings thresholds. The stored tier wins over spend because
 * tiers are never taken away (a refund can leave spend below the threshold).
 */
export function tierProgress(spendPkr: number, tier: Tier, t: { gold: number; diamond: number }): TierProgress {
  if (tier === "diamond") return { tier, nextTier: null, nextThresholdPkr: null, remainingPkr: 0, percent: 100 };
  const nextTier = tier === "gold" ? "diamond" : "gold";
  const target = nextTier === "gold" ? t.gold : t.diamond;
  const base = nextTier === "gold" ? 0 : t.gold;
  const span = Math.max(target - base, 1);
  const done = Math.min(Math.max(spendPkr - base, 0), span);
  return {
    tier,
    nextTier,
    nextThresholdPkr: target,
    remainingPkr: Math.max(Math.ceil(target - spendPkr), 0),
    percent: Math.round((done / span) * 100),
  };
}

// ── adjust balance ───────────────────────────────────────────────────────────

export { ADJUST_LIMITS, NOTE_MAX, previewBalance };
const IDEMPOTENCY_RE = /^[A-Za-z0-9_-]{8,64}$/;

export type Adjustment = {
  direction: "add" | "remove";
  points: number;
  reason: string;
  customerNote: string | null;
  idempotencyKey: string;
};

export function parseAdjustment(
  form: { get(name: string): unknown },
): { ok: true; value: Adjustment } | { ok: false; errors: FieldErrors } {
  const r = new FormReader(form);
  const direction = r.oneOf("direction", "Add or remove", ["add", "remove"] as const);
  const points = r.int("points", "Points", 1, ADJUST_LIMITS.maxPoints);
  const reason = r.text("reason", "Reason", { max: ADJUST_LIMITS.reason, required: true });
  const customerNote = r.text("customer_note", "Note the customer sees", { max: ADJUST_LIMITS.customerNote });
  const idempotencyKey = r.raw("idempotency_key");
  if (!IDEMPOTENCY_RE.test(idempotencyKey)) {
    r.fail("idempotency_key", "This form is out of date. Reload the page and try again.");
  }
  return r.ok
    ? { ok: true, value: { direction, points, reason, customerNote: customerNote || null, idempotencyKey } }
    : { ok: false, errors: r.errors };
}

/**
 * Who did it, stored at the front of the internal reason: "[by Ayesha R] Goodwill".
 * The ledger has no actor column; reason_note is admin-only and never reaches
 * the storefront, so the record of who adjusted a balance lives with the entry.
 */
export function withActor(actor: string, reason: string): string {
  const who = (actor ?? "").replace(/[\[\]\r\n]/g, " ").trim().slice(0, 80) || "Store staff";
  return `[by ${who}] ${reason}`;
}

/**
 * Apply one adjustment. The form's key becomes the ledger reference, and the
 * ledger is unique on (member, action, reference), so a double submit or a
 * retried request applies once: the second call returns applied=false with the
 * balance unchanged. The internal reason goes to reason_note (admin only); the
 * optional note goes to customer_note, the only text the storefront shows.
 */
export async function adjustBalance(
  memberId: string, a: Adjustment, actor: string,
): Promise<{ applied: boolean; newBalance: number }> {
  const { data, error } = await adb().rpc("award_points", {
    p_member_id: memberId,
    p_action_type: "adjustment",
    p_reference_id: `admin-adjust:${a.idempotencyKey}`,
    p_points: a.direction === "add" ? a.points : -a.points,
    p_reason_note: withActor(actor, a.reason),
    p_customer_note: a.customerNote,
  });
  if (error) throw new Error(`could not adjust the balance: ${error.message}`);
  const row = (Array.isArray(data) ? data[0] : data) as Row | null;
  return { applied: row?.awarded === true, newBalance: num(row?.new_balance) };
}

// ── block, notes ─────────────────────────────────────────────────────────────

/**
 * Block or unblock. Returns false when no such member exists (nothing changed).
 * Each change is written to the member's staff notes with who made it, so the
 * profile shows when she was blocked and by whom.
 */
export async function setBlocked(memberId: string, blocked: boolean, actor: string): Promise<boolean> {
  const { data, error } = await adb().from("members").update({ is_blocked: blocked }).eq("id", memberId).select("id");
  if (error) throw new Error(`could not update the customer: ${error.message}`);
  if (!data || (data as unknown[]).length === 0) return false;
  const { error: noteErr } = await adb().from("staff_notes").insert({
    member_id: memberId,
    note: blocked ? "Blocked this customer" : "Unblocked this customer",
    author: actor || "Store staff",
  });
  // The block itself is done; a missing audit line is logged, not hidden.
  if (noteErr) console.error(`[admin] block audit note not written for ${memberId}: ${noteErr.message}`);
  return true;
}

export async function listStaffNotes(memberId: string, limit = 50): Promise<StaffNote[]> {
  const { data, error } = await adb()
    .from("staff_notes")
    .select("id, note, author, created_at")
    .eq("member_id", memberId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error(`could not read staff notes: ${error.message}`);
  return ((data ?? []) as Row[]).map((r) => ({
    id: str(r.id), note: str(r.note), author: strOrNull(r.author), createdAt: str(r.created_at),
  }));
}

export async function addStaffNote(memberId: string, note: string, author: string | null): Promise<void> {
  const text = (note ?? "").trim();
  if (!text) throw new UserError("Write a note before saving.");
  if (text.length > NOTE_MAX) throw new UserError(`A note must be ${NOTE_MAX} characters or fewer.`);
  const { error } = await adb().from("staff_notes").insert({ member_id: memberId, note: text, author });
  if (error) throw new Error(`could not save the note: ${error.message}`);
}

export async function deleteStaffNote(memberId: string, noteId: string): Promise<void> {
  const { error } = await adb().from("staff_notes").delete().eq("id", noteId).eq("member_id", memberId);
  if (error) throw new Error(`could not delete the note: ${error.message}`);
}

// ── birthday ─────────────────────────────────────────────────────────────────

const DAYS_IN_MONTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

export function parseBirthday(
  form: { get(name: string): unknown },
): { ok: true; month: number; day: number } | { ok: false; errors: FieldErrors } {
  const r = new FormReader(form);
  const month = r.int("birthday_month", "Month", 1, 12);
  const day = r.int("birthday_day", "Day", 1, 31);
  if (r.ok && day > DAYS_IN_MONTH[month - 1]) r.fail("birthday_day", "That month does not have that many days.");
  return r.ok ? { ok: true, month, day } : { ok: false, errors: r.errors };
}

// ── links ────────────────────────────────────────────────────────────────────

/** Her public referral link. STOREFRONT_URL (the customer-facing domain) wins when set. */
export function referralLink(
  slug: string, shop: string, storefrontUrl: string | undefined = process.env.STOREFRONT_URL,
): string {
  if (!slug) return "";
  const base = storefrontUrl && /^https?:\/\//.test(storefrontUrl)
    ? storefrontUrl.replace(/\/+$/, "")
    : `https://${shop}`;
  return `${base}/?ref=${encodeURIComponent(slug)}`;
}

export function shopifyCustomerUrl(shop: string, numericId: string): string | null {
  return numericId && /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i.test(shop)
    ? `https://${shop}/admin/customers/${numericId}`
    : null;
}

/** Name for the staff-note author and the audit actor: who is signed in to Shopify admin. */
export function actorFromSession(session: { shop?: string; onlineAccessInfo?: unknown } | null | undefined): string {
  const info = session?.onlineAccessInfo as { associated_user?: { first_name?: string; last_name?: string; email?: string } } | undefined;
  const u = info?.associated_user;
  const name = [u?.first_name, u?.last_name].filter(Boolean).join(" ").trim();
  return name || u?.email || "Store staff";
}
