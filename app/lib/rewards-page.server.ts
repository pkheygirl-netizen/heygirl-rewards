// app/lib/rewards-page.server.ts
// Creates the /pages/rewards page once, at install. (The script tag that used
// to live beside this is gone: the storefront is a theme app extension now.)
// The page body is only a fallback; the content comes from the app block on
// the theme's `page.rewards` template.
import { shopifyGraphqlWithRetry, type AdminGraphqlClient } from "./shopify-graphql.server";

export const REWARDS_PAGE_HANDLE = "rewards";

const FIND_PAGE = `#graphql
  query HgFindRewardsPage($query: String!) {
    pages(first: 5, query: $query) { nodes { id handle } }
  }`;

const CREATE_PAGE = `#graphql
  mutation HgCreateRewardsPage($page: PageCreateInput!) {
    pageCreate(page: $page) {
      page { id handle }
      userErrors { field message code }
    }
  }`;

export async function ensureRewardsPage(
  admin: AdminGraphqlClient,
): Promise<{ created: boolean; exists: boolean; reason?: string }> {
  try {
    const found = await shopifyGraphqlWithRetry<{ pages: { nodes: Array<{ id: string; handle: string }> } }>(
      admin,
      FIND_PAGE,
      { query: `handle:${REWARDS_PAGE_HANDLE}` },
    );
    if (found.pages.nodes.some((p) => p.handle === REWARDS_PAGE_HANDLE)) return { created: false, exists: true };

    const data = await shopifyGraphqlWithRetry<{
      pageCreate: { page: { id: string; handle: string } | null; userErrors: Array<{ field: string[] | null; message: string }> } | null;
    }>(admin, CREATE_PAGE, {
      page: {
        title: "Rewards",
        handle: REWARDS_PAGE_HANDLE,
        body: "<p>Sign in to see your HeyGirl Rewards points and rewards.</p>",
        isPublished: true,
      },
    });
    const errors = data.pageCreate?.userErrors ?? [];
    if (errors.length > 0 || !data.pageCreate?.page) {
      console.error("[rewards-page] pageCreate rejected:", errors.map((e) => e.message).join("; ") || "no page returned");
      return { created: false, exists: false, reason: "user_errors" };
    }
    console.log("[rewards-page] created /pages/rewards");
    return { created: true, exists: true };
  } catch (err) {
    // Never block the install on this.
    console.error("[rewards-page] failed (non-fatal):", err instanceof Error ? err.message : err);
    return { created: false, exists: false, reason: "request_failed" };
  }
}
