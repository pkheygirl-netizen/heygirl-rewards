// app/widget/hub.ts
import type { CustomerResponse } from "./api";
import { renderRewardsTab } from "./hub-rewards";
import { renderHistoryTab } from "./hub-history";
import { renderReferralsTab } from "./hub-referrals";
import { renderTiersTab } from "./hub-tiers";
import { escHtml } from "./utils";

const TAB_LABELS = ["My Rewards", "History", "Referrals", "VIP Tiers"];

const TIER_LABEL: Record<string, string> = {
  silver: "◈ Silver",
  gold: "★ Gold",
  diamond: "◆ Diamond",
};

export function initHub(data: CustomerResponse) {
  if (!data.loggedIn || !data.member) return;

  const { member } = data;

  // Create overlay
  const overlay = document.createElement("div");
  overlay.id = "hg-hub-overlay";
  overlay.className = "hg-widget";

  const hub = document.createElement("div");
  hub.id = "hg-hub";

  // Header
  hub.innerHTML = `
    <div class="hg-hub-header">
      <div class="hg-hub-header-top">
        <div>
          <div class="hg-hub-name">Hi, ${escHtml(member.firstName ?? "there")}!</div>
          <div class="hg-hub-balance">${member.balance.toLocaleString()} pts</div>
          <span class="hg-hub-tier">${TIER_LABEL[member.tier] ?? escHtml(member.tier)}</span>
        </div>
        <button class="hg-hub-close" id="hg-hub-close" aria-label="Close">×</button>
      </div>
      <div class="hg-tabs">
        ${TAB_LABELS.map((label, i) => `
          <button class="hg-tab${i === 0 ? " hg-active" : ""}" data-tab="${i}">${label}</button>
        `).join("")}
      </div>
    </div>
    <div class="hg-hub-body">
      ${TAB_LABELS.map((_, i) => `<div class="hg-tab-panel${i === 0 ? " hg-active" : ""}" id="hg-panel-${i}"></div>`).join("")}
    </div>
  `;

  overlay.appendChild(hub);
  document.body.appendChild(overlay);

  // Render tab 0 immediately
  renderRewardsTab(document.getElementById("hg-panel-0")!, data);

  // Tab switching — lazy-render on first open
  const rendered = new Set([0]);
  hub.querySelectorAll(".hg-tab").forEach((btn) => {
    btn.addEventListener("click", () => {
      const tab = Number((btn as HTMLElement).dataset.tab);
      hub.querySelectorAll(".hg-tab").forEach((b) => b.classList.remove("hg-active"));
      btn.classList.add("hg-active");
      hub.querySelectorAll(".hg-tab-panel").forEach((p) => p.classList.remove("hg-active"));
      const panel = document.getElementById(`hg-panel-${tab}`)!;
      panel.classList.add("hg-active");

      if (!rendered.has(tab)) {
        rendered.add(tab);
        if (tab === 1) renderHistoryTab(panel, data);
        if (tab === 2) renderReferralsTab(panel, data);
        if (tab === 3) renderTiersTab(panel, data);
      }
    });
  });

  // Close
  hub.querySelector("#hg-hub-close")?.addEventListener("click", closeHub);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) closeHub();
  });

  // ARIA: mark hub as a dialog
  hub.setAttribute("role", "dialog");
  hub.setAttribute("aria-modal", "true");
  hub.setAttribute("aria-label", "Loyalty Rewards");
  hub.setAttribute("tabindex", "-1");

  // Focus trap helpers
  const FOCUSABLE_SELECTOR =
    'a[href], button:not([disabled]), input, select, textarea, [tabindex]:not([tabindex="-1"])';

  let _keyHandler: ((e: KeyboardEvent) => void) | null = null;

  function trapFocus(e: KeyboardEvent) {
    if (e.key === "Escape") {
      closeHub();
      return;
    }
    if (e.key === "Tab") {
      const focusable = hub.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR);
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  }

  // Expose global open function
  (window as unknown as Record<string, unknown>).__hgOpenHub = (tab = 0, launcher?: HTMLElement) => {
    overlay.classList.add("hg-open");
    // Switch to requested tab
    const tabBtn = hub.querySelector(`[data-tab="${tab}"]`) as HTMLElement | null;
    if (tabBtn) tabBtn.click();
    document.body.style.overflow = "hidden";

    // Store launcher to return focus on close
    if (launcher) {
      (overlay as unknown as Record<string, unknown>)._launcher = launcher;
    }

    // Move focus into the dialog
    hub.focus();

    // Attach key handler
    if (_keyHandler) document.removeEventListener("keydown", _keyHandler);
    _keyHandler = trapFocus;
    document.addEventListener("keydown", _keyHandler);
  };

  function closeHub() {
    overlay.classList.remove("hg-open");
    document.body.style.overflow = "";

    // Remove key handler
    if (_keyHandler) {
      document.removeEventListener("keydown", _keyHandler);
      _keyHandler = null;
    }

    // Return focus to launcher
    const launcher = (overlay as unknown as Record<string, unknown>)._launcher as HTMLElement | undefined;
    if (launcher) launcher.focus();
  }
}
