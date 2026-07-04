import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { db } from "../db.server";

// GDPR/CCPA mandatory: customers/data_request. Shopify requests a copy of the
// customer's stored data on the customer's behalf. We persist the request
// (logs rotate — W4) so the merchant can fulfil the export within 30 days;
// no data is returned in the webhook response itself.
export const action = async ({ request }: ActionFunctionArgs) => {
  const { topic, shop, payload } = await authenticate.webhook(request);
  console.log(`[webhook] ${topic} from ${shop}`);
  try {
    const customerId = (payload as { customer?: { id?: string | number } })?.customer?.id;
    const { error } = await db.from("gdpr_requests").insert({
      type: "data_request",
      shopify_customer_id: customerId != null ? String(customerId) : null,
      payload: payload as never,
    });
    if (error) throw error;
  } catch (err) {
    // Non-2xx so Shopify retries; the request must be durably recorded.
    console.error("[customers-data-request] error:", err);
    return new Response(null, { status: 500 });
  }
  return new Response(null, { status: 200 });
};
