// app/routes/app.tsx
// Layout for the embedded admin. Navigation is Shopify's own app nav (the
// sidebar entries under the app's name), declared with App Bridge's NavMenu.
// The link with rel="home" names the landing page and is not shown as an item.
import type { HeadersFunction, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { Link, Outlet, useLoaderData, useLocation, useNavigation, useRouteError } from "@remix-run/react";
import { NavMenu } from "@shopify/app-bridge-react";
import { AppProvider } from "@shopify/shopify-app-remix/react";
import { boundary } from "@shopify/shopify-app-remix/server";
import { authenticate } from "../shopify.server";
import { PageSkeleton } from "../components/admin-ui";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return json({ apiKey: process.env.SHOPIFY_API_KEY ?? "" });
};

export const NAV_ITEMS = [
  { label: "Customers", path: "/app/customers" },
  { label: "Program", path: "/app/program" },
  { label: "Referrals", path: "/app/referrals" },
  { label: "Influencers", path: "/app/influencers" },
  { label: "Campaigns", path: "/app/campaigns" },
  { label: "Analytics", path: "/app/analytics" },
  { label: "On-site", path: "/app/onsite" },
  { label: "Settings", path: "/app/settings" },
  { label: "Import", path: "/app/import" },
] as const;

export default function AdminLayout() {
  const { apiKey } = useLoaderData<typeof loader>();
  const navigation = useNavigation();
  const location = useLocation();
  // Skeleton while a different page loads. Not while a form saves or the same
  // page reloads with new filters: there the page stays put.
  const loadingOtherPage =
    navigation.state === "loading" &&
    !navigation.formMethod &&
    navigation.location.pathname !== location.pathname;

  return (
    <AppProvider isEmbeddedApp apiKey={apiKey}>
      <NavMenu>
        <Link to="/app" rel="home">Home</Link>
        {NAV_ITEMS.map((item) => (
          <Link key={item.path} to={item.path}>{item.label}</Link>
        ))}
      </NavMenu>
      {loadingOtherPage ? <PageSkeleton /> : <Outlet />}
    </AppProvider>
  );
}

// Shopify needs these so auth redirects and its response headers survive Remix's
// error and header handling inside the admin iframe.
export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
