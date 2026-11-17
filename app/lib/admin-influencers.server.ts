// app/lib/admin-influencers.server.ts
// Influencers tab: list with per-influencer results, detail, and form validation.
// Saving goes through stream A's influencer.service (setInfluencer,
// createInfluencerCode, removeInfluencerCode); nothing here writes those columns.
import { adb, memberName, num, rpcRows, str, strOrNull, UUID_RE, type Row } from "./admin-db.server";
import { FormReader, type FieldErrors } from "./admin-validate.server";
import { effectiveReferralPoints, removeInfluencerCode, setInfluencer } from "./influencer.service";

import { INFLUENCER_LIMITS, MULTIPLIER_PRESETS } from "../components/admin-constants";
export { INFLUENCER_LIMITS, MULTIPLIER_PRESETS };
const CODE_RE = /^[A-Z0-9][A-Z0-9_-]{2,31}$/;

export type InfluencerRow = {
  id: string;
  name: string;
  email: string | null;
  campaign: string | null;
  multiplier: number | null;
  /** What one completed referral pays her right now. */
  pointsPerReferral: number;
  /** True when her own rate is in force now (not paused, inside its dates). */
  rateActive: boolean;
  code: string | null;
  codePercent: number | null;
  paused: boolean;
  friends: number;
  completed: number;
  pending: number;
  held: number;
  orders: number;
  codeOrders: number;
  salesPkr: number;
  pointsPaid: number;
  slug: string;
};

type Stats = {
  friends: number; completed: number; pending: number; held: number;
  orders: number; codeOrders: number; salesPkr: number; pointsPaid: number;
};
const NO_STATS: Stats = { friends: 0, completed: 0, pending: 0, held: 0, orders: 0, codeOrders: 0, salesPkr: 0, pointsPaid: 0 };

const INFLUENCER_COLS =
  "id, first_name, last_name, email, phone, referral_slug, is_influencer, influencer_paused, influencer_multiplier, " +
  "influencer_referral_rate, influencer_campaign, influencer_rate_starts_at, influencer_rate_ends_at, " +
  "influencer_code, influencer_code_percent";

function nullableNum(v: unknown): number | null {
  return v === null || v === undefined || v === "" ? null : num(v);
}

function rateFields(m: Row) {
  return {
    is_influencer: m.is_influencer === true,
    influencer_paused: m.influencer_paused === true,
    influencer_multiplier: nullableNum(m.influencer_multiplier),
    influencer_referral_rate: nullableNum(m.influencer_referral_rate),
    influencer_rate_starts_at: strOrNull(m.influencer_rate_starts_at),
    influencer_rate_ends_at: strOrNull(m.influencer_rate_ends_at),
  };
}

function toRow(m: Row, s: Stats, standardPoints: number, now: Date): InfluencerRow {
  const per = effectiveReferralPoints(rateFields(m), standardPoints, now);
  return {
    id: str(m.id),
    name: memberName(m),
    email: strOrNull(m.email),
    campaign: strOrNull(m.influencer_campaign),
    multiplier: nullableNum(m.influencer_multiplier),
    pointsPerReferral: per,
    rateActive: per !== standardPoints,
    code: strOrNull(m.influencer_code),
    codePercent: nullableNum(m.influencer_code_percent),
    paused: m.influencer_paused === true,
    slug: str(m.referral_slug),
    ...s,
  };
}

async function statsByMember(from?: string | null, to?: string | null): Promise<Map<string, Stats>> {
  const rows = await rpcRows("admin_influencer_stats", { p_from: from ?? null, p_to: to ?? null });
  return new Map(
    rows.map((r) => [
      str(r.member_id),
      {
        friends: num(r.friends), completed: num(r.completed), pending: num(r.pending), held: num(r.held),
        orders: num(r.orders), codeOrders: num(r.code_orders),
        salesPkr: Math.round(num(r.sales_pkr)), pointsPaid: num(r.points_paid),
      },
    ]),
  );
}

export type InfluencerTotals = {
  active: number; paused: number; friends: number; completed: number;
  orders: number; salesPkr: number; pointsPaid: number; averagePerCompleted: number;
};

