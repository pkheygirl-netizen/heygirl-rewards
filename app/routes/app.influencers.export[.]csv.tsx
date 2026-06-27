import type { LoaderFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { getInfluencers } from "../lib/admin-influencers.server";
import { toCsv, csvResponse } from "../lib/csv.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  const rows = await getInfluencers();
  const csv = toCsv(rows, [
    { key: "name", header: "Name" },
    { key: "email", header: "Email" },
    { key: "tier", header: "Tier" },
    { key: "customRate", header: "Custom Rate" },
    { key: "clicks", header: "Clicks" },
    { key: "conversions", header: "Conversions" },
    { key: "conversionRate", header: "Conversion Rate" },
    { key: "pointsEarned", header: "Points Earned" },
    { key: "rsEquivalent", header: "Rs Equivalent" },
  ] as const);
  return csvResponse("influencers.csv", csv);
};
