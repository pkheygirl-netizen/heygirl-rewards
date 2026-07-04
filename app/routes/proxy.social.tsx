// app/routes/proxy.social.tsx
import type { ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { extractProxyCustomerId } from "../lib/proxy-auth.server";
import { socialQueue } from "../lib/queue.server";
import { db } from "../db.server";
import { getProgramEnabled } from "../lib/widget-data.server";

const CORS = { "Access-Control-Allow-Origin": "https://heygirl.pk" };

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

  const programEnabled = await getProgramEnabled();
  if (!programEnabled) return json({ error: "program_disabled" }, { status: 423, headers: { ...CORS, "Cache-Control": "no-store" } });

  let body: { platform?: string };
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid_json" }, { status: 400, headers: { ...CORS, "Cache-Control": "no-store" } });
  }

  const platform = body.platform;
  if (!["youtube", "facebook", "instagram"].includes(platform ?? "")) {
    return json({ error: "invalid_platform" }, { status: 400, headers: { ...CORS, "Cache-Control": "no-store" } });
  }

  // Honor-basis social rewards (per build plan): we trust the customer performed
  // the action; the 24h delay is the only friction. One claim per platform, ever.
  const { data: member } = await db
    .from("members")
    .select("id")
    .eq("shopify_customer_id", customerId)
    .maybeSingle();
  if (!member) return json({ error: "not_a_member" }, { status: 403, headers: { ...CORS, "Cache-Control": "no-store" } });

  const { data: existing } = await db
    .from("social_actions")
    .select("id")
    .eq("member_id", member.id)
    .eq("action_type", platform!)
    .maybeSingle();
  if (existing) return json({ queued: false, reason: "already_claimed" }, { headers: { ...CORS, "Cache-Control": "no-store" } });

  const { data: row, error: insertError } = await db
    .from("social_actions")
    .insert({
      member_id: member.id,
      action_type: platform!,
      status: "pending",
      pending_until: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    })
    .select("id")
    .single();
  if (insertError || !row) {
    // Concurrent double-claim: UNIQUE(member_id, action_type) → treat as claimed.
    if (insertError?.code === "23505") {
      return json({ queued: false, reason: "already_claimed" }, { headers: { ...CORS, "Cache-Control": "no-store" } });
    }
    console.error("[proxy.social] insert failed:", insertError?.message);
    return json({ error: "server_error" }, { status: 500, headers: { ...CORS, "Cache-Control": "no-store" } });
  }

  try {
    await socialQueue.add(
      "award_social_points",
      { socialActionId: row.id },
      { delay: 24 * 60 * 60 * 1000, jobId: `social-${row.id}` },
    );
  } catch (err) {
    // Roll back the pending row so the customer can retry cleanly.
    await db.from("social_actions").delete().eq("id", row.id);
    console.error("[proxy.social] enqueue failed:", err);
    return json({ error: "server_error" }, { status: 503, headers: { ...CORS, "Cache-Control": "no-store" } });
  }
  return json({ queued: true }, { headers: { ...CORS, "Cache-Control": "no-store" } });
};
