// Wiring tests for app/widget/core.ts: the real module is executed against a
// page stand-in, with fetch, storage and timers under the test's control.
//
// Neither jsdom nor happy-dom is installed in this repo, so (like
// cart-line.test.ts) this uses a small hand-written DOM that implements only
// what core.ts touches. It checks requests, storage and the wiring between
// elements; it does not check layout or real browser parsing.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { CACHE_TTL_MS, type BootData, type Config, type LoyaltyApi } from "./shared";
import { makeConfig, makeMember } from "./test-fixtures";

type Listener = (e: unknown) => void;

class FakeEl {
  children: FakeEl[] = [];
  parentNode: FakeEl | null = null;
  attrs: Record<string, string> = {};
  listeners: Record<string, Listener[]> = {};
  className = "";
  id = "";
  textContent = "";
  innerHTML = "";
  hidden = false;
  src = "";
  async = false;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public tagName = "div") {}
  setAttribute(k: string, v: string) { this.attrs[k] = String(v); }
  getAttribute(k: string) { return k in this.attrs ? this.attrs[k] : null; }
  removeAttribute(k: string) { delete this.attrs[k]; }
  hasAttribute(k: string) { return k in this.attrs; }
  addEventListener(type: string, fn: Listener) { (this.listeners[type] = this.listeners[type] || []).push(fn); }
  appendChild(n: FakeEl) { n.parentNode = this; this.children.push(n); return n; }
  remove() { if (this.parentNode) { const p = this.parentNode; p.children.splice(p.children.indexOf(this), 1); this.parentNode = null; } }
  matches(sel: string): boolean {
    if (sel.charAt(0) === ".") return this.className.split(" ").indexOf(sel.slice(1)) >= 0;
    if (sel.charAt(0) === "[") return this.hasAttribute(sel.slice(1, -1));
    return this.tagName === sel;
  }
  closest(sel: string): FakeEl | null {
    for (let e: FakeEl | null = this; e; e = e.parentNode) if (e.matches(sel)) return e;
    return null;
  }
  walk(out: FakeEl[] = []): FakeEl[] { for (const c of this.children) { out.push(c); c.walk(out); } return out; }
  querySelector(sel: string): FakeEl | null { return this.walk().find((e) => e.matches(sel)) || null; }
  querySelectorAll(sel: string): FakeEl[] { return this.walk().filter((e) => e.matches(sel)); }
}

class FakeStorage {
  map = new Map<string, string>();
  get length() { return this.map.size; }
  key(i: number) { return Array.from(this.map.keys())[i] ?? null; }
  getItem(k: string) { return this.map.has(k) ? (this.map.get(k) as string) : null; }
  setItem(k: string, v: string) { this.map.set(k, String(v)); }
  removeItem(k: string) { this.map.delete(k); }
}

type Reply = { status?: number; body?: unknown; fail?: boolean };
type Page = {
  api: () => LoyaltyApi | undefined;
  head: FakeEl;
  body: FakeEl;
  launcher: FakeEl;
  label: FakeEl;
  location: { hash: string; pathname: string; search: string; origin: string; href: string };
  fetch: ReturnType<typeof vi.fn>;
  /** Requests to the app (through the proxy), as "METHOD path". */
  proxyCalls: () => string[];
  bodies: () => unknown[];
  click: (el: FakeEl) => void;
  fireLoad: () => void;
  scripts: () => FakeEl[];
};

const HUB_URL = "https://cdn.shopify.com/extensions/x/assets/hg-hub.js";
const session = new FakeStorage();
const local = new FakeStorage();

