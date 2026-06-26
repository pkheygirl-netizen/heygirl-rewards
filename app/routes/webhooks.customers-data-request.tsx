import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";

// GDPR/CCPA mandatory: customers/data_request. Shopify requests a copy of the
// customer's stored data on the customer's behalf. We log the request so the
// merchant can fulfil the export within the required window; no data is
// returned in the webhook response itself.
export const action = async ({ request }: ActionFunctionArgs) => {
  const { topic, shop, payload } = await authenticate.webhook(request);
  console.log(`[webhook] ${topic} from ${shop}`);
  try {
    const customerId = (payload as { customer?: { id?: string | number } })?.customer?.id;
    console.log(`[customers-data-request] data export requested for customer ${customerId ?? "unknown"}`);
  } catch (err) {
    console.error("[customers-data-request] error:", err);
  }
  return new Response(null, { status: 200 });
};
