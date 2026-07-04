// app/widget/launcher.ts
import type { CustomerResponse } from "./api";
import { escHtml } from "./utils";

const TIER_LABEL: Record<string, string> = {
  silver: "◈ Silver",
  gold: "★ Gold",
  diamond: "◆ Diamond",
};

// W12: paint a skeleton button immediately so the launcher doesn't pop in
// seconds late on slow networks — renderLauncher() hydrates it in place.
export function renderSkeletonLauncher() {
  if (document.getElementById("hg-launcher")) return;
  const btn = document.createElement("button");
  btn.id = "hg-launcher";
  btn.className = "hg-loading";
  btn.setAttribute("aria-label", "Loyalty rewards");
  btn.innerHTML = `<span class="hg-icon">◈</span>`;
  document.body.appendChild(btn);
}

export function removeLauncher() {
  document.getElementById("hg-launcher")?.remove();
}

export function renderLauncher(data: CustomerResponse) {
  const existing = document.getElementById("hg-launcher") as HTMLButtonElement | null;
  // Already hydrated → nothing to do; a bare skeleton gets hydrated in place.
  if (existing && !existing.classList.contains("hg-loading")) return;

  const btn = existing ?? document.createElement("button");
  btn.id = "hg-launcher";
  btn.className = "hg-loading";

  if (!data.loggedIn || !data.member) {
    btn.classList.add("hg-gold");
    btn.setAttribute("aria-label", "Join the loyalty program");
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
    // W13: accessible name + expanded state for the panel it controls.
    btn.setAttribute("aria-label", "Open loyalty rewards panel");
    btn.setAttribute("aria-expanded", "false");
    btn.setAttribute("aria-haspopup", "dialog");
    btn.innerHTML = `
      <span class="hg-icon">◈</span>
      <span class="hg-badge">${TIER_LABEL[tier] ?? tier}</span>
      <span>${balance.toLocaleString()} pts</span>
    `;
    btn.addEventListener("click", togglePanel);
  }

  if (!existing) document.body.appendChild(btn);

  // Skeleton → real: remove loading class after 1.5s max
  setTimeout(() => btn.classList.remove("hg-loading"), 1500);
}

function togglePanel() {
  const panel = document.getElementById("hg-panel");
  if (!panel) return;
  panel.classList.toggle("hg-open");
  document
    .getElementById("hg-launcher")
    ?.setAttribute("aria-expanded", String(panel.classList.contains("hg-open")));
}

// Gate fix: every close path must also sync aria-expanded, or screen readers
// are told the panel is still open.
function closePanel() {
  document.getElementById("hg-panel")?.classList.remove("hg-open");
  document.getElementById("hg-launcher")?.setAttribute("aria-expanded", "false");
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
        <div style="margin-bottom:8px;font-size:13px;color:#9c7600;font-weight:600;">
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
    const launcher = document.getElementById("hg-launcher") as HTMLElement | null;
    if (typeof hubFn === "function") {
      (hubFn as (tab: number, launcher?: HTMLElement) => void)(0, launcher ?? undefined);
    } else {
      // Fallback until Plan 5B is deployed
      window.location.href = "/pages/rewards";
    }
    closePanel();
  });

  panel.querySelector("#hg-redeem-btn")?.addEventListener("click", () => {
    const hubFn = (window as unknown as Record<string, unknown>).__hgOpenHub;
    const launcher = document.getElementById("hg-launcher") as HTMLElement | null;
    if (typeof hubFn === "function") {
      (hubFn as (tab: number, launcher?: HTMLElement) => void)(0, launcher ?? undefined); // Tab 0 = My Rewards
    }
    closePanel();
  });

  // Copy referral link
  panel.querySelector("#hg-copy-ref")?.addEventListener("click", (e) => {
    const btn = e.currentTarget as HTMLButtonElement;
    navigator.clipboard?.writeText(`https://${referralLink}`).then(() => {
      btn.textContent = "Copied!";
      setTimeout(() => { btn.textContent = "Copy"; }, 2000);
    });
  });

  // Close on outside click. Use launcher.contains() (not e.target !== launcher)
  // so clicks on the launcher's child spans (tier badge, points) don't count as
  // "outside" — otherwise togglePanel opens the panel and this handler closes it
  // again on the same click, making the badge/points appear unclickable.
  document.addEventListener("click", (e) => {
    const launcher = document.getElementById("hg-launcher");
    const target = e.target as Node;
    if (!panel.contains(target) && !(launcher && launcher.contains(target))) {
      closePanel();
    }
  });
}