/** Builds the page the embed prints, then runs core.ts in it. */
async function boot(opts: { customerId?: string | null; search?: string; replies?: Record<string, Reply | (() => Reply)>; readyState?: string; config?: Partial<Config> | Record<string, unknown>; earnPrice?: number } = {}): Promise<Page> {
  const data: BootData = {
    // Nudges off: these tests are about requests, not toasts.
    config: makeConfig({ nudges: { accountCreation: false, pointsSpending: true, rewardUsage: true, tierProgress: false, goldWithin: 5000, diamondWithin: 10000 }, ...(opts.config as Partial<Config>) }),
    customer: opts.customerId ? { id: opts.customerId } : null,
    page: "index",
    urls: { login: "/customer_authentication/login", hub: HUB_URL, rewards: "/pages/rewards", shop: "/collections/all" },
    cart: { total: 0, count: 0, codes: [] },
  };
  const head = new FakeEl("head");
  const body = new FakeEl("body");
  const dataNode = Object.assign(new FakeEl("script"), { id: "hg-loyalty-data", textContent: JSON.stringify(data) });
  const launcher = Object.assign(new FakeEl("button"), { id: "hg-launcher", className: "hg-launcher" });
  launcher.setAttribute("data-hg-open", "");
  const label = Object.assign(new FakeEl("span"), { className: "hg-launcher__label", textContent: "Rewards" });
  launcher.appendChild(label);
  body.appendChild(dataNode);
  body.appendChild(launcher);
  if (opts.earnPrice !== undefined) {
    // The product block's "Earn N points" line (product-points.liquid).
    const earn = new FakeEl("div");
    earn.setAttribute("data-hg-earn", "");
    earn.setAttribute("data-price", String(opts.earnPrice));
    earn.hidden = true;
    const pts = new FakeEl("span");
    pts.setAttribute("data-hg-earn-pts", "");
    earn.appendChild(pts);
    body.appendChild(earn);
  }

  const docListeners: Record<string, Listener[]> = {};
  const winListeners: Record<string, Listener[]> = {};
  const all = () => [head, ...head.walk(), body, ...body.walk()];
  const document = {
    head,
    body,
    readyState: opts.readyState ?? "loading",
    getElementById: (id: string) => all().find((e) => e.id === id) || null,
    createElement: (tag: string) => new FakeEl(tag),
    querySelector: (sel: string) => all().find((e) => e.matches(sel)) || null,
    querySelectorAll: (sel: string) => all().filter((e) => e.matches(sel)),
    addEventListener: (t: string, fn: Listener) => void (docListeners[t] = docListeners[t] || []).push(fn),
    contains: (e: FakeEl) => all().indexOf(e) >= 0,
  };
  const location = { hash: "", pathname: "/", search: opts.search ?? "", origin: "https://heygirl.pk", href: "https://heygirl.pk/" + (opts.search ?? "") };
  const window = {
    sessionStorage: session,
    localStorage: local,
    location,
    addEventListener: (t: string, fn: Listener) => void (winListeners[t] = winListeners[t] || []).push(fn),
  } as Record<string, unknown>;

  const replies = opts.replies ?? {};
  const fetchMock = vi.fn((url: string, init?: { method?: string; body?: string }) => {
    const path = String(url).replace("/apps/loyalty", "");
    const r = replies[path];
    const reply: Reply = typeof r === "function" ? r() : r ?? { status: 404, body: null };
    void init;
    if (reply.fail) return Promise.reject(new Error("network"));
    const status = reply.status ?? 200;
    return Promise.resolve({ ok: status >= 200 && status < 300, status, json: () => Promise.resolve(reply.body) });
  });

  vi.stubGlobal("window", window);
  vi.stubGlobal("document", document);
  vi.stubGlobal("Element", FakeEl);
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("__HG_LINE_CSS__", ".hg-line{}");
  vi.resetModules();
  await import("./core");

  const appCalls = () => fetchMock.mock.calls.filter((c) => String(c[0]).indexOf("/apps/loyalty") === 0);
  return {
    api: () => window.HGLoyalty as LoyaltyApi | undefined,
    head,
    body,
    launcher,
    label,
    location,
    fetch: fetchMock,
    proxyCalls: () => appCalls().map((c) => `${(c[1] && (c[1] as { method?: string }).method) || "GET"} ${String(c[0]).replace("/apps/loyalty", "")}`),
    bodies: () => appCalls().filter((c) => c[1] && (c[1] as { body?: string }).body).map((c) => JSON.parse((c[1] as { body: string }).body) as unknown),
    click: (el: FakeEl) => { for (const fn of docListeners.click || []) fn({ target: el, preventDefault: () => undefined }); },
    fireLoad: () => { for (const fn of winListeners.load || []) fn({}); },
    scripts: () => head.children.filter((c) => c.tagName === "script"),
  };
}

