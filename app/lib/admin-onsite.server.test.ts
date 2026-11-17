import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { blockDeepLink, discoverThemeBlocks, embedDeepLink, parseBlockSchema, themeEditorUrl } from "./admin-onsite.server";

const SHOP = "heygirl-pk.myshopify.com";
const KEY = "abc123clientid";

describe("theme editor deep links", () => {
  it("builds the app embed link in Shopify's documented form", () => {
    expect(embedDeepLink(SHOP, KEY, "rewards-embed"))
      .toBe("https://heygirl-pk.myshopify.com/admin/themes/current/editor?context=apps&activateAppId=abc123clientid/rewards-embed");
  });

  it("builds the app block link, with the template when the block names one", () => {
    expect(blockDeepLink(SHOP, KEY, "points-on-product", "product"))
      .toBe("https://heygirl-pk.myshopify.com/admin/themes/current/editor?template=product&addAppBlockId=abc123clientid/points-on-product&target=newAppsSection");
    expect(blockDeepLink(SHOP, KEY, "rewards-page", null))
      .toBe("https://heygirl-pk.myshopify.com/admin/themes/current/editor?addAppBlockId=abc123clientid/rewards-page&target=newAppsSection");
  });

  it("gives no link for a domain that is not a myshopify domain, or when the key or handle is missing", () => {
    expect(embedDeepLink("evil.example.com", KEY, "x")).toBeNull();
    expect(embedDeepLink("heygirl-pk.myshopify.com/@evil.com", KEY, "x")).toBeNull();
    expect(embedDeepLink(SHOP, "", "x")).toBeNull();
    expect(blockDeepLink(SHOP, KEY, "")).toBeNull();
    expect(themeEditorUrl(SHOP)).toBe("https://heygirl-pk.myshopify.com/admin/themes/current/editor");
    expect(themeEditorUrl("")).toBeNull();
  });
});

describe("parseBlockSchema", () => {
  it("tells an app embed from an app block and reads its name and template", () => {
    const embed = parseBlockSchema("rewards-embed", `<div></div>{% schema %}{"name":"HeyGirl Rewards","target":"body","settings":[]}{% endschema %}`);
    expect(embed).toEqual({ handle: "rewards-embed", name: "HeyGirl Rewards", kind: "embed", template: null });
    const block = parseBlockSchema("points", `{%- schema -%}\n{"name":"Points on product","target":"section","enabled_on":{"templates":["product","cart"]}}\n{%- endschema -%}`);
    expect(block).toEqual({ handle: "points", name: "Points on product", kind: "block", template: "product" });
  });

  it("falls back to the file name when the schema is missing, broken or uses a translation key", () => {
    expect(parseBlockSchema("x", "<p>no schema</p>")).toEqual({ handle: "x", name: "x", kind: "block", template: null });
    expect(parseBlockSchema("x", "{% schema %}{broken{% endschema %}").name).toBe("x");
    expect(parseBlockSchema("x", `{% schema %}{"name":"t:blocks.x.name","target":"head"}{% endschema %}`)).toMatchObject({ name: "x", kind: "embed" });
  });
});

describe("discoverThemeBlocks", () => {
  let root = "";
  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "hg-onsite-"));
    const blocks = path.join(root, "extensions", "loyalty", "blocks");
    await fs.mkdir(blocks, { recursive: true });
    await fs.writeFile(path.join(blocks, "points.liquid"), `{% schema %}{"name":"Points","target":"section"}{% endschema %}`);
    await fs.writeFile(path.join(blocks, "embed.liquid"), `{% schema %}{"name":"Rewards panel","target":"body"}{% endschema %}`);
    await fs.writeFile(path.join(blocks, "notes.txt"), "not a block");
  });
  afterAll(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("finds the blocks shipped with the app, embeds first", async () => {
    expect(await discoverThemeBlocks(root)).toEqual([
      { handle: "embed", name: "Rewards panel", kind: "embed", template: null },
      { handle: "points", name: "Points", kind: "block", template: null },
    ]);
  });

  it("returns nothing when the app has no extensions folder", async () => {
    expect(await discoverThemeBlocks(path.join(root, "missing"))).toEqual([]);
  });
});
