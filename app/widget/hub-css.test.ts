// The hub panel lives inside the store's page, so the theme's own element rules
// reach it. Dawn's base.css colours h1-h6 directly
// (`h1,h2,h3,… { color: rgb(var(--color-foreground)); font-family: …; letter-spacing: … }`),
// which in the Dark panel made every heading black on black (owner report,
// 18 Nov 2026). These static checks make sure every text element type the hub
// markup uses has its own colour rule under `.hg-hub`, and every heading has all
// of its type styles at a specificity no theme element rule can beat.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { HUB_CSS } from "./hub-css";

type Rule = { selectors: string[]; body: string };

/** Splits a selector list on top-level commas (not the ones inside :where(…)). */
function splitSelectors(list: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of list) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) { out.push(cur.trim()); cur = ""; } else cur += ch;
  }
  out.push(cur.trim());
  return out.filter(Boolean);
}

/** Flat list of style rules (rules inside @media are included). */
function parseCss(css: string): Rule[] {
  const out: Rule[] = [];
  const flat = css.replace(/@media[^{]*\{((?:[^{}]*\{[^{}]*\})*)[^{}]*\}/g, "$1");
  for (const m of flat.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    out.push({ selectors: splitSelectors(m[1]), body: m[2] });
  }
  return out;
}
const rules = parseCss(HUB_CSS);

/** Every element type written in the hub's markup (views.ts + hub.ts), SVG parts left out. */
function markupTags(): Set<string> {
  const src = readFileSync("app/widget/views.ts", "utf8") + readFileSync("app/widget/hub.ts", "utf8");
  const tags = new Set<string>();
  for (const m of src.matchAll(/<([a-z][a-z0-9]*)[\s>/]/g)) tags.add(m[1]);
  for (const svg of ["svg", "use", "symbol", "path"]) tags.delete(svg);
  return tags;
}

/** Elements that show text, and so need a colour of their own against theme element rules. */
const TEXT_TAGS = ["h1", "h2", "h3", "h4", "h5", "h6", "p", "span", "a", "button", "label", "strong", "b", "em", "small", "li", "input", "select", "option", "textarea", "summary", "td", "th"];

/** True when `sel` is scoped to .hg-hub and targets elements of type `tag`. */
function targetsTag(sel: string, tag: string): boolean {
  if (sel === `.hg-hub ${tag}`) return true;
  const m = /^\.hg-hub :(?:where|is)\(([^)]*)\)$/.exec(sel);
  return !!m && m[1].split(",").map((s) => s.trim()).includes(tag);
}

/** Declared properties of a rule body. */
const props = (body: string) => new Set(body.split(";").map((d) => d.split(":")[0].trim()).filter(Boolean));

describe("theme CSS cannot recolour the hub (Dawn base.css leak)", () => {
  it("the hub markup still uses the element types this test knows about", () => {
    const tags = markupTags();
    for (const t of ["h2", "h3", "p", "span", "a", "button", "li", "strong", "label", "input", "select", "option"]) expect(tags, t).toContain(t);
  });

  it("every text element type used in the hub markup has an explicit colour rule under .hg-hub", () => {
    const used = [...markupTags()].filter((t) => TEXT_TAGS.includes(t));
    const missing = used.filter((t) => !rules.some((r) => props(r.body).has("color") && r.selectors.some((s) => targetsTag(s, t))));
    expect(missing).toEqual([]);
  });

  it("every heading carries a class whose .hg-hub rule sets colour, font, size, weight, spacing, line height and margin", () => {
    const src = readFileSync("app/widget/views.ts", "utf8") + readFileSync("app/widget/hub.ts", "utf8");
    const headings = [...src.matchAll(/<(h[1-6])(\s[^>]*)?>/g)];
    expect(headings.length).toBeGreaterThan(5);
    const need = ["color", "font-family", "font-style", "font-size", "font-weight", "letter-spacing", "line-height", "margin", "text-transform"];
    for (const [tagText, tag, attrs] of headings) {
      const cls = /class="([a-z0-9_-]+)/.exec(attrs || "");
      expect(cls, `${tag} without a class: ${tagText}`).not.toBeNull();
      // Two classes: beats `h2` (0,0,1), `.hg-hub h2` (0,1,1) and Dawn's `.h2` (0,1,0).
      const rule = rules.find((r) => r.selectors.includes(`.hg-hub .${cls![1]}`));
      expect(rule, `.hg-hub .${cls![1]}`).toBeDefined();
      const p = props(rule!.body);
      for (const k of need) expect(p.has(k), `.hg-hub .${cls![1]} sets ${k}`).toBe(true);
      expect(rule!.body).toMatch(/color:var\(--(ink|ht)\)/); // colours come from the panel tokens
      expect(rule!.body).toContain("letter-spacing:normal");
    }
    // No heading relies on !important or on a bare class selector for its colour.
    expect(HUB_CSS).not.toMatch(/(^|\n)\.hg-h\{/);
    expect(HUB_CSS).not.toMatch(/(^|\n)\.hg-hub__title\{/);
  });

  it("the theme's focus shadow is switched off inside the hub; our ring stays", () => {
    const focus = rules.find((r) => r.selectors.includes(".hg-hub :focus-visible"))!;
    expect(focus.body).toContain("outline:3px solid var(--ink)");
    expect(focus.body).toContain("box-shadow:none");
  });

  it("the plain-element colour reset sits before the class rules, so class colours still win", () => {
    const reset = HUB_CSS.indexOf(".hg-hub :where(");
    for (const cls of [".hg-row__s{", ".hg-p{", ".hg-st{", ".hg-need{", ".hg-bal__l{", ".hg-pts{"]) {
      expect(HUB_CSS.indexOf(cls), cls).toBeGreaterThan(reset);
    }
    expect(reset).toBeGreaterThan(0);
  });
});
