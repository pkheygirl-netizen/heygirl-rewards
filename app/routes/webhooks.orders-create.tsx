import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { pointsQueue } from "../lib/queue.server";
import { parseOrderPayload } from "../lib/orders.server";

// orders/create: enrols the customer (auto-consent, rule 3) and stores the
// pending points with the multiplier in force when the order was placed.
// The work happens in the points worker; this only parses and queues.
export const action = async ({ request }: ActionFunctionArgs) => {
  const { topic, shop, payload } = await authenticate.webhook(request);
  console.log(`[webhook] ${topic} from ${shop}`);
  const event = parseOrderPayload(payload);
  if (!event || !event.customer) return new Response(null, { status: 200 });
  try {
    await pointsQueue.add("order_event", { event, shop, topic });
  } catch (err) {
    console.error("[orders-create] enqueue failed:", err instanceof Error ? err.message : err);
    return new Response(null, { status: 503 }); // Shopify retries
  }
  return new Response(null, { status: 200 });
};
