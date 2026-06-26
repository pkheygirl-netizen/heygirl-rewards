// app/widget/hub-rewards.ts
import type { CustomerResponse } from "./api";
import { redeem } from "./api";
import { escHtml } from "./utils";

const REDEMPTION_TIERS = [
  { points: 3000, discount_pkr: 100 },
  { points: 6000, discount_pkr: 250 },
  { points: 11500, discount_pkr: 500 },
  { points: 22000, discount_pkr: 1000 },
  { points: 100000, discount_pkr: 5000 },
  { points: 180000, discount_pkr: 10000 },
];

const MONTH_NAMES = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

const BIRTHDAY_REWARD: Record<string, string> = {
  silver: "Rs.250 gift code",
  gold: "Rs.500 gift code",
  diamond: "Rs.1,000 code + 1.2× points all month",
};

export function renderRewardsTab(panel: HTMLElement, data: CustomerResponse) {
  if (!data.member) {
    panel.innerHTML = "<p style='color:#888;padding:20px 0;'>Please log in to view rewards.</p>";
    return;
  }
  const { member } = data;
  const currentMonth = new Date().getMonth() + 1; // 1-based

  // --- Hero card ---
  const goldThreshold = data.nudgeSettings?.tier_progress_gold_threshold ?? 50000;
  const diamondThreshold = data.nudgeSettings?.tier_progress_diamond_threshold ?? 100000;
  const goldPct = Math.min(100, Math.round((member.lifetimeSpend / goldThreshold) * 100));
  const diamondPct = Math.min(100, Math.round((member.lifetimeSpend / diamondThreshold) * 100));

  const heroHtml = `
    <div class="hg-rewards-hero">
      <div class="hg-rewards-pts">${member.balance.toLocaleString()}</div>
      <div class="hg-rewards-pts-label">points available</div>
      <div class="hg-progress-label" style="margin-top:14px;">
        <span>★ Gold (Rs.${goldThreshold.toLocaleString()})</span>
        <span>${goldPct}%</span>
      </div>
      <div class="hg-progress-track">
        <div class="hg-progress-fill" style="width:${goldPct}%"></div>
      </div>
      <div class="hg-progress-label">
        <span>◆ Diamond (Rs.${diamondThreshold.toLocaleString()})</span>
        <span>${diamondPct}%</span>
      </div>
      <div class="hg-progress-track">
        <div class="hg-progress-fill" style="width:${diamondPct}%;background:linear-gradient(90deg,#9c27b0,#e91e8c)"></div>
      </div>
      ${member.nextTier ? `<div style="font-size:12px;color:rgba(255,255,255,0.8);margin-top:4px;">Rs.${member.spendToNextTier.toLocaleString()} more to reach ${member.nextTier}</div>` : `<div style="font-size:12px;color:rgba(255,255,255,0.8);margin-top:4px;">You've reached the top tier! 🎉</div>`}
    </div>
  `;

  // --- Active codes ---
  const activeCodesHtml = member.activeCodes.length > 0
    ? `<div class="hg-section">
        <div class="hg-section-title">🎉 Active Rewards</div>
        ${member.activeCodes.map((c) => {
          const safeCode = escHtml(c.code);
          return `
          <div class="hg-active-code-row">
            <div>
              <strong>${safeCode}</strong>
              <div style="color:#888;font-size:11px;">Rs.${c.discount_pkr} off &middot; expires ${new Date(c.expires_at).toLocaleDateString()}</div>
            </div>
            <button class="hg-copy-btn hg-copy-code" data-code="${safeCode}">Copy</button>
          </div>`;
        }).join("")}
      </div>`
    : `<div class="hg-section">
        <div class="hg-section-title">Active Rewards</div>
        <p style="color:#888;font-size:13px;text-align:center;padding:12px 0;">No active codes — redeem points below!</p>
      </div>`;

  // --- Redemption tiles ---
  const tilesHtml = REDEMPTION_TIERS.map((t) => {
    const canAfford = member.balance >= t.points;
    const ptsLabel = t.points % 1000 === 500
      ? `${(t.points / 1000).toFixed(1)}k`
      : `${t.points / 1000}k`;
    return `
      <div class="hg-redeem-tile${canAfford ? "" : " hg-disabled"}" data-points="${t.points}" data-pkr="${t.discount_pkr}" role="button" tabindex="${canAfford ? 0 : -1}">
        <div class="hg-tile-pts">${ptsLabel} pts</div>
        <div class="hg-tile-val">Rs.${t.discount_pkr.toLocaleString()}</div>
        <div class="hg-tile-label">${canAfford ? "Tap to redeem" : `Need ${(t.points - member.balance).toLocaleString()} more`}</div>
      </div>`;
  }).join("");

  // --- Birthday card ---
  const birthdayHtml = (member.birthdayMonth && member.birthdayMonth === currentMonth)
    ? `<div class="hg-birthday-card">
        <div style="font-weight:700;font-size:15px;margin-bottom:6px;">🎂 Happy Birthday Month!</div>
        <div style="font-size:13px;color:#555;">
          Your ${MONTH_NAMES[member.birthdayMonth - 1]} reward: <strong>${BIRTHDAY_REWARD[member.tier] ?? "a special gift"}</strong>
        </div>
      </div>`
    : "";

  // --- Reward Room ---
  const rewardRoomHtml = `
    <div class="hg-reward-room">
      <div style="font-size:16px;font-weight:700;margin-bottom:4px;">🏆 Reward Room</div>
      <div style="font-size:13px;color:#aaa;margin-bottom:12px;">Exclusive products redeemable with points — coming soon!</div>
      <button class="hg-btn hg-reward-room-btn">Enter Reward Room →</button>
    </div>`;

  panel.innerHTML = `
    ${heroHtml}
    ${activeCodesHtml}
    <div class="hg-section">
      <div class="hg-section-title">Redeem Points</div>
      <div class="hg-redeem-grid" id="hg-redeem-grid">${tilesHtml}</div>
      <div id="hg-redeem-msg" class="hg-redeem-msg"></div>
    </div>
    ${birthdayHtml}
    ${rewardRoomHtml}
  `;

  // Wire copy buttons for active codes
  panel.querySelectorAll<HTMLButtonElement>(".hg-copy-code").forEach((btn) => {
    btn.addEventListener("click", () => {
      const code = btn.dataset.code ?? "";
      navigator.clipboard?.writeText(code).catch(() => {});
      btn.textContent = "Copied!";
      setTimeout(() => { btn.textContent = "Copy"; }, 2000);
    });
  });

  // Wire redemption tiles
  const msgEl = panel.querySelector<HTMLElement>("#hg-redeem-msg")!;
  panel.querySelectorAll<HTMLElement>(".hg-redeem-tile:not(.hg-disabled)").forEach((tile) => {
    tile.addEventListener("click", async () => {
      const pts = Number(tile.dataset.points);
      const pkr = Number(tile.dataset.pkr);
      msgEl.textContent = "Generating your reward code…";
      msgEl.style.color = "#888";
      tile.classList.add("hg-disabled");

      const result = await redeem(pts) as { redeemed?: boolean; code?: string; discount_pkr?: number; error?: string };
      if (result.redeemed && result.code) {
        const safeCode = escHtml(result.code);
        const displayPkr = result.discount_pkr ?? pkr;
        msgEl.innerHTML = `✅ Code <strong>${safeCode}</strong> — Rs.${displayPkr.toLocaleString()} off! <button class="hg-copy-btn hg-copy-result" data-code="${safeCode}">Copy</button>`;
        msgEl.style.color = "#2e7d32";
        // Update displayed balance
        const balEl = document.querySelector(".hg-hub-balance");
        if (balEl) balEl.textContent = `${Math.max(0, member.balance - pts).toLocaleString()} pts`;
        member.balance = Math.max(0, member.balance - pts);

        // Wire copy in result
        const copyBtn = msgEl.querySelector<HTMLButtonElement>(".hg-copy-result");
        copyBtn?.addEventListener("click", () => {
          navigator.clipboard?.writeText(result.code!).catch(() => {});
          copyBtn.textContent = "Copied!";
          setTimeout(() => { copyBtn.textContent = "Copy"; }, 2000);
        });
      } else {
        msgEl.textContent = `Failed: ${result.error ?? "unknown error"}`;
        msgEl.style.color = "#c62828";
        tile.classList.remove("hg-disabled");
      }
    });
  });

  // Reward Room tooltip
  panel.querySelector<HTMLButtonElement>(".hg-reward-room-btn")?.addEventListener("click", (e) => {
    e.preventDefault();
    const existing = panel.querySelector(".hg-coming-soon-tip");
    if (existing) return;
    const tip = document.createElement("div");
    tip.className = "hg-coming-soon-tip";
    tip.textContent = "Coming Soon! 🚀";
    (e.currentTarget as HTMLElement).insertAdjacentElement("afterend", tip);
    setTimeout(() => tip.remove(), 2500);
  });
}
