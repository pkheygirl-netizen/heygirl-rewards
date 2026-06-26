import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";

// orders/paid is not a valid Shopify webhook topic in 2025-04.
// All order payment logic is handled by orders/updated webhook.
// This stub exists as a safety net and will be removed in Week 3.
export const action = async ({ request }: ActionFunctionArgs) => {
  const { topic, shop } = await authenticate.webhook(request);
  console.log(`[webhook] ${topic} from ${shop} — handled by orders-updated`);
  return new Response(null, { status: 200 });
};
