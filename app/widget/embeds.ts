// app/widget/embeds.ts
import type { CustomerResponse } from "./api";
import { escHtml } from "./utils";

export function initProductEmbed(data: CustomerResponse) {
  if (document.getElementById("hg-product-embed")) return;

  // Product price in cents from Shopify global
  const pricePaisa: number =
    (window as unknown as { ShopifyAnalytics?: { meta?: { product?: { price?: number } } } })
      .ShopifyAnalytics?.meta?.product?.price ?? 0;
  const priceRs = Math.floor(pricePaisa / 100);
  const ptsEarnable = priceRs; // 1 pt per Rs.1

  const embed = document.createElement("div");
  embed.id = "hg-product-embed";
  embed.className = "hg-widget";

  if (!data.loggedIn) {
    embed.innerHTML = `<span>🎁</span> <a href="/account/login" style="color:#e91e8c;text-decoration:underline;">Sign in to earn ${ptsEarnable.toLocaleString()} pts</a> on this purchase`;
  } else {
    embed.innerHTML = `<span>🎁</span> Earn <span class="hg-pts">${ptsEarnable.toLocaleString()} pts</span> on this purchase`;
  }

  // Insert below price in Dawn theme: .price__container or .product__info-wrapper .price
  const priceEl =
    document.querySelector(".price__container") ??
    document.querySelector(".product__info-wrapper .price") ??
    document.querySelector("[data-product-price]");

  if (priceEl) {
    priceEl.insertAdjacentElement("afterend", embed);
  }
}

export function initCartInline(data: CustomerResponse) {
  if (document.getElementById("hg-cart-inline")) return;

  const inline = document.createElement("div");
  inline.id = "hg-cart-inline";
  inline.className = "hg-widget";

  if (!data.loggedIn || !data.member) {
    inline.innerHTML = `<span>🎁</span> <a href="/account/login" style="color:#e91e8c;">Sign in</a> to earn &amp; redeem rewards.`;
  } else {
    const { balance, activeCodes } = data.member;
    // Check if a loyalty code is already applied in cart
    const appliedCodes: string[] = getAppliedDiscountCodes();
    const loyaltyCodeApplied = appliedCodes.some((c) => c.startsWith("REWARD-"));
    const otherDiscountApplied = appliedCodes.some((c) => !c.startsWith("REWARD-"));

    if (loyaltyCodeApplied) {
      inline.innerHTML = `<span>✅</span> Your loyalty reward is applied. Enjoy the savings!`;
    } else if (otherDiscountApplied) {
      inline.innerHTML = `<span>ℹ️</span> A discount is already applied. Loyalty codes cannot stack.`;
    } else if (activeCodes.length > 0) {
      const code = activeCodes[0];
      inline.innerHTML = `
        <div style="margin-bottom:6px;font-weight:600;">🎉 You have a Rs.${code.discount_pkr} reward ready!</div>
        <div style="font-size:12px;color:#888;margin-bottom:8px;">Code: <strong>${escHtml(code.code)}</strong></div>
        <button class="hg-btn hg-btn-primary" id="hg-apply-code" style="margin:0;padding:8px;">Apply Code</button>
      `;
      setTimeout(() => {
        document.getElementById("hg-apply-code")?.addEventListener("click", () => {
          window.location.href = `/discount/${encodeURIComponent(code.code)}?redirect=/cart`;
        });
      }, 0);
    } else if (balance >= 3000) {
      inline.innerHTML = `
        <div style="margin-bottom:4px;font-weight:600;">💎 You have ${balance.toLocaleString()} pts to redeem!</div>
        <div style="font-size:12px;color:#888;margin-bottom:8px;">Earn a reward code and apply it here.</div>
        <button class="hg-btn hg-btn-secondary" id="hg-open-redeem" style="margin:0;padding:8px;">Redeem Points</button>
      `;
      setTimeout(() => {
        document.getElementById("hg-open-redeem")?.addEventListener("click", () => {
          const hubFn = (window as unknown as Record<string, unknown>).__hgOpenHub;
          if (typeof hubFn === "function") (hubFn as (tab: number) => void)(0);
        });
      }, 0);
    } else {
      const ptsNeeded = 3000 - balance;
      inline.innerHTML = `<span>🎁</span> Earn <strong>${ptsNeeded.toLocaleString()} more pts</strong> to unlock your first reward.`;
    }
  }

  // Insert before checkout button in Dawn cart
  const checkoutBtn =
    document.querySelector('[name="checkout"]') ??
    document.querySelector(".cart__checkout");
  if (checkoutBtn) {
    checkoutBtn.insertAdjacentElement("beforebegin", inline);
  }
}

function getAppliedDiscountCodes(): string[] {
  // Dawn theme sets Shopify.checkout.discount with applied discount
  const checkout = (window as unknown as { Shopify?: { checkout?: { discount?: { code?: string; applicable?: boolean } } } }).Shopify?.checkout;
  if (checkout?.discount?.applicable && checkout.discount.code) {
    return [checkout.discount.code];
  }
  return [];
}
