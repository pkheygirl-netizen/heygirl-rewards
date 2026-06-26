import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { redactShop } from "../lib/points.service";

// GDPR/CCPA mandatory: shop/redact. Fires ~48h after uninstall. Single-merchant
// app, so this erases all stored data for the shop.
export const action = async ({ request }: ActionFunctionArgs) => {
  const { topic, shop } = await authenticate.webhook(request);
  console.log(`[webhook] ${topic} from ${shop}`);
  try {
    await redactShop();
  } catch (err) {
    console.error("[shop-redact] error:", err);
  }
  return new Response(null, { status: 200 });
};
