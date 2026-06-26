import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { pointsQueue } from "../lib/queue.server";

const toPaisa = (v: unknown) => Math.round(Number(v ?? 0) * 100);

export const action = async ({ request }: ActionFunctionArgs) => {
  const { topic, shop, payload } = await authenticate.webhook(request);
  console.log(`[webhook] ${topic} from ${shop}`);

  try {
    const refund = payload as Record<string, any>;
    const customerId = refund?.order?.customer?.id ?? refund?.customer_id;
    if (!refund?.id || !customerId) return new Response(null, { status: 200 });

    const merchandisePaisa = (refund.refund_line_items ?? []).reduce(
      (sum: number, li: any) => sum + toPaisa(li.subtotal), 0,
    );
    if (merchandisePaisa <= 0) return new Response(null, { status: 200 });

    try {
      await pointsQueue.add("award_refund", {
        shopifyCustomerId: String(customerId),
        refundId: String(refund.id),
        refundedMerchandisePaisa: merchandisePaisa,
      });
    } catch (enqueueErr) {
      console.error("[refunds-create] enqueue failed:", enqueueErr);
      return new Response("enqueue failed", { status: 503 });
    }
  } catch (err) {
    console.error("[refunds-create] error:", err);
  }
  return new Response(null, { status: 200 });
};
