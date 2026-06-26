import type { CustomerResponse } from "./api";
import { fetchReferral, claimSocial } from "./api";
import { escHtml } from "./utils";

interface ReferralDashboard {
  referralSlug: string;
  referralLink: string;
  totalReferrals: number;
  completedReferrals: number;
  totalPtsEarned: number;
  history: Array<{ status: string; created_at: string; pts_awarded: number }>;
  isInfluencer: boolean;
  referralRate: number;
}

const SOCIAL_ACTIONS = [
  { platform: "youtube" as const, label: "YouTube", pts: 1000, icon: "▶" },
  { platform: "facebook" as const, label: "Facebook", pts: 1000, icon: "f" },
  { platform: "instagram" as const, label: "Instagram", pts: 1000, icon: "📷" },
];

export async function renderReferralsTab(panel: HTMLElement, _data: CustomerResponse) {
  panel.innerHTML = `<p style="color:#888;font-size:13px;text-align:center;padding:20px 0;">Loading…</p>`;

  const referralData = (await fetchReferral()) as ReferralDashboard | null;

  if (!referralData) {
    panel.innerHTML = `<p style="color:#888;font-size:13px;text-align:center;padding:20px 0;">Referral data unavailable.</p>`;
    return;
  }

  const {
    referralLink,
    totalReferrals,
    completedReferrals,
    totalPtsEarned,
    history,
    isInfluencer,
    referralRate,
  } = referralData;

  const safeLink = escHtml(referralLink);
  const waText = encodeURIComponent(
    `Join HeyGirl.pk and earn 1,000 welcome points! Use my link: ${referralLink}`
  );

  const influencerHtml = isInfluencer
    ? `<div class="hg-influencer-badge">
        <div class="hg-influencer-title">⭐ Influencer Account</div>
        <div class="hg-influencer-rate">Your referral earns <strong>${referralRate.toLocaleString()} pts</strong> per conversion</div>
        <div class="hg-influencer-stats">Total referral earnings: <strong>${totalPtsEarned.toLocaleString()} pts</strong></div>
      </div>`
    : "";

  const historyHtml =
    history.length > 0
      ? `<div class="hg-section-title">Referral History</div>
         ${history
           .slice(0, 10)
           .map(
             (h) => `<div class="hg-history-item">
               <div>
                 <div class="hg-history-label">Referral</div>
                 <div class="hg-history-date">${new Date(h.created_at).toLocaleDateString("en-PK", { day: "numeric", month: "short", year: "numeric" })}</div>
               </div>
               <div class="hg-status-badge hg-status-${escHtml(h.status)}">${escHtml(h.status)}</div>
             </div>`
           )
           .join("")}`
      : `<div class="hg-empty-state">No referrals yet — share your link to get started!</div>`;

  panel.innerHTML = `
    <div class="hg-referral-link-card">
      <div class="hg-section-title">Your Referral Link</div>
      <div class="hg-referral-url">${safeLink}</div>
      <div class="hg-share-row">
        <a class="hg-btn hg-btn-wa" href="https://wa.me/?text=${waText}" target="_blank" rel="noopener noreferrer">📲 WhatsApp Share</a>
        <button class="hg-btn hg-btn-copy" id="hg-ref-copy">Copy Link</button>
      </div>
    </div>

    <div class="hg-stats-row">
      <div class="hg-stat-box">
        <div class="hg-stat-num">${totalReferrals}</div>
        <div class="hg-stat-lbl">Friends Referred</div>
      </div>
      <div class="hg-stat-box">
        <div class="hg-stat-num">${completedReferrals}</div>
        <div class="hg-stat-lbl">Completed</div>
      </div>
      <div class="hg-stat-box">
        <div class="hg-stat-num">${totalPtsEarned.toLocaleString()}</div>
        <div class="hg-stat-lbl">Pts Earned</div>
      </div>
    </div>

    <div class="hg-section-title">Earn Social Points</div>
    <div class="hg-social-note">One-time per platform · Points arrive in ~24h after review</div>
    <div class="hg-social-list" id="hg-social-list">
      ${SOCIAL_ACTIONS.map(
        (a) => `<div class="hg-social-row">
          <div class="hg-social-label">${a.icon} ${escHtml(a.label)} <span class="hg-pts-badge">+${a.pts} pts</span></div>
          <button class="hg-btn hg-btn-social" data-platform="${a.platform}">I Followed!</button>
        </div>`
      ).join("")}
    </div>
    <div class="hg-social-msg" id="hg-social-msg"></div>

    <div class="hg-history-section">
      ${historyHtml}
    </div>

    ${influencerHtml}
  `;

  // Copy link handler
  panel.querySelector<HTMLButtonElement>("#hg-ref-copy")?.addEventListener("click", (e) => {
    const btn = e.currentTarget as HTMLButtonElement;
    navigator.clipboard?.writeText(referralLink).then(() => {
      btn.textContent = "Copied!";
      setTimeout(() => {
        btn.textContent = "Copy Link";
      }, 2000);
    });
  });

  // Social claim handlers
  const socialMsg = panel.querySelector<HTMLElement>("#hg-social-msg")!;
  panel.querySelectorAll<HTMLButtonElement>("[data-platform]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const platform = btn.dataset.platform as "youtube" | "facebook" | "instagram";
      const originalText = btn.textContent;
      btn.textContent = "Submitting…";
      btn.disabled = true;

      const res = (await claimSocial(platform)) as { queued?: boolean; alreadyClaimed?: boolean };

      if (res.alreadyClaimed) {
        socialMsg.textContent = "Already claimed for this platform.";
        socialMsg.className = "hg-social-msg hg-msg-warn";
        btn.textContent = "Claimed ✓";
      } else if (res.queued) {
        socialMsg.textContent = `Submitted! Points pending 24h review`;
        socialMsg.className = "hg-social-msg hg-msg-ok";
        btn.textContent = "Queued ✓";
      } else {
        socialMsg.textContent = "Something went wrong. Please try again.";
        socialMsg.className = "hg-social-msg hg-msg-err";
        btn.textContent = originalText ?? "I Followed!";
        btn.disabled = false;
      }
    });
  });
}
