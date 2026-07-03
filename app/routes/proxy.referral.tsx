// app/routes/proxy.referral.tsx
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { extractProxyCustomerId } from "../lib/proxy-auth.server";
import { getReferralDashboard, getProgramEnabled } from "../lib/widget-data.server";
import { recordReferralVisit } from "../lib/referrals.service";
import { db } from "../db.server";

const CORS = { "Access-Control-Allow-Origin": "https://heygirl.pk" };

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  let customerId: string | null;
  try {
    customerId = extractProxyCustomerId(url, process.env.SHOPIFY_API_SECRET!);
  } catch {
    return json({ error: "unauthorized" }, { status: 401, headers: { ...CORS, "Cache-Control": "no-store" } });
  }
  if (!customerId) return json({ error: "not_logged_in" }, { status: 403, headers: { ...CORS, "Cache-Control": "no-store" } });

  const programEnabled = await getProgramEnabled();
  if (!programEnabled) return json({ error: "program_disabled" }, { status: 423, headers: { ...CORS, "Cache-Control": "no-store" } });

  const data = await getReferralDashboard(customerId);
  return json(data, { headers: { ...CORS, "Cache-Control": "no-store" } });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "https://heygirl.pk",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      },
    });
  }
  if (request.method !== "POST") return json({ error: "method_not_allowed" }, { status: 405, headers: { ...CORS, "Cache-Control": "no-store" } });

  const url = new URL(request.url);
  let customerId: string | null;
  try {
    customerId = extractProxyCustomerId(url, process.env.SHOPIFY_API_SECRET!);
  } catch {
    return json({ error: "unauthorized" }, { status: 401, headers: { ...CORS, "Cache-Control": "no-store" } });
  }
  if (!customerId) return json({ error: "not_logged_in" }, { status: 403, headers: { ...CORS, "Cache-Control": "no-store" } });

  const programEnabledAction = await getProgramEnabled();
  if (!programEnabledAction) return json({ error: "program_disabled" }, { status: 423, headers: { ...CORS, "Cache-Control": "no-store" } });

  let body: { referralSlug?: string; deviceFingerprintHash?: string };
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid_json" }, { status: 400, headers: { ...CORS, "Cache-Control": "no-store" } });
  }

  const { referralSlug, deviceFingerprintHash } = body;
  if (!referralSlug || typeof referralSlug !== "string") {
    return json({ error: "missing_fields" }, { status: 400, headers: { ...CORS, "Cache-Control": "no-store" } });
  }

  // Derive IP server-side — never trust client-supplied values for fraud signals
  const referredIp =
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    request.headers.get("x-real-ip") ??
    "unknown";

  // Look up email from our DB rather than trusting a client-supplied value
  const { data: member } = await db
    .from("members")
    .select("email")
    .eq("shopify_customer_id", customerId)
    .maybeSingle();

  try {
    const result = await recordReferralVisit({
      referralSlug,
      referredShopifyCustomerId: customerId,
      referredEmail: member?.email ?? "",
      referredIp,
      deviceFingerprintHash,
    });
    return json(result, { headers: { ...CORS, "Cache-Control": "no-store" } });
  } catch (err) {
    console.error("[proxy.referral] visit record error:", err);
    return json({ error: "internal_error" }, { status: 500, headers: { ...CORS, "Cache-Control": "no-store" } });
  }
};
