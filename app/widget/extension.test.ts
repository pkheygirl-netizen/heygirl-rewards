// Static checks on the theme app extension and styles (review items 11–14).
// They read the source files, so they need no DOM library.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { HUB_CSS } from "./hub-css";

const read = (f: string) => readFileSync(`extensions/hg-loyalty/${f}`, "utf8");
const embed = read("blocks/embed.liquid");
const product = read("blocks/product-points.liquid");
const cartBlock = read("blocks/cart-points.liquid");
const page = read("blocks/rewards-page.liquid");

/** WCAG relative luminance contrast of two #rrggbb colours. */
function contrast(a: string, b: string): number {
  const lum = (hex: string) => {
    const [r, g, bl] = [1, 3, 5].map((i) => {
      const c = parseInt(hex.slice(i, i + 2), 16) / 255;
      return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

describe("extension static checks", () => {
  it("item 14: the cart line CSS is printed once (blocks print it, the embed never does)", () => {
    expect(embed).not.toContain("render 'hg-line-css'");
    expect(product.match(/render 'hg-line-css'/g)).toHaveLength(1);
    expect(cartBlock.match(/render 'hg-line-css'/g)).toHaveLength(1);
    expect(read("snippets/hg-line-css.liquid")).toContain('<style id="hg-line-css">');
    const core = readFileSync("app/widget/core.ts", "utf8");
    expect(core).toContain('document.getElementById("hg-line-css")'); // injects only when absent
  });

  it("item 12: the launcher label reserves its width", () => {
    expect(embed).toMatch(/\.hg-launcher__label\{[^}]*min-width:\d+px/);
  });

  it("item 11: Liquid prints no campaign wording; the embed publishes both campaigns", () => {
    for (const src of [product, cartBlock, page]) expect(src).not.toMatch(/cfg\.(campaign|nextCampaign)\.(name|endsAt)/);
    expect(product).toContain("data-hg-camp");
    expect(page).toContain("data-hg-camp");
    expect(embed).toContain('"campaign": {{ cfg.campaign | json }}');
    expect(embed).toContain('"nextCampaign": {{ cfg.nextCampaign | json }}');
    expect(read("snippets/hg-mult.liquid")).toContain("cfg.nextCampaign");
  });

  it("unused fields are no longer printed", () => {
    expect(embed).not.toContain("firstName");
    expect(embed).not.toContain("reviewReleaseHours");
    expect(embed).not.toContain("codeExpiryDays");
  });

  it("item 13: the rewards page prints no second h1", () => {
    expect(page).not.toMatch(/<h1[\s>]/);
    expect(page).not.toMatch(/\bh1\b\s*[{,]/);
  });

  it("item 13: bright gold is never an edge; the dark gold used instead reaches 3:1", () => {
    expect(contrast("#e8ad00", "#ffffff")).toBeLessThan(3); // why it must not carry meaning alone
    expect(contrast("#7a5c00", "#ffffff")).toBeGreaterThanOrEqual(3);
    expect(contrast("#7a5c00", "#faf7ee")).toBeGreaterThanOrEqual(3);
    expect(contrast("#7a5c00", "#eee4c2")).toBeGreaterThanOrEqual(3); // bar fill on its track
    expect(contrast("#b98900", "#ffffff")).toBeGreaterThanOrEqual(3);
    expect(contrast("#7a5c00", "#e8ad00")).toBeGreaterThanOrEqual(1); // sanity
    // No border, underline or bar fill uses the bright gold variable or value.
    expect(HUB_CSS).not.toMatch(/border[a-z-]*:[^;}]*var\(--g\)/);
    expect(HUB_CSS).not.toMatch(/border[a-z-]*:[^;}]*#e8ad00/i);
    expect(HUB_CSS).toMatch(/\.hg-bar span\{[^}]*background:var\(--gd\)/);
    expect(HUB_CSS).toMatch(/\.hg-tab\[aria-selected=true\]\{[^}]*border-bottom-color:var\(--gd\)/);
    expect(HUB_CSS).toMatch(/\.hg-tcard--me\{border:2px solid var\(--gd\)\}/);
    expect(HUB_CSS).toMatch(/\.hg-btn\{[^}]*border:2px solid var\(--gd\)/);
    for (const css of [embed, page]) expect(css).not.toMatch(/border[a-z-]*:[^;}]*#e8ad00/i);
    expect(embed).toMatch(/\.hg-launcher\{.*border:2px solid #7a5c00/);
  });

  it("item 13: the sign-in link is a 44px target", () => {
    expect(HUB_CSS).toMatch(/\.hg-signin a\{[^}]*min-height:44px/);
  });
});
