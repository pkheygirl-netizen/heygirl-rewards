import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { pointsQueue } from "../lib/queue.server";
import { parseOrderPayload } from "../lib/orders.server";

// orders/cancelled: reverses whatever the order still holds, marks it so it
// can never be awarded later (rule 6), and returns redeemed points when the
// order was cancelled before fulfilment (rule 7).
export const action = async ({ request }: ActionFunctionArgs) => {
  const { topic, shop, payload } = await authenticate.webhook(request);
  console.log(`[webhook] ${topic} from ${shop}`);
  const event = parseOrderPayload(payload);
  if (!event) return new Response(null, { status: 200 });
  try {
    await pointsQueue.add("order_cancelled", {
      event: { ...event, cancelledAt: event.cancelledAt ?? new Date().toISOString() },
      shop,
      topic,
    });
  } catch (err) {
    console.error("[orders-cancelled] enqueue failed:", err instanceof Error ? err.message : err);
    return new Response(null, { status: 503 }); // Shopify retries
  }
  return new Response(null, { status: 200 });
};
