import type { CustomerResponse } from "./api";
import { escHtml } from "./utils";

const TIER_DATA = [
  {
    key: "silver",
    name: "◈ Silver",
    color: "#9e9e9e",
    threshold: "Default",
    benefits: [
      "Earn 1 pt per Rs.1 spent",
      "Sign-up bonus: 1,000 pts",
      "Birthday reward: Rs.250",
      "Referral bonus: 6,000 pts",
      "Points expire after 1 year (FIFO)",
    ],
  },
  {
    key: "gold",
    name: "★ Gold",
    color: "#f9a825",
    threshold: "Rs.50,000 lifetime spend",
    benefits: [
      "Earn 1 pt per Rs.1 spent",
      "Points never expire",
      "Birthday reward: Rs.500",
      "Referral bonus: 6,000 pts",
      "Priority customer support",
    ],
  },
  {
    key: "diamond",
    name: "◆ Diamond",
    color: "#7b1fa2",
    threshold: "Rs.100,000 lifetime spend",
    benefits: [
      "Earn 1.2× points in birthday month",
      "Points never expire",
      "Birthday reward: Rs.1,000",
      "Referral bonus: 6,000 pts",
      "Early access to new arrivals",
      "Exclusive Reward Room access",
    ],
  },
];

export function renderTiersTab(panel: HTMLElement, data: CustomerResponse) {
  if (!data.member) {
    panel.innerHTML = "<p style='color:#888;text-align:center;padding:16px;'>Please log in to view tier info.</p>";
    return;
  }

  const { tier, lifetimeSpend, spendToNextTier, nextTier } = data.member;

  const goldThreshold = data.nudgeSettings?.tier_progress_gold_threshold ?? 50000;
  const diamondThreshold = data.nudgeSettings?.tier_progress_diamond_threshold ?? 100000;
  const goldPct = Math.min(100, Math.round((lifetimeSpend / goldThreshold) * 100));
  const diamondPct = Math.min(100, Math.round((lifetimeSpend / diamondThreshold) * 100));

  panel.innerHTML = `
    <div class="hg-tier-cards">
      ${TIER_DATA.map((t) => {
        const isCurrentTier = tier === t.key;
        const isAchieved = (tier === "gold" && t.key === "silver") || (tier === "diamond" && (t.key === "silver" || t.key === "gold"));
        return `
        <div class="hg-tier-card ${isCurrentTier ? "hg-current-tier" : ""} ${isAchieved ? "hg-achieved-tier" : ""}">
          <div class="hg-tier-card-header">
            <div class="hg-tier-name" style="color:${t.color};">${t.name}</div>
            ${isCurrentTier ? `<span class="hg-current-badge">Your Current Tier</span>` : ""}
            ${isAchieved ? `<span class="hg-achieved-badge">Achieved ✓</span>` : ""}
          </div>
          <div style="font-size:12px;color:#888;margin-bottom:8px;">Unlocks at: ${t.threshold}</div>
          ${t.benefits.map((b) => `<div class="hg-tier-benefit">✓ ${b}</div>`).join("")}
        </div>
      `;
      }).join("")}
    </div>

    <div class="hg-tier-progress-section">
      <div style="font-weight:700;font-size:14px;margin-bottom:12px;">Your Progress</div>
      <div style="font-size:13px;color:#555;margin-bottom:12px;">
        Lifetime spend: <strong>Rs.${lifetimeSpend.toLocaleString()}</strong>
        ${nextTier ? ` · Rs.${spendToNextTier.toLocaleString()} more to reach ${nextTier.charAt(0).toUpperCase() + nextTier.slice(1)}` : " · Maximum tier reached!"}
      </div>
      <div class="hg-progress-label">
        <span>Silver → Gold (Rs.${goldThreshold.toLocaleString()})</span><span>${goldPct}%</span>
      </div>
      <div class="hg-progress-track">
        <div class="hg-progress-fill" style="width:${goldPct}%;background:#f9a825;"></div>
      </div>
      <div class="hg-progress-label" style="margin-top:8px;">
        <span>Gold → Diamond (Rs.${diamondThreshold.toLocaleString()})</span><span>${diamondPct}%</span>
      </div>
      <div class="hg-progress-track">
        <div class="hg-progress-fill" style="width:${diamondPct}%;background:#7b1fa2;"></div>
      </div>
    </div>
  `;
}
