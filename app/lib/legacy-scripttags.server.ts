// app/lib/legacy-scripttags.server.ts
// One-time cleanup of the v2 storefront script tag. The old app version added
// a ScriptTag pointing at <app>/loyalty-widget.js?v=…; v3 is a theme app
// extension, so that tag only costs a request to the app server on every page
// view. This lists the app's script tags and deletes the old widget ones.
//
// It needs the read_script_tags and write_script_tags scopes, which the app
// does not ask for by default (the owner grants them temporarily on the dev
// app). Without them Shopify answers "access denied": that is reported as
// reason "no_scope" and logged once per process, never thrown.
//
// Operation shapes: the same `scriptTags(first:) { edges { node { id src } } }`
// query and `scriptTagDelete(id:) { deletedScriptTagId userErrors { field
// message } }` mutation the v2 app ran in production (git history,
// app/lib/scripttag.server.ts before c278834). Not re-checked against the
// 2026-10 schema reference in this round (see the report).
import { shopifyGraphqlWithRetry, type AdminGraphqlClient } from "./shopify-graphql.server";

export const LEGACY_WIDGET_PATH = "/loyalty-widget.js";

export const LIST_SCRIPT_TAGS = `#graphql
  query HgListScriptTags {
    scriptTags(first: 50) { edges { node { id src } } }
  }`;

export const DELETE_SCRIPT_TAG = `#graphql
  mutation HgDeleteScriptTag($id: ID!) {
    scriptTagDelete(id: $id) {
      deletedScriptTagId
      userErrors { field message }
    }
  }`;

export type LegacyScriptTagResult = {
  /** Old widget tags still present after this call. */
  found: number;
  removed: number;
  reason?: "no_scope" | "user_errors" | "request_failed";
};

let scopeWarned = false;

/** True when Shopify refused for lack of the script-tag scopes. */
export function isAccessDenied(err: unknown): boolean {
  if (typeof Response !== "undefined" && err instanceof Response) return err.status === 401 || err.status === 403;
  const e = (err ?? {}) as {
    message?: unknown;
    graphQLErrors?: Array<{ extensions?: { code?: string } }>;
    body?: { errors?: { graphQLErrors?: Array<{ extensions?: { code?: string } }> } | Array<{ extensions?: { code?: string } }> } | null;
    response?: { code?: unknown } | null;
  };
  const bodyErrors = e.body?.errors;
  const list = (Array.isArray(bodyErrors) ? bodyErrors : bodyErrors?.graphQLErrors) ?? e.graphQLErrors ?? [];
  if (list.some((g) => g?.extensions?.code === "ACCESS_DENIED")) return true;
  const status = Number(e.response?.code);
  if (status === 401 || status === 403) return true;
  return /access denied|ACCESS_DENIED|required access|_script_tags/i.test(String(e.message ?? ""));
}

function noScope(where: string): LegacyScriptTagResult {
  if (!scopeWarned) {
    scopeWarned = true;
    console.warn(`[legacy-scripttags] ${where}: no script-tag permission (read_script_tags / write_script_tags), old storefront script left in place`);
  }
  return { found: 0, removed: 0, reason: "no_scope" };
}

/** The old v2 widget tags among the app's script tags, or why they could not be listed. */
export async function findLegacyScriptTags(admin: AdminGraphqlClient): Promise<{ tags: Array<{ id: string; src: string }> } | LegacyScriptTagResult> {
  try {
    const data = await shopifyGraphqlWithRetry<{ scriptTags: { edges: Array<{ node: { id: string; src: string } }> } | null }>(admin, LIST_SCRIPT_TAGS);
    const tags = (data.scriptTags?.edges ?? []).map((e) => e.node).filter((n) => typeof n?.src === "string" && n.src.includes(LEGACY_WIDGET_PATH));
    return { tags };
  } catch (err) {
    if (isAccessDenied(err)) return noScope("list");
    console.error("[legacy-scripttags] list failed (non-fatal):", err instanceof Error ? err.message : err);
    return { found: 0, removed: 0, reason: "request_failed" };
  }
}

/** Deletes every script tag whose src contains /loyalty-widget.js. Never throws. */
export async function removeLegacyScriptTags(admin: AdminGraphqlClient): Promise<LegacyScriptTagResult> {
  const listed = await findLegacyScriptTags(admin);
  if (!("tags" in listed)) return listed;
  let removed = 0;
  let reason: LegacyScriptTagResult["reason"];
  for (const tag of listed.tags) {
    try {
      const data = await shopifyGraphqlWithRetry<{
        scriptTagDelete: { deletedScriptTagId: string | null; userErrors: Array<{ field: string[] | null; message: string }> } | null;
      }>(admin, DELETE_SCRIPT_TAG, { id: tag.id });
      const errors = data.scriptTagDelete?.userErrors ?? [];
      if (errors.length > 0 || !data.scriptTagDelete?.deletedScriptTagId) {
        console.error("[legacy-scripttags] scriptTagDelete rejected:", errors.map((e) => e.message).join("; ") || "nothing deleted");
        reason = reason ?? "user_errors";
        continue;
      }
      removed++;
      console.log("[legacy-scripttags] removed old storefront script:", tag.src);
    } catch (err) {
      if (isAccessDenied(err)) return { ...noScope("delete"), found: listed.tags.length - removed, removed };
      console.error("[legacy-scripttags] delete failed (non-fatal):", err instanceof Error ? err.message : err);
      reason = reason ?? "request_failed";
    }
  }
  return reason ? { found: listed.tags.length - removed, removed, reason } : { found: listed.tags.length - removed, removed };
}

/** Test hook: forget that the missing scope was already logged. */
export function resetScopeWarning(): void {
  scopeWarned = false;
}
