// Points ledger export (linked from Settings → Data export). ?period=7d|30d|90d|month
// or ?period=all; optional ?type=<action_type>. Read in pages, so it is complete.
import type { LoaderFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { fmtDateTime, parsePeriodKey, periodRange } from "../components/karachi";
import { listLedger } from "../lib/admin-campaigns.server";
import { csvResponse, toCsv } from "../lib/csv.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  const sp = new URL(request.url).searchParams;
  const period = sp.get("period") === "all" ? null : periodRange(parsePeriodKey(sp.get("period"), true));
  const type = (sp.get("type") ?? "").replace(/[^a-z_]/g, "").slice(0, 40);
  const { rows, truncated } = await listLedger({ from: period?.from, to: period?.to, actionType: type || null });
  const out = rows.map((r) => ({ ...r, when: fmtDateTime(r.earnedAt) }));
  const csv = toCsv(out, [
    { key: "when", header: "When (Asia/Karachi)" },
    { key: "memberName", header: "Customer" },
    { key: "email", header: "Email" },
    { key: "actionType", header: "Type" },
    { key: "points", header: "Points" },
    { key: "balanceAfter", header: "Balance after" },
    { key: "orderId", header: "Shopify order id" },
    { key: "reason", header: "Internal reason" },
    { key: "customerNote", header: "Note the customer sees" },
  ] as const);
  const res = csvResponse(truncated ? "points-ledger-first-100000-rows.csv" : "points-ledger.csv", csv);
  if (truncated) res.headers.set("X-Export-Truncated", "true");
  return res;
};
