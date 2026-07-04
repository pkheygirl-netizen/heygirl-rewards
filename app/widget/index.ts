// app/widget/index.ts
import { CSS } from "./styles";
import { fetchCustomer, trackReferralVisit, type CustomerResponse } from "./api";
import { renderLauncher, renderPanel, renderSkeletonLauncher, removeLauncher } from "./launcher";
import { initPreview } from "./preview";
import { initNudges } from "./nudges";
import { initProductEmbed, initCartInline } from "./embeds";
import { initHub } from "./hub";
import { renderLandingPage } from "./landing";

(function () {
  "use strict";

  function injectCSS() {
    if (document.getElementById("hg-styles")) return;
    const style = document.createElement("style");
    style.id = "hg-styles";
    style.textContent = CSS;
    document.head.appendChild(style);
  }

  function detectPage(): "product" | "cart" | "rewards" | "other" {
    const path = window.location.pathname;
    if (path === "/pages/rewards") return "rewards";
    if (path.startsWith("/products/")) return "product";
    if (path === "/cart") return "cart";
    return "other";
  }

  async function init() {
    try {
      injectCSS();
      const pageType = detectPage();
      // W12: paint the skeleton launcher BEFORE the network round-trip so the
      // button doesn't pop in late; hydrated (or removed) once data arrives.
      if (pageType !== "rewards") renderSkeletonLauncher();
      const data: CustomerResponse | null = await fetchCustomer();
      if (!data || data.programEnabled === false) {
        removeLauncher(); // no data / program paused — hide widget entirely
        return;
      }

      // Referral attribution spans sessions: a friend clicks heygirl.pk?ref=SLUG while
      // logged OUT, signs up (losing the ?ref= param), then returns logged in. So we
      // CAPTURE the slug at click time (any login state) into localStorage, and only
      // RECORD it once we have the friend's customer id (logged in). Server dedups.
      const refSlug = new URLSearchParams(window.location.search).get("ref");
      if (refSlug) {
        try { localStorage.setItem("hg_pending_ref", refSlug); } catch { /* storage blocked */ }
      }
      if (data.loggedIn && data.member) {
        let pending: string | null = null;
        try { pending = localStorage.getItem("hg_pending_ref"); } catch { /* storage blocked */ }
        // Skip self-referrals (clicking your own link)
        if (pending && pending !== data.member.referralSlug) {
          trackReferralVisit(pending).then((ok) => {
            if (ok) { try { localStorage.removeItem("hg_pending_ref"); } catch { /* noop */ } }
          });
        }
      }

      if (pageType !== "rewards") {
        renderLauncher(data);
        if (data.loggedIn && data.member) {
          renderPanel(data);
          initHub(data);
        } else {
          // Logged-out: clicking the launcher opens an in-page preview overlay
          // instead of navigating straight to the account page.
          initPreview(data);
        }
      }

      if (data.nudgeSettings) {
        initNudges(data, pageType);
      }

      if (pageType === "product") initProductEmbed(data);
      if (pageType === "cart") initCartInline(data);
      if (pageType === "rewards") renderLandingPage(data);
    } catch {
      // fail silently — but never leave a dead skeleton button behind
      try { removeLauncher(); } catch { /* noop */ }
    }
  }

  // W12: boot on idle, never in the load-critical window. requestIdleCallback
  // with a 3s timeout; setTimeout fallback for Safari.
  function boot() {
    const ric = (window as unknown as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => void }).requestIdleCallback;
    if (typeof ric === "function") ric(() => void init(), { timeout: 3000 });
    else setTimeout(() => void init(), 200);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