export function totalsOf(rows: InfluencerRow[]): InfluencerTotals {
  const sum = (f: (r: InfluencerRow) => number) => rows.reduce((s, r) => s + f(r), 0);
  const completed = sum((r) => r.completed);
  const pointsPaid = sum((r) => r.pointsPaid);
  return {
    active: rows.filter((r) => !r.paused).length,
    paused: rows.filter((r) => r.paused).length,
    friends: sum((r) => r.friends),
    completed,
    orders: sum((r) => r.orders),
    salesPkr: sum((r) => r.salesPkr),
    pointsPaid,
    averagePerCompleted: completed > 0 ? Math.round(pointsPaid / completed) : 0,
  };
}

/**
 * Every influencer with her results. `campaign` filters by her campaign label
 * ("none" = no label). The list of labels is returned unfiltered for the picker.
 * A store has tens of influencers, not thousands; the cap is a safety net and
 * `capped` tells the page when it was hit.
 */
export async function listInfluencers(opts: {
  campaign?: string | null; from?: string | null; to?: string | null; standardPoints: number; now?: Date;
}): Promise<{ rows: InfluencerRow[]; campaigns: string[]; capped: boolean }> {
  const CAP = 1000;
  const [membersRes, stats] = await Promise.all([
    adb().from("members").select(INFLUENCER_COLS).eq("is_influencer", true)
      .order("first_name", { ascending: true }).limit(CAP),
    statsByMember(opts.from, opts.to),
  ]);
  if (membersRes.error) throw new Error(`could not read influencers: ${membersRes.error.message}`);
  const members = (membersRes.data ?? []) as unknown as Row[];
  const now = opts.now ?? new Date();
  const all = members.map((m) => toRow(m, stats.get(str(m.id)) ?? NO_STATS, opts.standardPoints, now));
  const campaigns = [...new Set(all.map((r) => r.campaign).filter((c): c is string => Boolean(c)))].sort();
  const want = (opts.campaign ?? "").trim();
  const rows = !want ? all : want === "none" ? all.filter((r) => !r.campaign) : all.filter((r) => r.campaign === want);
  return { rows, campaigns, capped: members.length >= CAP };
}

// ── detail ───────────────────────────────────────────────────────────────────

export type InfluencerReferral = {
  id: string;
  friend: string;
  stage: string;
  status: string;
  points: number | null;
  createdAt: string;
};

/** Pure: where one of her referrals stands, in words. */
export function referralStage(
  r: { status: string },
  friendOrder: { fulfilled: boolean; paid: boolean } | null,
): string {
  switch (r.status) {
    case "completed": return "Order delivered and paid";
    case "flagged": return "Held for review";
    case "rejected": return "Rejected";
    case "blocked": return "Blocked";
    default:
      if (!friendOrder) return "Signed in, no order yet";
      if (friendOrder.fulfilled && !friendOrder.paid) return "Order delivered, awaiting payment";
      if (!friendOrder.fulfilled) return "Order placed, not delivered yet";
      return "Order delivered and paid, reward on its way";
  }
}

export type InfluencerDetail = {
  row: InfluencerRow;
  rateStartsAt: string | null;
  rateEndsAt: string | null;
  legacyRate: number | null;
  referrals: InfluencerReferral[];
  referralsTotal: number;
};

