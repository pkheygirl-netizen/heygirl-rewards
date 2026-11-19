// app/routes/proxy.customer.tsx — GET /apps/loyalty/customer (contract section 4)
import type { LoaderFunctionArgs } from "@remix-run/node";
import { guardProxy, proxyJson } from "../lib/proxy-auth.server";
import { getCustomerPayload, getMemberByCustomerId, type MemberRow } from "../lib/widget-data.server";
import { enrolFromSignin } from "../lib/points.service";
import { effectiveReferralPoints } from "../lib/influencer.service";
import { getSettings } from "../lib/settings.server";

function referralRewardFor(member: MemberRow, standardPoints: number): number {
  return effectiveReferralPoints(
    {
      is_influencer: !!member.is_influencer,
      influencer_paused: !!member.influencer_paused,
      influencer_multiplier: member.influencer_multiplier ?? null,
      influencer_referral_rate: member.influencer_referral_rate ?? null,
      influencer_rate_starts_at: member.influencer_rate_starts_at ?? null,
      influencer_rate_ends_at: member.influencer_rate_ends_at ?? null,
    },
    standardPoints,
  );
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const g = guardProxy(request, "customer");
  if (g.response) return g.response;
  const { customerId, shop } = g.ctx;

  try {
    // The program switch is not read here: it only pauses redeeming (rule 20),
    // so signing in enrols and the welcome bonus is queued either way.
    const settings = (await getSettings()) as unknown as { referral_points?: number };

    // Signing in on the storefront enrols the customer and queues the welcome
    // bonus when it was never given (business rules 3 and 4). A failure here must
    // not hide an existing member's balance.
    let welcomeQueued = false;
    try {
      const enrol = await enrolFromSignin({ shopifyCustomerId: customerId, shop });
      welcomeQueued = enrol.welcomeQueued;
    } catch (err) {
      console.error("[proxy.customer] enrolFromSignin failed:", err instanceof Error ? err.message : err);
    }

    const member = await getMemberByCustomerId(customerId);
    if (!member) return proxyJson({ enabled: true, member: null, state: "not_enrolled" });

    const standard = Math.max(0, Math.round(Number(settings.referral_points ?? 0)));
    const reward = member.is_influencer ? referralRewardFor(member, standard) : 0;
    const payload = await getCustomerPayload(member, new Date(), reward);
    return proxyJson({ enabled: true, ...payload, welcomeQueued });
  } catch (err) {
    console.error("[proxy.customer] error:", err instanceof Error ? err.message : err);
    return proxyJson({ ok: false, error: "server_error" }, 500);
  }
};
