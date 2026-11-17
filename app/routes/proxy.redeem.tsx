// app/routes/proxy.redeem.tsx — POST /apps/loyalty/redeem {points}
import type { ActionFunctionArgs } from "@remix-run/node";
import { guardProxy, proxyJson, readJsonBody } from "../lib/proxy-auth.server";
import { getMemberByCustomerId } from "../lib/widget-data.server";
import { redeemPoints } from "../lib/redemption.service";
import { getSettings } from "../lib/settings.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") return proxyJson({ ok: false, error: "method_not_allowed" }, 405);
  const g = guardProxy(request, "redeem");
  if (g.response) return g.response;
  const { customerId, shop } = g.ctx;

  const body = await readJsonBody(request);
  const points = Number(body?.points);
  if (!body || !Number.isInteger(points) || points <= 0) return proxyJson({ ok: false, error: "invalid_points" }, 400);

  try {
    const settings = (await getSettings()) as unknown as { program_enabled?: boolean };
    if (settings.program_enabled === false) return proxyJson({ ok: false, error: "program_disabled" });

    const member = await getMemberByCustomerId(customerId);
    if (!member) return proxyJson({ ok: false, error: "not_a_member" });
    // Clear states, not errors: the widget shows a message for each.
    if (member.opted_out) return proxyJson({ ok: false, error: "opted_out" });
    if (member.is_blocked) return proxyJson({ ok: false, error: "blocked" });

    const result = await redeemPoints({ memberId: member.id, points, shop });
    if (!result.ok) return proxyJson({ ok: false, error: result.reason || "redeem_failed" });
    return proxyJson({ ok: true, code: result.code, discountPkr: result.discountPkr, expiresAt: result.expiresAt });
  } catch (err) {
    console.error("[proxy.redeem] error:", err instanceof Error ? err.message : err);
    return proxyJson({ ok: false, error: "server_error" }, 500);
  }
};
