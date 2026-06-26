import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { db } from "../db.server";
import { pointsQueue } from "../lib/queue.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { topic, shop, payload } = await authenticate.webhook(request);
  console.log(`[webhook] ${topic} from ${shop}`);

  try {
    const order = payload as Record<string, any>;
    const customerId = order?.customer?.id;
    if (!customerId) return new Response(null, { status: 200 });

    const shipping = parseFloat(order?.total_shipping_price_set?.shop_money?.amount ?? "0");
    const tax = parseFloat(order?.total_tax ?? "0");
    const orderTotal = parseFloat(order?.total_price ?? "0") - shipping - tax;

    const { data: existing } = await db
      .from("order_webhook_state")
      .select("points_awarded")
      .eq("shopify_order_id", String(order.id))
      .maybeSingle();

    if (existing?.points_awarded) return new Response(null, { status: 200 });

    await db.from("order_webhook_state").upsert(
      {
        shopify_order_id: String(order.id),
        shopify_customer_id: String(customerId),
        fulfillment_status: order.fulfillment_status ?? null,
        financial_status: order.financial_status ?? null,
        order_total_pkr: orderTotal,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "shopify_order_id" }
    );

    if (
      order.fulfillment_status === "fulfilled" &&
      order.financial_status === "paid"
    ) {
      // Atomic race-condition fix added in Week 3 with advisory lock
      await pointsQueue.add("award_purchase_points", {
        shopify_order_id: order.id,
        shopify_customer_id: customerId,
        order_total_pkr: orderTotal,
      });
    }
  } catch (err) {
    console.error("[orders-updated] error:", err);
    // Always return 200 — prevents Shopify retry storm
  }

  return new Response(null, { status: 200 });
};