/** Lets the idle callback (setTimeout fallback), promise chains and later timers run. */
const settle = (ms = 10000) => vi.advanceTimersByTimeAsync(ms);

const MEMBER = makeMember({ pointsBalance: 4500 });
const REF_KEY = "hg_pending_ref";
const storedRef = () => JSON.parse(local.getItem(REF_KEY) || "null") as { s: string; t: number; n: number } | null;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-17T06:00:00Z"));
  session.map.clear();
  local.map.clear();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("core.ts wiring: guests", () => {
  it("a guest page load makes no request at all (nothing to the app proxy, nothing else)", async () => {
    const p = await boot({ customerId: null });
    expect(p.api()).toBeDefined(); // the script did run
    p.fireLoad();
    await settle(60000);
    expect(p.proxyCalls()).toEqual([]);
    expect(p.fetch).not.toHaveBeenCalled();
    expect(p.scripts()).toHaveLength(0); // the hub bundle is not loaded either
    expect(p.label.textContent).toBe("Rewards");
    expect(await p.api()!.member()).toBeNull();
    expect(p.fetch).not.toHaveBeenCalled();
  });

  it("a guest arriving with ?ref= only remembers the slug: still no request", async () => {
    const p = await boot({ customerId: null, search: "?ref=aisha-1234" });
    p.fireLoad();
    await settle(60000);
    expect(storedRef()).toMatchObject({ s: "aisha-1234", n: 0 });
    expect(p.fetch).not.toHaveBeenCalled();
  });

  it("does nothing when the embed printed no config", async () => {
    const p = await boot({ customerId: null });
    expect(p.head.children.some((c) => c.id === "hg-line-css")).toBe(true); // sanity: normal boot injects the line CSS once
    vi.stubGlobal("document", { getElementById: () => null });
    vi.stubGlobal("window", {});
    vi.resetModules();
    await import("./core");
    expect((globalThis as unknown as { window: { HGLoyalty?: unknown } }).window.HGLoyalty).toBeUndefined();
  });
});

