import { describe, it, expect } from "vitest";
import { cartFromJson, cartLineHtml, createCartSync, DRAWER_LINE_ATTR, ensureDrawerLine, fillCartBlock } from "./cart-line";
import { makeConfig, makeMember } from "./test-fixtures";

// jsdom is not installed in this repo, so the placement helper is exercised
// against a very small DOM stand-in that implements only what it uses.
class El {
  children: El[] = [];
  parentNode: El | null = null;
  attrs: Record<string, string> = {};
  className = "";
  innerHTML = "";
  hidden = false;
  ownerDocument = { createElement: (_tag: string) => new El() };
  setAttribute(k: string, v: string) { this.attrs[k] = v; }
  hasAttribute(k: string) { return k in this.attrs; }
  get previousElementSibling(): El | null {
    if (!this.parentNode) return null;
    const i = this.parentNode.children.indexOf(this);
    return i > 0 ? this.parentNode.children[i - 1] : null;
  }
  append(...kids: El[]) { for (const k of kids) { k.parentNode = this; this.children.push(k); } return this; }
  insertBefore(n: El, ref: El) { n.parentNode = this; this.children.splice(this.children.indexOf(ref), 0, n); return n; }
  remove() { if (this.parentNode) { const p = this.parentNode; p.children.splice(p.children.indexOf(this), 1); this.parentNode = null; } }
  private walk(out: El[] = []): El[] { for (const c of this.children) { out.push(c); c.walk(out); } return out; }
  private match(sel: string) { return sel.startsWith(".") ? this.className.split(" ").includes(sel.slice(1)) : this.hasAttribute(sel.slice(1, -1)); }
  querySelector(sel: string): El | null { return this.walk().find((e) => e.match(sel)) ?? null; }
  querySelectorAll(sel: string): El[] { return this.walk().filter((e) => e.match(sel)); }
}
const el = (cls: string) => Object.assign(new El(), { className: cls });

/** <cart-drawer> → .drawer__inner → .drawer__footer → [.cart-drawer__footer, .cart__ctas → button] */
function drawer() {
  const root = el("drawer");
  const inner = el("drawer__inner");
  const footer = el("drawer__footer");
  const ctas = el("cart__ctas").append(el("cart__checkout-button"));
  root.append(inner.append(footer.append(el("cart-drawer__footer"), ctas)));
  return { root, inner, footer, ctas };
}
const asEl = (e: El) => e as unknown as Element;
const lines = (root: El) => root.querySelectorAll(`[${DRAWER_LINE_ATTR}]`);

describe("ensureDrawerLine", () => {
  it("inserts one line immediately before .cart__ctas, never inside it", () => {
    const d = drawer();
    expect(ensureDrawerLine(asEl(d.root), "<p>A</p>")).toBe(true);
    expect(lines(d.root)).toHaveLength(1);
    expect(d.ctas.previousElementSibling).toBe(lines(d.root)[0]);
    expect(lines(d.root)[0].parentNode).toBe(d.footer);
    expect(d.ctas.children).toHaveLength(1); // the other app's button area is untouched
    expect(lines(d.root)[0].innerHTML).toBe("<p>A</p>");
  });

  it("is idempotent: repeated calls change nothing", () => {
    const d = drawer();
    ensureDrawerLine(asEl(d.root), "<p>A</p>");
    for (let i = 0; i < 5; i++) expect(ensureDrawerLine(asEl(d.root), "<p>A</p>")).toBe(false);
    expect(lines(d.root)).toHaveLength(1);
    expect(d.footer.children).toHaveLength(3);
  });

  it("updates the text in place when the cart changes", () => {
    const d = drawer();
    ensureDrawerLine(asEl(d.root), "<p>A</p>");
    const first = lines(d.root)[0];
    expect(ensureDrawerLine(asEl(d.root), "<p>B</p>")).toBe(true);
    expect(lines(d.root)).toEqual([first]);
    expect(first.innerHTML).toBe("<p>B</p>");
  });

  it("re-inserts after Dawn replaces the drawer contents", () => {
    const d = drawer();
    ensureDrawerLine(asEl(d.root), "<p>A</p>");
    // Dawn: `.drawer__inner`.innerHTML = fresh section HTML (our line is gone).
    d.inner.children = [];
    const footer = el("drawer__footer");
    const ctas = el("cart__ctas");
    d.inner.append(footer.append(ctas));
    expect(lines(d.root)).toHaveLength(0);
    expect(ensureDrawerLine(asEl(d.root), "<p>A</p>")).toBe(true);
    expect(lines(d.root)).toHaveLength(1);
    expect(ctas.previousElementSibling).toBe(lines(d.root)[0]);
  });

  it("removes strays and a misplaced line", () => {
    const d = drawer();
    const stray = el("hg-line");
    stray.setAttribute(DRAWER_LINE_ATTR, "");
    d.ctas.append(stray); // wrongly inside the buttons container
    ensureDrawerLine(asEl(d.root), "<p>A</p>");
    expect(lines(d.root)).toHaveLength(1);
    expect(d.ctas.querySelectorAll(`[${DRAWER_LINE_ATTR}]`)).toHaveLength(0);
  });

  it("removes the line when there is nothing to show or no buttons container", () => {
    const d = drawer();
    ensureDrawerLine(asEl(d.root), "<p>A</p>");
    expect(ensureDrawerLine(asEl(d.root), "")).toBe(true);
    expect(lines(d.root)).toHaveLength(0);
    const empty = el("drawer");
    expect(ensureDrawerLine(asEl(empty), "<p>A</p>")).toBe(false);
  });
});

