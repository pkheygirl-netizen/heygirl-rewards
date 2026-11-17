// app/routes/app.tsx
// Layout for the embedded admin. Navigation is Shopify's own app nav (the
// sidebar entries under the app's name), declared with App Bridge's NavMenu.
// The link with rel="home" names the landing page and is not shown as an item.
import type { HeadersFunction, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import {
  Link, Outlet, isRouteErrorResponse, useLoaderData, useLocation, useNavigation, useRouteError, useRouteLoaderData,
} from "@remix-run/react";
import { NavMenu } from "@shopify/app-bridge-react";
import { AppProvider } from "@shopify/shopify-app-remix/react";
import { boundary } from "@shopify/shopify-app-remix/server";
import { authenticate } from "../shopify.server";
import { PageSkeleton } from "../components/admin-ui";
import { AdminErrorState, readAdminMessage } from "../components/admin-error";
import { HOME_PATH, NAV_ITEMS } from "../components/admin-nav";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return json({ apiKey: process.env.SHOPIFY_API_KEY ?? "" });
};

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
        <Link to={HOME_PATH} rel="home">Home</Link>
        {NAV_ITEMS.map((item) => (
          <Link key={item.path} to={item.path}>{item.label}</Link>
        ))}
      </NavMenu>
      {loadingOtherPage ? <PageSkeleton /> : <Outlet />}
    </AppProvider>
  );
}

/**
 * Error boundary for the whole admin.
 *
 * 1. A Response thrown by Shopify's authentication (the App Bridge bounce page,
 *    401/410 answers, and so on) is handed to Shopify's own boundary untouched.
 *    The library's auth flow only ever throws Responses (checked in
 *    @shopify/shopify-app-remix dist/esm/server/authenticate/admin), so this
 *    branch is exactly what the Shopify template does.
 * 2. One of the admin's own "not found" answers (see notFound() in
 *    admin-validate.server.ts) gets a plain not-found state.
 * 3. Anything else is a real failure while loading a page (database down, a
 *    bug). Shopify's boundary would rethrow it to Remix's default screen, which
 *    is a bare "Application Error" and, in development, a stack trace. Staff
 *    get a plain message instead; the detail is in the server log, never here.
 */
export function ErrorBoundary() {
  const error = useRouteError();
  // The layout's own loader data: present when a child page failed, absent when
  // the layout itself could not load (then App Bridge is not on the page either).
  const layout = useRouteLoaderData<typeof loader>("routes/app");

  const own = readAdminMessage(error);
  if (isRouteErrorResponse(error) && !own) return boundary.error(error);

  const state = <AdminErrorState notFound={own?.message ?? null} homeUrl={layout?.apiKey ? HOME_PATH : null} />;
  if (!layout?.apiKey) return state;
  return (
    <AppProvider isEmbeddedApp apiKey={layout.apiKey}>
      <NavMenu>
        <Link to={HOME_PATH} rel="home">Home</Link>
        {NAV_ITEMS.map((item) => (
          <Link key={item.path} to={item.path}>{item.label}</Link>
        ))}
      </NavMenu>
      {state}
    </AppProvider>
  );
}

// Shopify needs this so the headers of its auth responses survive Remix's header handling.
export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
