// app/widget/launcher.ts
import type { CustomerResponse } from "./api";
import { escHtml } from "./utils";

const TIER_LABEL: Record<string, string> = {
  silver: "◈ Silver",
  gold: "★ Gold",
  diamond: "◆ Diamond",
};

export function renderLauncher(data: CustomerResponse) {
  if (document.getElementById("hg-launcher")) return;

  const btn = document.createElement("button");
  btn.id = "hg-launcher";
  btn.className = "hg-loading";

  if (!data.loggedIn || !data.member) {
    btn.classList.add("hg-gold");
    btn.innerHTML = `<span class="hg-icon">🎁</span><span>Join &amp; Earn</span>`;
    btn.addEventListener("click", () => {
      const w = window as unknown as Record<string, unknown>;
      if (typeof w.__hgTogglePreview === "function") {
        (w.__hgTogglePreview as () => void)();
      } else {
        // Fallback if the preview module failed to init.
        window.location.href = "/account/register";
      }
    });
  } else {
    const { tier, balance } = data.member;
    btn.className = "";
    btn.innerHTML = `
      <span class="hg-icon">◈</span>
      <span class="hg-badge">${TIER_LABEL[tier] ?? tier}</span>
      <span>${balance.toLocaleString()} pts</span>
    `;
    btn.addEventListener("click", togglePanel);
  }

  document.body.appendChild(btn);

  // Skeleton → real: remove loading class after 1.5s max
  setTimeout(() => btn.classList.remove("hg-loading"), 1500);
}

function togglePanel() {
  const panel = document.getElementById("hg-panel");
  if (!panel) return;
  panel.classList.toggle("hg-open");
}

export function renderPanel(data: CustomerResponse) {
  if (document.getElementById("hg-panel")) return;
  if (!data.loggedIn || !data.member) return;

  const { member } = data;
  const panel = document.createElement("div");
  panel.id = "hg-panel";
  panel.className = "hg-widget";

  // Progress to next tier
  const goldPct = Math.min(100, Math.floor((member.lifetimeSpend / 50000) * 100));
  const diamondPct = Math.min(100, Math.floor((member.lifetimeSpend / 100000) * 100));
  const referralLink = member.referralSlug ? `heygirl.pk?ref=${member.referralSlug}` : "";

  panel.innerHTML = `
    <div class="hg-panel-header">
      <div class="hg-name">Hi, ${escHtml(member.firstName ?? "there")}!</div>
      <span class="hg-tier">${TIER_LABEL[member.tier] ?? member.tier}</span>
      <div class="hg-balance">${member.balance.toLocaleString()} pts</div>
    </div>
    <div class="hg-panel-body">
      <div class="hg-progress-label">
        <span>Silver → Gold</span><span>${goldPct}%</span>
      </div>
      <div class="hg-progress-track">
        <div class="hg-progress-fill" style="width:${goldPct}%"></div>
      </div>
      <div class="hg-progress-label">
        <span>Gold → Diamond</span><span>${diamondPct}%</span>
      </div>
      <div class="hg-progress-track">
        <div class="hg-progress-fill" style="width:${diamondPct}%"></div>
      </div>
      ${member.activeCodes.length > 0 ? `
        <div style="margin-bottom:8px;font-size:13px;color:#e91e8c;font-weight:600;">
          🎉 You have ${member.activeCodes.length} active reward${member.activeCodes.length > 1 ? "s" : ""}!
        </div>` : ""}
      <button class="hg-btn hg-btn-primary" id="hg-redeem-btn">Redeem Points</button>
      <button class="hg-btn hg-btn-secondary" id="hg-hub-btn">View Full Dashboard →</button>
      ${referralLink ? `
        <div class="hg-referral-row">
          <span class="hg-referral-link">${referralLink}</span>
          <button class="hg-copy-btn" id="hg-copy-ref">Copy</button>
        </div>` : ""}
    </div>
  `;

  document.body.appendChild(panel);

  // Wire up hub button — opens full dashboard
  panel.querySelector("#hg-hub-btn")?.addEventListener("click", () => {
    const hubFn = (window as unknown as Record<string, unknown>).__hgOpenHub;
    if (typeof hubFn === "function") {
      (hubFn as () => void)();
    } else {
      // Fallback until Plan 5B is deployed
      window.location.href = "/pages/rewards";
    }
    panel.classList.remove("hg-open");
  });

  panel.querySelector("#hg-redeem-btn")?.addEventListener("click", () => {
    const hubFn = (window as unknown as Record<string, unknown>).__hgOpenHub;
    if (typeof hubFn === "function") {
      (hubFn as (tab: number) => void)(0); // Tab 0 = My Rewards
    }
    panel.classList.remove("hg-open");
  });

  // Copy referral link
  panel.querySelector("#hg-copy-ref")?.addEventListener("click", (e) => {
    const btn = e.currentTarget as HTMLButtonElement;
    navigator.clipboard?.writeText(`https://${referralLink}`).then(() => {
      btn.textContent = "Copied!";
      setTimeout(() => { btn.textContent = "Copy"; }, 2000);
    });
  });

  // Close on outside click
  document.addEventListener("click", (e) => {
    const launcher = document.getElementById("hg-launcher");
    if (!panel.contains(e.target as Node) && e.target !== launcher) {
      panel.classList.remove("hg-open");
    }
  });
}
