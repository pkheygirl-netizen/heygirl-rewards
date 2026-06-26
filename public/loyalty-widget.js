"use strict";var __LOYALTY_WIDGET__=(()=>{var S=`
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

/* Skeleton loader rows */
.hg-skel {
  display: inline-block; background: #f0e0ea;
  animation: hg-pulse 1.2s ease-in-out infinite;
}
.hg-skeleton-row { opacity: 0.8; }

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
`;var w="/apps/loyalty";async function $(){try{let e=await fetch(`${w}/customer`);return e.ok?await e.json():null}catch{return null}}async function E(e=1,n=null){try{let t=new URLSearchParams({page:String(e)});n&&t.set("type",n);let o=await fetch(`${w}/history?${t}`);return o.ok?await o.json():{items:[],total:0}}catch{return{items:[],total:0}}}async function T(e){try{return await(await fetch(`${w}/redeem`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({requestedPoints:e})})).json()}catch{return{redeemed:!1,error:"network_error"}}}function p(e){return e.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;")}var _={silver:"\u25C8 Silver",gold:"\u2605 Gold",diamond:"\u25C6 Diamond"};function R(e){if(document.getElementById("hg-launcher"))return;let n=document.createElement("button");if(n.id="hg-launcher",n.className="hg-loading",!e.loggedIn||!e.member)n.innerHTML='<span class="hg-icon">\u{1F381}</span><span>Join &amp; Earn</span>',n.addEventListener("click",()=>{window.location.href="/account/register"});else{let{tier:t,balance:o}=e.member;n.className="",n.innerHTML=`
      <span class="hg-icon">\u25C8</span>
      <span class="hg-badge">${_[t]??t}</span>
      <span>${o.toLocaleString()} pts</span>
    `,n.addEventListener("click",J)}document.body.appendChild(n),setTimeout(()=>n.classList.remove("hg-loading"),1500)}function J(){let e=document.getElementById("hg-panel");e&&e.classList.toggle("hg-open")}function C(e){if(document.getElementById("hg-panel")||!e.loggedIn||!e.member)return;let{member:n}=e,t=document.createElement("div");t.id="hg-panel",t.className="hg-widget";let o=Math.min(100,Math.floor(n.lifetimeSpend/5e4*100)),r=Math.min(100,Math.floor(n.lifetimeSpend/1e5*100)),i=n.referralSlug?`heygirl.pk?ref=${n.referralSlug}`:"";t.innerHTML=`
    <div class="hg-panel-header">
      <div class="hg-name">Hi, ${p(n.firstName??"there")}!</div>
      <span class="hg-tier">${_[n.tier]??n.tier}</span>
      <div class="hg-balance">${n.balance.toLocaleString()} pts</div>
    </div>
    <div class="hg-panel-body">
      <div class="hg-progress-label">
        <span>Silver \u2192 Gold</span><span>${o}%</span>
      </div>
      <div class="hg-progress-track">
        <div class="hg-progress-fill" style="width:${o}%"></div>
      </div>
      <div class="hg-progress-label">
        <span>Gold \u2192 Diamond</span><span>${r}%</span>
      </div>
      <div class="hg-progress-track">
        <div class="hg-progress-fill" style="width:${r}%"></div>
      </div>
      ${n.activeCodes.length>0?`
        <div style="margin-bottom:8px;font-size:13px;color:#e91e8c;font-weight:600;">
          \u{1F389} You have ${n.activeCodes.length} active reward${n.activeCodes.length>1?"s":""}!
        </div>`:""}
      <button class="hg-btn hg-btn-primary" id="hg-redeem-btn">Redeem Points</button>
      <button class="hg-btn hg-btn-secondary" id="hg-hub-btn">View Full Dashboard \u2192</button>
      ${i?`
        <div class="hg-referral-row">
          <span class="hg-referral-link">${i}</span>
          <button class="hg-copy-btn" id="hg-copy-ref">Copy</button>
        </div>`:""}
    </div>
  `,document.body.appendChild(t),t.querySelector("#hg-hub-btn")?.addEventListener("click",()=>{let s=window.__hgOpenHub;typeof s=="function"?s():window.location.href="/pages/rewards",t.classList.remove("hg-open")}),t.querySelector("#hg-redeem-btn")?.addEventListener("click",()=>{let s=window.__hgOpenHub;typeof s=="function"&&s(0),t.classList.remove("hg-open")}),t.querySelector("#hg-copy-ref")?.addEventListener("click",s=>{let a=s.currentTarget;navigator.clipboard?.writeText(`https://${i}`).then(()=>{a.textContent="Copied!",setTimeout(()=>{a.textContent="Copy"},2e3)})}),document.addEventListener("click",s=>{let a=document.getElementById("hg-launcher");!t.contains(s.target)&&s.target!==a&&t.classList.remove("hg-open")})}var H="hg_nudge1_shown",z="hg_nudge5_shown";function N(e,n){let t=e.nudgeSettings;if(t.nudge1_enabled&&!e.loggedIn&&!localStorage.getItem(H)&&setTimeout(()=>W(),3e3),n==="cart"&&e.loggedIn&&e.member){let{balance:o,activeCodes:r}=e.member;t.nudge3_enabled&&r.length>0?U(r[0]):t.nudge2_enabled&&o>=3e3&&V(o)}if(t.nudge5_enabled&&e.loggedIn&&e.member&&(n==="product"||n==="other")&&!sessionStorage.getItem(z)){let{member:o}=e;o.nextTier==="gold"&&o.spendToNextTier<=t.tier_progress_gold_threshold?M(`Only Rs.${o.spendToNextTier.toLocaleString()} away from Gold tier!`):o.nextTier==="diamond"&&o.spendToNextTier<=t.tier_progress_diamond_threshold&&M(`Only Rs.${o.spendToNextTier.toLocaleString()} away from Diamond tier!`)}}function W(){let e=x("Earn points on every purchase","Sign up free and start earning Rs. rewards on every order at HeyGirl.pk.","Join & Earn","hg-nudge-br",()=>{window.location.href="/account/register"});document.body.appendChild(e),localStorage.setItem(H,"1")}function V(e){let n=A();if(!n)return;let t=x(`You have ${e.toLocaleString()} pts to spend`,"Redeem your points for a discount before checking out.","Redeem Now","hg-nudge-cart",()=>{let o=window.__hgOpenHub;typeof o=="function"&&o(0)});n.insertAdjacentElement("beforebegin",t)}function U(e){let n=A();if(!n)return;let t=x(`You have an unused Rs.${e.discount_pkr} reward!`,`Apply code <strong>${p(e.code)}</strong> at checkout to save.`,"Copy Code","hg-nudge-cart",()=>{navigator.clipboard?.writeText(e.code)});n.insertAdjacentElement("beforebegin",t)}function M(e){let n=x("You're close to the next tier!",e,"View Tiers","hg-nudge-header",()=>{window.location.href="/pages/rewards"});document.body.prepend(n),sessionStorage.setItem(z,"1")}function A(){return document.querySelector(".cart__ctas")??document.querySelector('[name="checkout"]')?.closest("div")??document.querySelector(".cart")}function x(e,n,t,o,r){let i=document.createElement("div");return i.className=`hg-nudge hg-widget ${o}`,i.innerHTML=`
    <button class="hg-nudge-close" aria-label="Close">\xD7</button>
    <div class="hg-nudge-title">${e}</div>
    <div class="hg-nudge-body">${n}</div>
    <button class="hg-btn hg-btn-primary">${t}</button>
  `,i.querySelector(".hg-nudge-close")?.addEventListener("click",()=>i.remove()),i.querySelector(".hg-btn")?.addEventListener("click",()=>{r(),i.remove()}),i}function I(e){if(document.getElementById("hg-product-embed"))return;let n=window.ShopifyAnalytics?.meta?.product?.price??0,o=Math.floor(n/100),r=document.createElement("div");r.id="hg-product-embed",r.className="hg-widget",e.loggedIn?r.innerHTML=`<span>\u{1F381}</span> Earn <span class="hg-pts">${o.toLocaleString()} pts</span> on this purchase`:r.innerHTML=`<span>\u{1F381}</span> <a href="/account/login" style="color:#e91e8c;text-decoration:underline;">Sign in to earn ${o.toLocaleString()} pts</a> on this purchase`;let i=document.querySelector(".price__container")??document.querySelector(".product__info-wrapper .price")??document.querySelector("[data-product-price]");i&&i.insertAdjacentElement("afterend",r)}function P(e){if(document.getElementById("hg-cart-inline"))return;let n=document.createElement("div");if(n.id="hg-cart-inline",n.className="hg-widget",!e.loggedIn||!e.member)n.innerHTML='<span>\u{1F381}</span> <a href="/account/login" style="color:#e91e8c;">Sign in</a> to earn &amp; redeem rewards.';else{let{balance:o,activeCodes:r}=e.member,i=K(),s=i.some(c=>c.startsWith("REWARD-")),a=i.some(c=>!c.startsWith("REWARD-"));if(s)n.innerHTML="<span>\u2705</span> Your loyalty reward is applied. Enjoy the savings!";else if(a)n.innerHTML="<span>\u2139\uFE0F</span> A discount is already applied. Loyalty codes cannot stack.";else if(r.length>0){let c=r[0];n.innerHTML=`
        <div style="margin-bottom:6px;font-weight:600;">\u{1F389} You have a Rs.${c.discount_pkr} reward ready!</div>
        <div style="font-size:12px;color:#888;margin-bottom:8px;">Code: <strong>${c.code}</strong></div>
        <button class="hg-btn hg-btn-primary" id="hg-apply-code" style="margin:0;padding:8px;">Apply Code</button>
      `,setTimeout(()=>{document.getElementById("hg-apply-code")?.addEventListener("click",()=>{window.location.href=`/discount/${c.code}?redirect=/cart`})},0)}else if(o>=3e3)n.innerHTML=`
        <div style="margin-bottom:4px;font-weight:600;">\u{1F48E} You have ${o.toLocaleString()} pts to redeem!</div>
        <div style="font-size:12px;color:#888;margin-bottom:8px;">Earn a reward code and apply it here.</div>
        <button class="hg-btn hg-btn-secondary" id="hg-open-redeem" style="margin:0;padding:8px;">Redeem Points</button>
      `,setTimeout(()=>{document.getElementById("hg-open-redeem")?.addEventListener("click",()=>{let c=window.__hgOpenHub;typeof c=="function"&&c(0)})},0);else{let c=3e3-o;n.innerHTML=`<span>\u{1F381}</span> Earn <strong>${c.toLocaleString()} more pts</strong> to unlock your first reward.`}}let t=document.querySelector('[name="checkout"]')??document.querySelector(".cart__checkout");t&&t.insertAdjacentElement("beforebegin",n)}function K(){let e=window.Shopify?.checkout;return e?.discount?.applicable&&e.discount.code?[e.discount.code]:[]}var Q=[{points:3e3,discount_pkr:100},{points:6e3,discount_pkr:250},{points:11500,discount_pkr:500},{points:22e3,discount_pkr:1e3},{points:1e5,discount_pkr:5e3},{points:18e4,discount_pkr:1e4}],X=["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"],Z={silver:"Rs.250 gift code",gold:"Rs.500 gift code",diamond:"Rs.1,000 code + 1.2\xD7 points all month"};function q(e,n){if(!n.member){e.innerHTML="<p style='color:#888;padding:20px 0;'>Please log in to view rewards.</p>";return}let{member:t}=n,o=new Date().getMonth()+1,r=n.nudgeSettings?.tier_progress_gold_threshold??5e4,i=n.nudgeSettings?.tier_progress_diamond_threshold??1e5,s=Math.min(100,Math.round(t.lifetimeSpend/r*100)),a=Math.min(100,Math.round(t.lifetimeSpend/i*100)),c=`
    <div class="hg-rewards-hero">
      <div class="hg-rewards-pts">${t.balance.toLocaleString()}</div>
      <div class="hg-rewards-pts-label">points available</div>
      <div class="hg-progress-label" style="margin-top:14px;">
        <span>\u2605 Gold (Rs.${r.toLocaleString()})</span>
        <span>${s}%</span>
      </div>
      <div class="hg-progress-track">
        <div class="hg-progress-fill" style="width:${s}%"></div>
      </div>
      <div class="hg-progress-label">
        <span>\u25C6 Diamond (Rs.${i.toLocaleString()})</span>
        <span>${a}%</span>
      </div>
      <div class="hg-progress-track">
        <div class="hg-progress-fill" style="width:${a}%;background:linear-gradient(90deg,#9c27b0,#e91e8c)"></div>
      </div>
      ${t.nextTier?`<div style="font-size:12px;color:rgba(255,255,255,0.8);margin-top:4px;">Rs.${t.spendToNextTier.toLocaleString()} more to reach ${t.nextTier}</div>`:`<div style="font-size:12px;color:rgba(255,255,255,0.8);margin-top:4px;">You've reached the top tier! \u{1F389}</div>`}
    </div>
  `,m=t.activeCodes.length>0?`<div class="hg-section">
        <div class="hg-section-title">\u{1F389} Active Rewards</div>
        ${t.activeCodes.map(d=>{let l=p(d.code);return`
          <div class="hg-active-code-row">
            <div>
              <strong>${l}</strong>
              <div style="color:#888;font-size:11px;">Rs.${d.discount_pkr} off &middot; expires ${new Date(d.expires_at).toLocaleDateString()}</div>
            </div>
            <button class="hg-copy-btn hg-copy-code" data-code="${l}">Copy</button>
          </div>`}).join("")}
      </div>`:`<div class="hg-section">
        <div class="hg-section-title">Active Rewards</div>
        <p style="color:#888;font-size:13px;text-align:center;padding:12px 0;">No active codes \u2014 redeem points below!</p>
      </div>`,y=Q.map(d=>{let l=t.balance>=d.points,h=d.points%1e3===500?`${(d.points/1e3).toFixed(1)}k`:`${d.points/1e3}k`;return`
      <div class="hg-redeem-tile${l?"":" hg-disabled"}" data-points="${d.points}" data-pkr="${d.discount_pkr}" role="button" tabindex="${l?0:-1}">
        <div class="hg-tile-pts">${h} pts</div>
        <div class="hg-tile-val">Rs.${d.discount_pkr.toLocaleString()}</div>
        <div class="hg-tile-label">${l?"Tap to redeem":`Need ${(d.points-t.balance).toLocaleString()} more`}</div>
      </div>`}).join(""),b=t.birthdayMonth&&t.birthdayMonth===o?`<div class="hg-birthday-card">
        <div style="font-weight:700;font-size:15px;margin-bottom:6px;">\u{1F382} Happy Birthday Month!</div>
        <div style="font-size:13px;color:#555;">
          Your ${X[t.birthdayMonth-1]} reward: <strong>${Z[t.tier]??"a special gift"}</strong>
        </div>
      </div>`:"",g=`
    <div class="hg-reward-room">
      <div style="font-size:16px;font-weight:700;margin-bottom:4px;">\u{1F3C6} Reward Room</div>
      <div style="font-size:13px;color:#aaa;margin-bottom:12px;">Exclusive products redeemable with points \u2014 coming soon!</div>
      <button class="hg-btn hg-reward-room-btn">Enter Reward Room \u2192</button>
    </div>`;e.innerHTML=`
    ${c}
    ${m}
    <div class="hg-section">
      <div class="hg-section-title">Redeem Points</div>
      <div class="hg-redeem-grid" id="hg-redeem-grid">${y}</div>
      <div id="hg-redeem-msg" class="hg-redeem-msg"></div>
    </div>
    ${b}
    ${g}
  `,e.querySelectorAll(".hg-copy-code").forEach(d=>{d.addEventListener("click",()=>{let l=d.dataset.code??"";navigator.clipboard?.writeText(l).catch(()=>{}),d.textContent="Copied!",setTimeout(()=>{d.textContent="Copy"},2e3)})});let u=e.querySelector("#hg-redeem-msg");e.querySelectorAll(".hg-redeem-tile:not(.hg-disabled)").forEach(d=>{d.addEventListener("click",async()=>{let l=Number(d.dataset.points),h=Number(d.dataset.pkr);u.textContent="Generating your reward code\u2026",u.style.color="#888",d.classList.add("hg-disabled");let f=await T(l);if(f.redeemed&&f.code){let k=p(f.code),G=f.discount_pkr??h;u.innerHTML=`\u2705 Code <strong>${k}</strong> \u2014 Rs.${G.toLocaleString()} off! <button class="hg-copy-btn hg-copy-result" data-code="${k}">Copy</button>`,u.style.color="#2e7d32";let L=document.querySelector(".hg-hub-balance");L&&(L.textContent=`${Math.max(0,t.balance-l).toLocaleString()} pts`),t.balance=Math.max(0,t.balance-l);let v=u.querySelector(".hg-copy-result");v?.addEventListener("click",()=>{navigator.clipboard?.writeText(f.code).catch(()=>{}),v.textContent="Copied!",setTimeout(()=>{v.textContent="Copy"},2e3)})}else u.textContent=`Failed: ${f.error??"unknown error"}`,u.style.color="#c62828",d.classList.remove("hg-disabled")})}),e.querySelector(".hg-reward-room-btn")?.addEventListener("click",d=>{if(d.preventDefault(),e.querySelector(".hg-coming-soon-tip"))return;let h=document.createElement("div");h.className="hg-coming-soon-tip",h.textContent="Coming Soon! \u{1F680}",d.currentTarget.insertAdjacentElement("afterend",h),setTimeout(()=>h.remove(),2500)})}var ee={purchase:"Purchase Reward",social_youtube:"YouTube (pending)",social_facebook:"Facebook (pending)",social_instagram:"Instagram (pending)",redemption:"Redeemed",referral:"Referral Bonus",signup:"Welcome Bonus",birthday:"Birthday Reward",adjustment:"Manual Adjustment",expiry:"Points Expired"},te={purchase:"\u{1F6CD}\uFE0F",social_youtube:"\u25B6\uFE0F",social_facebook:"\u{1F44D}",social_instagram:"\u{1F4F8}",redemption:"\u{1F381}",referral:"\u{1F465}",signup:"\u{1F389}",birthday:"\u{1F382}",adjustment:"\u270F\uFE0F",expiry:"\u23F0"},ne=[{key:null,label:"All"},{key:"purchase",label:"Purchases"},{key:"social",label:"Social"},{key:"redemption",label:"Redemptions"},{key:"referral",label:"Referrals"},{key:"other",label:"Other"}];function oe(e){let n=Date.now()-new Date(e).getTime(),t=Math.floor(n/864e5);if(t===0)return"Today";if(t===1)return"Yesterday";if(t<30)return`${t} days ago`;let o=Math.floor(t/30);if(o<12)return`${o} month${o>1?"s":""} ago`;let r=Math.floor(o/12);return`${r} year${r>1?"s":""} ago`}function j(){return Array.from({length:5},()=>`
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
  `).join("")}function B(e,n){e.innerHTML=`
    <div class="hg-history-filter" id="hg-history-filter">
      ${ne.map((i,s)=>`
        <button class="hg-filter-btn${s===0?" hg-active":""}" data-type="${i.key??""}">
          ${p(i.label)}
        </button>
      `).join("")}
    </div>
    <div id="hg-history-list">${j()}</div>
    <div class="hg-pagination" id="hg-history-pagination"></div>
  `;let t=1,o=null;async function r(i,s){let a=e.querySelector("#hg-history-list"),c=e.querySelector("#hg-history-pagination");a.innerHTML=j(),c.innerHTML="";let{items:m,total:y}=await E(i,s);if(m.length===0){a.innerHTML='<p style="color:#888;font-size:13px;text-align:center;padding:32px 0;">No history yet \u2014 start earning points!</p>';return}a.innerHTML=m.map(g=>{let u=ee[g.action_type]??p(g.action_type),d=te[g.action_type]??"\u2B50",l=g.delta>=0,h=g.reason_note?`<div style="font-size:11px;color:#888;">${p(g.reason_note)}</div>`:"";return`
        <div class="hg-history-item">
          <div style="display:flex;align-items:center;gap:8px;">
            <span style="font-size:18px;line-height:1;">${d}</span>
            <div>
              <div style="font-weight:600;font-size:13px;">${u}</div>
              <div style="font-size:11px;color:#888;">${oe(g.created_at)}</div>
              ${h}
            </div>
          </div>
          <div class="hg-history-delta ${l?"hg-positive":"hg-negative"}">
            ${l?"+":""}${g.delta.toLocaleString()} pts
          </div>
        </div>
      `}).join("");let b=Math.ceil(y/50);b>1&&(c.innerHTML=`
        <button class="hg-page-btn" id="hg-hist-prev" ${i<=1?"disabled":""}>\u2190 Prev</button>
        <span style="font-size:13px;padding:6px 8px;">Page ${i} of ${b}</span>
        <button class="hg-page-btn" id="hg-hist-next" ${i>=b?"disabled":""}>Next \u2192</button>
      `,c.querySelector("#hg-hist-prev")?.addEventListener("click",()=>{t--,r(t,o)}),c.querySelector("#hg-hist-next")?.addEventListener("click",()=>{t++,r(t,o)}))}e.querySelector("#hg-history-filter")?.querySelectorAll(".hg-filter-btn").forEach(i=>{i.addEventListener("click",()=>{e.querySelectorAll(".hg-filter-btn").forEach(a=>a.classList.remove("hg-active")),i.classList.add("hg-active");let s=i.dataset.type??"";o=s===""?null:s,t=1,r(1,o)})}),r(1,null)}function D(e,n){e.innerHTML="<p>Loading\u2026</p>"}function Y(e,n){e.innerHTML="<p>Loading\u2026</p>"}var O=["My Rewards","History","Referrals","VIP Tiers"],re={silver:"\u25C8 Silver",gold:"\u2605 Gold",diamond:"\u25C6 Diamond"};function F(e){if(!e.loggedIn||!e.member)return;let{member:n}=e,t=document.createElement("div");t.id="hg-hub-overlay",t.className="hg-widget";let o=document.createElement("div");o.id="hg-hub",o.innerHTML=`
    <div class="hg-hub-header">
      <div class="hg-hub-header-top">
        <div>
          <div class="hg-hub-name">Hi, ${n.firstName??"there"}!</div>
          <div class="hg-hub-balance">${n.balance.toLocaleString()} pts</div>
          <span class="hg-hub-tier">${re[n.tier]??n.tier}</span>
        </div>
        <button class="hg-hub-close" id="hg-hub-close" aria-label="Close">\xD7</button>
      </div>
      <div class="hg-tabs">
        ${O.map((s,a)=>`
          <button class="hg-tab${a===0?" hg-active":""}" data-tab="${a}">${s}</button>
        `).join("")}
      </div>
    </div>
    <div class="hg-hub-body">
      ${O.map((s,a)=>`<div class="hg-tab-panel${a===0?" hg-active":""}" id="hg-panel-${a}"></div>`).join("")}
    </div>
  `,t.appendChild(o),document.body.appendChild(t),q(document.getElementById("hg-panel-0"),e);let r=new Set([0]);o.querySelectorAll(".hg-tab").forEach(s=>{s.addEventListener("click",()=>{let a=Number(s.dataset.tab);o.querySelectorAll(".hg-tab").forEach(m=>m.classList.remove("hg-active")),s.classList.add("hg-active"),o.querySelectorAll(".hg-tab-panel").forEach(m=>m.classList.remove("hg-active"));let c=document.getElementById(`hg-panel-${a}`);c.classList.add("hg-active"),r.has(a)||(r.add(a),a===1&&B(c,e),a===2&&D(c,e),a===3&&Y(c,e))})}),o.querySelector("#hg-hub-close")?.addEventListener("click",i),t.addEventListener("click",s=>{s.target===t&&i()}),window.__hgOpenHub=(s=0)=>{t.classList.add("hg-open");let a=o.querySelector(`[data-tab="${s}"]`);a&&a.click(),document.body.style.overflow="hidden"};function i(){t.classList.remove("hg-open"),document.body.style.overflow=""}}(function(){"use strict";function e(){if(document.getElementById("hg-styles"))return;let o=document.createElement("style");o.id="hg-styles",o.textContent=S,document.head.appendChild(o)}function n(){let o=window.location.pathname;return o==="/pages/rewards"?"rewards":o.startsWith("/products/")?"product":o==="/cart"?"cart":"other"}async function t(){try{e();let o=n(),r=await $();if(!r)return;o!=="rewards"&&(R(r),C(r),F(r)),r.nudgeSettings&&N(r,o),o==="product"&&I(r),o==="cart"&&P(r),o==="rewards"&&void 0}catch{}}document.readyState==="loading"?document.addEventListener("DOMContentLoaded",t):t()})();})();
