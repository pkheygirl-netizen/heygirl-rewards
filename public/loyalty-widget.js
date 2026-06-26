"use strict";var __LOYALTY_WIDGET__=(()=>{var d=`
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
`;var u="/apps/loyalty";async function p(){try{let r=await fetch(`${u}/customer`);return r.ok?await r.json():null}catch{return null}}var l={silver:"\u25C8 Silver",gold:"\u2605 Gold",diamond:"\u25C6 Diamond"};function c(r){if(document.getElementById("hg-launcher"))return;let e=document.createElement("button");if(e.id="hg-launcher",e.className="hg-loading",!r.loggedIn||!r.member)e.innerHTML='<span class="hg-icon">\u{1F381}</span><span>Join &amp; Earn</span>',e.addEventListener("click",()=>{window.location.href="/account/register"});else{let{tier:n,balance:i}=r.member;e.className="",e.innerHTML=`
      <span class="hg-icon">\u25C8</span>
      <span class="hg-badge">${l[n]??n}</span>
      <span>${i.toLocaleString()} pts</span>
    `,e.addEventListener("click",h)}document.body.appendChild(e),setTimeout(()=>e.classList.remove("hg-loading"),1500)}function h(){let r=document.getElementById("hg-panel");r&&r.classList.toggle("hg-open")}function g(r){if(document.getElementById("hg-panel")||!r.loggedIn||!r.member)return;let{member:e}=r,n=document.createElement("div");n.id="hg-panel",n.className="hg-widget";let i=Math.min(100,Math.floor(e.lifetimeSpend/5e4*100)),t=Math.min(100,Math.floor(e.lifetimeSpend/1e5*100)),o=e.referralSlug?`heygirl.pk?ref=${e.referralSlug}`:"";n.innerHTML=`
    <div class="hg-panel-header">
      <div class="hg-name">Hi, ${e.firstName??"there"}!</div>
      <span class="hg-tier">${l[e.tier]??e.tier}</span>
      <div class="hg-balance">${e.balance.toLocaleString()} pts</div>
    </div>
    <div class="hg-panel-body">
      <div class="hg-progress-label">
        <span>Silver \u2192 Gold</span><span>${i}%</span>
      </div>
      <div class="hg-progress-track">
        <div class="hg-progress-fill" style="width:${i}%"></div>
      </div>
      <div class="hg-progress-label">
        <span>Gold \u2192 Diamond</span><span>${t}%</span>
      </div>
      <div class="hg-progress-track">
        <div class="hg-progress-fill" style="width:${t}%"></div>
      </div>
      ${e.activeCodes.length>0?`
        <div style="margin-bottom:8px;font-size:13px;color:#e91e8c;font-weight:600;">
          \u{1F389} You have ${e.activeCodes.length} active reward${e.activeCodes.length>1?"s":""}!
        </div>`:""}
      <button class="hg-btn hg-btn-primary" id="hg-redeem-btn">Redeem Points</button>
      <button class="hg-btn hg-btn-secondary" id="hg-hub-btn">View Full Dashboard \u2192</button>
      ${o?`
        <div class="hg-referral-row">
          <span class="hg-referral-link">${o}</span>
          <button class="hg-copy-btn" id="hg-copy-ref">Copy</button>
        </div>`:""}
    </div>
  `,document.body.appendChild(n),n.querySelector("#hg-hub-btn")?.addEventListener("click",()=>{let a=window.__hgOpenHub;typeof a=="function"?a():window.location.href="/pages/rewards",n.classList.remove("hg-open")}),n.querySelector("#hg-redeem-btn")?.addEventListener("click",()=>{let a=window.__hgOpenHub;typeof a=="function"&&a(0),n.classList.remove("hg-open")}),n.querySelector("#hg-copy-ref")?.addEventListener("click",a=>{let s=a.currentTarget;navigator.clipboard?.writeText(`https://${o}`).then(()=>{s.textContent="Copied!",setTimeout(()=>{s.textContent="Copy"},2e3)})}),document.addEventListener("click",a=>{let s=document.getElementById("hg-launcher");!n.contains(a.target)&&a.target!==s&&n.classList.remove("hg-open")})}(function(){"use strict";function r(){if(document.getElementById("hg-styles"))return;let t=document.createElement("style");t.id="hg-styles",t.textContent=d,document.head.appendChild(t)}function e(){let t=window.location.pathname;return t==="/pages/rewards"?"rewards":t.startsWith("/products/")?"product":t==="/cart"?"cart":"other"}async function n(){try{r();let t=e(),o=await p();if(!o)return;t!=="rewards"&&(c(o),g(o)),o.nudgeSettings&&void 0,t==="product"&&void 0,t==="cart"&&void 0,t==="rewards"&&void 0}catch{}}function i(t){}window.__hgOpenHub=null,document.readyState==="loading"?document.addEventListener("DOMContentLoaded",n):n()})();})();
