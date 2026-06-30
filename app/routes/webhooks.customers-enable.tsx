import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { enrolMember } from "../lib/points.service";
import { pointsQueue } from "../lib/queue.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { topic, shop, payload } = await authenticate.webhook(request);
  console.log(`[webhook] ${topic} from ${shop}`);
  const customer = payload as { id?: string | number; email?: string | null; first_name?: string | null; last_name?: string | null };
  if (customer?.id) {
    enrolMember({ ...customer, id: customer.id }).catch((err) =>
      console.error("[customers-enable] enrol error:", err)
    );
    pointsQueue.add("award_signup_points", { shopifyCustomerId: String(customer.id) }).catch((err) =>
      console.error("[customers-enable] enqueue error:", err)
    );
  }
  return new Response(null, { status: 200 });
};