export async function getInfluencerDetail(
  memberId: string, opts: { standardPoints: number; page?: number; pageSize?: number; now?: Date },
): Promise<InfluencerDetail | null> {
  if (!UUID_RE.test(memberId)) return null;
  const page = Math.max(opts.page ?? 0, 0);
  const pageSize = opts.pageSize ?? 25;
  const [memberRes, stats, refsRes] = await Promise.all([
    adb().from("members").select(INFLUENCER_COLS).eq("id", memberId).maybeSingle(),
    statsByMember(),
    adb().from("referrals")
      .select("id, referred_email, referred_shopify_customer_id, status, reward_points, created_at", { count: "exact" })
      .eq("referrer_member_id", memberId)
      .order("created_at", { ascending: false })
      .range(page * pageSize, page * pageSize + pageSize - 1),
  ]);
  if (memberRes.error) throw new Error(`could not read the influencer: ${memberRes.error.message}`);
  if (refsRes.error) throw new Error(`could not read her referrals: ${refsRes.error.message}`);
  const m = memberRes.data as Row | null;
  if (!m || m.is_influencer !== true) return null;

  const refs = (refsRes.data ?? []) as Row[];
  const friendIds = [...new Set(refs.filter((r) => str(r.status) === "pending").map((r) => str(r.referred_shopify_customer_id)).filter(Boolean))];
  const orders = new Map<string, { fulfilled: boolean; paid: boolean }>();
  if (friendIds.length) {
    const { data, error } = await adb()
      .from("order_webhook_state")
      .select("shopify_customer_id, fulfillment_status, financial_status, created_at")
      .in("shopify_customer_id", friendIds)
      .is("cancelled_at", null)
      .order("created_at", { ascending: true })
      .limit(500);
    if (error) throw new Error(`could not read friends' orders: ${error.message}`);
    for (const o of (data ?? []) as Row[]) {
      const id = str(o.shopify_customer_id);
      if (!orders.has(id)) {
        orders.set(id, { fulfilled: str(o.fulfillment_status) === "fulfilled", paid: str(o.financial_status) === "paid" });
      }
    }
  }

  return {
    row: toRow(m, stats.get(memberId) ?? NO_STATS, opts.standardPoints, opts.now ?? new Date()),
    rateStartsAt: strOrNull(m.influencer_rate_starts_at),
    rateEndsAt: strOrNull(m.influencer_rate_ends_at),
    legacyRate: nullableNum(m.influencer_referral_rate),
    referrals: refs.map((r) => {
      const status = str(r.status);
      return {
        id: str(r.id),
        friend: str(r.referred_email) || `Customer ${str(r.referred_shopify_customer_id)}`,
        status,
        stage: referralStage({ status }, orders.get(str(r.referred_shopify_customer_id)) ?? null),
        points: r.reward_points === null || r.reward_points === undefined ? null : num(r.reward_points),
        createdAt: str(r.created_at),
      };
    }),
    referralsTotal: num(refsRes.count),
  };
}

// ── guards ───────────────────────────────────────────────────────────────────

/**
 * Is she an influencer right now, and does she hold a discount code? Read
 * before any rate, pause or resume action: those go through setInfluencer with
 * isInfluencer=true, so a tab left open after she was removed would otherwise
 * quietly make her an influencer again. null = no such member.
 */
export async function influencerState(memberId: string): Promise<{ isInfluencer: boolean; code: string | null } | null> {
  if (!UUID_RE.test(memberId)) return null;
  const { data, error } = await adb().from("members").select("id, is_influencer, influencer_code").eq("id", memberId).maybeSingle();
  if (error) throw new Error(`could not read the member: ${error.message}`);
  const m = data as Row | null;
  if (!m) return null;
  return { isInfluencer: m.is_influencer === true, code: strOrNull(m.influencer_code) };
}

export const NOT_AN_INFLUENCER = "She is no longer an influencer, so nothing was changed. Reload the page.";

export type RemoveInfluencerResult =
  | { ok: true; codeRemoved: string | null }
  | { ok: false; reason: string; stage: "code" | "status" | "lookup" };

/**
 * Remove influencer status. Her public Shopify discount code is deleted FIRST:
 * if that fails she stays an influencer and the caller reports the failure, so
 * a code that still works at checkout can never be left behind on a member the
 * admin no longer lists as an influencer.
 */
export async function removeInfluencerStatus(memberId: string, shop: string): Promise<RemoveInfluencerResult> {
  const state = await influencerState(memberId);
  if (!state) return { ok: false, reason: "member_not_found", stage: "lookup" };
  let codeRemoved: string | null = null;
  if (state.code) {
    const res = await removeInfluencerCode({ memberId, shop });
    // "no_code" means it was already gone: nothing is live, carry on.
    if (!res.ok && res.reason !== "no_code") return { ok: false, reason: res.reason ?? "shopify_error", stage: "code" };
    codeRemoved = state.code;
  }
  const res = await setInfluencer(memberId, { isInfluencer: false });
  if (!res.ok) return { ok: false, reason: res.reason ?? "db_error", stage: "status" };
  return { ok: true, codeRemoved };
}

