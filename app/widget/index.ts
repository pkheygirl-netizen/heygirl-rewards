// app/widget/index.ts
import { CSS } from "./styles";
import { fetchCustomer, type CustomerResponse } from "./api";
import { renderLauncher, renderPanel } from "./launcher";
import { initNudges } from "./nudges";
import { initProductEmbed, initCartInline } from "./embeds";

(function () {
  "use strict";

  // Inject CSS once
  function injectCSS() {
    if (document.getElementById("hg-styles")) return;
    const style = document.createElement("style");
    style.id = "hg-styles";
    style.textContent = CSS;
    document.head.appendChild(style);
  }

  // Detect current page context
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
      if (!data) return; // fail silently

      // Floating launcher visible on all pages except /pages/rewards
      if (pageType !== "rewards") {
        renderLauncher(data);
        renderPanel(data);
      }

      // Nudges
      if (data.nudgeSettings) {
        initNudges(data, pageType);
      }

      // Page-specific embeds
      if (pageType === "product") {
        initProductEmbed(data);
      }
      if (pageType === "cart") {
        initCartInline(data);
      }

      // /pages/rewards landing page — Plan 5B fills this in
      if (pageType === "rewards") {
        renderRewardsLandingPage(data);
      }
    } catch {
      // fail silently — storefront looks normal
    }
  }

  // Stub — implemented in Plan 5B
  function renderRewardsLandingPage(_data: CustomerResponse) {}

  // Expose for Plan 5B to override
  (window as unknown as Record<string, unknown>).__hgRenderHub = null;

  // Activate: either immediately if DOM ready, or on DOMContentLoaded
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
