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
