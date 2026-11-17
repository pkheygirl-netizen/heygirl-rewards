// app/widget/hub.ts → extensions/hg-loyalty/assets/hg-hub.js
// Second bundle: the rewards panel. Loaded by hg-core.js only when the launcher
// or a deep link opens it. Guests see a preview built from config (no request
// to the app server); members get tabs backed by the proxy API.
import { HUB_CSS, HUB_ICONS } from "./hub-css";
import { fmtDate, PROXY, pts, rs, type LoyaltyApi, type MemberData } from "./shared";
import { earnTab, errorText, guestHome, guestSub, historyFilters, historyRows, referTab, rewardsTab, stateMessage, tiersView, type Ctx, type HistoryRow, type ReferralSummary } from "./views";

(function () {
  const api = (window as unknown as { HGLoyalty?: LoyaltyApi }).HGLoyalty;
  if (!api || api._hub) return;
  const { data } = api;
  const cfg = data.config;
  const signedIn = !!data.customer;

  const TABS: Array<{ key: string; label: string }> = [
    { key: "rewards", label: "Rewards" },
    { key: "earn", label: "Earn" },
    { key: "history", label: "History" },
    { key: "refer", label: "Refer" },
    { key: "tiers", label: "VIP tiers" },
  ];
  const GUEST_TITLES: Record<string, string> = { earn: "Ways to earn", redeem: "Ways to redeem", tiers: "VIP tiers" };
  const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])';

  let hub: HTMLElement;
  let backdrop: HTMLElement;
  let body: HTMLElement;
  let msg: HTMLElement;
  let tabs: HTMLElement;
  let backBtn: HTMLElement;
  let eyebrow: HTMLElement;
  let title: HTMLElement;
  let built = false;
  let isOpen = false;
  let opener: HTMLElement | null = null;
  let prevOverflow = "";
  let screen = "";
  let member: MemberData | null = null;
  let summary: ReferralSummary | null = null;
  const hist: { filter: string; page: number; rows: HistoryRow[]; hasMore: boolean; loaded: boolean } = { filter: "all", page: 1, rows: [], hasMore: false, loaded: false };

  const ctx = (): Ctx => ({ cfg, member, loginUrl: data.urls.login, path: window.location.pathname + window.location.search, origin: window.location.origin });

  function build() {
    if (built) return;
    built = true;
    const style = document.createElement("style");
    style.id = "hg-hub-css";
    style.textContent = HUB_CSS;
    document.head.appendChild(style);
    const sprite = document.createElement("div");
    sprite.innerHTML = HUB_ICONS;
    document.body.appendChild(sprite.firstChild as Node);

    backdrop = document.createElement("div");
    backdrop.className = "hg-bd";
    backdrop.hidden = true;
    backdrop.addEventListener("click", close);

    hub = document.createElement("div");
    hub.id = "hg-hub";
    hub.className = "hg-hub";
    const launcher = document.getElementById("hg-launcher");
    if (launcher && launcher.getAttribute("data-pos") === "left") hub.className += " hg-hub--left";
    hub.hidden = true;
    hub.setAttribute("role", "dialog");
    hub.setAttribute("aria-modal", "true");
    hub.setAttribute("aria-labelledby", "hg-hub-title");
    hub.setAttribute("tabindex", "-1");
    const ic = (n: string) => `<svg class="hg-ic" aria-hidden="true" focusable="false"><use href="#hg-i-${n}"/></svg>`;
    hub.innerHTML =
      `<div class="hg-hub__head"><button type="button" class="hg-hub__ib" data-act="back" aria-label="Back" hidden>${ic("back")}</button>` +
      `<div class="hg-hub__tt"><p class="hg-hub__eb"></p><h2 class="hg-hub__title" id="hg-hub-title"></h2></div>` +
      `<button type="button" class="hg-hub__ib" data-act="close" aria-label="Close rewards">${ic("x")}</button></div>` +
      `<div class="hg-tabs" role="tablist" aria-label="Rewards sections" hidden>` +
      TABS.map((t) => `<button type="button" class="hg-tab" role="tab" id="hg-tab-${t.key}" data-tab="${t.key}" aria-controls="hg-hub-body" aria-selected="false" tabindex="-1">${t.label}</button>`).join("") +
      `</div><div class="hg-msg" role="status" aria-live="polite"></div><div class="hg-hub__body" id="hg-hub-body"></div>`;
    body = hub.querySelector(".hg-hub__body") as HTMLElement;
    msg = hub.querySelector(".hg-msg") as HTMLElement;
    tabs = hub.querySelector(".hg-tabs") as HTMLElement;
    backBtn = hub.querySelector('[data-act="back"]') as HTMLElement;
    eyebrow = hub.querySelector(".hg-hub__eb") as HTMLElement;
    title = hub.querySelector(".hg-hub__title") as HTMLElement;
    hub.addEventListener("click", onClick);
    hub.addEventListener("submit", onSubmit);
    tabs.addEventListener("keydown", onTabKey);
    document.body.appendChild(backdrop);
    document.body.appendChild(hub);
  }

  // ── Open / close, focus trap, Esc ──────────────────────────────────────────
  function onKey(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
      return;
    }
    if (e.key !== "Tab") return;
    const list = Array.prototype.filter.call(hub.querySelectorAll(FOCUSABLE), (el: HTMLElement) => el.offsetParent !== null || el === document.activeElement) as HTMLElement[];
    if (!list.length) {
      e.preventDefault();
      hub.focus();
      return;
    }
    const first = list[0];
    const last = list[list.length - 1];
    const active = document.activeElement;
    if (e.shiftKey && (active === first || active === hub)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    } else if (!hub.contains(active)) {
      e.preventDefault();
      first.focus();
    }
  }

  function open(target: string, from?: HTMLElement | null) {
    build();
    const launcher = document.getElementById("hg-launcher");
    if (isOpen && !target && from === launcher) {
      close();
      return;
    }
    if (!isOpen) {
      // Restore the theme's own value on close; capture only on a real open.
      prevOverflow = document.body.style.overflow;
      opener = from || launcher;
      isOpen = true;
      hub.hidden = false;
      backdrop.hidden = false;
      void hub.offsetWidth; // let the transition run
      hub.classList.add("hg-hub--open");
      if (window.matchMedia && window.matchMedia("(max-width:600px)").matches) document.body.style.overflow = "hidden";
      document.addEventListener("keydown", onKey);
      if (launcher) launcher.setAttribute("aria-expanded", "true");
    }
    setMsg("");
    if (signedIn) openMember(target);
    else show(target === "earn" || target === "redeem" || target === "tiers" ? target : "");
    hub.focus();
  }

  function close() {
    if (!isOpen) return;
    isOpen = false;
    hub.classList.remove("hg-hub--open");
    hub.hidden = true;
    backdrop.hidden = true;
    document.body.style.overflow = prevOverflow;
    document.removeEventListener("keydown", onKey);
    const launcher = document.getElementById("hg-launcher");
    if (launcher) launcher.setAttribute("aria-expanded", "false");
    const back = opener && document.contains(opener) ? opener : launcher;
    if (back) back.focus();
  }

  function setMsg(text: string, isError?: boolean) {
    msg.className = "hg-msg" + (isError ? " hg-msg--err" : "");
    msg.textContent = text;
    if (text) body.scrollTop = 0;
  }

  // ── Rendering ──────────────────────────────────────────────────────────────
  function head(eb: string, t: string, back: boolean) {
    eyebrow.textContent = eb;
    eyebrow.hidden = !eb;
    title.textContent = t;
    backBtn.hidden = !back;
  }

  /** Guest screens and member tabs share one entry point. */
  function show(next: string) {
    screen = next;
    body.scrollTop = 0;
    if (!signedIn) {
      tabs.hidden = true;
      body.removeAttribute("role");
      if (!next) {
        head("Welcome to", cfg.programName, false);
        body.innerHTML = guestHome(ctx());
      } else {
        head("", GUEST_TITLES[next] || cfg.programName, true);
        body.innerHTML = guestSub(ctx(), next as "earn" | "redeem" | "tiers");
      }
      return;
    }
    head("", cfg.programName, false);
    const mm = member && member.member;
    if (!member || !mm || mm.optedOut || mm.blocked) {
      tabs.hidden = true;
      body.removeAttribute("role");
      body.innerHTML = stateMessage(ctx(), api!.state() || "error");
      return;
    }
    tabs.hidden = false;
    const all = tabs.querySelectorAll<HTMLElement>(".hg-tab");
    for (let i = 0; i < all.length; i++) {
      const on = all[i].getAttribute("data-tab") === next;
      all[i].setAttribute("aria-selected", String(on));
      all[i].tabIndex = on ? 0 : -1;
      if (on && typeof all[i].scrollIntoView === "function") all[i].scrollIntoView({ block: "nearest", inline: "nearest" });
    }
    body.setAttribute("role", "tabpanel");
    body.setAttribute("aria-labelledby", "hg-tab-" + next);
    if (next === "earn") body.innerHTML = earnTab(ctx());
    else if (next === "tiers") body.innerHTML = tiersView(ctx());
    else if (next === "refer") {
      body.innerHTML = referTab(ctx(), summary);
      if (!summary) {
        void get<ReferralSummary & { ok?: boolean }>("/referral").then((d) => {
          if (d && d.ok !== false && Array.isArray(d.rows)) {
            summary = d;
            if (isOpen && screen === "refer") body.innerHTML = referTab(ctx(), summary);
          }
        });
      }
    } else if (next === "history") {
      renderHistory();
      if (!hist.loaded) loadHistory(true);
    } else body.innerHTML = rewardsTab(ctx());
  }

  function openMember(target: string) {
    const tab = target === "redeem" ? "rewards" : TABS.some((t) => t.key === target) ? target : "rewards";
    const had = !!member;
    if (had) show(tab);
    else {
      head("", cfg.programName, false);
      tabs.hidden = true;
      body.innerHTML = `<p class="hg-load">Loading your rewards…</p>`;
    }
    // Served from the five-minute cache when fresh; otherwise one request.
    void api!.member().then((d) => {
      const changed = !!d && d !== member;
      if (d) member = d;
      if (isOpen && (!had || changed)) show(had ? screen : tab);
    });
  }

  function renderHistory() {
    body.innerHTML =
      historyFilters(hist.filter) +
      `<section class="hg-card">` +
      (hist.rows.length ? `<ul class="hg-list">${historyRows(hist.rows)}</ul>` : `<p class="hg-empty">${hist.loaded ? "Nothing here yet." : "Loading…"}</p>`) +
      (hist.hasMore ? `<button type="button" class="hg-btn hg-btn--block hg-btn--ghost" data-act="more">Show more</button>` : "") +
      `</section>`;
  }

  function loadHistory(reset: boolean) {
    if (reset) {
      hist.page = 1;
      hist.rows = [];
      hist.loaded = false;
    }
    const filter = hist.filter;
    void get<{ rows?: HistoryRow[]; hasMore?: boolean }>(`/history?filter=${encodeURIComponent(filter)}&page=${hist.page}`).then((d) => {
      if (filter !== hist.filter) return; // a newer filter was chosen meanwhile
      hist.loaded = true;
      if (d && Array.isArray(d.rows)) {
        hist.rows = hist.rows.concat(d.rows);
        hist.hasMore = !!d.hasMore;
      } else {
        hist.hasMore = false;
        setMsg(errorText(null), true);
      }
      if (isOpen && screen === "history") renderHistory();
    });
  }

  // ── Network ────────────────────────────────────────────────────────────────
  type Result = { ok?: boolean; error?: string } & Record<string, unknown>;

  function get<T>(path: string): Promise<T | null> {
    return fetch(PROXY + path, { credentials: "same-origin", headers: { Accept: "application/json" } })
      .then((r) => (r.ok ? (r.json() as Promise<T>) : null))
      .catch(() => null);
  }

  function post(path: string, payload: Record<string, unknown>): Promise<Result> {
    return fetch(PROXY + path, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(payload),
    })
      .then((r) => r.json() as Promise<Result>)
      .catch(() => ({ ok: false, error: "network" }));
  }

  /** Runs an action with the button disabled; refreshes cached member data after success. */
  function act(btn: HTMLButtonElement, path: string, payload: Record<string, unknown>, done: (r: Result) => string) {
    if (btn.disabled) return;
    btn.disabled = true;
    void post(path, payload).then((r) => {
      btn.disabled = false;
      if (!r || !r.ok) {
        setMsg(errorText(r && r.error), true);
        return;
      }
      const text = done(r);
      api!.invalidate();
      hist.loaded = false;
      show(screen);
      setMsg(text);
      hub.focus();
    });
  }

  // ── Events ─────────────────────────────────────────────────────────────────
  function copy(btn: HTMLElement, text: string) {
    const ok = () => {
      const old = btn.textContent;
      btn.textContent = "Copied";
      setTimeout(() => { btn.textContent = old; }, 2000);
    };
    const fallback = () => {
      const input = hub.querySelector<HTMLInputElement>(".hg-ref__i");
      const ta = input && input.value === text ? input : document.createElement("textarea");
      if (ta !== input) {
        (ta as HTMLTextAreaElement).value = text;
        ta.setAttribute("readonly", "");
        ta.style.cssText = "position:fixed;opacity:0";
        hub.appendChild(ta);
      }
      ta.select();
      try { if (document.execCommand("copy")) ok(); } catch { /* noop */ }
      if (ta !== input) ta.remove();
    };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(ok, fallback);
    else fallback();
  }

  function onClick(e: Event) {
    const t = e.target instanceof Element ? e.target : null;
    if (!t) return;
    const tab = t.closest<HTMLElement>("[data-tab]");
    if (tab) return void (setMsg(""), show(tab.getAttribute("data-tab") || "rewards"));
    const go = t.closest<HTMLElement>("[data-go]");
    if (go) return void (setMsg(""), show(go.getAttribute("data-go") || ""), hub.focus());
    const cp = t.closest<HTMLElement>("[data-copy]");
    if (cp) return copy(cp, cp.getAttribute("data-copy") || "");
    const f = t.closest<HTMLElement>("[data-filter]");
    if (f) {
      hist.filter = f.getAttribute("data-filter") || "all";
      renderHistory();
      loadHistory(true);
      const again = body.querySelector<HTMLElement>(`[data-filter="${hist.filter}"]`);
      if (again) again.focus();
      return;
    }
    const b = t.closest<HTMLButtonElement>("[data-act]");
    if (!b) return;
    const a = b.getAttribute("data-act");
    const m = member;
    if (a === "close") close();
    else if (a === "back") { show(""); hub.focus(); }
    else if (a === "more") { hist.page += 1; loadHistory(false); }
    else if (a === "retry") { member = null; api!.invalidate(); openMember(screen); }
    else if (a === "social" && m) {
      // Open the profile first (new tab), then let her confirm.
      const url = b.getAttribute("data-url") || "";
      if (/^https?:\/\//i.test(url)) window.open(url, "_blank", "noopener");
      b.setAttribute("data-act", "social-claim");
      b.textContent = "Claim points";
      setMsg("Done it? Tap “Claim points” to confirm.");
    } else if (a === "social-claim" && m) {
      const p = b.getAttribute("data-p") as "instagram" | "facebook" | "youtube";
      act(b, "/social", { platform: p }, (r) => {
        m.social[p] = "claimed";
        return r.status === "already_claimed" ? "You have already claimed this one." : `Thank you! ${pts(Number(r.points) || 0)} will be added to your balance soon.`;
      });
    } else if (a === "review" && m) {
      act(b, "/review", {}, (r) => {
        m.review = { eligible: false, pending: m.review.pending + 1 };
        const when = fmtDate(String(r.releaseAt || ""));
        return `Thank you! ${pts(cfg.reviewPoints)} will be added${when ? " by " + when : " soon"}.`;
      });
    } else if (a === "redeem" && m) {
      const points = Number(b.getAttribute("data-points"));
      const pkr = Number(b.getAttribute("data-pkr"));
      if (b.getAttribute("data-armed") !== "1") {
        // Two taps: the first one asks, the second one spends the points.
        b.setAttribute("data-armed", "1");
        b.textContent = "Confirm";
        setMsg(`Use ${pts(points)} for ${rs(pkr)} off? Tap Confirm.`);
        setTimeout(() => {
          if (document.contains(b) && !b.disabled) { b.removeAttribute("data-armed"); b.textContent = "Redeem"; }
        }, 8000);
        return;
      }
      act(b, "/redeem", { points }, (r) => {
        const code = String(r.code || "");
        m.member.pointsBalance = Math.max(0, m.member.pointsBalance - points);
        m.codes.unshift({ id: code, code, kind: "reward", discountPkr: Number(r.discountPkr) || pkr, expiresAt: (r.expiresAt as string) || null });
        const when = fmtDate(String(r.expiresAt || ""));
        return `Your code ${code} is ready: ${rs(Number(r.discountPkr) || pkr)} off${when ? ", use by " + when : ""}.`;
      });
    }
  }

  function onSubmit(e: Event) {
    const form = e.target as HTMLFormElement;
    if (!form || form.getAttribute("data-form") !== "birthday" || !member) return;
    e.preventDefault();
    const m = member;
    const day = Number((form.elements.namedItem("day") as HTMLSelectElement).value);
    const month = Number((form.elements.namedItem("month") as HTMLSelectElement).value);
    if (!day || !month) return setMsg(errorText("invalid_date"), true);
    act(form.querySelector("button") as HTMLButtonElement, "/birthday", { month, day }, () => {
      m.member.birthday = { month, day };
      m.member.canSetBirthday = false;
      return "Your birthday is saved.";
    });
  }

  function onTabKey(e: KeyboardEvent) {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft" && e.key !== "Home" && e.key !== "End") return;
    const all = Array.prototype.slice.call(tabs.querySelectorAll(".hg-tab")) as HTMLElement[];
    let i = all.indexOf(document.activeElement as HTMLElement);
    if (i < 0) return;
    e.preventDefault();
    i = e.key === "Home" ? 0 : e.key === "End" ? all.length - 1 : (i + (e.key === "ArrowRight" ? 1 : -1) + all.length) % all.length;
    show(all[i].getAttribute("data-tab") || "rewards");
    all[i].focus();
  }

  api._hub = open;
})();
