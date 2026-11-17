import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { redactCustomer } from "../lib/points.service";
import { db } from "../db.server";

// GDPR/CCPA mandatory: customers/redact. Shopify requires the customer's
// personal data be erased. We anonymize the member and strip referral PII.
export const action = async ({ request }: ActionFunctionArgs) => {
  const { topic, shop, payload } = await authenticate.webhook(request);
  console.log(`[webhook] ${topic} from ${shop}`);
  try {
    const customerId = (payload as { customer?: { id?: string | number } })?.customer?.id;
    if (!customerId) return new Response(null, { status: 200 });
    await redactCustomer(String(customerId));
    // Durable record that the request was received and carried out.
    await db.from("gdpr_requests").insert({
      type: "customer_redact",
      shopify_customer_id: String(customerId),
      payload: null,
      status: "fulfilled",
    });
  } catch (err) {
    // Non-2xx so Shopify retries — a failed redaction must not be swallowed (W3).
    console.error("[customers-redact] error:", err);
    return new Response(null, { status: 500 });
  }
  return new Response(null, { status: 200 });
};
