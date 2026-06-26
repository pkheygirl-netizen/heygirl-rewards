// app/widget/nudges.ts
import type { CustomerResponse } from "./api";
import { escHtml } from "./utils";

const LS_NUDGE1 = "hg_nudge1_shown";
const SS_NUDGE5 = "hg_nudge5_shown";

export function initNudges(data: CustomerResponse, pageType: string) {
  const ns = data.nudgeSettings;

  // Nudge 1: Account creation — guest, first visit, 3s delay, bottom-right, once per device
  if (ns.nudge1_enabled && !data.loggedIn && !localStorage.getItem(LS_NUDGE1)) {
    setTimeout(() => showNudge1(), 3000);
  }

  // Nudge 2 & 3: cart page only
  if (pageType === "cart" && data.loggedIn && data.member) {
    const { balance, activeCodes } = data.member;
    // Nudge 3 takes priority over Nudge 2 when both qualify
    if (ns.nudge3_enabled && activeCodes.length > 0) {
      showNudge3(activeCodes[0]);
    } else if (ns.nudge2_enabled && balance >= 3000) {
      showNudge2(balance);
    }
  }

  // Nudge 5: tier progress — product/collection pages, once per session, dismissable
  if (
    ns.nudge5_enabled &&
    data.loggedIn &&
    data.member &&
    (pageType === "product" || pageType === "other") &&
    !sessionStorage.getItem(SS_NUDGE5)
  ) {
    const { member } = data;
    if (member.nextTier === "gold" && member.spendToNextTier <= ns.tier_progress_gold_threshold) {
      showNudge5(`Only Rs.${member.spendToNextTier.toLocaleString()} away from Gold tier!`);
    } else if (member.nextTier === "diamond" && member.spendToNextTier <= ns.tier_progress_diamond_threshold) {
      showNudge5(`Only Rs.${member.spendToNextTier.toLocaleString()} away from Diamond tier!`);
    }
  }
}

function showNudge1() {
  const el = createNudge(
    "Earn points on every purchase",
    "Sign up free and start earning Rs. rewards on every order at HeyGirl.pk.",
    "Join & Earn",
    "hg-nudge-br",
    () => { window.location.href = "/account/register"; }
  );
  document.body.appendChild(el);
  localStorage.setItem(LS_NUDGE1, "1");
}

function showNudge2(balance: number) {
  const container = findCartInsertionPoint();
  if (!container) return;
  const el = createNudge(
    `You have ${balance.toLocaleString()} pts to spend`,
    "Redeem your points for a discount before checking out.",
    "Redeem Now",
    "hg-nudge-cart",
    () => {
      const hubFn = (window as unknown as Record<string, unknown>).__hgOpenHub;
      if (typeof hubFn === "function") (hubFn as (tab: number) => void)(0);
    }
  );
  container.insertAdjacentElement("beforebegin", el);
}

function showNudge3(code: { code: string; discount_pkr: number }) {
  const container = findCartInsertionPoint();
  if (!container) return;
  const el = createNudge(
    `You have an unused Rs.${code.discount_pkr} reward!`,
    `Apply code <strong>${escHtml(code.code)}</strong> at checkout to save.`,
    "Copy Code",
    "hg-nudge-cart",
    () => { navigator.clipboard?.writeText(code.code); }
  );
  container.insertAdjacentElement("beforebegin", el);
}

function showNudge5(message: string) {
  const el = createNudge(
    "You're close to the next tier!",
    message,
    "View Tiers",
    "hg-nudge-header",
    () => { window.location.href = "/pages/rewards"; }
  );
  // Prepend inside body for header banner effect
  document.body.prepend(el);
  sessionStorage.setItem(SS_NUDGE5, "1");
}

function findCartInsertionPoint(): Element | null {
  // Dawn theme: checkout button is inside [data-type="add-to-cart-form"] or .cart__ctas
  return (
    document.querySelector(".cart__ctas") ??
    document.querySelector('[name="checkout"]')?.closest("div") ??
    document.querySelector(".cart")
  );
}

function createNudge(
  title: string,
  body: string,
  ctaText: string,
  posClass: string,
  onCta: () => void
): HTMLElement {
  const el = document.createElement("div");
  el.className = `hg-nudge hg-widget ${posClass}`;
  el.innerHTML = `
    <button class="hg-nudge-close" aria-label="Close">×</button>
    <div class="hg-nudge-title">${title}</div>
    <div class="hg-nudge-body">${body}</div>
    <button class="hg-btn hg-btn-primary">${ctaText}</button>
  `;
  el.querySelector(".hg-nudge-close")?.addEventListener("click", () => el.remove());
  el.querySelector(".hg-btn")?.addEventListener("click", () => {
    onCta();
    el.remove();
  });
  return el;
}
