// app/routes/proxy.history.tsx — GET /apps/loyalty/history?filter=&page=
import type { LoaderFunctionArgs } from "@remix-run/node";
import { guardProxy, proxyJson } from "../lib/proxy-auth.server";
import { getMemberByCustomerId, getPointsHistory, parseHistoryFilter } from "../lib/widget-data.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const g = guardProxy(request, "history");
  if (g.response) return g.response;
  const { customerId, url } = g.ctx;

  try {
    const member = await getMemberByCustomerId(customerId);
    if (!member) return proxyJson({ rows: [], page: 1, total: 0, hasMore: false });
    const page = Number(url.searchParams.get("page") ?? "1");
    const filter = parseHistoryFilter(url.searchParams.get("filter"));
    return proxyJson(await getPointsHistory(member.id, page, filter));
  } catch (err) {
    console.error("[proxy.history] error:", err instanceof Error ? err.message : err);
    return proxyJson({ ok: false, error: "server_error" }, 500);
  }
};