describe("core.ts wiring: signed-in member data", () => {
  const replies = { "/customer": { body: MEMBER } };

  it("asks /customer exactly once, only after the page has loaded", async () => {
    const p = await boot({ customerId: "42", replies });
    await settle(60000);
    expect(p.fetch).not.toHaveBeenCalled(); // before the load event: nothing
    p.fireLoad();
    await settle();
    expect(p.proxyCalls()).toEqual(["GET /customer"]);
    expect(p.label.textContent).toBe("4,500 pts");
    expect(p.launcher.getAttribute("aria-label")).toBe("4,500 pts: open HeyGirl Rewards");
    // Later reads in the same page come from the cache.
    expect((await p.api()!.member())!.member.pointsBalance).toBe(4500);
    await settle(60000);
    expect(p.proxyCalls()).toEqual(["GET /customer"]);
  });

  it("a second page within five minutes uses the cache: no request, label painted at once", async () => {
    const first = await boot({ customerId: "42", replies });
    first.fireLoad();
    await settle();
    expect(first.proxyCalls()).toEqual(["GET /customer"]);

    vi.setSystemTime(Date.now() + CACHE_TTL_MS - 60000); // four minutes later, next page
    const second = await boot({ customerId: "42", replies });
    expect(second.label.textContent).toBe("4,500 pts"); // painted before load, from sessionStorage
    second.fireLoad();
    await settle(30000);
    expect(second.fetch).not.toHaveBeenCalled();
  });

  it("after five minutes the next page asks again, once", async () => {
    const first = await boot({ customerId: "42", replies });
    first.fireLoad();
    await settle();
    vi.setSystemTime(Date.now() + CACHE_TTL_MS + 60000);
    const later = await boot({ customerId: "42", replies });
    expect(later.label.textContent).toBe("Rewards"); // stale cache is not painted
    later.fireLoad();
    await settle();
    expect(later.proxyCalls()).toEqual(["GET /customer"]);
  });

  it("a failed request is not cached, and another customer's cache is dropped", async () => {
    const bad = await boot({ customerId: "42", replies: { "/customer": { status: 500, body: null } } });
    bad.fireLoad();
    await settle();
    expect(bad.proxyCalls()).toEqual(["GET /customer"]);
    expect(bad.api()!.state()).toBe("error");
    expect(session.getItem("hg_m:42")).toBeNull();

    const ok = await boot({ customerId: "42", replies });
    ok.fireLoad();
    await settle();
    expect(session.getItem("hg_m:42")).not.toBeNull();
    const other = await boot({ customerId: "77", replies });
    expect(session.getItem("hg_m:42")).toBeNull(); // account switch
    other.fireLoad();
    await settle();
    expect(other.proxyCalls()).toEqual(["GET /customer"]);
  });

  it("runs straight away when the page had already finished loading", async () => {
    const p = await boot({ customerId: "42", replies, readyState: "complete" });
    await settle();
    expect(p.proxyCalls()).toEqual(["GET /customer"]);
  });
});

describe("core.ts wiring: launcher and hub bundle", () => {
  it("the first tap on the launcher loads the hub script once and opens it", async () => {
    const p = await boot({ customerId: null });
    expect(p.scripts()).toHaveLength(0);
    p.click(p.label); // a tap on the label inside the launcher counts
    expect(p.scripts()).toHaveLength(1);
    const s = p.scripts()[0];
    expect(s.src).toBe(HUB_URL);
    expect(s.async).toBe(true);
    expect(p.launcher.getAttribute("aria-busy")).toBe("true");

    const hub = vi.fn();
    p.api()!._hub = hub; // what hg-hub.js does when it runs
    s.onload!();
    await settle(0);
    expect(hub).toHaveBeenCalledTimes(1);
    expect(hub).toHaveBeenCalledWith("", p.launcher);
    expect(p.launcher.getAttribute("aria-busy")).toBeNull();

    p.click(p.launcher);
    await settle(0);
    expect(p.scripts()).toHaveLength(1); // not loaded twice
    expect(hub).toHaveBeenCalledTimes(2);
    expect(p.fetch).not.toHaveBeenCalled(); // opening as a guest still asks the app nothing
  });

  it("other [data-hg-open] controls open their own screen; unrelated clicks do nothing", async () => {
    const p = await boot({ customerId: null });
    const other = new FakeEl("button");
    other.setAttribute("data-hg-open", "tiers");
    p.body.appendChild(other);
    const plain = new FakeEl("a");
    p.body.appendChild(plain);
    p.click(plain);
    expect(p.scripts()).toHaveLength(0);
    const hub = vi.fn();
    p.api()!._hub = hub;
    p.click(other);
    p.scripts()[0].onload!();
    await settle(0);
    expect(hub).toHaveBeenCalledWith("tiers", other);
  });

  it("a #hg-rewards deep link opens the hub on load", async () => {
    const p = await boot({ customerId: null });
    p.location.hash = "#hg-rewards-earn";
    const hub = vi.fn();
    p.api()!._hub = hub;
    p.fireLoad();
    expect(p.scripts()).toHaveLength(1);
    p.scripts()[0].onload!();
    await settle(0);
    expect(hub).toHaveBeenCalledWith("earn", p.launcher);
  });

  it("if the hub script cannot load, the shopper is sent to the rewards page and a later tap retries", async () => {
    const p = await boot({ customerId: null });
    p.click(p.launcher);
    p.scripts()[0].onerror!();
    await settle(0);
    expect(p.location.href).toBe("/pages/rewards");
    expect(p.launcher.getAttribute("aria-busy")).toBeNull();
    p.click(p.launcher);
    expect(p.scripts()).toHaveLength(2);
  });
});

