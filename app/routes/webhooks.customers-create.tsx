import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { pointsQueue } from "../lib/queue.server";

// customers/create: keep a member row (no consent, no bonus). Consent is
// recorded by the first order or the first storefront sign-in (rule 3).
export const action = async ({ request }: ActionFunctionArgs) => {
  const { topic, shop, payload } = await authenticate.webhook(request);
  console.log(`[webhook] ${topic} from ${shop}`);
  const c = payload as { id?: string | number; email?: string | null; phone?: string | null; first_name?: string | null; last_name?: string | null };
  if (c?.id) {
    try {
      await pointsQueue.add(
        "enrol_member",
        { customer: { id: String(c.id), email: c.email ?? null, phone: c.phone ?? null, first_name: c.first_name ?? null, last_name: c.last_name ?? null } },
      );
    } catch (err) {
      console.error("[customers-create] enqueue failed:", err instanceof Error ? err.message : err);
      return new Response(null, { status: 503 }); // Shopify retries
    }
  }
  return new Response(null, { status: 200 });
};