describe("fillCartBlock", () => {
  it("writes once per distinct html and hides when empty", () => {
    const b = new El();
    expect(fillCartBlock(asEl(b), "<p>A</p>")).toBe(true);
    expect(fillCartBlock(asEl(b), "<p>A</p>")).toBe(false);
    expect(fillCartBlock(asEl(b), "")).toBe(true);
    expect(b.hidden).toBe(true);
  });
});

describe("cartFromJson", () => {
  it("reads applied codes from /cart.js, not Shopify.checkout", () => {
    const c = cartFromJson({
      total_price: 250000,
      item_count: 2,
      discount_codes: [{ code: "REWARD-AB12", applicable: true }, { code: "NOPE", applicable: false }],
      cart_level_discount_applications: [{ type: "discount_code", title: "REWARD-AB12" }, { type: "automatic", title: "Sale" }],
      items: [{ line_level_discount_allocations: [{ discount_application: { type: "discount_code", title: "LINE10" } }] }],
    });
    expect(c).toEqual({ total: 250000, count: 2, codes: ["REWARD-AB12", "LINE10"] });
    expect(cartFromJson(null)).toEqual({ total: 0, count: 0, codes: [] });
  });
});

describe("cartLineHtml", () => {
  const cfg = makeConfig();
  const cart = { total: 250000, count: 1, codes: [] as string[] };
  const code = { id: "c1", code: "REWARD-AB12", kind: "reward", discountPkr: 250, expiresAt: null };

  it("guest: points and the enrolment sentence, no member links", () => {
    const h = cartLineHtml(cfg, cart, null, false, "/cart");
    expect(h).toContain("2,500 points");
    expect(h).toContain("Placing an order enrols you in HeyGirl Rewards.");
    expect(h).not.toContain("/discount/");
  });

  it("member with an active code gets an Apply reward link back to the current path", () => {
    const h = cartLineHtml(cfg, cart, makeMember({}, { codes: [code] }), true, "/products/serum?variant=1");
    expect(h).toContain('href="/discount/REWARD-AB12?redirect=%2Fproducts%2Fserum%3Fvariant%3D1"');
    expect(h).toContain("Apply reward: Rs. 250 off");
    expect(h).not.toContain("enrols");
  });

  it("shows applied / cannot-combine states from the cart's codes", () => {
    const m = makeMember({}, { codes: [code] });
    expect(cartLineHtml(cfg, { ...cart, codes: ["reward-ab12"] }, m, true, "/cart")).toContain("Your reward REWARD-AB12 is applied.");
    const other = cartLineHtml(cfg, { ...cart, codes: ["WELCOME10"] }, m, true, "/cart");
    expect(other).toContain("can't be combined");
    expect(other).not.toContain("/discount/");
  });

  it("member with enough points and no code is invited to redeem", () => {
    expect(cartLineHtml(cfg, cart, makeMember({ pointsBalance: 3000 }), true, "/cart")).toContain('data-hg-open="rewards"');
    expect(cartLineHtml(cfg, cart, makeMember({ pointsBalance: 2999 }), true, "/cart")).not.toContain("data-hg-open");
  });

  it("is empty for an empty cart, and opted-out or blocked members", () => {
    expect(cartLineHtml(cfg, { total: 0, count: 0, codes: [] }, null, false, "/")).toBe("");
    expect(cartLineHtml(cfg, cart, makeMember({ optedOut: true }), true, "/")).toBe("");
    expect(cartLineHtml(cfg, cart, makeMember({ blocked: true }), true, "/")).toBe("");
  });

  it("rule 20: while redeeming is paused the earn line stays, the 'points to spend' nudge goes, issued codes are untouched", () => {
    const paused = makeConfig({ redeemPaused: true });
    // A config an older admin published with enabled false is not hidden either.
    const old = { ...paused, enabled: false } as unknown as typeof paused;
    for (const c of [paused, old]) {
      const guest = cartLineHtml(c, cart, null, false, "/cart");
      expect(guest).toContain("You'll earn");
      expect(guest).toContain("enrols you");
      const rich = cartLineHtml(c, cart, makeMember({ pointsBalance: 9000 }), true, "/cart");
      expect(rich).toContain("You'll earn");
      expect(rich).not.toContain("data-hg-open");
      expect(rich).not.toContain("Redeem");
    }
    // The member's own code still works at checkout, so its Apply link is kept.
    expect(cartLineHtml(paused, cart, makeMember({}, { codes: [code] }), true, "/cart")).toContain("Apply reward: Rs. 250 off");
    expect(cartLineHtml(paused, { ...cart, codes: ["reward-ab12"] }, makeMember({}, { codes: [code] }), true, "/cart")).toContain("is applied");
  });
});

