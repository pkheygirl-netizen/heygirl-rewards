import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { redactCustomer } from "../lib/points.service";

// GDPR/CCPA mandatory: customers/redact. Shopify requires the customer's
// personal data be erased. We anonymize the member and strip referral PII.
export const action = async ({ request }: ActionFunctionArgs) => {
  const { topic, shop, payload } = await authenticate.webhook(request);
  console.log(`[webhook] ${topic} from ${shop}`);
  try {
    const customerId = (payload as { customer?: { id?: string | number } })?.customer?.id;
    if (!customerId) return new Response(null, { status: 200 });
    await redactCustomer(String(customerId));
  } catch (err) {
    console.error("[customers-redact] error:", err);
  }
  return new Response(null, { status: 200 });
};
