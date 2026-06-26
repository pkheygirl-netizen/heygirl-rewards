"use strict";var __LOYALTY_WIDGET__=(()=>{var v=`
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

/* ---- Loyalty Hub overlay ---- */
#hg-hub-overlay {
  position: fixed; inset: 0; z-index: 2147483010;
  background: rgba(0,0,0,0.5); display: none; align-items: flex-end;
  justify-content: center;
}
#hg-hub-overlay.hg-open { display: flex; }
@media (min-width: 640px) {
  #hg-hub-overlay { align-items: center; }
}
#hg-hub {
  background: #fff; width: 100%; max-width: 540px;
  max-height: 90vh; border-radius: 20px 20px 0 0;
  overflow: hidden; display: flex; flex-direction: column;
  box-shadow: 0 -4px 40px rgba(0,0,0,0.2);
}
@media (min-width: 640px) {
  #hg-hub { border-radius: 20px; max-height: 85vh; }
}
.hg-hub-header {
  background: linear-gradient(135deg, #e91e8c 0%, #c2185b 100%);
  color: #fff; padding: 20px 20px 0;
  flex-shrink: 0;
}
.hg-hub-header-top {
  display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 16px;
}
.hg-hub-name { font-size: 16px; font-weight: 700; }
.hg-hub-balance { font-size: 28px; font-weight: 800; }
.hg-hub-tier {
  display: inline-block; background: rgba(255,255,255,0.25);
  border-radius: 20px; padding: 2px 10px; font-size: 12px;
  font-weight: 600; text-transform: capitalize; margin-top: 4px;
}
.hg-hub-close {
  background: rgba(255,255,255,0.2); border: none; color: #fff;
  border-radius: 50%; width: 30px; height: 30px; font-size: 18px;
  cursor: pointer; display: flex; align-items: center; justify-content: center;
}
.hg-tabs {
  display: flex; border-bottom: none; padding: 0 4px;
}
.hg-tab {
  flex: 1; background: none; border: none; color: rgba(255,255,255,0.7);
  font-size: 12px; font-weight: 600; padding: 10px 4px;
  cursor: pointer; border-bottom: 3px solid transparent;
  transition: color 0.15s, border-color 0.15s;
}
.hg-tab.hg-active { color: #fff; border-bottom-color: #fff; }
.hg-hub-body { flex: 1; overflow-y: auto; padding: 20px; }
.hg-tab-panel { display: none; }
.hg-tab-panel.hg-active { display: block; }

/* Redemption tiles */
.hg-redeem-grid {
  display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; margin-bottom: 20px;
}
.hg-redeem-tile {
  background: #fdf0f8; border: 1.5px solid #f7e8f2; border-radius: 10px;
  padding: 12px 8px; text-align: center; cursor: pointer;
  transition: border-color 0.15s, transform 0.1s;
}
.hg-redeem-tile:hover { border-color: #e91e8c; transform: translateY(-2px); }
.hg-redeem-tile.hg-disabled { opacity: 0.4; cursor: not-allowed; }
.hg-redeem-tile .hg-tile-pts { font-size: 13px; font-weight: 700; color: #e91e8c; }
.hg-redeem-tile .hg-tile-val { font-size: 15px; font-weight: 800; color: #1a1a1a; margin: 4px 0; }
.hg-redeem-tile .hg-tile-label { font-size: 10px; color: #888; }

/* History list */
.hg-history-filter {
  display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 16px;
}
.hg-filter-btn {
  background: #f7e8f2; border: none; border-radius: 20px; padding: 4px 12px;
  font-size: 12px; cursor: pointer; color: #1a1a1a;
}
.hg-filter-btn.hg-active { background: #e91e8c; color: #fff; }
.hg-history-item {
  display: flex; justify-content: space-between; align-items: center;
  padding: 10px 0; border-bottom: 1px solid #f7e8f2; font-size: 13px;
}
.hg-history-item:last-child { border-bottom: none; }
.hg-history-delta { font-weight: 700; }
.hg-history-delta.hg-positive { color: #2e7d32; }
.hg-history-delta.hg-negative { color: #c62828; }
.hg-pagination { display: flex; gap: 8px; justify-content: center; margin-top: 16px; }
.hg-page-btn { background: #f7e8f2; border: none; border-radius: 6px; padding: 6px 14px; cursor: pointer; font-size: 13px; }
.hg-page-btn:disabled { opacity: 0.4; cursor: not-allowed; }

/* Referral section */
.hg-referral-card { background: #fdf0f8; border-radius: 12px; padding: 16px; margin-bottom: 16px; }
.hg-share-row { display: flex; gap: 8px; margin-top: 10px; flex-wrap: wrap; }
.hg-share-btn { flex: 1; min-width: 80px; padding: 8px; border-radius: 8px; border: none; font-size: 12px; font-weight: 600; cursor: pointer; }
.hg-share-whatsapp { background: #25d366; color: #fff; }
.hg-share-copy { background: #e91e8c; color: #fff; }
.hg-referral-stats { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; margin-bottom: 16px; }
.hg-stat-card { background: #f7e8f2; border-radius: 8px; padding: 10px; text-align: center; }
.hg-stat-val { font-size: 20px; font-weight: 800; color: #e91e8c; }
.hg-stat-label { font-size: 11px; color: #888; margin-top: 2px; }

/* My Rewards tab */
.hg-rewards-hero {
  background: linear-gradient(135deg, #e91e8c 0%, #c2185b 100%);
  border-radius: 14px; padding: 18px; margin-bottom: 20px; color: #fff;
}
.hg-rewards-pts { font-size: 36px; font-weight: 800; line-height: 1; }
.hg-rewards-pts-label { font-size: 13px; opacity: 0.85; margin-top: 2px; }
.hg-section { margin-bottom: 20px; }
.hg-section-title { font-weight: 700; font-size: 14px; margin-bottom: 10px; }
.hg-active-code-row {
  background: #fdf0f8; border-radius: 8px; padding: 10px 12px;
  margin-bottom: 8px; display: flex; justify-content: space-between;
  align-items: center; font-size: 13px;
}
.hg-redeem-msg {
  min-height: 24px; font-size: 13px; text-align: center; margin: 0 0 16px;
}
.hg-birthday-card {
  background: linear-gradient(135deg, #fdf0f8, #f7e8f2);
  border-radius: 12px; padding: 14px; margin-bottom: 20px;
  border: 1px solid #f0d0e8;
}
.hg-reward-room {
  background: #1a1a1a; border-radius: 12px; padding: 16px;
  text-align: center; color: #fff; margin-bottom: 8px;
}
.hg-reward-room-btn {
  background: #e91e8c; color: #fff; opacity: 0.75;
  margin: 0; cursor: pointer;
}
.hg-coming-soon-tip {
  background: #333; color: #fff; border-radius: 6px;
  padding: 6px 12px; font-size: 12px; text-align: center;
  margin-top: 8px; animation: hg-slide-up 0.2s ease;
}

/* VIP tiers */
.hg-tier-cards { display: flex; flex-direction: column; gap: 12px; }
.hg-tier-card { border: 2px solid #f7e8f2; border-radius: 12px; padding: 16px; }
.hg-tier-card.hg-current-tier { border-color: #e91e8c; }
.hg-tier-card-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; }
.hg-tier-name { font-size: 16px; font-weight: 800; }
.hg-current-badge {
  background: #e91e8c; color: #fff; border-radius: 20px;
  padding: 2px 8px; font-size: 11px; font-weight: 600;
}
.hg-tier-benefit { font-size: 12px; color: #555; margin: 3px 0; }
.hg-tier-progress-section { margin-top: 16px; padding-top: 16px; border-top: 1px solid #f7e8f2; }
`;var w="/apps/loyalty";async function k(){try{let e=await fetch(`${w}/customer`);return e.ok?await e.json():null}catch{return null}}async function L(e){try{return await(await fetch(`${w}/redeem`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({requestedPoints:e})})).json()}catch{return{redeemed:!1,error:"network_error"}}}function h(e){return e.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;")}var S={silver:"\u25C8 Silver",gold:"\u2605 Gold",diamond:"\u25C6 Diamond"};function E(e){if(document.getElementById("hg-launcher"))return;let t=document.createElement("button");if(t.id="hg-launcher",t.className="hg-loading",!e.loggedIn||!e.member)t.innerHTML='<span class="hg-icon">\u{1F381}</span><span>Join &amp; Earn</span>',t.addEventListener("click",()=>{window.location.href="/account/register"});else{let{tier:o,balance:n}=e.member;t.className="",t.innerHTML=`
      <span class="hg-icon">\u25C8</span>
      <span class="hg-badge">${S[o]??o}</span>
      <span>${n.toLocaleString()} pts</span>
    `,t.addEventListener("click",G)}document.body.appendChild(t),setTimeout(()=>t.classList.remove("hg-loading"),1500)}function G(){let e=document.getElementById("hg-panel");e&&e.classList.toggle("hg-open")}function T(e){if(document.getElementById("hg-panel")||!e.loggedIn||!e.member)return;let{member:t}=e,o=document.createElement("div");o.id="hg-panel",o.className="hg-widget";let n=Math.min(100,Math.floor(t.lifetimeSpend/5e4*100)),r=Math.min(100,Math.floor(t.lifetimeSpend/1e5*100)),d=t.referralSlug?`heygirl.pk?ref=${t.referralSlug}`:"";o.innerHTML=`
    <div class="hg-panel-header">
      <div class="hg-name">Hi, ${h(t.firstName??"there")}!</div>
      <span class="hg-tier">${S[t.tier]??t.tier}</span>
      <div class="hg-balance">${t.balance.toLocaleString()} pts</div>
    </div>
    <div class="hg-panel-body">
      <div class="hg-progress-label">
        <span>Silver \u2192 Gold</span><span>${n}%</span>
      </div>
      <div class="hg-progress-track">
        <div class="hg-progress-fill" style="width:${n}%"></div>
      </div>
      <div class="hg-progress-label">
        <span>Gold \u2192 Diamond</span><span>${r}%</span>
      </div>
      <div class="hg-progress-track">
        <div class="hg-progress-fill" style="width:${r}%"></div>
      </div>
      ${t.activeCodes.length>0?`
        <div style="margin-bottom:8px;font-size:13px;color:#e91e8c;font-weight:600;">
          \u{1F389} You have ${t.activeCodes.length} active reward${t.activeCodes.length>1?"s":""}!
        </div>`:""}
      <button class="hg-btn hg-btn-primary" id="hg-redeem-btn">Redeem Points</button>
      <button class="hg-btn hg-btn-secondary" id="hg-hub-btn">View Full Dashboard \u2192</button>
      ${d?`
        <div class="hg-referral-row">
          <span class="hg-referral-link">${d}</span>
          <button class="hg-copy-btn" id="hg-copy-ref">Copy</button>
        </div>`:""}
    </div>
  `,document.body.appendChild(o),o.querySelector("#hg-hub-btn")?.addEventListener("click",()=>{let i=window.__hgOpenHub;typeof i=="function"?i():window.location.href="/pages/rewards",o.classList.remove("hg-open")}),o.querySelector("#hg-redeem-btn")?.addEventListener("click",()=>{let i=window.__hgOpenHub;typeof i=="function"&&i(0),o.classList.remove("hg-open")}),o.querySelector("#hg-copy-ref")?.addEventListener("click",i=>{let a=i.currentTarget;navigator.clipboard?.writeText(`https://${d}`).then(()=>{a.textContent="Copied!",setTimeout(()=>{a.textContent="Copy"},2e3)})}),document.addEventListener("click",i=>{let a=document.getElementById("hg-launcher");!o.contains(i.target)&&i.target!==a&&o.classList.remove("hg-open")})}var C="hg_nudge1_shown",R="hg_nudge5_shown";function _(e,t){let o=e.nudgeSettings;if(o.nudge1_enabled&&!e.loggedIn&&!localStorage.getItem(C)&&setTimeout(()=>F(),3e3),t==="cart"&&e.loggedIn&&e.member){let{balance:n,activeCodes:r}=e.member;o.nudge3_enabled&&r.length>0?W(r[0]):o.nudge2_enabled&&n>=3e3&&J(n)}if(o.nudge5_enabled&&e.loggedIn&&e.member&&(t==="product"||t==="other")&&!sessionStorage.getItem(R)){let{member:n}=e;n.nextTier==="gold"&&n.spendToNextTier<=o.tier_progress_gold_threshold?$(`Only Rs.${n.spendToNextTier.toLocaleString()} away from Gold tier!`):n.nextTier==="diamond"&&n.spendToNextTier<=o.tier_progress_diamond_threshold&&$(`Only Rs.${n.spendToNextTier.toLocaleString()} away from Diamond tier!`)}}function F(){let e=f("Earn points on every purchase","Sign up free and start earning Rs. rewards on every order at HeyGirl.pk.","Join & Earn","hg-nudge-br",()=>{window.location.href="/account/register"});document.body.appendChild(e),localStorage.setItem(C,"1")}function J(e){let t=H();if(!t)return;let o=f(`You have ${e.toLocaleString()} pts to spend`,"Redeem your points for a discount before checking out.","Redeem Now","hg-nudge-cart",()=>{let n=window.__hgOpenHub;typeof n=="function"&&n(0)});t.insertAdjacentElement("beforebegin",o)}function W(e){let t=H();if(!t)return;let o=f(`You have an unused Rs.${e.discount_pkr} reward!`,`Apply code <strong>${h(e.code)}</strong> at checkout to save.`,"Copy Code","hg-nudge-cart",()=>{navigator.clipboard?.writeText(e.code)});t.insertAdjacentElement("beforebegin",o)}function $(e){let t=f("You're close to the next tier!",e,"View Tiers","hg-nudge-header",()=>{window.location.href="/pages/rewards"});document.body.prepend(t),sessionStorage.setItem(R,"1")}function H(){return document.querySelector(".cart__ctas")??document.querySelector('[name="checkout"]')?.closest("div")??document.querySelector(".cart")}function f(e,t,o,n,r){let d=document.createElement("div");return d.className=`hg-nudge hg-widget ${n}`,d.innerHTML=`
    <button class="hg-nudge-close" aria-label="Close">\xD7</button>
    <div class="hg-nudge-title">${e}</div>
    <div class="hg-nudge-body">${t}</div>
    <button class="hg-btn hg-btn-primary">${o}</button>
  `,d.querySelector(".hg-nudge-close")?.addEventListener("click",()=>d.remove()),d.querySelector(".hg-btn")?.addEventListener("click",()=>{r(),d.remove()}),d}function M(e){if(document.getElementById("hg-product-embed"))return;let t=window.ShopifyAnalytics?.meta?.product?.price??0,n=Math.floor(t/100),r=document.createElement("div");r.id="hg-product-embed",r.className="hg-widget",e.loggedIn?r.innerHTML=`<span>\u{1F381}</span> Earn <span class="hg-pts">${n.toLocaleString()} pts</span> on this purchase`:r.innerHTML=`<span>\u{1F381}</span> <a href="/account/login" style="color:#e91e8c;text-decoration:underline;">Sign in to earn ${n.toLocaleString()} pts</a> on this purchase`;let d=document.querySelector(".price__container")??document.querySelector(".product__info-wrapper .price")??document.querySelector("[data-product-price]");d&&d.insertAdjacentElement("afterend",r)}function z(e){if(document.getElementById("hg-cart-inline"))return;let t=document.createElement("div");if(t.id="hg-cart-inline",t.className="hg-widget",!e.loggedIn||!e.member)t.innerHTML='<span>\u{1F381}</span> <a href="/account/login" style="color:#e91e8c;">Sign in</a> to earn &amp; redeem rewards.';else{let{balance:n,activeCodes:r}=e.member,d=V(),i=d.some(c=>c.startsWith("REWARD-")),a=d.some(c=>!c.startsWith("REWARD-"));if(i)t.innerHTML="<span>\u2705</span> Your loyalty reward is applied. Enjoy the savings!";else if(a)t.innerHTML="<span>\u2139\uFE0F</span> A discount is already applied. Loyalty codes cannot stack.";else if(r.length>0){let c=r[0];t.innerHTML=`
        <div style="margin-bottom:6px;font-weight:600;">\u{1F389} You have a Rs.${c.discount_pkr} reward ready!</div>
        <div style="font-size:12px;color:#888;margin-bottom:8px;">Code: <strong>${c.code}</strong></div>
        <button class="hg-btn hg-btn-primary" id="hg-apply-code" style="margin:0;padding:8px;">Apply Code</button>
      `,setTimeout(()=>{document.getElementById("hg-apply-code")?.addEventListener("click",()=>{window.location.href=`/discount/${c.code}?redirect=/cart`})},0)}else if(n>=3e3)t.innerHTML=`
        <div style="margin-bottom:4px;font-weight:600;">\u{1F48E} You have ${n.toLocaleString()} pts to redeem!</div>
        <div style="font-size:12px;color:#888;margin-bottom:8px;">Earn a reward code and apply it here.</div>
        <button class="hg-btn hg-btn-secondary" id="hg-open-redeem" style="margin:0;padding:8px;">Redeem Points</button>
      `,setTimeout(()=>{document.getElementById("hg-open-redeem")?.addEventListener("click",()=>{let c=window.__hgOpenHub;typeof c=="function"&&c(0)})},0);else{let c=3e3-n;t.innerHTML=`<span>\u{1F381}</span> Earn <strong>${c.toLocaleString()} more pts</strong> to unlock your first reward.`}}let o=document.querySelector('[name="checkout"]')??document.querySelector(".cart__checkout");o&&o.insertAdjacentElement("beforebegin",t)}function V(){let e=window.Shopify?.checkout;return e?.discount?.applicable&&e.discount.code?[e.discount.code]:[]}var U=[{points:3e3,discount_pkr:100},{points:6e3,discount_pkr:250},{points:11500,discount_pkr:500},{points:22e3,discount_pkr:1e3},{points:1e5,discount_pkr:5e3},{points:18e4,discount_pkr:1e4}],K=["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"],Q={silver:"Rs.250 gift code",gold:"Rs.500 gift code",diamond:"Rs.1,000 code + 1.2\xD7 points all month"};function N(e,t){if(!t.member){e.innerHTML="<p style='color:#888;padding:20px 0;'>Please log in to view rewards.</p>";return}let{member:o}=t,n=new Date().getMonth()+1,r=t.nudgeSettings?.tier_progress_gold_threshold??5e4,d=t.nudgeSettings?.tier_progress_diamond_threshold??1e5,i=Math.min(100,Math.round(o.lifetimeSpend/r*100)),a=Math.min(100,Math.round(o.lifetimeSpend/d*100)),c=`
    <div class="hg-rewards-hero">
      <div class="hg-rewards-pts">${o.balance.toLocaleString()}</div>
      <div class="hg-rewards-pts-label">points available</div>
      <div class="hg-progress-label" style="margin-top:14px;">
        <span>\u2605 Gold (Rs.${r.toLocaleString()})</span>
        <span>${i}%</span>
      </div>
      <div class="hg-progress-track">
        <div class="hg-progress-fill" style="width:${i}%"></div>
      </div>
      <div class="hg-progress-label">
        <span>\u25C6 Diamond (Rs.${d.toLocaleString()})</span>
        <span>${a}%</span>
      </div>
      <div class="hg-progress-track">
        <div class="hg-progress-fill" style="width:${a}%;background:linear-gradient(90deg,#9c27b0,#e91e8c)"></div>
      </div>
      ${o.nextTier?`<div style="font-size:12px;color:rgba(255,255,255,0.8);margin-top:4px;">Rs.${o.spendToNextTier.toLocaleString()} more to reach ${o.nextTier}</div>`:`<div style="font-size:12px;color:rgba(255,255,255,0.8);margin-top:4px;">You've reached the top tier! \u{1F389}</div>`}
    </div>
  `,m=o.activeCodes.length>0?`<div class="hg-section">
        <div class="hg-section-title">\u{1F389} Active Rewards</div>
        ${o.activeCodes.map(s=>{let p=h(s.code);return`
          <div class="hg-active-code-row">
            <div>
              <strong>${p}</strong>
              <div style="color:#888;font-size:11px;">Rs.${s.discount_pkr} off &middot; expires ${new Date(s.expires_at).toLocaleDateString()}</div>
            </div>
            <button class="hg-copy-btn hg-copy-code" data-code="${p}">Copy</button>
          </div>`}).join("")}
      </div>`:`<div class="hg-section">
        <div class="hg-section-title">Active Rewards</div>
        <p style="color:#888;font-size:13px;text-align:center;padding:12px 0;">No active codes \u2014 redeem points below!</p>
      </div>`,B=U.map(s=>{let p=o.balance>=s.points,l=s.points%1e3===500?`${(s.points/1e3).toFixed(1)}k`:`${s.points/1e3}k`;return`
      <div class="hg-redeem-tile${p?"":" hg-disabled"}" data-points="${s.points}" data-pkr="${s.discount_pkr}" role="button" tabindex="${p?0:-1}">
        <div class="hg-tile-pts">${l} pts</div>
        <div class="hg-tile-val">Rs.${s.discount_pkr.toLocaleString()}</div>
        <div class="hg-tile-label">${p?"Tap to redeem":`Need ${(s.points-o.balance).toLocaleString()} more`}</div>
      </div>`}).join(""),D=o.birthdayMonth&&o.birthdayMonth===n?`<div class="hg-birthday-card">
        <div style="font-weight:700;font-size:15px;margin-bottom:6px;">\u{1F382} Happy Birthday Month!</div>
        <div style="font-size:13px;color:#555;">
          Your ${K[o.birthdayMonth-1]} reward: <strong>${Q[o.tier]??"a special gift"}</strong>
        </div>
      </div>`:"",Y=`
    <div class="hg-reward-room">
      <div style="font-size:16px;font-weight:700;margin-bottom:4px;">\u{1F3C6} Reward Room</div>
      <div style="font-size:13px;color:#aaa;margin-bottom:12px;">Exclusive products redeemable with points \u2014 coming soon!</div>
      <button class="hg-btn hg-reward-room-btn">Enter Reward Room \u2192</button>
    </div>`;e.innerHTML=`
    ${c}
    ${m}
    <div class="hg-section">
      <div class="hg-section-title">Redeem Points</div>
      <div class="hg-redeem-grid" id="hg-redeem-grid">${B}</div>
      <div id="hg-redeem-msg" class="hg-redeem-msg"></div>
    </div>
    ${D}
    ${Y}
  `,e.querySelectorAll(".hg-copy-code").forEach(s=>{s.addEventListener("click",()=>{let p=s.dataset.code??"";navigator.clipboard?.writeText(p).catch(()=>{}),s.textContent="Copied!",setTimeout(()=>{s.textContent="Copy"},2e3)})});let g=e.querySelector("#hg-redeem-msg");e.querySelectorAll(".hg-redeem-tile:not(.hg-disabled)").forEach(s=>{s.addEventListener("click",async()=>{let p=Number(s.dataset.points),l=Number(s.dataset.pkr);g.textContent="Generating your reward code\u2026",g.style.color="#888",s.classList.add("hg-disabled");let u=await L(p);if(u.redeemed&&u.code){let x=h(u.code),O=u.discount_pkr??l;g.innerHTML=`\u2705 Code <strong>${x}</strong> \u2014 Rs.${O.toLocaleString()} off! <button class="hg-copy-btn hg-copy-result" data-code="${x}">Copy</button>`,g.style.color="#2e7d32";let y=document.querySelector(".hg-hub-balance");y&&(y.textContent=`${Math.max(0,o.balance-p).toLocaleString()} pts`),o.balance=Math.max(0,o.balance-p);let b=g.querySelector(".hg-copy-result");b?.addEventListener("click",()=>{navigator.clipboard?.writeText(u.code).catch(()=>{}),b.textContent="Copied!",setTimeout(()=>{b.textContent="Copy"},2e3)})}else g.textContent=`Failed: ${u.error??"unknown error"}`,g.style.color="#c62828",s.classList.remove("hg-disabled")})}),e.querySelector(".hg-reward-room-btn")?.addEventListener("click",s=>{if(s.preventDefault(),e.querySelector(".hg-coming-soon-tip"))return;let l=document.createElement("div");l.className="hg-coming-soon-tip",l.textContent="Coming Soon! \u{1F680}",s.currentTarget.insertAdjacentElement("afterend",l),setTimeout(()=>l.remove(),2500)})}function A(e,t){e.innerHTML="<p>Loading\u2026</p>"}function I(e,t){e.innerHTML="<p>Loading\u2026</p>"}function P(e,t){e.innerHTML="<p>Loading\u2026</p>"}var q=["My Rewards","History","Referrals","VIP Tiers"],X={silver:"\u25C8 Silver",gold:"\u2605 Gold",diamond:"\u25C6 Diamond"};function j(e){if(!e.loggedIn||!e.member)return;let{member:t}=e,o=document.createElement("div");o.id="hg-hub-overlay",o.className="hg-widget";let n=document.createElement("div");n.id="hg-hub",n.innerHTML=`
    <div class="hg-hub-header">
      <div class="hg-hub-header-top">
        <div>
          <div class="hg-hub-name">Hi, ${t.firstName??"there"}!</div>
          <div class="hg-hub-balance">${t.balance.toLocaleString()} pts</div>
          <span class="hg-hub-tier">${X[t.tier]??t.tier}</span>
        </div>
        <button class="hg-hub-close" id="hg-hub-close" aria-label="Close">\xD7</button>
      </div>
      <div class="hg-tabs">
        ${q.map((i,a)=>`
          <button class="hg-tab${a===0?" hg-active":""}" data-tab="${a}">${i}</button>
        `).join("")}
      </div>
    </div>
    <div class="hg-hub-body">
      ${q.map((i,a)=>`<div class="hg-tab-panel${a===0?" hg-active":""}" id="hg-panel-${a}"></div>`).join("")}
    </div>
  `,o.appendChild(n),document.body.appendChild(o),N(document.getElementById("hg-panel-0"),e);let r=new Set([0]);n.querySelectorAll(".hg-tab").forEach(i=>{i.addEventListener("click",()=>{let a=Number(i.dataset.tab);n.querySelectorAll(".hg-tab").forEach(m=>m.classList.remove("hg-active")),i.classList.add("hg-active"),n.querySelectorAll(".hg-tab-panel").forEach(m=>m.classList.remove("hg-active"));let c=document.getElementById(`hg-panel-${a}`);c.classList.add("hg-active"),r.has(a)||(r.add(a),a===1&&A(c,e),a===2&&I(c,e),a===3&&P(c,e))})}),n.querySelector("#hg-hub-close")?.addEventListener("click",d),o.addEventListener("click",i=>{i.target===o&&d()}),window.__hgOpenHub=(i=0)=>{o.classList.add("hg-open");let a=n.querySelector(`[data-tab="${i}"]`);a&&a.click(),document.body.style.overflow="hidden"};function d(){o.classList.remove("hg-open"),document.body.style.overflow=""}}(function(){"use strict";function e(){if(document.getElementById("hg-styles"))return;let n=document.createElement("style");n.id="hg-styles",n.textContent=v,document.head.appendChild(n)}function t(){let n=window.location.pathname;return n==="/pages/rewards"?"rewards":n.startsWith("/products/")?"product":n==="/cart"?"cart":"other"}async function o(){try{e();let n=t(),r=await k();if(!r)return;n!=="rewards"&&(E(r),T(r),j(r)),r.nudgeSettings&&_(r,n),n==="product"&&M(r),n==="cart"&&z(r),n==="rewards"&&void 0}catch{}}document.readyState==="loading"?document.addEventListener("DOMContentLoaded",o):o()})();})();
