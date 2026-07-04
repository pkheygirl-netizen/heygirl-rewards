import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { pointsQueue } from "../lib/queue.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { topic, shop, payload } = await authenticate.webhook(request);
  console.log(`[webhook] ${topic} from ${shop}`);
  const customer = payload as { id?: string | number; email?: string | null; first_name?: string | null; last_name?: string | null };
  if (customer?.id) {
    // Durable enrolment via queue (W5: unawaited promise was lost on restart).
    try {
      await pointsQueue.add(
        "enrol_member",
        { customer: { ...customer, id: customer.id } },
        { jobId: `enrol-${customer.id}` },
      );
    } catch (err) {
      console.error("[customers-create] enqueue failed:", err);
      return new Response(null, { status: 503 }); // Shopify retries
    }
  }
  return new Response(null, { status: 200 });
};
