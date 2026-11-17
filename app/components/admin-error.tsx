// app/components/admin-error.tsx
// What staff see when an admin page cannot be loaded. Never shows system text:
// no error message, no stack, no table or column names.
import type { ReactNode } from "react";
import { Banner, BlockStack, Button, Card, InlineStack, Layout, Page, Text } from "@shopify/polaris";

/** Key of the body a loader sends for a "this record does not exist" answer. */
export const ADMIN_MESSAGE_KEY = "adminMessage";

/**
 * Pure: is this route error one of the admin's own "not found" answers (a
 * Response whose JSON body is { adminMessage: "..." })? Returns the message, or
 * null for everything else, including every Response Shopify's auth flow throws
 * (those carry HTML or an empty body, never this shape).
 */
export function readAdminMessage(error: unknown): { status: number; message: string } | null {
  if (!error || typeof error !== "object") return null;
  const e = error as { status?: unknown; data?: unknown };
  if (typeof e.status !== "number") return null;
  if (!e.data || typeof e.data !== "object") return null;
  const m = (e.data as Record<string, unknown>)[ADMIN_MESSAGE_KEY];
  return typeof m === "string" && m.trim() !== "" ? { status: e.status, message: m.slice(0, 200) } : null;
}

export const LOAD_FAILED_TITLE = "This page could not be loaded";
export const LOAD_FAILED_TEXT =
  "Something went wrong on our side while opening this page. Nothing was changed. Reload the page in your browser. If it keeps happening, tell your developer what you were opening and the time it happened.";

/**
 * `homeUrl` is only passed when in-app navigation is known to work (the layout's
 * own data loaded, so App Bridge is on the page). Without it the only advice is
 * to reload the browser tab, which reloads Shopify admin and the app with it.
 */
export function AdminErrorState(props: { notFound?: string | null; homeUrl?: string | null }): ReactNode {
  const notFound = props.notFound ?? null;
  return (
    <Page title={notFound ? "Not found" : LOAD_FAILED_TITLE}>
      <Layout>
        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <Banner tone={notFound ? "warning" : "critical"} title={notFound ?? LOAD_FAILED_TITLE}>
                <p>
                  {notFound
                    ? "It may have been removed, or the link is out of date. Go back and open it from the list again."
                    : LOAD_FAILED_TEXT}
                </p>
              </Banner>
              {props.homeUrl ? (
                <InlineStack>
                  <Button url={props.homeUrl}>Go to Home</Button>
                </InlineStack>
              ) : (
                <Text as="p" tone="subdued">Reload this browser tab to open the app again.</Text>
              )}
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
