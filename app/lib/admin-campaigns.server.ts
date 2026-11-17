// app/lib/admin-campaigns.server.ts
// Bonus campaigns: list with status and results, create, edit, switch off.
//
// Times are typed and shown in Asia/Karachi and stored in UTC (handbook R6).
// Switching a campaign on only ever switches off the campaigns whose dates
// overlap it, and only after the admin confirms (handbook R7); that switch-off
// and the save are one database transaction. The database refuses two active
// campaigns with overlapping dates.
import { adb, num, rpcObject, rpcRows, str, UUID_RE, type Row } from "./admin-db.server";
import { FormReader, type FieldErrors } from "./admin-validate.server";
import { fetchAllPages } from "./csv.server";

import { CAMPAIGN_LIMITS, CAMPAIGN_STATUS_LABELS, type CampaignStatus } from "../components/admin-constants";
export { CAMPAIGN_LIMITS, CAMPAIGN_STATUS_LABELS, type CampaignStatus };

export type CampaignResults = { orders: number; salesPkr: number; pointsIssued: number; pointsPending: number };

export type CampaignRow = {
  id: string;
  name: string;
  multiplier: number;
  startsAt: string;
  endsAt: string;
  isActive: boolean;
  status: CampaignStatus;
  results: CampaignResults;
};

export type CampaignInput = {
  name: string;
  multiplier: number;
  startsAt: string;
  endsAt: string;
  isActive: boolean;
};

export function campaignStatus(
  c: { startsAt: string; endsAt: string; isActive: boolean }, now: Date = new Date(),
): CampaignStatus {
  const t = now.getTime();
  if (t >= new Date(c.endsAt).getTime()) return "ended";
  if (!c.isActive) return "off";
  return t < new Date(c.startsAt).getTime() ? "scheduled" : "live";
}

/** Form → input. Start and end are Karachi wall-clock times. */
export function parseCampaignForm(
  form: { get(name: string): unknown },
): { ok: true; value: CampaignInput } | { ok: false; errors: FieldErrors } {
  const r = new FormReader(form);
  const L = CAMPAIGN_LIMITS;
  const name = r.text("name", "Campaign name", { max: L.name, required: true });
  // bonus_campaigns.multiplier is numeric(3,1): one decimal place
  const multiplier = r.decimal("multiplier", "Multiplier", L.multiplier.min, L.multiplier.max, 1);
  const startsAt = r.karachiDateTime("starts_at", "Start");
  const endsAt = r.karachiDateTime("ends_at", "End");
  if (r.ok && new Date(endsAt).getTime() <= new Date(startsAt).getTime()) {
    r.fail("ends_at", "The end must be after the start.");
  }
  const isActive = r.bool("is_active");
  return r.ok ? { ok: true, value: { name, multiplier, startsAt, endsAt, isActive } } : { ok: false, errors: r.errors };
}

function toCampaign(c: Row, results: Map<string, CampaignResults>, now: Date): CampaignRow {
  const base = {
    id: str(c.id), name: str(c.name), multiplier: num(c.multiplier, 1),
    startsAt: str(c.starts_at), endsAt: str(c.ends_at), isActive: c.is_active === true,
  };
  return {
    ...base,
    status: campaignStatus(base, now),
    results: results.get(base.id) ?? { orders: 0, salesPkr: 0, pointsIssued: 0, pointsPending: 0 },
  };
}

export async function listCampaigns(now: Date = new Date()): Promise<CampaignRow[]> {
  const [res, resultRows] = await Promise.all([
    adb().from("bonus_campaigns").select("id, name, multiplier, starts_at, ends_at, is_active")
      .order("starts_at", { ascending: false }).limit(500),
    rpcRows("admin_campaign_results"),
  ]);
  if (res.error) throw new Error(`could not read campaigns: ${res.error.message}`);
  const results = new Map<string, CampaignResults>(
    resultRows.map((r) => [
      str(r.campaign_id),
      {
        orders: num(r.orders), salesPkr: Math.round(num(r.sales_pkr)),
        pointsIssued: num(r.points_issued), pointsPending: num(r.points_pending),
      },
    ]),
  );
  return ((res.data ?? []) as Row[]).map((c) => toCampaign(c, results, now));
}

export type SaveCampaignResult =
  | { ok: true; switchedOff: string[] }
  | { ok: false; conflicts: Array<{ id: string; name: string }> }
  | { ok: false; error: string };

const CAMPAIGN_ERRORS: Record<string, string> = {
  not_found: "That campaign no longer exists.",
  overlap: "Another active campaign now overlaps these dates. Reload the page and try again.",
  ended: "This campaign has already ended. Edit its end time first, then switch it on.",
};

