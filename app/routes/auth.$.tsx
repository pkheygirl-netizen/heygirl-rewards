import type { LoaderFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";

/**
 * Splat route for the Shopify auth-code OAuth flow.
 *
 * The app runs the (non-token-exchange) auth-code strategy, so the
 * shopify-app-remix library bounces through `/auth`, `/auth/callback`,
 * `/auth/login`, `/auth/session-token`, and `/auth/exit-iframe`. Without a
 * route matching `/auth/*` those bounces 404, which surfaced as a "404 Not
 * Found" page inside the embedded admin iframe. Delegating to
 * `authenticate.admin` lets the library handle each sub-path.
 */
export async function loader({ request }: LoaderFunctionArgs) {
  await authenticate.admin(request);

  return null;
}
