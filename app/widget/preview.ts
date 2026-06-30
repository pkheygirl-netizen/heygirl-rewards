// app/widget/preview.ts
// Logged-out preview overlay for the storefront launcher. Clicking "Join & Earn"
// fades this panel in (instead of navigating away), keeping the customer on the
// same URL. Mirrors the Smile-style layout with HeyGirl gold branding.
//
// Earn/redeem/referral values are the canonical program values from the build
// plan (NOT the marketing poster) — see app/widget/landing.ts for the same data.
import type { CustomerResponse } from "./api";

const REGISTER_URL = "/account/register";
const LOGIN_URL = "/account/login";

type EarnItem = { icon: string; title: string; sub: string };
type RedeemItem = { icon: string; value: string; pts: string };

const EARN: EarnItem[] = [
  { icon: "👤", title: "Sign up", sub: "1,000 HeyGirl Points" },
  { icon: "▶️", title: "Subscribe on YouTube", sub: "1,000 HeyGirl Points" },
  { icon: "🛍️", title: "Place an order", sub: "1 HeyGirl Point for every Rs1 spent" },
  { icon: "📷", title: "Follow on Instagram", sub: "1,000 HeyGirl Points" },
  { icon: "👍", title: "Like on Facebook", sub: "1,000 HeyGirl Points" },
  { icon: "🔗", title: "Share on Facebook", sub: "1,000 HeyGirl Points" },
  { icon: "⭐", title: "Post a review", sub: "3,000 HeyGirl Points" },
  { icon: "🎂", title: "Celebrate a birthday", sub: "Birthday reward coupon" },
];

const REDEEM: RedeemItem[] = [
  { icon: "💵", value: "Rs100 off coupon", pts: "3,000 HeyGirl Points" },
  { icon: "💵", value: "Rs250 off coupon", pts: "6,000 HeyGirl Points" },
  { icon: "💵", value: "Rs500 off coupon", pts: "11,500 HeyGirl Points" },
  { icon: "💵", value: "Rs1,000 off coupon", pts: "22,000 HeyGirl Points" },
  { icon: "💵", value: "Rs5,000 off coupon", pts: "100,000 HeyGirl Points" },
  { icon: "💵", value: "Rs10,000 off coupon", pts: "180,000 HeyGirl Points" },
];

const joinCta = `<a href="${REGISTER_URL}" class="hg-pv-btn">Join now</a>
  <p class="hg-pv-signin">Already have an account? <a href="${LOGIN_URL}">Sign in</a></p>`;

function earnRows(): string {
  return EARN.map(
    (e) => `<div class="hg-pv-row">
      <span class="hg-pv-ic">${e.icon}</span>
      <div class="hg-pv-row-main">
        <div class="hg-pv-row-title">${e.title}</div>
        <div class="hg-pv-row-sub">${e.sub}</div>
      </div>
    </div>`,
  ).join("");
}

function redeemRows(): string {
  return REDEEM.map(
    (r) => `<div class="hg-pv-row">
      <span class="hg-pv-ic">${r.icon}</span>
      <div class="hg-pv-row-main">
        <div class="hg-pv-row-title">${r.value}</div>
        <div class="hg-pv-row-sub">${r.pts}</div>
      </div>
    </div>`,
  ).join("");
}

