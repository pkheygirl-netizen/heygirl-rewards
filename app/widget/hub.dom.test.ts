// Wiring tests for app/widget/hub.ts: how the open panel takes fresh member
// data from core (owner, 18 Nov 2026: every open asks /customer afresh).
//
// Neither jsdom nor happy-dom is installed, so this uses a small stand-in DOM:
// innerHTML is stored as a string (not parsed), and the panel's fixed parts
// (body, tabs, title...) are handed out by selector. It checks what is written
// into the panel body, its scroll position and focus; not layout or parsing.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { BootData, LoyaltyApi, MemberData, MemberState } from "./shared";
import { makeConfig, makeMember } from "./test-fixtures";

type Listener = (e: unknown) => void;
let activeElement: El | null = null;

class El {
  children: El[] = [];
  parentNode: El | null = null;
  attrs: Record<string, string> = {};
  listeners: Record<string, Listener[]> = {};
  slots: Record<string, El> = {};
  className = "";
  id = "";
  textContent = "";
  hidden = false;
  tabIndex = 0;
  scrollTop = 0;
  offsetWidth = 0;
  /** Distance from the top of the page, for getBoundingClientRect(). */
  rectTop = 0;
  style: Record<string, string> = {};
  htmlWrites = 0;
  private html = "";
  constructor(public tagName = "div") {}
  get innerHTML() { return this.html; }
  set innerHTML(v: string) {
    this.html = v;
    this.htmlWrites++;
    for (const c of this.children) c.parentNode = null;
    this.children = []; // a real browser drops the old nodes too
  }
  get classList() {
    return {
      add: (c: string) => { if (!this.classList.contains(c)) this.className = (this.className + " " + c).trim(); },
      remove: (c: string) => { this.className = this.className.split(" ").filter((x) => x !== c).join(" "); },
      contains: (c: string) => this.className.split(" ").indexOf(c) >= 0,
    };
  }
  get firstChild() { return new El("svg"); }
  setAttribute(k: string, v: string) { this.attrs[k] = String(v); }
  getAttribute(k: string) { return k in this.attrs ? this.attrs[k] : null; }
  removeAttribute(k: string) { delete this.attrs[k]; }
  addEventListener(t: string, fn: Listener) { (this.listeners[t] = this.listeners[t] || []).push(fn); }
  appendChild(n: El) { n.parentNode = this; this.children.push(n); return n; }
  focus() { activeElement = this; }
  scrollCalls: Array<{ top: number; behavior?: string }> = [];
  scrollTo(o: { top: number; behavior?: string }) { this.scrollCalls.push(o); this.scrollTop = o.top; }
  getBoundingClientRect() { return { top: this.rectTop - (this.parentNode ? this.parentNode.scrollTop : 0) }; }
  contains(e: El | null): boolean { for (let x = e; x; x = x.parentNode) if (x === this) return true; return false; }
  closest(sel: string): El | null {
    const m = /^\[([a-z-]+)\]$/.exec(sel);
    for (let e: El | null = this; e; e = e.parentNode) if (m && m[1] in e.attrs) return e;
    return null;
  }
  /** The panel's fixed parts, one element per selector. */
  querySelector(sel: string): El | null {
    if (!this.slots[sel]) this.slots[sel] = this.appendChild(new El());
    return this.slots[sel];
  }
  querySelectorAll(): El[] { return []; }
}

type Harness = {
  api: LoyaltyApi;
  panel: () => El; // #hg-hub
  body: () => El; // .hg-hub__body
  setHeld: (d: MemberData | null) => void;
  clickTab: (key: string) => void;
  clickAct: (act: string) => void;
};

const HELD = makeMember({ pointsBalance: 4500 });

