// app/widget/core.ts → extensions/hg-loyalty/assets/hg-core.js
// Small deferred script loaded by the app embed on every page. It wires the
// Liquid-rendered launcher, keeps the cart rewards line in place, updates the
// product "Earn N points" line, and lazy-loads the hub bundle on demand.
// Guests cause no request to the app server.
import { cartFromJson, cartLineHtml, createCartSync, ensureDrawerLine, fillCartBlock } from "./cart-line";
import { cacheKey, earnsNothing, purgeCache, readCache, readNoEarn, writeCache, writeNoEarn } from "./member-cache";
import {
  CACHE_TTL_MS,
  campaignNote,
  esc,
  fmt,
  isFinalReferralReply,
  parsePendingRef,
  pointsFor,
  PROXY,
  rs,
  tierProgress,
  TIER_NAME,
  validSlug,
  type BootData,
  type CacheEntry,
  type CartState,
  type LoyaltyApi,
  type MemberData,
  type MemberState,
} from "./shared";

// Contents of snippets/hg-line-css.liquid, inlined by scripts/build-widget.mjs.
declare const __HG_LINE_CSS__: string;

(function () {
  const w = window as unknown as { HGLoyalty?: LoyaltyApi; requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number };
  if (w.HGLoyalty) return;

  let data: BootData;
  try {
    const node = document.getElementById("hg-loyalty-data");
    if (!node) return;
    data = JSON.parse(node.textContent || "") as BootData;
  } catch {
    return;
  }
  const cfg = data.config;
  // Only a missing config turns the storefront off; the program switch only
  // pauses redeeming (rule 20, `cfg.redeemPaused`).
  if (!cfg) return;
  if (data.customer) data.customer.id = String(data.customer.id);
  data.cart.codes = (data.cart.codes || []).filter(Boolean);
  const cid = data.customer ? data.customer.id : null;

  let ss: Storage | null = null;
  let ls: Storage | null = null;
  try { ss = window.sessionStorage; } catch { /* blocked */ }
  try { ls = window.localStorage; } catch { /* blocked */ }
  if (ss) purgeCache(ss, cid); // sign-out or account switch drops old entries

  // The cart line's styles are printed once per page: by an app block when one
  // is on the page, otherwise here (the drawer line needs them everywhere).
  if (!document.getElementById("hg-line-css")) {
    const st = document.createElement("style");
    st.id = "hg-line-css";
    st.textContent = __HG_LINE_CSS__;
    document.head.appendChild(st);
  }

  const idle = (fn: () => void, timeout = 4000) => {
    if (typeof w.requestIdleCallback === "function") w.requestIdleCallback(fn, { timeout });
    else setTimeout(fn, 1200);
  };

  // ── Member data ────────────────────────────────────────────────────────────
  let member: MemberData | null = null;
  let state: MemberState = "";
  // Opted-out and blocked members earn nothing: remembered for the session so
  // "Earn N points" is hidden at once on later pages.
  let noEarn = !!(cid && ss && readNoEarn(ss, cid));
  let inflight: Promise<MemberData | null> | null = null;

  /** Applies a cached or fresh answer; returns the member payload or null. */
  function take(d: CacheEntry | null): MemberData | null {
    if (d && d.member) {
      member = d as MemberData;
      state = "";
    } else {
      member = null;
      state = d ? (d as { state: MemberState }).state || "error" : "error";
    }
    if (d && d.member) {
      const hide = earnsNothing(d);
      if (hide !== noEarn && cid && ss) writeNoEarn(ss, cid, hide);
      noEarn = hide;
    }
    return member;
  }

  function loadMember(force?: boolean): Promise<MemberData | null> {
    if (!cid) return Promise.resolve(null);
    if (!force) {
      const c = fresh(ss ? readCache(ss, cid) : null);
      if (c) return Promise.resolve(take(c));
      if (!ss && (member || state)) return Promise.resolve(member);
    }
    // One request at a time: a second open (or the idle load) shares it.
    if (inflight) return inflight;
    inflight = fetch(PROXY + "/customer", { credentials: "same-origin", headers: { Accept: "application/json" } })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: (Partial<MemberData> & { state?: string }) | null) => {
        inflight = null;
        let entry: CacheEntry | null = null;
        if (d && d.member) entry = d as MemberData;
        else if (d && d.state === "not_enrolled") entry = { member: null, state: "not_enrolled" };
        if (!entry) return failed();
        // A customer without a member row is cached too, so she is not asked
        // about again on every page. A failed request is not cached.
        if (ss) {
          const queued = !!(entry.member && (entry as MemberData).welcomeQueued);
          // A welcome bonus still in the queue: let the cache lapse within 30 s.
          writeCache(ss, cid, entry, queued ? Date.now() - CACHE_TTL_MS + 30000 : Date.now());
        }
        take(entry);
        onMember();
        if (api._upd) api._upd(member);
        return member;
      })
      .catch(() => {
        inflight = null;
        return failed();
      });
    return inflight;
  }

  /** A failed request keeps whatever is already shown (cached data), silently. */
  function failed(): MemberData | null {
    if (!member) state = "error";
    return member;
  }

  /** A cached answer still worth using: the old "paused" answer is not (rule 20 no longer hides anything). */
  function fresh(c: CacheEntry | null): CacheEntry | null {
    return c && (c.member || (c as { state?: string }).state === "not_enrolled") ? c : null;
  }

  function invalidate() {
    member = null;
    state = "";
    try { if (ss && cid) ss.removeItem(cacheKey(cid)); } catch { /* noop */ }
  }

  // ── Hub (second bundle, loaded on first open) ──────────────────────────────
  let hubLoad: Promise<void> | null = null;
  const launcher = document.getElementById("hg-launcher");

  function open(screen?: string, opener?: HTMLElement | null) {
    // Opening the panel (not the tap that closes it) always asks a signed-in
    // member's data afresh; the panel shows what is held meanwhile. Guests: no request.
    if (cid && !document.querySelector(".hg-hub--open")) void loadMember(true);
    if (!hubLoad) {
      hubLoad = new Promise<void>((resolve, reject) => {
        const s = document.createElement("script");
        s.src = data.urls.hub;
        s.async = true;
        s.onload = () => resolve();
        s.onerror = () => {
          hubLoad = null;
          reject(new Error("hub"));
        };
        document.head.appendChild(s);
      });
    }
    if (launcher) launcher.setAttribute("aria-busy", "true");
    hubLoad
      .then(() => {
        if (api._hub) api._hub(screen || "", opener || launcher);
      })
      .catch(() => {
        // The panel could not load: fall back to a normal page.
        window.location.href = data.urls.rewards || data.urls.login;
      })
      .then(() => {
        if (launcher) launcher.removeAttribute("aria-busy");
      });
  }

  const api: LoyaltyApi = {
    data,
    member: loadMember,
    state: () => state,
    invalidate: () => {
      invalidate();
      idle(() => void loadMember(true), 1500);
    },
    open,
    cached: () => member,
  };
  w.HGLoyalty = api;

  document.addEventListener("click", (e) => {
    const t = e.target instanceof Element ? (e.target.closest("[data-hg-open]") as HTMLElement | null) : null;
    if (!t) return;
    e.preventDefault();
    open(t.getAttribute("data-hg-open") || "", t);
  });

  function deepLink() {
    const m = /^#hg-rewards(?:[:/-]([a-z]+))?$/.exec(window.location.hash);
    if (m) open(m[1] || "", launcher);
  }
  window.addEventListener("hashchange", deepLink);

  // ── Launcher label ─────────────────────────────────────────────────────────
  function onMember() {
    const label = launcher && launcher.querySelector(".hg-launcher__label");
    if (label && member && !noEarn) {
      label.textContent = fmt(member.member.pointsBalance) + " pts";
      // The visible text comes first in the name (WCAG 2.5.3, label in name).
      launcher!.setAttribute("aria-label", `${label.textContent}: open ${cfg.programName}`);
    }
    updateEarn();
    renderLines();
  }

  // ── Cart rewards line (drawer + cart page block) ───────────────────────────
  let cart: CartState = data.cart;
  const drawer = document.querySelector("cart-drawer");
  const footer = document.getElementById("main-cart-footer");
  let observer: MutationObserver | null = null;

  function renderLines() {
    const path = window.location.pathname + window.location.search;
    // noEarn covers the time before member data has loaded on this page.
    const html = noEarn ? "" : cartLineHtml(cfg, cart, member, !!cid, path);
    if (drawer) ensureDrawerLine(drawer, html);
    const blocks = document.querySelectorAll("[data-hg-cart-block]");
    for (let i = 0; i < blocks.length; i++) fillCartBlock(blocks[i], html);
    // Our own writes must not look like a cart change.
    if (observer) observer.takeRecords();
  }

  // Dawn replaces #CartDrawer / .drawer__inner innerHTML on every cart update;
  // only the outer <cart-drawer> element is stable. The line goes back in the
  // same task as the re-render, then is refreshed once /cart.js answers.
  const cartChanged = createCartSync(renderLines, () =>
    fetch("/cart.js", { credentials: "same-origin", headers: { Accept: "application/json" } })
      .then((r) => (r.ok ? r.json() : null))
      .then((c) => {
        if (c) cart = cartFromJson(c);
      }),
  );

  renderLines();
  if ((drawer || footer) && typeof MutationObserver === "function") {
    observer = new MutationObserver(cartChanged);
    if (drawer) observer.observe(drawer, { childList: true, subtree: true });
    if (footer) observer.observe(footer, { childList: true, subtree: true });
  }

  // ── Product page line and campaign wording ─────────────────────────────────
  // The script, not Liquid, decides whether a campaign is running right now.
  const earnEls = document.querySelectorAll<HTMLElement>("[data-hg-earn]");
  function updateEarn() {
    const note = campaignNote(cfg);
    for (let i = 0; i < earnEls.length; i++) {
      const el = earnEls[i];
      let price = Number(el.getAttribute("data-price")) || 0;
      try {
        const map = JSON.parse(el.getAttribute("data-prices") || "{}") as Record<string, number>;
        const fromUrl = new URLSearchParams(window.location.search).get("variant");
        const section = el.closest(".shopify-section") || document;
        const input = section.querySelector<HTMLInputElement>('form[action*="/cart/add"] [name="id"]');
        const id = (fromUrl && map[fromUrl] != null ? fromUrl : "") || (input && input.value) || "";
        if (map[id] != null) price = map[id];
      } catch { /* keep the Liquid price */ }
      const n = noEarn ? 0 : pointsFor(price, cfg);
      const out = el.querySelector("[data-hg-earn-pts]");
      if (out) out.textContent = fmt(n);
      el.hidden = n <= 0;
    }
    const notes = document.querySelectorAll<HTMLElement>("[data-hg-camp]");
    for (let i = 0; i < notes.length; i++) {
      notes[i].textContent = note ? ` (${note})` : "";
      notes[i].hidden = !note;
    }
  }
  updateEarn();
  if (earnEls.length) {
    document.addEventListener("change", () => {
      setTimeout(updateEarn, 60);
      setTimeout(updateEarn, 600);
    });
  }

  // ── Small toast (nudges, referral result) ──────────────────────────────────
  function toast(title: string, text: string, cta?: { label: string; href?: string; screen?: string }) {
    if (document.querySelector(".hg-toast") || document.querySelector(".hg-hub--open")) return;
    const el = document.createElement("div");
    // Follows the panel style (Dark by default); Light keeps the white card.
    el.className = cfg.panelTheme === "light" ? "hg-toast" : "hg-toast hg-toast--dark";
    el.setAttribute("role", "status");
    el.innerHTML =
      `<button type="button" class="hg-toast__x" aria-label="Dismiss">&times;</button><p class="hg-toast__t">${esc(title)}</p><p class="hg-toast__b">${esc(text)}</p>` +
      (cta ? (cta.href ? `<a class="hg-toast__cta" href="${esc(cta.href)}">${esc(cta.label)}</a>` : `<button type="button" class="hg-toast__cta" data-hg-open="${esc(cta.screen || "")}">${esc(cta.label)}</button>`) : "");
    el.addEventListener("click", (e) => {
      const t = e.target as Element;
      if (t.closest(".hg-toast__x") || t.closest(".hg-toast__cta")) el.remove();
    });
    document.body.appendChild(el);
  }

  function nudges() {
    const n = cfg.nudges;
    if (data.page === "cart") return;
    if (!cid) {
      if (!n.accountCreation || !ls || !cfg.earnRules.signup.enabled || cfg.signupPoints <= 0) return;
      try {
        if (ls.getItem("hg_n1")) return;
        ls.setItem("hg_n1", "1");
      } catch { return; }
      toast(`Join ${cfg.programName}`, `Sign in and get ${fmt(cfg.signupPoints)} points to start.`, { label: "Join now", href: data.urls.login });
      return;
    }
    if (!n.tierProgress || !member || !ss || noEarn) return;
    const m = member.member;
    const p = tierProgress(m.lifetimeSpendPkr, m.tier, cfg.tiers);
    const within = p.next === "gold" ? n.goldWithin : n.diamondWithin;
    if (!p.next || p.remaining <= 0 || p.remaining > within) return;
    try {
      if (ss.getItem("hg_n5")) return;
      ss.setItem("hg_n5", "1");
    } catch { return; }
    toast(`Almost ${TIER_NAME[p.next]}`, `Spend ${rs(p.remaining)} more to reach ${TIER_NAME[p.next]}.`, { label: "View tiers", screen: "tiers" });
  }

  // ── Referral: remember ?ref= for guests, record it once signed in ──────────
  const REF_KEY = "hg_pending_ref";
  function referral() {
    if (!ls) return;
    const store = ls;
    try {
      const ref = new URLSearchParams(window.location.search).get("ref");
      if (validSlug(ref)) store.setItem(REF_KEY, JSON.stringify({ s: ref, t: Date.now(), n: 0 }));
      const raw = store.getItem(REF_KEY);
      const pending = parsePendingRef(raw);
      if (raw && !pending) store.removeItem(REF_KEY); // malformed, older than 30 days, or tried too often
      // Wait for a signed-in member: without one the server can only say "not yet".
      if (!pending || !cid || !member) return;
      store.setItem(REF_KEY, JSON.stringify({ s: pending.s, t: pending.t, n: pending.n + 1 }));
      let http = 0;
      fetch(PROXY + "/referral", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ slug: pending.s }),
      })
        .then((r) => {
          http = r.status;
          return r.json();
        })
        .then((d: { ok?: boolean; status?: string; error?: string; friendCode?: string } | null) => {
          // Forget the slug only on a final answer; anything temporary is retried later.
          if (!isFinalReferralReply(http, d)) return;
          store.removeItem(REF_KEY);
          if (d && d.ok && d.friendCode) {
            api.invalidate();
            toast("Welcome gift", `Your free shipping code ${d.friendCode} is ready.`, { label: "View reward", screen: "rewards" });
          }
        })
        .catch(() => { /* keep the slug */ });
    } catch { /* storage blocked */ }
  }

  // ── Boot: everything network-related waits until the page is idle ──────────
  function boot() {
    deepLink();
    idle(() => {
      if (cid) {
        void loadMember().then(() => {
          referral();
          setTimeout(nudges, 3000);
        });
      } else {
        referral();
        setTimeout(nudges, 4000);
      }
    });
  }
  // Fresh cached data paints at once (no request).
  if (cid && ss) {
    const c = fresh(readCache(ss, cid));
    if (c) {
      take(c);
      onMember();
    }
  }
  if (document.readyState === "complete") boot();
  else window.addEventListener("load", boot);
})();
