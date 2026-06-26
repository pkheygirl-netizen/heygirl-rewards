// app/routes/proxy.referral.tsx
import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { extractProxyCustomerId } from "../lib/proxy-auth.server";
import { getReferralDashboard } from "../lib/widget-data.server";

const CORS = { "Access-Control-Allow-Origin": "https://heygirl.pk" };

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  let customerId: string | null;
  try {
    customerId = extractProxyCustomerId(url, process.env.SHOPIFY_API_SECRET!);
  } catch {
    return json({ error: "unauthorized" }, { status: 401, headers: CORS });
  }
  if (!customerId) return json({ error: "not_logged_in" }, { status: 403, headers: CORS });

  const data = await getReferralDashboard(customerId);
  return json({ data }, { headers: CORS });
};
