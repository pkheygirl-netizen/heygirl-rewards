import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { pointsQueue } from "../lib/queue.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { topic, shop, payload } = await authenticate.webhook(request);
  console.log(`[webhook] ${topic} from ${shop}`);
  const customer = payload as { id?: string | number; email?: string | null; first_name?: string | null; last_name?: string | null };
  if (customer?.id) {
    // Durable: enqueue enrol+signup as ONE job (worker enrols before awarding).
    // W5: the old fire-and-forget IIFE was lost on dyno restart with a 200
    // already sent, so Shopify never retried.
    try {
      await pointsQueue.add(
        "enrol_and_signup",
        { customer: { ...customer, id: customer.id } },
        { jobId: `enrol-signup-${customer.id}` },
      );
    } catch (err) {
      console.error("[customers-enable] enqueue failed:", err);
      return new Response(null, { status: 503 }); // Shopify retries
    }
  }
  return new Response(null, { status: 200 });
};
