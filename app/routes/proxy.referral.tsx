// app/routes/proxy.referral.tsx
// POST /apps/loyalty/referral {slug} → { ok, status, friendCode? } (contract section 4)
// GET  /apps/loyalty/referral        → referral summary for the Refer tab (additive)
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { clientIp, guardProxy, proxyJson, readJsonBody } from "../lib/proxy-auth.server";
import { getMemberByCustomerId, getReferralSummary } from "../lib/widget-data.server";
import { recordReferralVisit } from "../lib/referrals.service";
import { effectiveReferralPoints } from "../lib/influencer.service";
import { getSettings } from "../lib/settings.server";

const SLUG_RE = /^[a-z0-9][a-z0-9_-]{1,63}$/i;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const g = guardProxy(request, "referral");
  if (g.response) return g.response;

  try {
    const member = await getMemberByCustomerId(g.ctx.customerId);
    if (!member) return proxyJson({ ok: false, error: "not_a_member" });
    const settings = (await getSettings()) as unknown as { referral_points?: number };
    const standard = Math.max(0, Math.round(Number(settings.referral_points ?? 0)));
    const rewardPoints = effectiveReferralPoints(
      {
        is_influencer: !!member.is_influencer,
        influencer_paused: !!member.influencer_paused,
        influencer_multiplier: member.influencer_multiplier ?? null,
        influencer_referral_rate: member.influencer_referral_rate ?? null,
        influencer_rate_starts_at: member.influencer_rate_starts_at ?? null,
        influencer_rate_ends_at: member.influencer_rate_ends_at ?? null,
      },
      standard,
    );
    const summary = await getReferralSummary(member.id);
    return proxyJson({ ok: true, rewardPoints, ...summary });
  } catch (err) {
    console.error("[proxy.referral] summary error:", err instanceof Error ? err.message : err);
    return proxyJson({ ok: false, error: "server_error" }, 500);
  }
};

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") return proxyJson({ ok: false, error: "method_not_allowed" }, 405);
  const g = guardProxy(request, "referral");
  if (g.response) return g.response;
  const { customerId, shop } = g.ctx;

  const body = await readJsonBody(request);
  const slug = typeof body?.slug === "string" ? body.slug.trim() : "";
  if (!SLUG_RE.test(slug)) return proxyJson({ ok: false, error: "invalid_slug" }, 400);

  try {
    const settings = (await getSettings()) as unknown as { program_enabled?: boolean };
    if (settings.program_enabled === false) return proxyJson({ ok: false, error: "program_disabled" });

    const member = await getMemberByCustomerId(customerId);
    if (!member) return proxyJson({ ok: false, error: "not_a_member" });
    if (member.referral_slug && member.referral_slug.toLowerCase() === slug.toLowerCase()) {
      return proxyJson({ ok: false, error: "self_referral" });
    }

    // The address and email are taken server-side, never from the client.
    // `shop` is passed for the friend's free-shipping code (rule 10); it is held
    // in a variable so the call compiles against either service signature.
    const input = {
      referralSlug: slug,
      referredShopifyCustomerId: customerId,
      referredEmail: member.email ?? "",
      referredIp: clientIp(request) ?? "unknown",
      shop,
    };
    const result = (await recordReferralVisit(input)) as unknown as Record<string, unknown>;

    const status =
      typeof result.status === "string"
        ? result.status
        : result.blocked
          ? "blocked"
          : result.recorded
            ? "pending"
            : typeof result.reason === "string"
              ? result.reason
              : "not_recorded";
    const ok = result.ok === true || result.recorded === true;
    const friendCode = typeof result.friendCode === "string" ? result.friendCode : undefined;
    return proxyJson(friendCode ? { ok, status, friendCode } : { ok, status });
  } catch (err) {
    console.error("[proxy.referral] record error:", err instanceof Error ? err.message : err);
    return proxyJson({ ok: false, error: "server_error" }, 500);
  }
};
