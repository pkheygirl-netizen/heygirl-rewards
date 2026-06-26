// app/widget/index.ts
import { CSS } from "./styles";
import { fetchCustomer, type CustomerResponse } from "./api";
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