describe("core.ts wiring: opening the panel asks for fresh member data (owner, 18 Nov 2026)", () => {
  const FRESH = makeMember({ pointsBalance: 5200 });
  const cachedBalance = () => (JSON.parse(session.getItem("hg_m:42") || "null") as { d: { member: { pointsBalance: number } } } | null)?.d.member.pointsBalance;

  /** First page caches 4,500; the next page, two minutes later, is inside the five-minute window. */
  async function secondPage(reply: Reply | (() => Reply), extra: { hash?: string } = {}) {
    const first = await boot({ customerId: "42", replies: { "/customer": { body: MEMBER } } });
    first.fireLoad();
    await settle();
    expect(first.proxyCalls()).toEqual(["GET /customer"]);
    vi.setSystemTime(Date.now() + 2 * 60000);
    const p = await boot({ customerId: "42", replies: { "/customer": reply } });
    if (extra.hash) p.location.hash = extra.hash;
    expect(p.label.textContent).toBe("4,500 pts"); // painted from the cache
    return p;
  }

  it("a page load inside the window still uses the cache; a launcher tap then asks once, afresh, and updates label, cache and panel", async () => {
    const p = await secondPage({ body: FRESH });
    p.fireLoad();
    await settle(30000);
    expect(p.fetch).not.toHaveBeenCalled(); // store speed: page loads keep the 5-minute cache
    const upd = vi.fn();
    p.api()!._upd = upd; // what hg-hub.js registers
    p.click(p.launcher);
    expect(p.proxyCalls()).toEqual(["GET /customer"]);
    expect(p.api()!.cached()!.member.pointsBalance).toBe(4500); // held data is there for the panel meanwhile
    await settle(0);
    expect(p.label.textContent).toBe("5,200 pts");
    expect(p.launcher.getAttribute("aria-label")).toBe("5,200 pts: open HeyGirl Rewards");
    expect(cachedBalance()).toBe(5200);
    expect(upd).toHaveBeenCalledTimes(1);
    expect(upd.mock.calls[0][0].member.pointsBalance).toBe(5200);
    // Later reads on this page come from the refreshed cache.
    expect((await p.api()!.member())!.member.pointsBalance).toBe(5200);
    await settle(30000);
    expect(p.proxyCalls()).toEqual(["GET /customer"]);
  });

  it("every open asks again (any [data-hg-open] control and the #hg-rewards deep link too)", async () => {
    const p = await secondPage({ body: FRESH }, { hash: "#hg-rewards-earn" });
    p.fireLoad(); // the deep link opens the panel on load
    expect(p.proxyCalls()).toEqual(["GET /customer"]);
    await settle(30000);
    expect(p.proxyCalls()).toEqual(["GET /customer"]); // the idle page load used the fresh cache
    const other = new FakeEl("a");
    other.setAttribute("data-hg-open", "tiers");
    p.body.appendChild(other);
    p.click(other);
    await settle(0);
    expect(p.proxyCalls()).toEqual(["GET /customer", "GET /customer"]);
    p.click(p.launcher);
    await settle(0);
    expect(p.proxyCalls()).toEqual(["GET /customer", "GET /customer", "GET /customer"]);
  });

  it("opening twice quickly sends one request", async () => {
    const p = await secondPage({ body: FRESH });
    p.click(p.launcher);
    p.click(p.launcher);
    const other = new FakeEl("button");
    other.setAttribute("data-hg-open", "earn");
    p.body.appendChild(other);
    p.click(other);
    await settle(0);
    expect(p.proxyCalls()).toEqual(["GET /customer"]);
    expect(p.label.textContent).toBe("5,200 pts");
  });

  it("the tap that closes an open panel asks nothing", async () => {
    const p = await secondPage({ body: FRESH });
    const panel = Object.assign(new FakeEl("div"), { className: "hg-hub hg-hub--open" });
    p.body.appendChild(panel);
    p.click(p.launcher);
    await settle(0);
    expect(p.fetch).not.toHaveBeenCalled();
    expect(p.label.textContent).toBe("4,500 pts");
  });

  it.each([
    ["a 500", { status: 500, body: null }],
    ["a network failure", { fail: true }],
    ["an unreadable reply", { body: { nope: 1 } }],
  ] as Array<[string, Reply]>)("a failed fresh request (%s) keeps the cached data, silently", async (_name, reply) => {
    const p = await secondPage(reply);
    const upd = vi.fn();
    p.api()!._upd = upd;
    p.click(p.launcher);
    const got = await p.api()!.member(true); // shares the request the open started
    await settle(0);
    expect(p.proxyCalls()).toEqual(["GET /customer"]);
    expect(got!.member.pointsBalance).toBe(4500);
    expect(p.api()!.cached()!.member.pointsBalance).toBe(4500);
    expect(p.api()!.state()).toBe("");
    expect(p.label.textContent).toBe("4,500 pts");
    expect(cachedBalance()).toBe(4500); // the cache entry is kept
    expect(upd).not.toHaveBeenCalled();
    expect(p.body.querySelector(".hg-toast")).toBeNull();
  });

  it("guests opening the panel by any route make no request", async () => {
    const p = await boot({ customerId: null });
    p.location.hash = "#hg-rewards";
    p.fireLoad();
    p.click(p.launcher);
    const other = new FakeEl("button");
    other.setAttribute("data-hg-open", "redeem");
    p.body.appendChild(other);
    p.click(other);
    await settle(60000);
    expect(p.fetch).not.toHaveBeenCalled();
    expect(p.api()!.cached()).toBeNull();
  });
});

