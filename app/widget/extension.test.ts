// Static checks on the theme app extension and styles (review items 11–14).
// They read the source files, so they need no DOM library.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { HUB_CSS, HUB_DARK, HUB_LIGHT } from "./hub-css";

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
    expect(embed).toMatch(/\.hg-launcher\{.*border:1px solid #c99a12/); // Option A: thin gold edge on black (decorative)
  });

  it("item 13: the sign-in link is a 44px target", () => {
    expect(HUB_CSS).toMatch(/\.hg-signin a\{[^}]*min-height:44px/);
  });
});

describe("rule 20: the program switch only pauses redeeming", () => {
  it("no block hides on the switch: only a missing config turns the storefront off", () => {
    for (const [name, src] of [["embed", embed], ["product", product], ["cart", cartBlock], ["page", page]] as const) {
      expect(src, name).not.toMatch(/cfg\.enabled/);
      expect(src, name).toMatch(/\{%-? if cfg( |-)/);
    }
    const core = readFileSync("app/widget/core.ts", "utf8");
    expect(core).toContain("if (!cfg) return;");
    expect(core).not.toMatch(/cfg\.enabled/);
    expect(readFileSync("app/widget/cart-line.ts", "utf8")).not.toMatch(/cfg\.enabled/);
  });

  it("the embed publishes redeemPaused and the panel style as plain literals", () => {
    expect(embed).toContain(`"redeemPaused": {% if cfg.redeemPaused == true %}true{% else %}false{% endif %},`);
    expect(embed).toContain(`"panelTheme": {% if cfg.panelTheme == 'light' %}"light"{% else %}"dark"{% endif %},`);
  });

  it("the rewards page says redeeming is paused above the reward table, only when it is", () => {
    const sec = page.slice(page.indexOf('id="hg-lp-redeem"'), page.indexOf("</table>", page.indexOf('id="hg-lp-redeem"')));
    expect(sec).toMatch(/\{%- if cfg\.redeemPaused -%\}\s*<p class="hg-lp__paused"[^>]*>Redeeming points is paused for now\. You are still earning points, and your balance is safe\.<\/p>/);
    expect(contrast("#1a1a1a", "#fff4e0")).toBeGreaterThanOrEqual(4.5);
    expect(page).toMatch(/\.hg-lp__paused\{[^}]*background:#fff4e0;color:#1a1a1a/);
  });
});

describe("panel style: Light and Dark token sets", () => {
  const tokens = (set: string): Record<string, string> =>
    Object.fromEntries(set.split(";").map((d) => d.split(":")).map(([k, ...v]) => [k.trim().slice(2), v.join(":").trim()]));
  const light = tokens(HUB_LIGHT);
  const dark = { ...light, ...tokens(HUB_DARK) };
  const hex = (v: string) => (/^#[0-9a-f]{3}$/i.test(v) ? "#" + v[1] + v[1] + v[2] + v[2] + v[3] + v[3] : v);
  /** Every text colour token on every background it is used on in HUB_CSS. */
  const PAIRS: Array<[string, string, string]> = [
    ["body text", "ink", "bg"],
    ["card text", "ink", "card"],
    ["muted text on cards (row subtitles, .hg-p, tabs, 'N more')", "mute", "card"],
    ["muted text on the panel (loading, stats, sign-in line)", "mute", "bg"],
    ["links, icons, Available/chip text on cards", "gd", "card"],
    ["links on the panel (sign-in)", "gd", "bg"],
    ["state pill / chip / icon badge", "gd", "tint"],
    ["Claimed / Saved pill, success message", "ok", "okb"],
    ["error message", "err", "errb"],
    ["history minus points", "err", "card"],
    ["history plus points, perk ticks", "pos", "card"],
    ["Pending pill", "mute", "pend"],
    ["notice (expiry, redeeming paused)", "ink", "wrn"],
    ["input and select text", "ink", "card"],
    ["pressed filter chip", "card", "ink"],
    ["gold button text", "ong", "g"],
    ["header text", "ht", "hb"],
    ["balance card greeting", "ball", "balb"],
    ["balance card number", "baln", "balb"],
    ["balance card 'points' word", "balt", "balb"],
  ];
  const resolve = (t: Record<string, string>, k: string) => hex(k.charAt(0) === "#" ? k : t[k]);
  /** The header background is a gradient in Light: both ends must pass. */
  const stops = (v: string) => (v.match(/#[0-9a-f]{3,6}\b/gi) || [v]).map(hex);

  it.each([["light", light], ["dark", dark]] as const)("%s: every text/background pair reaches 4.5:1", (_name, t) => {
    for (const [what, fg, bg] of PAIRS) {
      for (const b of stops(resolve(t, bg))) expect(contrast(resolve(t, fg), b), `${what}: ${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
    }
    // Tier badges keep their own light fills and dark ink in both styles.
    for (const fill of ["#e4e4e4", "#f3bd1c", "#d9ccff"]) expect(contrast("#1a1a1a", fill)).toBeGreaterThanOrEqual(4.5);
    // Non-text: input borders, the progress bar and accent edges reach 3:1.
    expect(contrast(resolve(t, "fld"), resolve(t, "card"))).toBeGreaterThanOrEqual(3);
    expect(contrast(resolve(t, "gd"), resolve(t, "trk"))).toBeGreaterThanOrEqual(3);
    expect(contrast(resolve(t, "gd"), resolve(t, "card"))).toBeGreaterThanOrEqual(3);
    // Focus ring (var(--ink)) is visible on the panel and on cards.
    expect(contrast(resolve(t, "ink"), resolve(t, "bg"))).toBeGreaterThanOrEqual(3);
    expect(contrast(resolve(t, "ink"), resolve(t, "card"))).toBeGreaterThanOrEqual(3);
    for (const b of stops(resolve(t, "hb"))) expect(contrast(resolve(t, "ht"), b)).toBeGreaterThanOrEqual(3); // focus ring in the header
  });

  it("the CSS uses the tokens for those pairs", () => {
    for (const rule of [
      /\.hg-hub\{[^}]*background:var\(--bg\);color:var\(--ink\)/,
      /\.hg-card\{background:var\(--card\)/,
      /\.hg-p\{color:var\(--mute\)/,
      /\.hg-msg\{[^}]*background:var\(--okb\);color:var\(--ok\)/,
      /\.hg-msg--err\{background:var\(--errb\);color:var\(--err\)\}/,
      /\.hg-pts\{[^}]*color:var\(--pos\)/,
      /\.hg-pts--neg\{color:var\(--err\)\}/,
      /\.hg-note--warn\{background:var\(--wrn\)/,
      /\.hg-fchip\[aria-pressed=true\]\{background:var\(--ink\);color:var\(--card\)/,
      /\.hg-btn\{[^}]*background:var\(--g\);color:var\(--ong\)!important/,
      /\.hg-btn:hover\{background:#f3bd1c;color:var\(--ong\)!important\}/,
      /\.hg-btn--ghost\{background:var\(--card\);color:var\(--ink\)!important\}/,
      /\.hg-hub__head\{[^}]*background:var\(--hb\);color:var\(--ht\)/,
      /\.hg-bal\{background:var\(--balb\);border:1px solid var\(--balln\);color:var\(--balt\)/,
      /\.hg-bal__l\{[^}]*color:var\(--ball\)\}/,
      /\.hg-bal__n\{[^}]*color:var\(--baln\);/,
      /\.hg-bal__n span\{[^}]*color:var\(--balt\)\}/,
      /\.hg-ref__i\{[^}]*border:1px solid var\(--fld\);[^}]*background:var\(--card\)/,
      /\.hg-bday select\{[^}]*border:1px solid var\(--fld\);[^}]*background:var\(--card\)/,
      /\.hg-hub :focus-visible\{outline:3px solid var\(--ink\)/,
    ]) expect(HUB_CSS).toMatch(rule);
  });

  it("no colour is hard-coded outside the two token sets, except the tier badges and button hover (same in both styles)", () => {
    const rules = HUB_CSS.replace(HUB_LIGHT, "").replace(HUB_DARK, "");
    const found = new Set((rules.match(/#[0-9a-f]{3,6}\b/gi) || []).map((c) => c.toLowerCase()));
    expect([...found].sort()).toEqual(["#1a1a1a", "#595959", "#d9ccff", "#e4e4e4", "#f3bd1c"].sort());
  });

  it("owner request 18 Nov 2026: Light keeps its black balance card; Dark gets a gold one with near-black text", () => {
    // Light unchanged: black card, light-grey greeting, yellow number, white 'points'.
    expect([light.balb, light.balln, light.ball, light.baln, light.balt]).toEqual(["#1a1a1a", "#1a1a1a", "#e6e6e6", "#ffd24a", "#fff"]);
    // Dark: the same gold gradient as the Light header, so it stands out on #121212.
    expect(dark.balb).toBe(light.hb);
    expect(dark.balb).toBe("linear-gradient(135deg,#f3bd1c,#e0a400)");
    for (const k of ["ball", "baln", "balt"]) {
      for (const b of stops(dark.balb)) expect(contrast(resolve(dark, k), b), k).toBeGreaterThanOrEqual(4.5);
    }
    // The card itself is clearly visible on the dark panel (non-text, 3:1).
    for (const b of stops(dark.balb)) expect(contrast(b, resolve(dark, "bg"))).toBeGreaterThanOrEqual(3);
    // Tier badge on the gold card: dark ink on its fill, and a near-black outline
    // so the Gold badge does not melt into the gold card.
    expect(HUB_CSS).toContain(".hg-hub--dark .hg-bal .hg-tier{border-color:var(--baln)}");
    for (const b of stops(dark.balb)) expect(contrast(resolve(dark, "baln"), b)).toBeGreaterThanOrEqual(3);
    for (const fill of ["#e4e4e4", "#f3bd1c", "#d9ccff"]) expect(contrast("#1a1a1a", fill)).toBeGreaterThanOrEqual(4.5);
  });

  it("Dark is applied only by a class on the hub root; the toast follows the panel style; the launcher and cart/product lines are not themed", () => {
    expect(HUB_CSS).toContain(".hg-hub--dark{" + HUB_DARK + ";color-scheme:dark;");
    // The dark set only redefines tokens the light set already has.
    for (const k of Object.keys(tokens(HUB_DARK))) expect(light, k).toHaveProperty(k);
    const hub = readFileSync("app/widget/hub.ts", "utf8");
    expect(hub).toContain('if (cfg.panelTheme !== "light") hub.className += " hg-hub--dark";');
    const core = readFileSync("app/widget/core.ts", "utf8");
    expect(core).toContain('el.className = cfg.panelTheme === "light" ? "hg-toast" : "hg-toast hg-toast--dark";');
    for (const src of [embed, product, cartBlock, read("snippets/hg-line-css.liquid"), core, readFileSync("app/widget/cart-line.ts", "utf8")]) {
      expect(src).not.toMatch(/hg-hub--dark|--ink|--card/);
    }
    expect(embed).toMatch(/\.hg-launcher\{.*background:#0e0e0e;color:#f3bd1c/); // one launcher for both styles
  });
});

const tokens = (set: string): Record<string, string> =>
  Object.fromEntries(set.split(";").map((d) => d.split(":")).map(([k, ...v]) => [k.trim().slice(2), v.join(":").trim()]));

describe("guest nudge / toast follows the panel style (owner, 18 Nov 2026)", () => {
  const css = /<style>([\s\S]*?)<\/style>/.exec(embed)![1].replaceAll("{{ block.settings.position }}", "right");
  const rule = (sel: string) => {
    const m = new RegExp(sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\{([^}]*)\\}").exec(css);
    expect(m, sel).not.toBeNull();
    return m![1];
  };
  const dark = { ...tokens(HUB_LIGHT), ...tokens(HUB_DARK) };
  const val = (body: string, prop: string) => new RegExp(`(?:^|;)${prop}:(#[0-9a-f]{6})`).exec(body)![1];

  it("Dark: black card in the Dark panel's own colours, text 4.5:1", () => {
    const box = rule(".hg-toast--dark");
    expect(val(box, "background")).toBe(dark.bg);
    expect(val(box, "color")).toBe(dark.ink);
    expect(val(box, "border-color")).toBe(dark.ln);
    expect(box).toContain(`border-top:2px solid ${dark.gd}`);
    expect(val(rule(".hg-toast--dark .hg-toast__b"), "color")).toBe(dark.mute);
    expect(val(rule(".hg-toast--dark .hg-toast__x"), "color")).toBe(dark.ink);
    for (const fg of [dark.ink, dark.mute]) expect(contrast(fg, dark.bg)).toBeGreaterThanOrEqual(4.5);
    expect(contrast("#1a1a1a", "#e8ad00")).toBeGreaterThanOrEqual(4.5); // the gold button keeps dark text
    // a focus ring that shows on black (the theme's own ring is dark)
    expect(rule(".hg-toast--dark :focus-visible")).toContain("outline:3px solid #f5f5f5");
  });

  it("Light keeps today's white card", () => {
    const box = rule(".hg-toast");
    expect(box).toContain("background:#fff;color:#1a1a1a");
    expect(contrast("#1a1a1a", "#ffffff")).toBeGreaterThanOrEqual(4.5);
    expect(contrast("#595959", "#ffffff")).toBeGreaterThanOrEqual(4.5);
  });
});

describe("launcher: Option A, black and gold (owner, 18 Nov 2026)", () => {
  const css = /<style>([\s\S]*?)<\/style>/.exec(embed)![1].replaceAll("{{ block.settings.position }}", "right");
  const launcher = /\.hg-launcher\{([^}]*)\}/.exec(css)![1];

  it("matches the approved mock: black pill, thin gold border, gold text, 48px tall, no white circle", () => {
    for (const d of ["display:inline-flex", "gap:9px", "height:48px", "min-height:48px", "padding:0 20px 0 16px", "border:1px solid #c99a12", "border-radius:999px", "background:#0e0e0e", "color:#f3bd1c", "font-size:15px", "font-weight:600", "letter-spacing:.2px", "box-shadow:0 6px 18px rgba(0,0,0,.25)"]) {
      expect(launcher, d).toContain(d);
    }
    expect(embed).not.toContain("hg-launcher__ic"); // the white circle is gone
    expect(css).toMatch(/\.hg-launcher \.hg-ico\{width:22px;height:22px;flex:none;color:#f3bd1c\}/);
    expect(contrast("#f3bd1c", "#0e0e0e")).toBeGreaterThanOrEqual(4.5); // label text
    expect(Number(/min-height:(\d+)px/.exec(launcher)![1])).toBeGreaterThanOrEqual(44); // tap target
  });

  it("its focus ring shows on light and dark pages: a gold ring inside a black ring", () => {
    const focus = /\.hg-launcher:focus-visible\{([^}]*)\}/.exec(css)![1];
    expect(focus).toContain("outline:3px solid #f3bd1c");
    expect(focus).toContain("box-shadow:0 0 0 7px #0e0e0e");
    expect(contrast("#0e0e0e", "#ffffff")).toBeGreaterThanOrEqual(3); // black ring on a white page
    expect(contrast("#f3bd1c", "#0e0e0e")).toBeGreaterThanOrEqual(3); // gold ring next to the black ring / on dark photos
  });

  it("one single-colour line gift (stroke = currentColor) for the launcher and the cart/product lines", () => {
    const symbol = /<symbol id="hg-i-gift"([^>]*)>(.*?)<\/symbol>/.exec(embed)!;
    expect(embed.match(/<symbol id="hg-i-gift"/g)).toHaveLength(1);
    expect(symbol[1]).toContain('fill="none" stroke="currentColor"');
    expect(symbol[2]).not.toMatch(/fill="#|#d62839|#f7c531/); // the old red-and-gold gift is gone
    expect(embed).toContain('<svg class="hg-ico" aria-hidden="true" focusable="false"><use href="#hg-i-gift"/></svg>');
    const snippet = read("snippets/hg-gift.liquid");
    expect(snippet).toContain('stroke="currentColor"');
    expect(snippet).not.toMatch(/#d62839|#f7c531/);
    // On the store's white/cream background the lines draw it in dark gold (6:1), text unchanged.
    const lineCss = read("snippets/hg-line-css.liquid");
    expect(lineCss).toContain(".hg-line .hg-ico,.hg-earn .hg-ico{color:#7a5c00}");
    expect(contrast("#7a5c00", "#fffaf0")).toBeGreaterThanOrEqual(4.5);
    expect(contrast("#1a1a1a", "#fffaf0")).toBeGreaterThanOrEqual(4.5);
  });

  it("visitor text comes from the On-site setting (escaped, default Shop & Earn); the accessible name starts with it", () => {
    expect(embed).toContain(`<span class="hg-launcher__label">{{ cfg.launcherLabel | default: 'Shop & Earn' | escape }}</span>`);
    expect(embed).toContain(`aria-label="{{ cfg.launcherLabel | default: 'Shop & Earn' | escape }}: open {{ cfg.programName | escape }}"`);
    expect(embed).not.toMatch(/"launcherLabel":/); // not needed in the script config
    const core = readFileSync("app/widget/core.ts", "utf8");
    expect(core).toContain('label.textContent = fmt(member.member.pointsBalance) + " pts";');
  });
});
