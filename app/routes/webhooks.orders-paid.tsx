import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { db } from "../db.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { topic, shop, payload } = await authenticate.webhook(request);
  console.log(`[webhook] ${topic} from ${shop}`);

  try {
    const order = payload as Record<string, any>;
    const discountCodes: Array<{ code: string }> = order.discount_codes ?? [];
    if (discountCodes.length === 0) return new Response(null, { status: 200 });

    const codes = discountCodes.map((d) => d.code);
    await db
      .from("loyalty_codes")
      .update({
        status: "used",
        used_at: new Date().toISOString(),
        shopify_order_id: String(order.id),
      })
      .in("code", codes)
      .eq("status", "active");
  } catch (err) {
    console.error("[orders-paid] error:", err);
  }
  return new Response(null, { status: 200 });
};