export function initPreview(_data: CustomerResponse) {
  if (document.getElementById("hg-preview")) return;

  const overlay = document.createElement("div");
  overlay.id = "hg-preview";
  overlay.className = "hg-widget";
  overlay.innerHTML = `
    <div class="hg-pv-head">
      <button class="hg-pv-back" id="hg-pv-back" aria-label="Back" style="display:none">‹</button>
      <div class="hg-pv-head-titles">
        <span class="hg-pv-eyebrow" id="hg-pv-eyebrow">Welcome to</span>
        <span class="hg-pv-title" id="hg-pv-title">HeyGirl.pk Rewards</span>
      </div>
      <button class="hg-pv-close" id="hg-pv-close" aria-label="Close">✕</button>
    </div>
    <div class="hg-pv-body">
      <!-- Main screen -->
      <div class="hg-pv-screen hg-active" id="hg-pv-main">
        <div class="hg-pv-card">
          <div class="hg-pv-card-title">Become a member</div>
          <div class="hg-pv-card-text">With more ways to unlock exciting perks, this is your all access pass to exclusive rewards.</div>
          ${joinCta}
        </div>
        <div class="hg-pv-card">
          <div class="hg-pv-card-title">HeyGirl Points</div>
          <div class="hg-pv-card-text">Earn more HeyGirl Points for different actions, and turn those HeyGirl Points into awesome rewards!</div>
          <div class="hg-pv-nav-list">
            <div class="hg-pv-row hg-pv-row-nav" id="hg-pv-go-earn" role="button" tabindex="0">
              <span class="hg-pv-ic">🪙</span>
              <div class="hg-pv-row-main"><div class="hg-pv-row-title">Ways to earn</div></div>
              <span class="hg-pv-chev">›</span>
            </div>
            <div class="hg-pv-row hg-pv-row-nav" id="hg-pv-go-redeem" role="button" tabindex="0">
              <span class="hg-pv-ic">🎁</span>
              <div class="hg-pv-row-main"><div class="hg-pv-row-title">Ways to redeem</div></div>
              <span class="hg-pv-chev">›</span>
            </div>
          </div>
        </div>
        <div class="hg-pv-card">
          <div class="hg-pv-card-title">Refer &amp; Earn</div>
          <div class="hg-pv-card-text">Give your friends a reward and claim your own when they make a purchase.</div>
          <div class="hg-pv-list">
            <div class="hg-pv-row">
              <span class="hg-pv-ic">🚚</span>
              <div class="hg-pv-row-main"><div class="hg-pv-row-title">They get</div><div class="hg-pv-row-sub">Free shipping coupon</div></div>
            </div>
            <div class="hg-pv-row">
              <span class="hg-pv-ic">💰</span>
              <div class="hg-pv-row-main"><div class="hg-pv-row-title">You get</div><div class="hg-pv-row-sub">6,000 HeyGirl Points</div></div>
            </div>
          </div>
          <div style="margin-top:14px">${joinCta}</div>
        </div>
      </div>

      <!-- Ways to earn screen -->
      <div class="hg-pv-screen" id="hg-pv-earn">
        <div class="hg-pv-sub-title">Ways to earn</div>
        <div class="hg-pv-card">${earnRows()}</div>
        <div class="hg-pv-pill">Join now for free to start earning</div>
        ${joinCta}
      </div>

      <!-- Ways to redeem screen -->
      <div class="hg-pv-screen" id="hg-pv-redeem">
        <div class="hg-pv-sub-title">Ways to redeem</div>
        <div class="hg-pv-card">${redeemRows()}</div>
        ${joinCta}
      </div>
    </div>`;

  document.body.appendChild(overlay);

  const body = overlay.querySelector<HTMLElement>(".hg-pv-body")!;
  const backBtn = overlay.querySelector<HTMLElement>("#hg-pv-back")!;
  const eyebrow = overlay.querySelector<HTMLElement>("#hg-pv-eyebrow")!;
  const title = overlay.querySelector<HTMLElement>("#hg-pv-title")!;
  const screens: Record<string, HTMLElement> = {
    main: overlay.querySelector<HTMLElement>("#hg-pv-main")!,
    earn: overlay.querySelector<HTMLElement>("#hg-pv-earn")!,
    redeem: overlay.querySelector<HTMLElement>("#hg-pv-redeem")!,
  };

  function showScreen(name: "main" | "earn" | "redeem") {
    Object.values(screens).forEach((s) => s.classList.remove("hg-active"));
    screens[name].classList.add("hg-active");
    const isMain = name === "main";
    backBtn.style.display = isMain ? "none" : "flex";
    eyebrow.style.display = isMain ? "block" : "none";
    title.classList.toggle("hg-pv-title-lg", isMain);
    body.scrollTop = 0;
    if (!isMain) backBtn.focus();
  }

  function setLauncherX(isOpen: boolean) {
    const launcher = document.getElementById("hg-launcher");
    if (!launcher) return;
    if (isOpen) {
      launcher.classList.add("hg-x");
      launcher.innerHTML = `<span class="hg-pv-x">✕</span>`;
      launcher.setAttribute("aria-label", "Close rewards preview");
    } else {
      launcher.classList.remove("hg-x");
      launcher.innerHTML = `<span class="hg-icon">🎁</span><span>Join &amp; Earn</span>`;
      launcher.setAttribute("aria-label", "Open HeyGirl Rewards");
    }
  }

  function onKeydown(e: KeyboardEvent) {
    if (e.key === "Escape") close();
  }

  function open() {
    showScreen("main");
    overlay.classList.add("hg-open");
    setLauncherX(true);
    document.addEventListener("keydown", onKeydown);
    // Move focus into the overlay for keyboard/AT users.
    overlay.querySelector<HTMLElement>("#hg-pv-close")?.focus();
  }
  function close() {
    overlay.classList.remove("hg-open");
    setLauncherX(false);
    document.removeEventListener("keydown", onKeydown);
    // Restore focus to the launcher that opened it.
    document.getElementById("hg-launcher")?.focus();
  }

  // Make the nav rows operable by mouse and keyboard (they are role="button").
  function wireNav(id: string, screen: "earn" | "redeem") {
    const el = overlay.querySelector<HTMLElement>(id);
    el?.addEventListener("click", () => showScreen(screen));
    el?.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        showScreen(screen);
      }
    });
  }
  wireNav("#hg-pv-go-earn", "earn");
  wireNav("#hg-pv-go-redeem", "redeem");
  backBtn.addEventListener("click", () => showScreen("main"));
  overlay.querySelector("#hg-pv-close")?.addEventListener("click", close);

  const win = window as unknown as Record<string, unknown>;
  win.__hgOpenPreview = open;
  win.__hgClosePreview = close;
  win.__hgTogglePreview = () =>
    overlay.classList.contains("hg-open") ? close() : open();
}
