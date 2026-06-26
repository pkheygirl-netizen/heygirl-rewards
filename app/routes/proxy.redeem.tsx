// app/routes/proxy.redeem.tsx
import type { ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { extractProxyCustomerId } from "../lib/proxy-auth.server";
import { redeemPoints } from "../lib/redemption.service";
import { unauthenticated } from "../shopify.server";

const CORS = { "Access-Control-Allow-Origin": "https://heygirl.pk" };

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") return json({ error: "method_not_allowed" }, { status: 405, headers: CORS });

  const url = new URL(request.url);
  let customerId: string | null;
  try {
    customerId = extractProxyCustomerId(url, process.env.SHOPIFY_API_SECRET!);
  } catch {
    return json({ error: "unauthorized" }, { status: 401, headers: CORS });
  }
  if (!customerId) return json({ error: "not_logged_in" }, { status: 403, headers: CORS });

  let body: { requestedPoints?: number };
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid_json" }, { status: 400, headers: CORS });
  }

  const { requestedPoints } = body;
  if (!requestedPoints) return json({ error: "missing_fields" }, { status: 400, headers: CORS });

  let admin: Awaited<ReturnType<typeof unauthenticated.admin>>["admin"];
  try {
    ({ admin } = await unauthenticated.admin(
      process.env.SHOPIFY_SHOP_DOMAIN ?? "heygirl.myshopify.com"
    ));
  } catch (err) {
    console.error("[proxy.redeem] admin auth failed:", err);
    return json({ error: "admin_auth_failed" }, { status: 500, headers: CORS });
  }

  try {
    const result = await redeemPoints({ shopifyCustomerId: customerId, requestedPoints: Number(requestedPoints), admin });
    return json(result, { status: result.redeemed ? 200 : 400, headers: CORS });
  } catch (err) {
    console.error("[proxy.redeem] error:", err);
    return json({ error: "internal_error" }, { status: 500, headers: CORS });
  }
};
