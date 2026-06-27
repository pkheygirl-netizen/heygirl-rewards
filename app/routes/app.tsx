// app/routes/app.tsx
import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import {
  Outlet,
  useLoaderData,
  useLocation,
  useNavigate,
} from "@remix-run/react";
import { Tabs } from "@shopify/polaris";
import { AppProvider } from "@shopify/shopify-app-remix/react";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return json({ apiKey: process.env.SHOPIFY_API_KEY ?? "" });
};

const TABS = [
  { id: "overview", content: "Overview", path: "/app" },
  { id: "members", content: "Members", path: "/app/members" },
  { id: "influencers", content: "Influencer", path: "/app/influencers" },
  { id: "referrals", content: "Referrals", path: "/app/referrals" },
  { id: "campaigns", content: "Points & Campaigns", path: "/app/campaigns" },
  { id: "analytics", content: "Analytics", path: "/app/analytics" },
  { id: "nudges", content: "Nudges", path: "/app/nudges" },
  { id: "settings", content: "Settings", path: "/app/settings" },
];

export default function AdminLayout() {
  const { apiKey } = useLoaderData<typeof loader>();
  const navigate = useNavigate();
  const location = useLocation();

  const selected = Math.max(
    0,
    TABS.findIndex((t) =>
      t.path === "/app"
        ? location.pathname === "/app" || location.pathname === "/app/"
        : location.pathname.startsWith(t.path),
    ),
  );

  return (
    <AppProvider isEmbeddedApp apiKey={apiKey}>
      <Tabs
        tabs={TABS.map((t) => ({ id: t.id, content: t.content }))}
        selected={selected}
        onSelect={(i) => navigate(TABS[i].path)}
      >
        <Outlet />
      </Tabs>
    </AppProvider>
  );
}
