// app/routes/proxy.review.tsx — POST /apps/loyalty/review (business rule 14: staff approve each claim)
import type { ActionFunctionArgs } from "@remix-run/node";
import { guardProxy, proxyJson } from "../lib/proxy-auth.server";
import { getMemberByCustomerId } from "../lib/widget-data.server";
import { claimReview } from "../lib/review-claims.service";

export const action = async ({ request }: ActionFunctionArgs) => {
  // HMAC first: an unsigned request learns nothing, not even the allowed method.
  const g = guardProxy(request, "review");
  if (g.response) return g.response;
  if (request.method !== "POST") return proxyJson({ ok: false, error: "method_not_allowed" }, 405);

  try {
    // No program-switch check: it only pauses redeeming (rule 20).
    const member = await getMemberByCustomerId(g.ctx.customerId);
    if (!member) return proxyJson({ ok: false, error: "not_a_member" });
    if (member.opted_out) return proxyJson({ ok: false, error: "opted_out" });
    if (member.is_blocked) return proxyJson({ ok: false, error: "blocked" });

    const result = await claimReview(member.id);
    if (!result.ok) return proxyJson({ ok: false, error: result.reason });
    // The claim waits for staff approval (rule 14): no release time exists.
    return proxyJson({ ok: true });
  } catch (err) {
    console.error("[proxy.review] error:", err instanceof Error ? err.message : err);
    return proxyJson({ ok: false, error: "server_error" }, 500);
  }
};
