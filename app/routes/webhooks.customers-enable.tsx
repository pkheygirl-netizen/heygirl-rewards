import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { enrolMember } from "../lib/points.service";
import { pointsQueue } from "../lib/queue.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { topic, shop, payload } = await authenticate.webhook(request);
  console.log(`[webhook] ${topic} from ${shop}`);
  const customer = payload as { id?: string | number; email?: string | null; first_name?: string | null; last_name?: string | null };
  if (customer?.id) {
    const id = customer.id;
    // Fire-and-forget to keep the webhook response under Shopify's 5s limit, but
    // enrol BEFORE enqueuing signup points — the award_signup_points worker looks
    // up the member row, which must exist first or the points are silently lost.
    (async () => {
      await enrolMember({ ...customer, id });
      await pointsQueue.add("award_signup_points", { shopifyCustomerId: String(id) });
    })().catch((err) => console.error("[customers-enable] background error:", err));
  }
  return new Response(null, { status: 200 });
};
