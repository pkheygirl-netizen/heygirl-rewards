import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate, sessionStorage } from "../shopify.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { topic, shop } = await authenticate.webhook(request);
  console.log(`[webhook] ${topic} — ${shop} uninstalled`);
  try {
    const sessions = await sessionStorage.findSessionsByShop(shop);
    if (sessions.length > 0) {
      await sessionStorage.deleteSessions(sessions.map((s) => s.id));
      console.log(`[app-uninstalled] deleted ${sessions.length} session(s) for ${shop}`);
    }
  } catch (err) {
    console.error("[app-uninstalled] session cleanup error:", err);
  }
  return new Response(null, { status: 200 });
};
