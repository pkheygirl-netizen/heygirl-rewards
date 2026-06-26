import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";

// orders/paid IS a valid topic. Earning is primarily driven by orders/fulfilled
// + a paid check; orders/updated also converges the paid+fulfilled pair. This
// route is retained as a no-op acknowledgement and may carry paid-status logic later.
export const action = async ({ request }: ActionFunctionArgs) => {
  const { topic, shop } = await authenticate.webhook(request);
  console.log(`[webhook] ${topic} from ${shop} — acknowledged`);
  return new Response(null, { status: 200 });
};
