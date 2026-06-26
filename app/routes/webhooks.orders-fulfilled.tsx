import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { db } from "../db.server";
import { pointsQueue } from "../lib/queue.server";

const toPaisa = (v: unknown) => Math.round(Number(v ?? 0) * 100);

export const action = async ({ request }: ActionFunctionArgs) => {
  const { topic, shop, payload } = await authenticate.webhook(request);
  console.log(`[webhook] ${topic} from ${shop}`);

  try {
    const order = payload as Record<string, any>;
    const customerId = order?.customer?.id;
    if (!customerId) return new Response(null, { status: 200 });

    const orderTotalPaisa = toPaisa(order.total_price);
    const shippingPaisa = toPaisa(order.total_shipping_price_set?.shop_money?.amount);
    const taxPaisa = toPaisa(order.total_tax);

    const { data: existing } = await db
      .from("order_webhook_state").select("points_awarded")
      .eq("shopify_order_id", String(order.id)).maybeSingle();
    if (existing?.points_awarded) return new Response(null, { status: 200 });

    await db.from("order_webhook_state").upsert(
      {
        shopify_order_id: String(order.id),
        shopify_customer_id: String(customerId),
        fulfillment_status: order.fulfillment_status ?? null,
        financial_status: order.financial_status ?? null,
        order_total_pkr: (orderTotalPaisa - shippingPaisa - taxPaisa) / 100,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "shopify_order_id" },
    );

    if (order.financial_status !== "paid") {
      // Fulfilled but not yet paid — wait for paid signal; no award yet.
      return new Response(null, { status: 200 });
    }

    try {
      await pointsQueue.add("award_purchase_points", {
        shopifyCustomerId: String(customerId),
        shopifyOrderId: String(order.id),
        orderTotalPaisa, shippingPaisa, taxPaisa,
      });
    } catch (enqueueErr) {
      console.error("[orders-fulfilled] enqueue failed:", enqueueErr);
      return new Response("enqueue failed", { status: 503 }); // Shopify will retry
    }
  } catch (err) {
    console.error("[orders-fulfilled] error:", err);
  }
  return new Response(null, { status: 200 });
};
