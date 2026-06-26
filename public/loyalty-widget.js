"use strict";var __LOYALTY_WIDGET__=(()=>{var p=`
/* ---- Reset ---- */
.hg-widget * { box-sizing: border-box; margin: 0; padding: 0; font-family: inherit; }

/* ---- Launcher button ---- */
#hg-launcher {
  position: fixed; bottom: 24px; right: 24px; z-index: 2147483000;
  display: flex; align-items: center; gap: 8px;
  background: #e91e8c; color: #fff;
  border: none; border-radius: 50px; padding: 12px 18px;
  cursor: pointer; font-size: 14px; font-weight: 600;
  box-shadow: 0 4px 16px rgba(233,30,140,0.35);
  transition: transform 0.15s ease, box-shadow 0.15s ease;
}
#hg-launcher:hover { transform: translateY(-2px); box-shadow: 0 6px 20px rgba(233,30,140,0.45); }
#hg-launcher .hg-icon { font-size: 18px; line-height: 1; }
#hg-launcher .hg-badge {
  background: rgba(255,255,255,0.25); border-radius: 20px;
  padding: 2px 8px; font-size: 12px;
}

/* ---- Skeleton loader ---- */
#hg-launcher.hg-loading { background: #ccc; pointer-events: none; animation: hg-pulse 1.2s ease-in-out infinite; }
@keyframes hg-pulse { 0%,100%{opacity:1} 50%{opacity:0.5} }

/* ---- Mini panel ---- */
#hg-panel {
  position: fixed; bottom: 86px; right: 24px; z-index: 2147483001;
  width: 320px; background: #fff; border-radius: 16px;
  box-shadow: 0 8px 32px rgba(0,0,0,0.15); border: 1px solid #f7e8f2;
  overflow: hidden; transform: translateY(12px); opacity: 0;
  transition: transform 0.2s ease, opacity 0.2s ease; pointer-events: none;
}
#hg-panel.hg-open { transform: translateY(0); opacity: 1; pointer-events: all; }
@media (max-width: 480px) {
  #hg-panel {
    bottom: 0; right: 0; left: 0; width: 100%; border-radius: 16px 16px 0 0;
    transform: translateY(100%);
  }
  #hg-panel.hg-open { transform: translateY(0); }
}
.hg-panel-header {
  background: linear-gradient(135deg, #e91e8c 0%, #c2185b 100%);
  color: #fff; padding: 20px;
}
.hg-panel-header .hg-name { font-size: 16px; font-weight: 700; margin-bottom: 4px; }
.hg-panel-header .hg-tier {
  display: inline-block; background: rgba(255,255,255,0.25);
  border-radius: 20px; padding: 2px 10px; font-size: 12px; font-weight: 600;
  text-transform: capitalize;
}
.hg-balance { font-size: 28px; font-weight: 700; margin: 12px 0 4px; }
.hg-panel-body { padding: 16px; }

/* ---- Progress bars ---- */
.hg-progress-label { display: flex; justify-content: space-between; font-size: 12px; color: #888; margin-bottom: 4px; }
.hg-progress-track { background: #f7e8f2; border-radius: 4px; height: 6px; margin-bottom: 12px; overflow: hidden; }
.hg-progress-fill { background: #e91e8c; height: 100%; border-radius: 4px; transition: width 0.5s ease; }

/* ---- Panel CTA buttons ---- */
.hg-btn {
  display: block; width: 100%; text-align: center;
  border-radius: 8px; padding: 10px; font-size: 14px; font-weight: 600;
  cursor: pointer; border: none; text-decoration: none; margin-bottom: 8px;
}
.hg-btn-primary { background: #e91e8c; color: #fff; }
.hg-btn-secondary { background: #f7e8f2; color: #e91e8c; }
.hg-btn:hover { opacity: 0.9; }

/* ---- Referral row ---- */
.hg-referral-row {
  display: flex; align-items: center; gap: 8px; margin-top: 8px;
  background: #f7e8f2; border-radius: 8px; padding: 10px 12px;
  font-size: 13px;
}
.hg-referral-link { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #888; }
.hg-copy-btn { background: #e91e8c; color: #fff; border: none; border-radius: 6px; padding: 4px 10px; font-size: 12px; cursor: pointer; white-space: nowrap; }

/* ---- Nudges ---- */
.hg-nudge {
  position: fixed; z-index: 2147483000;
  background: #fff; border-radius: 12px;
  box-shadow: 0 4px 20px rgba(0,0,0,0.12); border: 1px solid #f7e8f2;
  padding: 16px; max-width: 300px;
  animation: hg-slide-up 0.25s ease forwards;
}
@keyframes hg-slide-up { from{transform:translateY(20px);opacity:0} to{transform:translateY(0);opacity:1} }
.hg-nudge-close {
  position: absolute; top: 8px; right: 10px; background: none; border: none;
  font-size: 18px; cursor: pointer; color: #888; line-height: 1;
}
.hg-nudge-title { font-weight: 700; font-size: 14px; margin-bottom: 6px; color: #1a1a1a; }
.hg-nudge-body { font-size: 13px; color: #555; margin-bottom: 12px; }

/* nudge positions */
.hg-nudge-br { bottom: 86px; right: 24px; }
.hg-nudge-cart { margin: 12px 0; position: static; box-shadow: none; border: 1px solid #f7e8f2; border-radius: 8px; padding: 12px; max-width: 100%; }
.hg-nudge-header { top: 0; left: 0; right: 0; max-width: 100%; border-radius: 0 0 8px 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.08); display: flex; align-items: center; gap: 12px; padding: 10px 16px; }

/* ---- Product embed ---- */
#hg-product-embed {
  display: flex; align-items: center; gap: 8px;
  font-size: 13px; color: #e91e8c; margin: 8px 0;
  padding: 8px 12px; background: #fdf0f8; border-radius: 6px;
}
#hg-product-embed .hg-pts { font-weight: 700; }

/* ---- Cart inline ---- */
#hg-cart-inline {
  margin: 12px 0; padding: 12px; background: #fdf0f8;
  border: 1px solid #f7e8f2; border-radius: 8px; font-size: 13px;
}
`;var S="/apps/loyalty";async function g(){try{let n=await fetch(`${S}/customer`);return n.ok?await n.json():null}catch{return null}}function c(n){return n.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;")}var u={silver:"\u25C8 Silver",gold:"\u2605 Gold",diamond:"\u25C6 Diamond"};function h(n){if(document.getElementById("hg-launcher"))return;let e=document.createElement("button");if(e.id="hg-launcher",e.className="hg-loading",!n.loggedIn||!n.member)e.innerHTML='<span class="hg-icon">\u{1F381}</span><span>Join &amp; Earn</span>',e.addEventListener("click",()=>{window.location.href="/account/register"});else{let{tier:t,balance:r}=n.member;e.className="",e.innerHTML=`
      <span class="hg-icon">\u25C8</span>
      <span class="hg-badge">${u[t]??t}</span>
      <span>${r.toLocaleString()} pts</span>
    `,e.addEventListener("click",_)}document.body.appendChild(e),setTimeout(()=>e.classList.remove("hg-loading"),1500)}function _(){let n=document.getElementById("hg-panel");n&&n.classList.toggle("hg-open")}function m(n){if(document.getElementById("hg-panel")||!n.loggedIn||!n.member)return;let{member:e}=n,t=document.createElement("div");t.id="hg-panel",t.className="hg-widget";let r=Math.min(100,Math.floor(e.lifetimeSpend/5e4*100)),o=Math.min(100,Math.floor(e.lifetimeSpend/1e5*100)),i=e.referralSlug?`heygirl.pk?ref=${e.referralSlug}`:"";t.innerHTML=`
    <div class="hg-panel-header">
      <div class="hg-name">Hi, ${c(e.firstName??"there")}!</div>
      <span class="hg-tier">${u[e.tier]??e.tier}</span>
      <div class="hg-balance">${e.balance.toLocaleString()} pts</div>
    </div>
    <div class="hg-panel-body">
      <div class="hg-progress-label">
        <span>Silver \u2192 Gold</span><span>${r}%</span>
      </div>
      <div class="hg-progress-track">
        <div class="hg-progress-fill" style="width:${r}%"></div>
      </div>
      <div class="hg-progress-label">
        <span>Gold \u2192 Diamond</span><span>${o}%</span>
      </div>
      <div class="hg-progress-track">
        <div class="hg-progress-fill" style="width:${o}%"></div>
      </div>
      ${e.activeCodes.length>0?`
        <div style="margin-bottom:8px;font-size:13px;color:#e91e8c;font-weight:600;">
          \u{1F389} You have ${e.activeCodes.length} active reward${e.activeCodes.length>1?"s":""}!
        </div>`:""}
      <button class="hg-btn hg-btn-primary" id="hg-redeem-btn">Redeem Points</button>
      <button class="hg-btn hg-btn-secondary" id="hg-hub-btn">View Full Dashboard \u2192</button>
      ${i?`
        <div class="hg-referral-row">
          <span class="hg-referral-link">${i}</span>
          <button class="hg-copy-btn" id="hg-copy-ref">Copy</button>
        </div>`:""}
    </div>
  `,document.body.appendChild(t),t.querySelector("#hg-hub-btn")?.addEventListener("click",()=>{let s=window.__hgOpenHub;typeof s=="function"?s():window.location.href="/pages/rewards",t.classList.remove("hg-open")}),t.querySelector("#hg-redeem-btn")?.addEventListener("click",()=>{let s=window.__hgOpenHub;typeof s=="function"&&s(0),t.classList.remove("hg-open")}),t.querySelector("#hg-copy-ref")?.addEventListener("click",s=>{let d=s.currentTarget;navigator.clipboard?.writeText(`https://${i}`).then(()=>{d.textContent="Copied!",setTimeout(()=>{d.textContent="Copy"},2e3)})}),document.addEventListener("click",s=>{let d=document.getElementById("hg-launcher");!t.contains(s.target)&&s.target!==d&&t.classList.remove("hg-open")})}var b="hg_nudge1_shown",x="hg_nudge5_shown";function y(n,e){let t=n.nudgeSettings;if(t.nudge1_enabled&&!n.loggedIn&&!localStorage.getItem(b)&&setTimeout(()=>E(),3e3),e==="cart"&&n.loggedIn&&n.member){let{balance:r,activeCodes:o}=n.member;t.nudge3_enabled&&o.length>0?L(o[0]):t.nudge2_enabled&&r>=3e3&&C(r)}if(t.nudge5_enabled&&n.loggedIn&&n.member&&(e==="product"||e==="other")&&!sessionStorage.getItem(x)){let{member:r}=n;r.nextTier==="gold"&&r.spendToNextTier<=t.tier_progress_gold_threshold?f(`Only Rs.${r.spendToNextTier.toLocaleString()} away from Gold tier!`):r.nextTier==="diamond"&&r.spendToNextTier<=t.tier_progress_diamond_threshold&&f(`Only Rs.${r.spendToNextTier.toLocaleString()} away from Diamond tier!`)}}function E(){let n=l("Earn points on every purchase","Sign up free and start earning Rs. rewards on every order at HeyGirl.pk.","Join & Earn","hg-nudge-br",()=>{window.location.href="/account/register"});document.body.appendChild(n),localStorage.setItem(b,"1")}function C(n){let e=w();if(!e)return;let t=l(`You have ${n.toLocaleString()} pts to spend`,"Redeem your points for a discount before checking out.","Redeem Now","hg-nudge-cart",()=>{let r=window.__hgOpenHub;typeof r=="function"&&r(0)});e.insertAdjacentElement("beforebegin",t)}function L(n){let e=w();if(!e)return;let t=l(`You have an unused Rs.${n.discount_pkr} reward!`,`Apply code <strong>${c(n.code)}</strong> at checkout to save.`,"Copy Code","hg-nudge-cart",()=>{navigator.clipboard?.writeText(n.code)});e.insertAdjacentElement("beforebegin",t)}function f(n){let e=l("You're close to the next tier!",n,"View Tiers","hg-nudge-header",()=>{window.location.href="/pages/rewards"});document.body.prepend(e),sessionStorage.setItem(x,"1")}function w(){return document.querySelector(".cart__ctas")??document.querySelector('[name="checkout"]')?.closest("div")??document.querySelector(".cart")}function l(n,e,t,r,o){let i=document.createElement("div");return i.className=`hg-nudge hg-widget ${r}`,i.innerHTML=`
    <button class="hg-nudge-close" aria-label="Close">\xD7</button>
    <div class="hg-nudge-title">${n}</div>
    <div class="hg-nudge-body">${e}</div>
    <button class="hg-btn hg-btn-primary">${t}</button>
  `,i.querySelector(".hg-nudge-close")?.addEventListener("click",()=>i.remove()),i.querySelector(".hg-btn")?.addEventListener("click",()=>{o(),i.remove()}),i}function v(n){if(document.getElementById("hg-product-embed"))return;let e=window.ShopifyAnalytics?.meta?.product?.price??0,r=Math.floor(e/100),o=document.createElement("div");o.id="hg-product-embed",o.className="hg-widget",n.loggedIn?o.innerHTML=`<span>\u{1F381}</span> Earn <span class="hg-pts">${r.toLocaleString()} pts</span> on this purchase`:o.innerHTML=`<span>\u{1F381}</span> <a href="/account/login" style="color:#e91e8c;text-decoration:underline;">Sign in to earn ${r.toLocaleString()} pts</a> on this purchase`;let i=document.querySelector(".price__container")??document.querySelector(".product__info-wrapper .price")??document.querySelector("[data-product-price]");i&&i.insertAdjacentElement("afterend",o)}function k(n){if(document.getElementById("hg-cart-inline"))return;let e=document.createElement("div");if(e.id="hg-cart-inline",e.className="hg-widget",!n.loggedIn||!n.member)e.innerHTML='<span>\u{1F381}</span> <a href="/account/login" style="color:#e91e8c;">Sign in</a> to earn &amp; redeem rewards.';else{let{balance:r,activeCodes:o}=n.member,i=R(),s=i.some(a=>a.startsWith("REWARD-")),d=i.some(a=>!a.startsWith("REWARD-"));if(s)e.innerHTML="<span>\u2705</span> Your loyalty reward is applied. Enjoy the savings!";else if(d)e.innerHTML="<span>\u2139\uFE0F</span> A discount is already applied. Loyalty codes cannot stack.";else if(o.length>0){let a=o[0];e.innerHTML=`
        <div style="margin-bottom:6px;font-weight:600;">\u{1F389} You have a Rs.${a.discount_pkr} reward ready!</div>
        <div style="font-size:12px;color:#888;margin-bottom:8px;">Code: <strong>${a.code}</strong></div>
        <button class="hg-btn hg-btn-primary" id="hg-apply-code" style="margin:0;padding:8px;">Apply Code</button>
      `,setTimeout(()=>{document.getElementById("hg-apply-code")?.addEventListener("click",()=>{window.location.href=`/discount/${a.code}?redirect=/cart`})},0)}else if(r>=3e3)e.innerHTML=`
        <div style="margin-bottom:4px;font-weight:600;">\u{1F48E} You have ${r.toLocaleString()} pts to redeem!</div>
        <div style="font-size:12px;color:#888;margin-bottom:8px;">Earn a reward code and apply it here.</div>
        <button class="hg-btn hg-btn-secondary" id="hg-open-redeem" style="margin:0;padding:8px;">Redeem Points</button>
      `,setTimeout(()=>{document.getElementById("hg-open-redeem")?.addEventListener("click",()=>{let a=window.__hgOpenHub;typeof a=="function"&&a(0)})},0);else{let a=3e3-r;e.innerHTML=`<span>\u{1F381}</span> Earn <strong>${a.toLocaleString()} more pts</strong> to unlock your first reward.`}}let t=document.querySelector('[name="checkout"]')??document.querySelector(".cart__checkout");t&&t.insertAdjacentElement("beforebegin",e)}function R(){let n=window.Shopify?.checkout;return n?.discount?.applicable&&n.discount.code?[n.discount.code]:[]}(function(){"use strict";function n(){if(document.getElementById("hg-styles"))return;let o=document.createElement("style");o.id="hg-styles",o.textContent=p,document.head.appendChild(o)}function e(){let o=window.location.pathname;return o==="/pages/rewards"?"rewards":o.startsWith("/products/")?"product":o==="/cart"?"cart":"other"}async function t(){try{n();let o=e(),i=await g();if(!i)return;o!=="rewards"&&(h(i),m(i)),i.nudgeSettings&&y(i,o),o==="product"&&v(i),o==="cart"&&k(i),o==="rewards"&&void 0}catch{}}function r(o){}window.__hgOpenHub=null,document.readyState==="loading"?document.addEventListener("DOMContentLoaded",t):t()})();})();
