import type { LoaderFunctionArgs } from "@remix-run/node";
import { json, redirect } from "@remix-run/node";

/**
 * Handles the app's root URL (`/`).
 *
 * Shopify embeds the app by loading `application_url` (the root) inside the
 * admin iframe with a `?shop=...&host=...&embedded=1&id_token=...` query.
 * Without this route Remix matches only `root.tsx`, rendering an empty
 * `<Outlet />` — a blank body with a 200 status (the embedded blank-page bug).
 *
 * When a `shop` param is present we forward to `/app`, preserving the full
 * query so the embedded auth + App Bridge handshake can complete there.
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);

  if (url.searchParams.get("shop")) {
    throw redirect(`/app?${url.searchParams.toString()}`);
  }

  return json({ ok: true });
};

export default function Index() {
  return (
    <main style={{ fontFamily: "system-ui, sans-serif", padding: "2rem" }}>
      <h1>HeyGirl Rewards</h1>
      <p>Loyalty &amp; rewards for HeyGirl.pk. Open this app from your Shopify admin.</p>
    </main>
  );
}