describe("core.ts wiring: referral slug", () => {
  const withRef = (referral: Reply | (() => Reply)) => ({ customerId: "42", search: "?ref=sana-5678", replies: { "/customer": { body: MEMBER }, "/referral": referral } });

  it("is sent once the member is known, with the slug from the link", async () => {
    const p = await boot(withRef({ body: { ok: true, status: "recorded" } }));
    expect(p.fetch).not.toHaveBeenCalled();
    p.fireLoad();
    await settle();
    expect(p.proxyCalls()).toEqual(["GET /customer", "POST /referral"]);
    expect(p.bodies()).toEqual([{ slug: "sana-5678" }]);
  });

  it.each([
    ["a 503 from the server", { status: 503, body: { ok: false, error: "server_error" } }],
    ["a 429 rate limit", { status: 429, body: { ok: false, error: "rate_limited" } }],
    ["a network failure", { fail: true }],
    ["try_again", { body: { ok: false, status: "try_again" } }],
    ["an older server's program_disabled", { body: { ok: false, error: "program_disabled" } }],
    ["an unreadable reply", { body: null }],
  ] as Array<[string, Reply]>)("is kept after a temporary error: %s", async (_name, reply) => {
    const p = await boot(withRef(reply));
    p.fireLoad();
    await settle();
    expect(p.proxyCalls()).toContain("POST /referral");
    expect(storedRef()).toMatchObject({ s: "sana-5678", n: 1 }); // kept, one try counted
    expect(p.body.querySelector(".hg-toast")).toBeNull();
  });

  it.each([
    ["recorded", { body: { ok: true, status: "recorded" } }],
    ["not_eligible", { body: { ok: false, status: "not_eligible" } }],
    ["self_referral", { body: { ok: false, error: "self_referral" } }],
    ["invalid_slug (400)", { status: 400, body: { ok: false, error: "invalid_slug" } }],
  ] as Array<[string, Reply]>)("is cleared after a final answer: %s", async (_name, reply) => {
    const p = await boot(withRef(reply));
    p.fireLoad();
    await settle();
    expect(p.proxyCalls()).toContain("POST /referral");
    expect(local.getItem(REF_KEY)).toBeNull();
  });

  it("a kept slug is retried on the next page (no ?ref= needed) and cleared when the answer is final", async () => {
    const first = await boot(withRef({ status: 503, body: null }));
    first.fireLoad();
    await settle();
    expect(storedRef()).toMatchObject({ s: "sana-5678", n: 1 });

    const next = await boot({ customerId: "42", replies: { "/customer": { body: MEMBER }, "/referral": { body: { ok: true, status: "recorded", friendCode: "FRIEND-AB12" } } } });
    next.fireLoad();
    await settle(2000);
    expect(next.bodies()).toEqual([{ slug: "sana-5678" }]);
    expect(local.getItem(REF_KEY)).toBeNull();
    // The friend's free-shipping code is announced.
    const toast = next.body.querySelector(".hg-toast");
    expect(toast).not.toBeNull();
    expect(toast!.innerHTML).toContain("FRIEND-AB12");
  });

  it("is not sent while the member is unknown, and stays stored", async () => {
    const p = await boot({ customerId: "42", search: "?ref=sana-5678", replies: { "/customer": { body: { state: "not_enrolled" } } } });
    p.fireLoad();
    await settle();
    expect(p.proxyCalls()).toEqual(["GET /customer"]);
    expect(storedRef()).toMatchObject({ s: "sana-5678", n: 0 });
  });
});

