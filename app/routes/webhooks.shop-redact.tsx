import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { recordShopRedactRequest } from "../lib/points.service";

// Mandatory privacy webhook: shop/redact, sent about 48 hours after an
// uninstall. This app NEVER deletes data automatically (rule 18): the request
// is recorded in gdpr_requests and raised as an alert for the admin. Erasing
// the data is a manual, backed-up step described in the README.
export const action = async ({ request }: ActionFunctionArgs) => {
  const { topic, shop, payload } = await authenticate.webhook(request);
  console.log(`[webhook] ${topic} from ${shop}`);
  try {
    await recordShopRedactRequest(shop, payload);
  } catch (err) {
    // Non-2xx so Shopify retries: the request must be durably recorded.
    console.error("[shop-redact] error:", err instanceof Error ? err.message : err);
    return new Response(null, { status: 500 });
  }
  return new Response(null, { status: 200 });
};