async function load(opts: { held?: MemberData | null; member?: () => Promise<MemberData | null>; state?: MemberState; guest?: boolean } = {}): Promise<Harness> {
  let held: MemberData | null = opts.held === undefined ? HELD : opts.held;
  const data: BootData = {
    config: makeConfig(),
    customer: opts.guest ? null : { id: "42" },
    page: "index",
    urls: { login: "/customer_authentication/login", hub: "", rewards: "/pages/rewards", shop: "/collections/all" },
    cart: { total: 0, count: 0, codes: [] },
  };
  const head = new El("head");
  const docBody = new El("body");
  const launcher = Object.assign(new El("button"), { id: "hg-launcher" });
  docBody.appendChild(launcher);
  activeElement = null;
  const document = {
    head,
    body: docBody,
    get activeElement() { return activeElement; },
    createElement: (t: string) => new El(t),
    getElementById: (id: string) => (id === "hg-launcher" ? launcher : null),
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    contains: (e: El) => docBody.contains(e),
  };
  const api: LoyaltyApi = {
    data,
    // Core's answer: the held data (cache), or the shared fresh request.
    member: vi.fn(opts.member ?? (() => Promise.resolve(held))),
    cached: () => held,
    state: () => opts.state ?? "",
    invalidate: vi.fn(),
    open: vi.fn(),
  };
  vi.stubGlobal("window", { HGLoyalty: api, location: { pathname: "/", search: "", origin: "https://heygirl.pk" } });
  vi.stubGlobal("document", document);
  vi.stubGlobal("Element", El);
  vi.resetModules();
  await import("./hub");
  const panel = () => docBody.children.find((c) => c.id === "hg-hub") as El;
  return {
    api,
    panel,
    body: () => panel().querySelector(".hg-hub__body") as El,
    setHeld: (d) => { held = d; },
    clickTab: (key) => {
      const t = new El("button");
      t.setAttribute("data-tab", key);
      for (const fn of panel().listeners.click || []) fn({ target: t });
    },
    clickAct: (act) => {
      const b = new El("button");
      b.setAttribute("data-act", act);
      for (const fn of panel().listeners.click || []) fn({ target: b });
    },
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => { activeElement = null; });
afterEach(() => { vi.unstubAllGlobals(); });

describe("hub.ts: fresh member data on every open", () => {
  it("shows the held (cached) data at once: no Loading screen", async () => {
    const h = await load();
    h.api._hub!("", null);
    expect(h.body().innerHTML).toContain("4,500 <span>points</span>");
    expect(h.body().innerHTML).not.toContain("Loading");
    expect(typeof h.api._upd).toBe("function");
  });

  it("swaps in fresh data on the same tab and at the same scroll position", async () => {
    const h = await load();
    h.api._hub!("", null);
    await flush();
    h.body().scrollTop = 240;
    h.api._upd!(makeMember({ pointsBalance: 5200 }));
    expect(h.body().innerHTML).toContain("5,200 <span>points</span>");
    expect(h.body().getAttribute("aria-labelledby")).toBe("hg-tab-rewards");
    expect(h.body().scrollTop).toBe(240);

    // On another tab the tab is kept too.
    h.clickTab("earn");
    expect(h.body().getAttribute("aria-labelledby")).toBe("hg-tab-earn");
    h.body().scrollTop = 90;
    h.api._upd!(makeMember({ pointsBalance: 5200, tier: "gold", lifetimeSpendPkr: 60000 }));
    expect(h.body().getAttribute("aria-labelledby")).toBe("hg-tab-earn");
    expect(h.body().scrollTop).toBe(90);
  });

  it("does not repaint when the fresh data is the same (no flicker)", async () => {
    const h = await load();
    h.api._hub!("", null);
    await flush();
    const writes = h.body().htmlWrites;
    h.body().scrollTop = 120;
    h.api._upd!(JSON.parse(JSON.stringify(HELD)) as MemberData); // a new object, same content
    expect(h.body().htmlWrites).toBe(writes);
    expect(h.body().scrollTop).toBe(120);
  });

  it("a failed refresh (core answers with the held data) changes nothing", async () => {
    const h = await load();
    h.api._hub!("", null);
    const writes = h.body().htmlWrites;
    await flush(); // api.member() resolved with the held object
    expect(h.body().htmlWrites).toBe(writes);
    expect(h.body().innerHTML).toContain("4,500 <span>points</span>");
  });

  it("keeps keyboard focus in the panel when a repaint replaces the focused control", async () => {
    const h = await load();
    h.api._hub!("", null);
    await flush();
    const btn = h.body().appendChild(new El("button"));
    btn.focus();
    h.api._upd!(makeMember({ pointsBalance: 5200 }));
    expect(activeElement).toBe(h.panel());
  });

  it("with nothing held, shows Loading and then the fresh data", async () => {
    let resolve: (d: MemberData | null) => void = () => undefined;
    const h = await load({ held: null, member: () => new Promise((r) => { resolve = r; }) });
    h.api._hub!("earn", null);
    expect(h.body().innerHTML).toContain("Loading your rewards");
    h.api._upd!(makeMember({ pointsBalance: 5200 }));
    expect(h.body().getAttribute("aria-labelledby")).toBe("hg-tab-earn"); // the tab that was asked for
    resolve(null);
    await flush();
    expect(h.body().getAttribute("aria-labelledby")).toBe("hg-tab-earn");
  });

  it("with nothing held and a failed request, says it could not load (as before)", async () => {
    const h = await load({ held: null, state: "error" });
    h.api._hub!("", null);
    await flush();
    expect(h.body().innerHTML).toContain("We could not load your rewards");
  });

  it("data arriving while the panel is closed is kept, not painted", async () => {
    const h = await load();
    h.api._hub!("", null);
    await flush();
    h.api._hub!("", document.getElementById("hg-launcher") as unknown as HTMLElement); // launcher tap closes it
    const writes = h.body().htmlWrites;
    h.api._upd!(makeMember({ pointsBalance: 5200 }));
    expect(h.body().htmlWrites).toBe(writes);
    h.setHeld(null); // core holds nothing now: the panel uses what it was given
    h.api._hub!("", null);
    expect(h.body().innerHTML).toContain("5,200 <span>points</span>");
  });
  it("History is read again on every open, so new rows show without a page refresh", async () => {
    const h = await load();
    const fetchMock = vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve({ rows: [], hasMore: false, page: 1, total: 0 }) }));
    vi.stubGlobal("fetch", fetchMock);
    const historyCalls = () => (fetchMock.mock.calls as unknown as Array<[string]>).filter((c) => String(c[0]).indexOf("/history") >= 0).length;
    h.api._hub!("history", null);
    await flush();
    expect(historyCalls()).toBe(1);
    h.api._hub!("", document.getElementById("hg-launcher") as unknown as HTMLElement); // close
    h.api._hub!("history", null); // reopen on the same page
    await flush();
    expect(historyCalls()).toBe(2);
  });
});

