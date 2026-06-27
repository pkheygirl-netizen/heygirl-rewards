// app/widget/index.ts
import { CSS } from "./styles";
import { fetchCustomer, trackReferralVisit, type CustomerResponse } from "./api";
import { renderLauncher, renderPanel } from "./launcher";
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
      const data: CustomerResponse | null = await fetchCustomer();
      if (!data) return;

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
        renderPanel(data);
        initHub(data);
      }

      if (data.nudgeSettings) {
        initNudges(data, pageType);
      }

      if (pageType === "product") initProductEmbed(data);
      if (pageType === "cart") initCartInline(data);
      if (pageType === "rewards") renderLandingPage(data);
    } catch {
      // fail silently
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
