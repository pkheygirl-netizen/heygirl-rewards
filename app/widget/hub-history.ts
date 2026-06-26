import type { CustomerResponse } from "./api";
import { fetchHistory } from "./api";
import { escHtml } from "./utils";

const ACTION_LABELS: Record<string, string> = {
  purchase: "Purchase Reward",
  social_youtube: "YouTube (pending)",
  social_facebook: "Facebook (pending)",
  social_instagram: "Instagram (pending)",
  redemption: "Redeemed",
  referral: "Referral Bonus",
  signup: "Welcome Bonus",
  birthday: "Birthday Reward",
  adjustment: "Manual Adjustment",
  expiry: "Points Expired",
};

const ACTION_ICONS: Record<string, string> = {
  purchase: "🛍️",
  social_youtube: "▶️",
  social_facebook: "👍",
  social_instagram: "📸",
  redemption: "🎁",
  referral: "👥",
  signup: "🎉",
  birthday: "🎂",
  adjustment: "✏️",
  expiry: "⏰",
};

const FILTER_CHIPS = [
  { key: null, label: "All" },
  { key: "purchase", label: "Purchases" },
  { key: "social", label: "Social" },
  { key: "redemption", label: "Redemptions" },
  { key: "referral", label: "Referrals" },
  { key: "other", label: "Other" },
];

function relativeDate(dateStr: string): string {
  const diffMs = Date.now() - new Date(dateStr).getTime();
  const diffDays = Math.floor(diffMs / 86400000);
  if (diffDays === 0) return "Today";
  if (diffDays === 1) return "Yesterday";
  if (diffDays < 30) return `${diffDays} days ago`;
  const diffMonths = Math.floor(diffDays / 30);
  if (diffMonths < 12) return `${diffMonths} month${diffMonths > 1 ? "s" : ""} ago`;
  const diffYears = Math.floor(diffMonths / 12);
  return `${diffYears} year${diffYears > 1 ? "s" : ""} ago`;
}

function skeletonRows(): string {
  return Array.from({ length: 5 }, () => `
    <div class="hg-history-item hg-skeleton-row">
      <div style="display:flex;align-items:center;gap:8px;">
        <div class="hg-skel" style="width:28px;height:28px;border-radius:50%;"></div>
        <div>
          <div class="hg-skel" style="width:110px;height:12px;border-radius:4px;margin-bottom:4px;"></div>
          <div class="hg-skel" style="width:70px;height:10px;border-radius:4px;"></div>
        </div>
      </div>
      <div style="text-align:right;">
        <div class="hg-skel" style="width:60px;height:12px;border-radius:4px;"></div>
      </div>
    </div>
  `).join("");
}

export function renderHistoryTab(panel: HTMLElement, _data: CustomerResponse): void {
  panel.innerHTML = `
    <div class="hg-history-filter" id="hg-history-filter">
      ${FILTER_CHIPS.map((f, i) => `
        <button class="hg-filter-btn${i === 0 ? " hg-active" : ""}" data-type="${f.key ?? ""}">
          ${escHtml(f.label)}
        </button>
      `).join("")}
    </div>
    <div id="hg-history-list">${skeletonRows()}</div>
    <div class="hg-pagination" id="hg-history-pagination"></div>
  `;

  let currentPage = 1;
  let currentFilter: string | null = null;

  async function loadPage(page: number, filterType: string | null): Promise<void> {
    const listEl = panel.querySelector("#hg-history-list") as HTMLElement;
    const pagEl = panel.querySelector("#hg-history-pagination") as HTMLElement;

    listEl.innerHTML = skeletonRows();
    pagEl.innerHTML = "";

    const { items, total } = await fetchHistory(page, filterType) as {
      items: Array<{ action_type: string; points: number; created_at: string; reason_note?: string }>;
      total: number;
    };

    if (items.length === 0) {
      listEl.innerHTML = `<p style="color:#888;font-size:13px;text-align:center;padding:32px 0;">No history yet — start earning points!</p>`;
      return;
    }

    listEl.innerHTML = items.map((item) => {
      const label = ACTION_LABELS[item.action_type] ?? escHtml(item.action_type);
      const icon = ACTION_ICONS[item.action_type] ?? "⭐";
      const positive = item.points >= 0;
      const note = item.reason_note ? `<div style="font-size:11px;color:#888;">${escHtml(item.reason_note)}</div>` : "";
      return `
        <div class="hg-history-item">
          <div style="display:flex;align-items:center;gap:8px;">
            <span style="font-size:18px;line-height:1;">${icon}</span>
            <div>
              <div style="font-weight:600;font-size:13px;">${label}</div>
              <div style="font-size:11px;color:#888;">${relativeDate(item.created_at)}</div>
              ${note}
            </div>
          </div>
          <div class="hg-history-delta ${positive ? "hg-positive" : "hg-negative"}">
            ${positive ? "+" : ""}${item.points.toLocaleString()} pts
          </div>
        </div>
      `;
    }).join("");

    const totalPages = Math.ceil(total / 50);
    if (totalPages > 1) {
      pagEl.innerHTML = `
        <button class="hg-page-btn" id="hg-hist-prev" ${page <= 1 ? "disabled" : ""}>← Prev</button>
        <span style="font-size:13px;padding:6px 8px;">Page ${page} of ${totalPages}</span>
        <button class="hg-page-btn" id="hg-hist-next" ${page >= totalPages ? "disabled" : ""}>Next →</button>
      `;
      pagEl.querySelector("#hg-hist-prev")?.addEventListener("click", () => {
        currentPage--;
        loadPage(currentPage, currentFilter);
      });
      pagEl.querySelector("#hg-hist-next")?.addEventListener("click", () => {
        currentPage++;
        loadPage(currentPage, currentFilter);
      });
    }
  }

  panel.querySelector("#hg-history-filter")?.querySelectorAll(".hg-filter-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      panel.querySelectorAll(".hg-filter-btn").forEach((b) => b.classList.remove("hg-active"));
      btn.classList.add("hg-active");
      const raw = (btn as HTMLElement).dataset.type ?? "";
      currentFilter = raw === "" ? null : raw;
      currentPage = 1;
      loadPage(1, currentFilter);
    });
  });

  loadPage(1, null);
}
