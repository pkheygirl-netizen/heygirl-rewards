// app/routes/proxy.customer.tsx
import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { extractProxyCustomerId } from "../lib/proxy-auth.server";
import { getMemberDashboard, getNudgeSettings, getProgramEnabled } from "../lib/widget-data.server";
import { enrolLoggedInCustomer } from "../lib/points.service";
import { unauthenticated } from "../shopify.server";

const CORS = { "Access-Control-Allow-Origin": "https://heygirl.pk" };

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);

  const programEnabled = await getProgramEnabled();
  if (!programEnabled) {
    return json({ programEnabled: false, loggedIn: false, nudgeSettings: null }, { headers: { ...CORS, "Cache-Control": "no-store" } });
  }

  let customerId: string | null;
  try {
    customerId = extractProxyCustomerId(url, process.env.SHOPIFY_API_SECRET!);
  } catch {
    return json({ error: "unauthorized" }, { status: 401, headers: { ...CORS, "Cache-Control": "no-store" } });
  }

  const nudgeSettings = await getNudgeSettings();

  if (!customerId) {
    return json({ loggedIn: false, nudgeSettings }, { headers: { ...CORS, "Cache-Control": "no-store" } });
  }

  const member = await getMemberDashboard(customerId);
  if (member) {
    return json({ loggedIn: true, member, nudgeSettings }, { headers: { ...CORS, "Cache-Control": "no-store" } });
  }

  // Logged-in customer with no member record yet (e.g. account predates install,
  // or the customers/create webhook never fired). Auto-enrol on first widget open
  // so the rewards panel can render. `shop` is part of the HMAC-verified query.
  try {
    const shop =
      url.searchParams.get("shop") ?? process.env.SHOPIFY_SHOP_DOMAIN ?? "heygirl.myshopify.com";
    const { admin } = await unauthenticated.admin(shop);
    await enrolLoggedInCustomer(customerId, admin);
    const enrolled = await getMemberDashboard(customerId);
    if (enrolled) {
      return json({ loggedIn: true, member: enrolled, nudgeSettings }, { headers: { ...CORS, "Cache-Control": "no-store" } });
    }
  } catch (err) {
    console.error("[proxy.customer] auto-enrol failed:", err);
  }

  return json({ loggedIn: true, member: null, nudgeSettings }, { headers: { ...CORS, "Cache-Control": "no-store" } });
};
