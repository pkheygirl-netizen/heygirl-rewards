import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { pointsQueue } from "../lib/queue.server";
import { parseOrderPayload } from "../lib/orders.server";

// orders/updated: the worker keeps the stored order in step and awards the points
// once the order is fulfilled AND paid AND not cancelled (rule 1). Cash on
// delivery orders reach "paid" when staff mark them paid in Shopify admin.
export const action = async ({ request }: ActionFunctionArgs) => {
  const { topic, shop, payload } = await authenticate.webhook(request);
  console.log(`[webhook] ${topic} from ${shop}`);
  const event = parseOrderPayload(payload);
  if (!event || !event.customer) return new Response(null, { status: 200 });
  try {
    await pointsQueue.add("order_event", { event, shop, topic });
  } catch (err) {
    console.error("[orders-updated] enqueue failed:", err instanceof Error ? err.message : err);
    return new Response(null, { status: 503 }); // Shopify retries
  }
  return new Response(null, { status: 200 });
};
