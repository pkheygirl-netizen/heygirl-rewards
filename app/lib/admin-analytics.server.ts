import { db } from "../db.server";

export function bucketFlowByDay(
  rows: Array<{ points: number; action_type: string; earned_at: string }>,
): Array<{ date: string; issued: number; redeemed: number; expired: number }> {
  const map = new Map<string, { issued: number; redeemed: number; expired: number }>();
  for (const r of rows) {
    const day = new Date(r.earned_at).toISOString().slice(0, 10);
    const cur = map.get(day) ?? { issued: 0, redeemed: 0, expired: 0 };
    if (r.action_type === "redemption") cur.redeemed += Math.abs(r.points);
    else if (r.action_type === "expiry") cur.expired += Math.abs(r.points);
    else if (r.points > 0) cur.issued += r.points;
    map.set(day, cur);
  }
  return [...map.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, v]) => ({ date, ...v }));
}

export function parseRange(sp: URLSearchParams): { from: Date; to: Date } {
  const to = new Date();
  const fromParam = sp.get("from");
  const toParam = sp.get("to");
  if (fromParam && toParam) {
    return { from: new Date(fromParam), to: new Date(toParam) };
  }
  const range = sp.get("range") ?? "30d";
  const days = range === "7d" ? 7 : range === "90d" ? 90 : 30;
  return { from: new Date(to.getTime() - days * 86400000), to };
}

export async function getPointsFlowSeries(from: Date, to: Date) {
  const { data, error } = await db
    .from("points_ledger")
    .select("points, action_type, earned_at")
    .gte("earned_at", from.toISOString())
    .lte("earned_at", to.toISOString());
  if (error) throw error;
  return bucketFlowByDay((data ?? []) as any);
}

export async function getTopEarners(limit = 10) {
  const { data, error } = await db
    .from("points_ledger")
    .select("points, members(first_name,last_name,email)")
    .gt("points", 0);
  if (error) throw error;
  return aggregateByMember(data ?? [], (r) => r.points as number, limit);
}

export async function getTopRedeemers(limit = 10) {
  const { data, error } = await db
    .from("points_ledger")
    .select("points, members(first_name,last_name,email)")
    .eq("action_type", "redemption");
  if (error) throw error;
  return aggregateByMember(data ?? [], (r) => Math.abs(r.points as number), limit);
}

function aggregateByMember(
  rows: any[],
  value: (r: any) => number,
  limit: number,
): Array<{ name: string; email: string; points: number }> {
  const map = new Map<string, { name: string; email: string; points: number }>();
  for (const r of rows) {
    const m = r.members;
    if (!m) continue;
    const email = m.email ?? "—";
    const cur =
      map.get(email) ?? {
        name: [m.first_name, m.last_name].filter(Boolean).join(" ") || email,
        email,
        points: 0,
      };
    cur.points += value(r);
    map.set(email, cur);
  }
  return [...map.values()].sort((a, b) => b.points - a.points).slice(0, limit);
}

export async function getPopularRedemptionTier(): Promise<{ pkr: number; count: number } | null> {
  const { data, error } = await db.from("loyalty_codes").select("discount_amount_pkr");
  if (error) throw error;
  const counts = new Map<number, number>();
  for (const r of data ?? []) {
    const pkr = (r.discount_amount_pkr as number) ?? 0;
    counts.set(pkr, (counts.get(pkr) ?? 0) + 1);
  }
  let best: { pkr: number; count: number } | null = null;
  for (const [pkr, count] of counts) {
    if (!best || count > best.count) best = { pkr, count };
  }
  return best;
}

export async function getReferralFunnel(): Promise<{
  clicks: number;
  withOrder: number;
  completed: number;
}> {
  const [clicks, withOrder, completed] = await Promise.all([
    db.from("referrals").select("*", { count: "exact", head: true }),
    db.from("referrals").select("*", { count: "exact", head: true }).not("shopify_order_id", "is", null),
    db.from("referrals").select("*", { count: "exact", head: true }).eq("status", "completed"),
  ]);
  return {
    clicks: clicks.count ?? 0,
    withOrder: withOrder.count ?? 0,
    completed: completed.count ?? 0,
  };
}
