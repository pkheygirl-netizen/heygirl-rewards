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

    if (order.fulfillment_status === "fulfilled" && order.financial_status === "paid") {
      try {
        await pointsQueue.add("award_purchase_points", {
          shopifyCustomerId: String(customerId),
          shopifyOrderId: String(order.id),
          orderTotalPaisa, shippingPaisa, taxPaisa,
        });
      } catch (enqueueErr) {
        console.error("[orders-updated] enqueue failed:", enqueueErr);
        return new Response("enqueue failed", { status: 503 });
      }
      // Mirror referral award — referral service is idempotent so safe to enqueue from both handlers
      try {
        await pointsQueue.add("award_referral", {
          referredShopifyCustomerId: String(customerId),
        });
      } catch (refErr) {
        console.error("[orders-updated] referral enqueue failed:", refErr);
      }
    }

    // Mark any loyalty codes used on paid orders
    if (order.financial_status === "paid") {
      const discountCodes: Array<{ code: string }> = order.discount_codes ?? [];
      if (discountCodes.length > 0) {
        const codes = discountCodes.map((d: { code: string }) => d.code);
        const { error: codeErr } = await db
          .from("loyalty_codes")
          .update({
            status: "used",
            used_at: new Date().toISOString(),
            shopify_order_id: String(order.id),
          })
          .in("code", codes)
          .eq("status", "active");
        if (codeErr) console.error("[orders-updated] loyalty_codes mark-used error:", codeErr);
      }
    }
  } catch (err) {
    console.error("[orders-updated] error:", err);
  }
  return new Response(null, { status: 200 });
};
