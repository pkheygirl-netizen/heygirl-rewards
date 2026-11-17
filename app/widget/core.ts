// app/widget/core.ts → extensions/hg-loyalty/assets/hg-core.js
// Small deferred script loaded by the app embed on every page. It wires the
// Liquid-rendered launcher, keeps the cart rewards line in place, updates the
// product "Earn N points" line, and lazy-loads the hub bundle on demand.
// Guests cause no request to the app server.
import { cartFromJson, cartLineHtml, ensureDrawerLine, fillCartBlock } from "./cart-line";
import { purgeCache, readCache, writeCache, cacheKey } from "./member-cache";
import { esc, fmt, pointsFor, PROXY, rs, tierProgress, TIER_NAME, CACHE_TTL_MS, type BootData, type CartState, type LoyaltyApi, type MemberData } from "./shared";

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
  if (!cfg || !cfg.enabled) return;
  if (data.customer) data.customer.id = String(data.customer.id);
  data.cart.codes = (data.cart.codes || []).filter(Boolean);
  const cid = data.customer ? data.customer.id : null;

  let ss: Storage | null = null;
  let ls: Storage | null = null;
  try { ss = window.sessionStorage; } catch { /* blocked */ }
  try { ls = window.localStorage; } catch { /* blocked */ }
  if (ss) purgeCache(ss, cid); // sign-out or account switch drops old entries

  const idle = (fn: () => void, timeout = 4000) => {
    if (typeof w.requestIdleCallback === "function") w.requestIdleCallback(fn, { timeout });
    else setTimeout(fn, 1200);
  };

  // ── Member data ────────────────────────────────────────────────────────────
  let member: MemberData | null = cid && ss ? readCache(ss, cid) : null;
  let inflight: Promise<MemberData | null> | null = null;

  function loadMember(force?: boolean): Promise<MemberData | null> {
    if (!cid) return Promise.resolve(null);
    if (!force) {
      const c = ss ? readCache(ss, cid) : member;
      if (c) return Promise.resolve((member = c));
    }
    if (inflight) return inflight;
    inflight = fetch(PROXY + "/customer", { credentials: "same-origin", headers: { Accept: "application/json" } })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: MemberData | null) => {
        inflight = null;
        if (!d || !d.member) return (member = null);
        member = d;
        // A welcome bonus still in the queue: let the cache lapse within 30 s.
        if (ss) writeCache(ss, cid, d, d.welcomeQueued ? Date.now() - CACHE_TTL_MS + 30000 : Date.now());
        onMember();
        return d;
      })
      .catch(() => {
        inflight = null;
        return null;
      });
    return inflight;
  }

  function invalidate() {
    member = null;
    try { if (ss && cid) ss.removeItem(cacheKey(cid)); } catch { /* noop */ }
  }

  // ── Hub (second bundle, loaded on first open) ──────────────────────────────
  let hubLoad: Promise<void> | null = null;
  const launcher = document.getElementById("hg-launcher");

  function open(screen?: string, opener?: HTMLElement | null) {
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

  const api: LoyaltyApi = { data, member: loadMember, invalidate: () => { invalidate(); idle(() => void loadMember(true).then(renderLines), 1500); }, open };
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
    if (label && member && !member.member.optedOut && !member.member.blocked) {
      label.textContent = fmt(member.member.pointsBalance) + " pts";
      launcher!.setAttribute("aria-label", `${cfg.programName}: ${fmt(member.member.pointsBalance)} points. Open rewards`);
    }
    renderLines();
  }

  // ── Cart rewards line (drawer + cart page block) ───────────────────────────
  let cart: CartState = data.cart;
  const drawer = document.querySelector("cart-drawer");
  const footer = document.getElementById("main-cart-footer");
  let observer: MutationObserver | null = null;

  function renderLines() {
    const path = window.location.pathname + window.location.search;
    const html = cartLineHtml(cfg, cart, member, !!cid, path);
    if (drawer) ensureDrawerLine(drawer, html);
    const blocks = document.querySelectorAll("[data-hg-cart-block]");
    for (let i = 0; i < blocks.length; i++) fillCartBlock(blocks[i], html);
    // Our own writes must not look like a cart change.
    if (observer) observer.takeRecords();
  }

  let timer = 0;
  function cartChanged() {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      fetch("/cart.js", { credentials: "same-origin", headers: { Accept: "application/json" } })
        .then((r) => (r.ok ? r.json() : null))
        .then((c) => {
          if (c) cart = cartFromJson(c);
          renderLines();
        })
        .catch(renderLines);
    }, 250);
  }

  if (drawer || footer) {
    renderLines();
    if (typeof MutationObserver === "function") {
      // Dawn replaces #CartDrawer / .drawer__inner innerHTML on every cart
      // update; only the outer <cart-drawer> element is stable.
      observer = new MutationObserver(cartChanged);
      if (drawer) observer.observe(drawer, { childList: true, subtree: true });
      if (footer) observer.observe(footer, { childList: true, subtree: true });
    }
  }

  // ── Product page: keep "Earn N points" in step with the selected variant ───
  const earnEls = document.querySelectorAll<HTMLElement>("[data-hg-earn]");
  function updateEarn() {
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
      const n = pointsFor(price, cfg);
      const out = el.querySelector("[data-hg-earn-pts]");
      if (out) out.textContent = fmt(n);
      el.hidden = n <= 0;
    }
  }
  if (earnEls.length) {
    updateEarn();
    document.addEventListener("change", () => {
      setTimeout(updateEarn, 60);
      setTimeout(updateEarn, 600);
    });
  }

  // ── Small toast (nudges, referral result) ──────────────────────────────────
  function toast(title: string, text: string, cta?: { label: string; href?: string; screen?: string }) {
    if (document.querySelector(".hg-toast") || document.querySelector(".hg-hub--open")) return;
    const el = document.createElement("div");
    el.className = "hg-toast";
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
    if (!n.tierProgress || !member || !ss) return;
    const m = member.member;
    if (m.optedOut || m.blocked) return;
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
  function referral() {
    if (!ls) return;
    try {
      const ref = new URLSearchParams(window.location.search).get("ref");
      if (ref && /^[a-z0-9][a-z0-9_-]{1,63}$/i.test(ref)) ls.setItem("hg_pending_ref", ref);
      const pending = cid ? ls.getItem("hg_pending_ref") : null;
      if (!pending) return;
      fetch(PROXY + "/referral", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ slug: pending }),
      })
        .then((r) => (r.status >= 500 || r.status === 429 ? null : r.json()))
        .then((d: { ok?: boolean; friendCode?: string } | null) => {
          if (!d) return; // temporary failure: keep the slug for the next page
          ls!.removeItem("hg_pending_ref");
          if (d.ok && d.friendCode) {
            invalidate();
            void loadMember(true);
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
          if (member) onMember();
          referral();
          setTimeout(nudges, 3000);
        });
      } else {
        referral();
        setTimeout(nudges, 4000);
      }
    });
  }
  if (member) onMember();
  if (document.readyState === "complete") boot();
  else window.addEventListener("load", boot);
})();
