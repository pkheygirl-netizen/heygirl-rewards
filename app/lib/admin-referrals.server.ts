// app/lib/admin-referrals.server.ts
// Referral review queue. Approve and reject are stream A's functions; this file
// lists referrals with the reason each one is held and wraps the two actions.
import { adb, memberName, num, rpcObject, str, strOrNull, UUID_RE, type Row } from "./admin-db.server";
import { approveReferral, rejectReferral } from "./referrals.service";

import {
  REFERRAL_STATUSES, REFERRAL_STATUS_LABELS, REJECT_NOTE_MAX, type ReferralStatus,
} from "../components/admin-constants";
export { REFERRAL_STATUSES, REJECT_NOTE_MAX, type ReferralStatus };

export function parseReferralStatus(v: string | null | undefined): ReferralStatus | null {
  return (REFERRAL_STATUSES as readonly string[]).includes(v ?? "") ? (v as ReferralStatus) : null;
}

export const STATUS_LABELS = REFERRAL_STATUS_LABELS;

const FLAG_REASONS: Record<string, string> = {
  same_network: "Friend signed in from the same network address as the referrer",
  same_ip: "Friend signed in from the same network address as the referrer",
  same_contact: "Friend has the same email or phone as the referrer",
  same_email: "Friend has the same email as the referrer",
  same_address: "Friend uses the same delivery address as the referrer",
  same_device: "Friend used the same device as the referrer",
};

/**
 * Why a referral is held or blocked, from fraud_flags (then block_reason).
 * The old "IP match" column is gone: it compared two copies of the same
 * address and so was true for every row (handbook R5).
 */
export function referralReason(row: { fraud_flags?: unknown; block_reason?: unknown; status?: unknown }): string {
  const status = str(row.status);
  if (status !== "flagged" && status !== "blocked" && status !== "rejected") return "";
  const flags = Array.isArray(row.fraud_flags) ? row.fraud_flags.map(str).filter(Boolean) : [];
  const reasons = [...new Set(flags.map((f) => FLAG_REASONS[f] ?? f.replace(/_/g, " ")))];
  if (reasons.length) return reasons.join("; ");
  return str(row.block_reason) || (status === "flagged" ? "No reason was recorded" : "");
}

export type ReferralListRow = {
  id: string;
  referrerId: string;
  referrerName: string;
  referrerIsInfluencer: boolean;
  friend: string;
  status: string;
  statusLabel: string;
  reason: string;
  rewardPoints: number | null;
  createdAt: string;
  completedAt: string | null;
  reviewedNote: string | null;
};

export async function listReferrals(opts: {
  status?: ReferralStatus | null; page?: number; pageSize?: number;
}): Promise<{ rows: ReferralListRow[]; total: number }> {
  const page = Math.max(opts.page ?? 0, 0);
  const pageSize = opts.pageSize ?? 25;
  let q = adb()
    .from("referrals")
    .select(
      "id, referrer_member_id, referred_email, referred_shopify_customer_id, status, block_reason, fraud_flags, " +
        "reward_points, created_at, completed_at, reviewed_note, " +
        "members:referrer_member_id(first_name,last_name,email,phone,is_influencer)",
      { count: "exact" },
    );
  if (opts.status) q = q.eq("status", opts.status);
  const { data, count, error } = await q
    .order("created_at", { ascending: false })
    .range(page * pageSize, page * pageSize + pageSize - 1);
  if (error) throw new Error(`could not read referrals: ${error.message}`);
  const rows = ((data ?? []) as unknown as Row[]).map((r) => {
    const m = r.members as Row | null;
    const status = str(r.status);
    return {
      id: str(r.id),
      referrerId: str(r.referrer_member_id),
      referrerName: memberName(m),
      referrerIsInfluencer: m?.is_influencer === true,
      friend: str(r.referred_email) || (r.referred_shopify_customer_id ? `Customer ${str(r.referred_shopify_customer_id)}` : "Unknown"),
      status,
      statusLabel: STATUS_LABELS[status] ?? status,
      reason: referralReason(r),
      rewardPoints: r.reward_points === null || r.reward_points === undefined ? null : num(r.reward_points),
      createdAt: str(r.created_at),
      completedAt: strOrNull(r.completed_at),
      reviewedNote: strOrNull(r.reviewed_note),
    };
  });
  return { rows, total: num(count) };
}

export type ReferralSummary = {
  recorded: number; withOrder: number; completed: number; pending: number;
  flagged: number; blocked: number; rejected: number; pointsPaid: number;
};

export async function referralSummary(from?: string | null, to?: string | null): Promise<ReferralSummary> {
  const r = await rpcObject("admin_referral_funnel", { p_from: from ?? null, p_to: to ?? null });
  return {
    recorded: num(r.recorded), withOrder: num(r.with_order), completed: num(r.completed),
    pending: num(r.pending), flagged: num(r.flagged), blocked: num(r.blocked),
    rejected: num(r.rejected), pointsPaid: num(r.points_paid),
  };
}

export type ReviewOutcome = { ok: true; message: string } | { ok: false; error: string };

/**
 * Approve: the referral goes back to "pending" and pays when the friend's first
 * order is delivered and paid (straight away if it already is). It does not mark
 * the referral completed without paying, which the old button did (handbook L5).
 */
export async function approve(referralId: string, actor: string, shop: string): Promise<ReviewOutcome> {
  if (!UUID_RE.test(referralId)) return { ok: false, error: "That referral could not be found." };
  const res = await approveReferral(referralId, actor, shop);
  if (!res.ok) {
    return { ok: false, error: `The referral was not approved${res.reason ? ` (${res.reason.replace(/_/g, " ")})` : ""}. It may have been reviewed already.` };
  }
  return {
    ok: true,
    message: res.paid
      ? "Referral approved and the referrer has been paid"
      : "Referral approved. It pays when the friend's first order is delivered and paid",
  };
}

export async function reject(referralId: string, actor: string, note: string): Promise<ReviewOutcome> {
  if (!UUID_RE.test(referralId)) return { ok: false, error: "That referral could not be found." };
  const text = (note ?? "").trim();
  if (text.length > REJECT_NOTE_MAX) return { ok: false, error: `The note must be ${REJECT_NOTE_MAX} characters or fewer.` };
  const res = await rejectReferral(referralId, actor, text || undefined);
  if (!res.ok) return { ok: false, error: "The referral was not rejected. It may have been reviewed already." };
  return { ok: true, message: "Referral rejected. No points will be paid" };
}