describe("hub.ts: panel v5 tabs (owner, 19 Nov 2026)", () => {
  /** The tier section inside the body, placed `top` px below the top of the body's content. */
  const tiersAt = (h: Harness, top: number) => {
    const t = h.body().querySelector("#hg-tiers") as El;
    t.rectTop = top;
    return t;
  };

  it("member tabs are exactly Rewards, Refer & Earn, Shop & Earn, History (no VIP tiers tab)", async () => {
    const h = await load();
    h.api._hub!("", null);
    const html = h.panel().innerHTML;
    const tabs = [...html.matchAll(/<button type="button" class="hg-tab" role="tab" id="hg-tab-([a-z]+)"[^>]*>([^<]*)<\/button>/g)].map((m) => [m[1], m[2]]);
    expect(tabs).toEqual([["rewards", "Rewards"], ["refer", "Refer &amp; Earn"], ["earn", "Shop &amp; Earn"], ["history", "History"]]);
    expect(html).not.toContain("VIP tiers");
    expect(html).not.toContain("hg-tab-tiers");
  });

  it("a \"tiers\" target (#hg-rewards-tiers, the level nudge) opens Rewards scrolled to the other levels at once", async () => {
    const h = await load();
    h.api._hub!("", null); // builds the panel
    h.api._hub!("", document.getElementById("hg-launcher") as unknown as HTMLElement); // close
    tiersAt(h, 900);
    h.api._hub!("tiers", null);
    expect(h.body().getAttribute("aria-labelledby")).toBe("hg-tab-rewards");
    expect(h.body().innerHTML).toContain('id="hg-tiers"');
    expect(h.body().scrollTop).toBe(892); // 8px above the section
    expect(h.body().scrollCalls).toEqual([]); // a jump on open, not an animation
    // Fresh data keeps that position; a later plain open starts at the top.
    await flush();
    h.api._upd!(makeMember({ pointsBalance: 5200 }));
    expect(h.body().scrollTop).toBe(892);
    h.api._hub!("", document.getElementById("hg-launcher") as unknown as HTMLElement); // close
    h.api._hub!("rewards", null);
    expect(h.body().scrollTop).toBe(0);
  });

  it("with nothing held, the scroll to the tiers happens when the data arrives (not undone by the repaint)", async () => {
    const h = await load({ held: null, member: () => new Promise(() => undefined) });
    h.api._hub!("tiers", null);
    expect(h.body().innerHTML).toContain("Loading your rewards");
    tiersAt(h, 640);
    h.api._upd!(makeMember({ pointsBalance: 5200 }));
    expect(h.body().getAttribute("aria-labelledby")).toBe("hg-tab-rewards");
    expect(h.body().scrollTop).toBe(632);
  });

  it("guests still get the VIP levels screen for a \"tiers\" target, with no request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const h = await load({ guest: true });
    h.api._hub!("tiers", null);
    expect(h.body().innerHTML).toContain("Everyone starts here.");
    expect(h.body().innerHTML).not.toContain("hg-tiers");
    expect((h.panel().querySelector(".hg-hub__title") as El).textContent).toBe("VIP levels");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(h.api.member).not.toHaveBeenCalled();
  });

  it("View all VIP perks scrolls smoothly to the other levels and moves focus to their heading", async () => {
    const h = await load();
    h.api._hub!("", null);
    tiersAt(h, 1500);
    h.clickAct("perks");
    expect(h.body().scrollCalls).toEqual([{ top: 1492, behavior: "smooth" }]);
    expect(activeElement).toBe(h.body().querySelector("#hg-tiers .hg-sec"));
  });

  it("with reduced motion asked for, the perks line jumps instead of animating", async () => {
    const h = await load();
    (window as unknown as { matchMedia: (q: string) => { matches: boolean } }).matchMedia = (q) => ({ matches: q.indexOf("reduce") >= 0 });
    h.api._hub!("", null);
    tiersAt(h, 700);
    h.clickAct("perks");
    expect(h.body().scrollCalls).toEqual([]);
    expect(h.body().scrollTop).toBe(692);
  });
});
