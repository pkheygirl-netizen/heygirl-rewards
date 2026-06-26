// app/routes/proxy.history.tsx
import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { extractProxyCustomerId } from "../lib/proxy-auth.server";
import { getPointsHistory } from "../lib/widget-data.server";

const CORS = { "Access-Control-Allow-Origin": "https://heygirl.pk" };

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  let customerId: string | null;
  try {
    customerId = extractProxyCustomerId(url, process.env.SHOPIFY_API_SECRET!);
  } catch {
    return json({ error: "unauthorized" }, { status: 401, headers: CORS });
  }
  if (!customerId) return json({ error: "not_logged_in" }, { status: 403, headers: CORS });

  const page = Number(url.searchParams.get("page") ?? "1");
  const filterType = url.searchParams.get("type") ?? null;
  const result = await getPointsHistory(customerId, Math.max(1, page), filterType);
  return json(result, { headers: CORS });
};
