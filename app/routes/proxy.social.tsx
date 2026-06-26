// app/routes/proxy.social.tsx
import type { ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { extractProxyCustomerId } from "../lib/proxy-auth.server";
import { socialQueue } from "../lib/queue.server";

const CORS = { "Access-Control-Allow-Origin": "https://heygirl.pk" };

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") return json({ error: "method_not_allowed" }, { status: 405, headers: CORS });

  const url = new URL(request.url);
  let customerId: string | null;
  try {
    customerId = extractProxyCustomerId(url, process.env.SHOPIFY_API_SECRET!);
  } catch {
    return json({ error: "unauthorized" }, { status: 401, headers: CORS });
  }
  if (!customerId) return json({ error: "not_logged_in" }, { status: 403, headers: CORS });

  let body: { platform?: string };
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid_json" }, { status: 400, headers: CORS });
  }

  const platform = body.platform;
  if (!["youtube", "facebook", "instagram"].includes(platform ?? "")) {
    return json({ error: "invalid_platform" }, { status: 400, headers: CORS });
  }

  await socialQueue.add("social-action", { shopifyCustomerId: customerId, platform }, { delay: 24 * 60 * 60 * 1000 });
  return json({ queued: true }, { headers: CORS });
};
