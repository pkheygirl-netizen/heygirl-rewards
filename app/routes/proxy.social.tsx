// app/routes/proxy.social.tsx — POST /apps/loyalty/social {platform}
// Honour system, once per platform (business rule 15). The widget opens the
// profile URL in a new tab before it calls this.
import type { ActionFunctionArgs } from "@remix-run/node";
import type { SupabaseClient } from "@supabase/supabase-js";
import { guardProxy, proxyJson, readJsonBody } from "../lib/proxy-auth.server";
import { getMemberByCustomerId, SOCIAL_AWARD_DELAY_HOURS, SOCIAL_PLATFORMS, type SocialPlatform } from "../lib/widget-data.server";
import { getSettings } from "../lib/settings.server";
import { socialQueue } from "../lib/queue.server";
import { db } from "../db.server";

const sdb = db as unknown as SupabaseClient;
const DELAY_MS = SOCIAL_AWARD_DELAY_HOURS * 60 * 60 * 1000;

function ruleOn(rules: unknown, key: string): boolean {
  const r = rules && typeof rules === "object" ? (rules as Record<string, unknown>)[key] : null;
  return !(r && typeof r === "object" && (r as Record<string, unknown>).enabled === false);
}

export const action = async ({ request }: ActionFunctionArgs) => {
  // HMAC first: an unsigned request learns nothing, not even the allowed method.
  const g = guardProxy(request, "social");
  if (g.response) return g.response;
  if (request.method !== "POST") return proxyJson({ ok: false, error: "method_not_allowed" }, 405);
  const { customerId } = g.ctx;

  const body = await readJsonBody(request);
  const platform = body?.platform as SocialPlatform;
  if (!body || !SOCIAL_PLATFORMS.includes(platform)) return proxyJson({ ok: false, error: "invalid_platform" }, 400);

  try {
    const settings = (await getSettings()) as unknown as Record<string, unknown>;
    // No program-switch check: it only pauses redeeming (rule 20). The platform's own switch still applies.
    if (!ruleOn(settings.earn_rules, platform)) return proxyJson({ ok: false, error: "disabled" });
    // No profile link in settings means there is nothing to follow: never award.
    const profileUrl = settings[`social_url_${platform}`];
    if (typeof profileUrl !== "string" || !/^https?:\/\/[^\s"'<>]+$/i.test(profileUrl.trim())) {
      return proxyJson({ ok: false, error: "disabled" });
    }
    const points = Math.max(0, Math.round(Number(settings[`social_points_${platform}`] ?? settings.social_points ?? 0)));

    const member = await getMemberByCustomerId(customerId);
    if (!member) return proxyJson({ ok: false, error: "not_a_member" });
    if (member.opted_out) return proxyJson({ ok: false, error: "opted_out" });
    if (member.is_blocked) return proxyJson({ ok: false, error: "blocked" });

    const { data: existing } = await sdb
      .from("social_actions")
      .select("id")
      .eq("member_id", member.id)
      .eq("action_type", platform)
      .maybeSingle();
    if (existing) return proxyJson({ ok: true, status: "already_claimed", points: 0 });

    const { data: row, error: insertError } = await sdb
      .from("social_actions")
      .insert({
        member_id: member.id,
        action_type: platform,
        status: "pending",
        pending_until: new Date(Date.now() + DELAY_MS).toISOString(),
      })
      .select("id")
      .single();
    if (insertError || !row) {
      // UNIQUE(member_id, action_type): a concurrent second tap is a repeat claim.
      if (insertError?.code === "23505") return proxyJson({ ok: true, status: "already_claimed", points: 0 });
      console.error("[proxy.social] insert failed:", insertError?.message);
      return proxyJson({ ok: false, error: "server_error" }, 500);
    }

    try {
      await socialQueue.add("award_social_points", { socialActionId: row.id }, { delay: DELAY_MS });
    } catch (err) {
      // Roll back so the customer can try again cleanly.
      await sdb.from("social_actions").delete().eq("id", row.id);
      console.error("[proxy.social] enqueue failed:", err instanceof Error ? err.message : err);
      return proxyJson({ ok: false, error: "server_error" }, 503);
    }
    return proxyJson({ ok: true, status: "awarded", points });
  } catch (err) {
    console.error("[proxy.social] error:", err instanceof Error ? err.message : err);
    return proxyJson({ ok: false, error: "server_error" }, 500);
  }
};
