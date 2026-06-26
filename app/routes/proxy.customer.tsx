// app/routes/proxy.customer.tsx
import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { extractProxyCustomerId } from "../lib/proxy-auth.server";
import { getMemberDashboard, getNudgeSettings } from "../lib/widget-data.server";

const CORS = { "Access-Control-Allow-Origin": "https://heygirl.pk" };

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  let customerId: string | null;
  try {
    customerId = extractProxyCustomerId(url, process.env.SHOPIFY_API_SECRET!);
  } catch {
    return json({ error: "unauthorized" }, { status: 401, headers: CORS });
  }

  const nudgeSettings = await getNudgeSettings();

  if (!customerId) {
    return json({ loggedIn: false, nudgeSettings }, { headers: CORS });
  }

  const member = await getMemberDashboard(customerId);
  if (!member) {
    return json({ loggedIn: true, member: null, nudgeSettings }, { headers: CORS });
  }

  return json({ loggedIn: true, member, nudgeSettings }, { headers: CORS });
};
