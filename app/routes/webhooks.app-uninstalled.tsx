import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { topic, shop } = await authenticate.webhook(request);
  try {
    console.log(`[webhook] ${topic} — ${shop} uninstalled`);
    // Session cleanup handled by Shopify library automatically
    // Additional cleanup added in Week 5
  } catch (err) {
    console.error("[app-uninstalled] error:", err);
  }
  return new Response(null, { status: 200 });
};