// ── forms ────────────────────────────────────────────────────────────────────

type Form = { get(name: string): unknown };

export type InfluencerRateInput = {
  multiplier: number | null;
  campaign: string | null;
  rateStartsAt: string | null;
  rateEndsAt: string | null;
};

/**
 * multiplier_choice is "standard" (no own rate), one of the presets, or "custom"
 * with multiplier_custom. Dates are Karachi calendar days: the rate applies from
 * the start of the first day to the end of the last day.
 */
export function parseInfluencerRateForm(
  form: Form,
): { ok: true; value: InfluencerRateInput } | { ok: false; errors: FieldErrors } {
  const r = new FormReader(form);
  const L = INFLUENCER_LIMITS;
  const choice = r.raw("multiplier_choice");
  let multiplier: number | null = null;
  if (choice === "standard") multiplier = null;
  else if (choice === "custom") {
    multiplier = r.decimal("multiplier_custom", "Custom multiplier", L.multiplier.min, L.multiplier.max, 2);
  } else if ((MULTIPLIER_PRESETS as readonly number[]).includes(Number(choice))) multiplier = Number(choice);
  else r.fail("multiplier_choice", "Choose a multiplier.");

  const campaign = r.text("campaign", "Campaign", { max: L.campaign });
  const rateStartsAt = r.karachiDate("rate_starts", "Rate start date", "start");
  const rateEndsAt = r.karachiDate("rate_ends", "Rate end date", "end");
  if (r.ok && rateStartsAt && rateEndsAt && new Date(rateEndsAt) <= new Date(rateStartsAt)) {
    r.fail("rate_ends", "The end date must be on or after the start date.");
  }
  return r.ok
    ? { ok: true, value: { multiplier, campaign: campaign || null, rateStartsAt, rateEndsAt } }
    : { ok: false, errors: r.errors };
}

export function parseInfluencerCodeForm(
  form: Form,
): { ok: true; value: { code: string; percentOff: number } } | { ok: false; errors: FieldErrors } {
  const r = new FormReader(form);
  const code = r.raw("code").toUpperCase();
  if (!CODE_RE.test(code)) {
    r.fail("code", "A code is 3 to 32 letters or numbers (dashes and underscores allowed), with no spaces.");
  }
  const percentOff = r.int(
    "percent_off", "Discount percent", INFLUENCER_LIMITS.codePercent.min, INFLUENCER_LIMITS.codePercent.max);
  return r.ok ? { ok: true, value: { code, percentOff } } : { ok: false, errors: r.errors };
}

// ── export ───────────────────────────────────────────────────────────────────

export const INFLUENCER_CSV_COLUMNS = [
  { key: "name", header: "Influencer" },
  { key: "email", header: "Email" },
  { key: "campaign", header: "Campaign" },
  { key: "status", header: "Status" },
  { key: "multiplier", header: "Multiplier" },
  { key: "pointsPerReferral", header: "Points per referral" },
  { key: "code", header: "Discount code" },
  { key: "codePercent", header: "Code percent off" },
  { key: "friends", header: "Friends referred" },
  { key: "completed", header: "Completed referrals" },
  { key: "orders", header: "Orders attributed" },
  { key: "codeOrders", header: "Orders with her code" },
  { key: "salesPkr", header: "Sales attributed (Rs)" },
  { key: "pointsPaid", header: "Points paid" },
  { key: "link", header: "Referral link" },
] as const;

export function influencerCsvRows(rows: InfluencerRow[], link: (slug: string) => string) {
  return rows.map((r) => ({
    name: r.name, email: r.email ?? "", campaign: r.campaign ?? "",
    status: r.paused ? "Paused" : "Active",
    multiplier: r.multiplier, pointsPerReferral: r.pointsPerReferral,
    code: r.code ?? "", codePercent: r.codePercent,
    friends: r.friends, completed: r.completed, orders: r.orders, codeOrders: r.codeOrders,
    salesPkr: r.salesPkr, pointsPaid: r.pointsPaid, link: link(r.slug),
  }));
}
