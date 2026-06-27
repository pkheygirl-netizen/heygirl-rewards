import type { LoaderFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { parseRange, getPointsFlowSeries } from "../lib/admin-analytics.server";
import { toCsv, csvResponse } from "../lib/csv.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  const url = new URL(request.url);
  const { from, to } = parseRange(url.searchParams);
  const flow = await getPointsFlowSeries(from, to);
  const csv = toCsv(flow, [
    { key: "date", header: "Date" },
    { key: "issued", header: "Issued" },
    { key: "redeemed", header: "Redeemed" },
    { key: "expired", header: "Expired" },
  ] as const);
  return csvResponse("analytics-points-flow.csv", csv);
};
