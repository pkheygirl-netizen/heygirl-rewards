import type { LoaderFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { listLedger } from "../lib/admin-campaigns.server";
import { toCsv, csvResponse } from "../lib/csv.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  const url = new URL(request.url);
  const rows = await listLedger({
    from: url.searchParams.get("from") ?? undefined,
    to: url.searchParams.get("to") ?? undefined,
    actionType: url.searchParams.get("actionType") ?? undefined,
  });
  const csv = toCsv(rows, [
    { key: "earnedAt", header: "Date" },
    { key: "memberName", header: "Member" },
    { key: "email", header: "Email" },
    { key: "actionType", header: "Action" },
    { key: "points", header: "Points" },
    { key: "balanceAfter", header: "Balance After" },
    { key: "reason", header: "Reason" },
  ] as const);
  return csvResponse("points-ledger.csv", csv);
};