describe("review fixes: cart line", () => {
  it("item 2: the line is back in the same task as Dawn's re-render, then refreshed after /cart.js", async () => {
    const d = drawer();
    let html = "<p>2,500 points</p>";
    const render = () => void ensureDrawerLine(asEl(d.root), html);
    render();

    const queued: Array<() => void> = [];
    let cleared = 0;
    let fetches = 0;
    const sync = createCartSync(
      render,
      async () => {
        fetches++;
        html = "<p>5,000 points</p>";
      },
      250,
      { set: (fn) => queued.push(fn), clear: () => void cleared++ },
    );

    // Dawn replaces .drawer__inner contents; the observer fires.
    d.inner.children = [];
    const ctas = el("cart__ctas");
    d.inner.append(el("drawer__footer").append(ctas));
    expect(lines(d.root)).toHaveLength(0);
    sync();
    // No timer has run and nothing was fetched, yet the line is already there.
    expect(fetches).toBe(0);
    expect(lines(d.root)).toHaveLength(1);
    expect(ctas.previousElementSibling).toBe(lines(d.root)[0]);
    expect(lines(d.root)[0].innerHTML).toBe("<p>2,500 points</p>");

    sync(); // a second mutation within the debounce window
    expect(cleared).toBe(1);
    expect(lines(d.root)).toHaveLength(1);

    queued[queued.length - 1]();
    await Promise.resolve();
    await Promise.resolve();
    expect(fetches).toBe(1);
    expect(lines(d.root)).toHaveLength(1);
    expect(lines(d.root)[0].innerHTML).toBe("<p>5,000 points</p>");
  });

  it("item 2: still renders when the cart request fails", async () => {
    let renders = 0;
    const queued: Array<() => void> = [];
    const sync = createCartSync(() => void renders++, () => Promise.reject(new Error("offline")), 250, { set: (fn) => queued.push(fn), clear: () => undefined });
    sync();
    queued[0]();
    await Promise.resolve();
    await Promise.resolve();
    expect(renders).toBe(2);
  });

  it("item 11: campaign wording in the cart line follows the script's clock", () => {
    const campaign = { name: "11.11", multiplier: 2, startsAt: "2026-11-10T00:00:00Z", endsAt: "2026-11-20T00:00:00Z" };
    const cfg = makeConfig({ campaign });
    const cart = { total: 250000, count: 1, codes: [] as string[] };
    const during = cartLineHtml(cfg, cart, null, false, "/cart", Date.parse("2026-11-16T00:00:00Z"));
    expect(during).toContain("5,000 points");
    expect(during).toContain("11.11: 2x points on this order.");
    const after = cartLineHtml(cfg, cart, null, false, "/cart", Date.parse("2026-11-21T00:00:00Z"));
    expect(after).toContain("2,500 points");
    expect(after).not.toContain("11.11");
  });
});
