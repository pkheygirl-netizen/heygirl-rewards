import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeAdmin, h, opName, resetHarness } from "./testing/harness";
import { DELETE_SCRIPT_TAG, LIST_SCRIPT_TAGS, findLegacyScriptTags, isAccessDenied, removeLegacyScriptTags, resetScopeWarning } from "./legacy-scripttags.server";

const OLD = "https://app.heygirl.pk/loyalty-widget.js?v=f58b83ff&shop=heygirl-dev.myshopify.com";
const OTHER = "https://cdn.example.com/other-app.js";
const list = (...srcs: string[]) => ({ scriptTags: { edges: srcs.map((src, i) => ({ node: { id: `gid://shopify/ScriptTag/${i + 1}`, src } })) } });
const DENIED = "Access denied for scriptTags field. Required access: `read_script_tags` access scope.";

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  resetHarness();
  resetScopeWarning();
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

describe("removeLegacyScriptTags", () => {
  it("deletes only the old /loyalty-widget.js tags, checking userErrors", async () => {
    h.graphql = (q, v) =>
      opName(q) === "HgListScriptTags" ? list(OLD, OTHER) : { scriptTagDelete: { deletedScriptTagId: v.id, userErrors: [] } };
    expect(await removeLegacyScriptTags(fakeAdmin)).toEqual({ found: 0, removed: 1 });
    expect(h.graphqlCalls).toHaveLength(2);
    expect(h.graphqlCalls[1].query).toContain("scriptTagDelete(id: $id)");
    expect(h.graphqlCalls[1].variables).toEqual({ id: "gid://shopify/ScriptTag/1" }); // never the other app's tag
  });

  it("nothing to do when no old tag exists", async () => {
    h.graphql = () => list(OTHER);
    expect(await removeLegacyScriptTags(fakeAdmin)).toEqual({ found: 0, removed: 0 });
    expect(h.graphqlCalls).toHaveLength(1);
  });

  it("a delete refused with userErrors is reported, not counted as removed", async () => {
    h.graphql = (q) =>
      opName(q) === "HgListScriptTags" ? list(OLD) : { scriptTagDelete: { deletedScriptTagId: null, userErrors: [{ field: ["id"], message: "not found" }] } };
    expect(await removeLegacyScriptTags(fakeAdmin)).toEqual({ found: 1, removed: 0, reason: "user_errors" });
  });

  it("without the script-tag scopes: no throw, reason no_scope, logged once per process", async () => {
    h.graphql = () => { throw new Error(DENIED); };
    expect(await removeLegacyScriptTags(fakeAdmin)).toEqual({ found: 0, removed: 0, reason: "no_scope" });
    expect(await removeLegacyScriptTags(fakeAdmin)).toEqual({ found: 0, removed: 0, reason: "no_scope" });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(await findLegacyScriptTags(fakeAdmin)).toEqual({ found: 0, removed: 0, reason: "no_scope" });
  });

  it("any other failure is non-fatal", async () => {
    h.graphql = () => { throw new Error("network down"); };
    expect(await removeLegacyScriptTags(fakeAdmin)).toEqual({ found: 0, removed: 0, reason: "request_failed" });
  });

  it("recognises Shopify's access-denied shapes", () => {
    expect(isAccessDenied(new Error(DENIED))).toBe(true);
    expect(isAccessDenied({ body: { errors: { graphQLErrors: [{ message: "x", extensions: { code: "ACCESS_DENIED" } }] } } })).toBe(true);
    expect(isAccessDenied(new Response("", { status: 403 }))).toBe(true);
    expect(isAccessDenied(new Error("Throttled"))).toBe(false);
  });

  it("operations are the ScriptTag list query and delete mutation (shapes the v2 app ran)", () => {
    expect(LIST_SCRIPT_TAGS).toContain("scriptTags(first: 50) { edges { node { id src } } }");
    expect(DELETE_SCRIPT_TAG).toMatch(/scriptTagDelete\(id: \$id\) \{\s*deletedScriptTagId\s*userErrors \{ field message \}/);
  });
});

describe("wiring", () => {
  it("afterAuth runs it, and the scopes are NOT added to the app config", async () => {
    const fs = await import("node:fs");
    const server = fs.readFileSync("app/shopify.server.ts", "utf8");
    expect(server).toMatch(/afterAuth:[\s\S]*await ensureRewardsPage\(admin\);[\s\S]*await removeLegacyScriptTags\(admin\);/);
    expect(fs.readFileSync("shopify.app.example.toml", "utf8")).not.toMatch(/script_tags/);
    expect(server).not.toMatch(/script_tags/);
  });

  it("GET /loyalty-widget.js answers 200 with an empty script cached for a year", async () => {
    const { loader } = await import("../routes/loyalty-widget[.]js");
    const res = await loader();
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/javascript; charset=utf-8");
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable");
    expect(await res.text()).toBe("/* retired */\n");
  });
});