function readCampaignResult(r: Row): SaveCampaignResult {
  if (r.ok === true) {
    return { ok: true, switchedOff: Array.isArray(r.switched_off) ? r.switched_off.map(str) : [] };
  }
  if (Array.isArray(r.conflicts) && r.conflicts.length > 0) {
    return { ok: false, conflicts: (r.conflicts as Row[]).map((c) => ({ id: str(c.id), name: str(c.name) })) };
  }
  return { ok: false, error: CAMPAIGN_ERRORS[str(r.error)] ?? "The campaign could not be saved." };
}

/**
 * Create (id null) or update, in ONE database transaction (SQL function
 * admin_save_campaign in 011). When the campaign is on and other active
 * campaigns overlap its dates, nothing is saved unless `replaceOverlapping` is
 * true; then those campaigns are switched off and this one is saved together,
 * or neither happens. Campaigns that do not overlap are never touched.
 *
 * Switching off follows contract rule 2: a campaign that has started ends now
 * (ends_at = least(ends_at, now()), deactivated_at = now()) so orders already
 * placed during it keep its multiplier; one that has not started is only
 * switched off and keeps its dates.
 */
export async function saveCampaign(
  id: string | null, input: CampaignInput, opts: { replaceOverlapping?: boolean } = {},
): Promise<SaveCampaignResult> {
  if (id !== null && !UUID_RE.test(id)) return { ok: false, error: "That campaign could not be found." };
  const r = await rpcObject("admin_save_campaign", {
    p_id: id,
    p_name: input.name,
    p_multiplier: input.multiplier,
    p_starts_at: input.startsAt,
    p_ends_at: input.endsAt,
    p_is_active: input.isActive,
    p_replace_overlapping: opts.replaceOverlapping === true,
  });
  return readCampaignResult(r);
}

/** Switch one campaign on or off (SQL function admin_set_campaign_active; same rules as above). */
export async function setCampaignActive(id: string, active: boolean): Promise<SaveCampaignResult> {
  if (!UUID_RE.test(id)) return { ok: false, error: "That campaign could not be found." };
  return readCampaignResult(await rpcObject("admin_set_campaign_active", { p_id: id, p_active: active }));
}

/**
 * Delete is only for a campaign no order was placed under. Orders keep the
 * multiplier of the campaign that was running when they were placed, so a
 * campaign with orders stays as a record and can only be switched off.
 */
export async function deleteCampaign(id: string): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!UUID_RE.test(id)) return { ok: false, error: "That campaign could not be found." };
  const { count, error: countErr } = await adb().from("order_webhook_state")
    .select("id", { count: "exact", head: true }).eq("campaign_id", id);
  if (countErr) throw new Error(`could not check the campaign's orders: ${countErr.message}`);
  if (num(count) > 0) {
    return { ok: false, error: "Orders were placed under this campaign, so it is kept as a record. Switch it off instead." };
  }
  const { error } = await adb().from("bonus_campaigns").delete().eq("id", id);
  if (error) throw new Error(`could not delete the campaign: ${error.message}`);
  return { ok: true };
}

// ── points ledger export ─────────────────────────────────────────────────────

export type LedgerExportRow = {
  earnedAt: string;
  memberName: string;
  email: string;
  actionType: string;
  points: number;
  balanceAfter: number;
  reason: string;
  customerNote: string;
  orderId: string;
};

export const LEDGER_MAX_ROWS = 100000;

/** The ledger between two instants, read in pages so the export is complete. */
export async function listLedger(opts: {
  from?: string | null; to?: string | null; actionType?: string | null;
}): Promise<{ rows: LedgerExportRow[]; truncated: boolean }> {
  const { rows, truncated } = await fetchAllPages<Row>(
    (start, end) => {
      let q = adb().from("points_ledger").select(
        "id, earned_at, action_type, points, balance_after, reason_note, customer_note, shopify_order_id, " +
          "members(first_name,last_name,email,phone)",
      );
      if (opts.from) q = q.gte("earned_at", opts.from);
      if (opts.to) q = q.lt("earned_at", opts.to);
      if (opts.actionType) q = q.eq("action_type", opts.actionType);
      return q.order("earned_at", { ascending: false }).order("id", { ascending: true }).range(start, end) as unknown as
        PromiseLike<{ data: Row[] | null; error: { message: string } | null }>;
    },
    { maxRows: LEDGER_MAX_ROWS },
  );
  return {
    truncated,
    rows: rows.map((r) => {
      const m = r.members as Row | null;
      const name = [m?.first_name, m?.last_name].map(str).filter(Boolean).join(" ");
      return {
        earnedAt: str(r.earned_at),
        memberName: name || str(m?.email) || str(m?.phone),
        email: str(m?.email),
        actionType: str(r.action_type),
        points: num(r.points),
        balanceAfter: num(r.balance_after),
        reason: str(r.reason_note),
        customerNote: str(r.customer_note),
        orderId: str(r.shopify_order_id),
      };
    }),
  };
}
