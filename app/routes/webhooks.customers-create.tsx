import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { db } from "../db.server";
import { pointsQueue } from "../lib/queue.server";

function buildSlug(firstName?: string, lastName?: string, customerId?: number): string {
  const base = [firstName, lastName]
    .filter(Boolean)
    .join("-")
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "");
  // Append Shopify customer ID for guaranteed uniqueness — no collision possible
  return `${base || "member"}-${customerId ?? Date.now()}`;
}

export const action = async ({ request }: ActionFunctionArgs) => {
  const { topic, shop, payload } = await authenticate.webhook(request);
  console.log(`[webhook] ${topic} from ${shop}`);

  try {
    const customer = payload as Record<string, any>;
    if (!customer?.id) return new Response(null, { status: 200 });

    const { data: existing } = await db
      .from("members")
      .select("id")
      .eq("shopify_customer_id", String(customer.id))
      .maybeSingle();

    if (existing) return new Response(null, { status: 200 });

    const { error } = await db.from("members").insert({
      shopify_customer_id: String(customer.id),
      email: customer.email ?? null,
      first_name: customer.first_name ?? null,
      last_name: customer.last_name ?? null,
      tier: "silver",
      points_balance: 0,
      lifetime_spend_pkr: 0,
      referral_slug: buildSlug(customer.first_name, customer.last_name, customer.id),
      consent_given: false,
    });

    if (error) {
      console.error("[customers-create] insert error:", error);
    } else {
      await pointsQueue.add("award_signup_points", {
        shopify_customer_id: customer.id,
        email: customer.email,
      });
    }
  } catch (err) {
    console.error("[customers-create] unexpected error:", err);
  }

  return new Response(null, { status: 200 });
};
