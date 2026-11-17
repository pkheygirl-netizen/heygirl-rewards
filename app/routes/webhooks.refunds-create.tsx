import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { pointsQueue } from "../lib/queue.server";
import { parseRefundPayload } from "../lib/orders.server";

// refunds/create: the payload carries the order id but no customer, so the
// worker finds the customer through the stored order (finding B3).
export const action = async ({ request }: ActionFunctionArgs) => {
  const { topic, shop, payload } = await authenticate.webhook(request);
  console.log(`[webhook] ${topic} from ${shop}`);
  const event = parseRefundPayload(payload);
  if (!event) return new Response(null, { status: 200 });
  try {
    // No fixed job id (a failed job would block a redelivery): the database
    // counts each refund id once, so a duplicate job changes nothing.
    await pointsQueue.add("refund_event", { event, shop, topic });
  } catch (err) {
    console.error("[refunds-create] enqueue failed:", err instanceof Error ? err.message : err);
    return new Response(null, { status: 503 }); // Shopify retries
  }
  return new Response(null, { status: 200 });
};
