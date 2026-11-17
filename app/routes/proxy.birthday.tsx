// app/routes/proxy.birthday.tsx — POST /apps/loyalty/birthday {month, day}
// Set once from the storefront; afterwards only the admin can change it (rule 13).
import type { ActionFunctionArgs } from "@remix-run/node";
import { guardProxy, proxyJson, readJsonBody } from "../lib/proxy-auth.server";
import { getMemberByCustomerId, isValidBirthday } from "../lib/widget-data.server";
import { setBirthday } from "../lib/points.service";
import { getSettings } from "../lib/settings.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  // HMAC first: an unsigned request learns nothing, not even the allowed method.
  const g = guardProxy(request, "birthday");
  if (g.response) return g.response;
  if (request.method !== "POST") return proxyJson({ ok: false, error: "method_not_allowed" }, 405);

  const body = await readJsonBody(request);
  const month = Number(body?.month);
  const day = Number(body?.day);
  if (!body || !isValidBirthday(month, day)) return proxyJson({ ok: false, error: "invalid_date" }, 400);

  try {
    const settings = (await getSettings()) as unknown as { program_enabled?: boolean };
    if (settings.program_enabled === false) return proxyJson({ ok: false, error: "program_disabled" });

    const member = await getMemberByCustomerId(g.ctx.customerId);
    if (!member) return proxyJson({ ok: false, error: "not_a_member" });
    if (member.opted_out) return proxyJson({ ok: false, error: "opted_out" });
    if (member.is_blocked) return proxyJson({ ok: false, error: "blocked" });

    const result = await setBirthday(member.id, month, day, { byAdmin: false });
    if (!result.ok) return proxyJson({ ok: false, error: result.reason ?? "birthday_failed" });
    return proxyJson({ ok: true });
  } catch (err) {
    console.error("[proxy.birthday] error:", err instanceof Error ? err.message : err);
    return proxyJson({ ok: false, error: "server_error" }, 500);
  }
};
