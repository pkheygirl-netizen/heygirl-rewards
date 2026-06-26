import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { enrolMember } from "../lib/points.service";
import { pointsQueue } from "../lib/queue.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { topic, shop, payload } = await authenticate.webhook(request);
  console.log(`[webhook] ${topic} from ${shop}`);
  try {
    const customer = payload as Record<string, any>;
    if (!customer?.id) return new Response(null, { status: 200 });
    await enrolMember(customer); // idempotent — ensures member exists if create was missed
    try {
      await pointsQueue.add("award_signup_points", { shopifyCustomerId: String(customer.id) });
    } catch (enqueueErr) {
      console.error("[customers-enable] enqueue failed:", enqueueErr);
      return new Response("enqueue failed", { status: 503 });
    }
  } catch (err) {
    console.error("[customers-enable] error:", err);
  }
  return new Response(null, { status: 200 });
};