describe("rule 20: redeeming paused keeps the storefront on", () => {
  it("the launcher, member data and product line work with redeemPaused, even from a config an older admin published with enabled false", async () => {
    const p = await boot({ customerId: "42", replies: { "/customer": { body: MEMBER } }, config: { enabled: false, redeemPaused: true }, earnPrice: 300000 });
    expect(p.api()).toBeDefined();
    const earn = p.body.querySelector("[data-hg-earn]")!;
    expect(earn.hidden).toBe(false);
    expect(earn.querySelector("[data-hg-earn-pts]")!.textContent).toBe("3,000");
    p.fireLoad();
    await settle();
    expect(p.proxyCalls()).toEqual(["GET /customer"]);
    expect(p.label.textContent).toBe("4,500 pts");
  });

  it("a cached 'paused' answer from before the change is not used: the member is asked for again", async () => {
    session.setItem("hg_m:42", JSON.stringify({ t: Date.now(), d: { member: null, state: "paused" } }));
    const p = await boot({ customerId: "42", replies: { "/customer": { body: MEMBER } } });
    p.fireLoad();
    await settle();
    expect(p.proxyCalls()).toEqual(["GET /customer"]);
    expect(p.api()!.state()).toBe("");
    expect(p.label.textContent).toBe("4,500 pts");
  });

  it("guests still make no request while redeeming is paused", async () => {
    const p = await boot({ customerId: null, config: { redeemPaused: true } });
    p.fireLoad();
    await settle(60000);
    expect(p.fetch).not.toHaveBeenCalled();
  });
});

describe("guest join nudge follows the panel style (owner, 18 Nov 2026)", () => {
  const nudgeOn = { accountCreation: true, pointsSpending: true, rewardUsage: true, tierProgress: false, goldWithin: 5000, diamondWithin: 10000 };

  it.each([
    ["dark", "hg-toast hg-toast--dark"],
    ["light", "hg-toast"],
  ] as const)("%s panel style: the toast gets class %s, and still no request to the app", async (panelTheme, cls) => {
    const p = await boot({ customerId: null, config: { panelTheme, nudges: nudgeOn } });
    p.fireLoad();
    await settle(10000);
    const toast = p.body.querySelector(".hg-toast");
    expect(toast).not.toBeNull();
    expect(toast!.className).toBe(cls);
    expect(toast!.innerHTML).toContain("Join HeyGirl Rewards");
    expect(p.fetch).not.toHaveBeenCalled();
  });
});
