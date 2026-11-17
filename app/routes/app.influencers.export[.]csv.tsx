// CSV export for the Influencers tab. Without ?id: one row per influencer (same
// campaign and period filters as the page). With ?id: that influencer's referrals.
import type { LoaderFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { fmtDateTime, parsePeriodKey, periodRange } from "../components/karachi";
import { adb, num, str, UUID_RE, type Row } from "../lib/admin-db.server";
import { INFLUENCER_CSV_COLUMNS, influencerCsvRows, listInfluencers } from "../lib/admin-influencers.server";
import { referralLink } from "../lib/admin-members.server";
import { STATUS_LABELS } from "../lib/admin-referrals.server";
import { getSettingsRow } from "../lib/admin-settings.server";
import { csvResponse, fetchAllPages, toCsv } from "../lib/csv.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const sp = new URL(request.url).searchParams;

  const id = sp.get("id");
  if (id) {
    if (!UUID_RE.test(id)) return new Response("Not found", { status: 404 });
    const { rows } = await fetchAllPages<Row>(
      (from, to) => adb().from("referrals")
        .select("id, referred_email, referred_shopify_customer_id, status, reward_points, shopify_order_id, created_at, completed_at")
        .eq("referrer_member_id", id).order("created_at", { ascending: false }).order("id", { ascending: true })
        .range(from, to) as unknown as PromiseLike<{ data: Row[] | null; error: { message: string } | null }>,
      { maxRows: 50000 },
    );
    const out = rows.map((r) => ({
      friend: str(r.referred_email) || `Customer ${str(r.referred_shopify_customer_id)}`,
      status: STATUS_LABELS[str(r.status)] ?? str(r.status),
      points: r.reward_points === null || r.reward_points === undefined ? null : num(r.reward_points),
      order: str(r.shopify_order_id),
      created: fmtDateTime(str(r.created_at)),
      completed: fmtDateTime(str(r.completed_at)),
    }));
    return csvResponse("influencer-referrals.csv", toCsv(out, [
      { key: "friend", header: "Friend" },
      { key: "status", header: "Stage" },
      { key: "points", header: "Points paid" },
      { key: "order", header: "Shopify order id" },
      { key: "created", header: "Referred at (Asia/Karachi)" },
      { key: "completed", header: "Completed at (Asia/Karachi)" },
    ] as const));
  }

  const periodKey = sp.get("period") ?? "all";
  const period = periodKey === "all" ? null : periodRange(parsePeriodKey(periodKey, true));
  const settings = await getSettingsRow();
  const { rows } = await listInfluencers({
    campaign: (sp.get("campaign") ?? "").slice(0, 80),
    from: period?.from ?? null, to: period?.to ?? null,
    standardPoints: Number(settings.referral_points ?? 6000),
  });
  const csv = toCsv(influencerCsvRows(rows, (slug) => referralLink(slug, session.shop)), INFLUENCER_CSV_COLUMNS);
  return csvResponse("influencers.csv", csv);
};
