"use strict";var __LOYALTY_WIDGET__=(()=>{var T=`
/* ---- Reset ---- */
.hg-widget * { box-sizing: border-box; margin: 0; padding: 0; font-family: inherit; }

/* ---- Launcher button ---- */
#hg-launcher {
  position: fixed; bottom: 24px; right: 24px; z-index: 2147483000;
  display: flex; align-items: center; gap: 8px;
  background: #e8ad00; color: #1a1a1a;
  border: none; border-radius: 50px; padding: 12px 18px;
  cursor: pointer; font-size: 14px; font-weight: 600;
  box-shadow: 0 4px 16px rgba(232,173,0,0.35);
  transition: transform 0.15s ease, box-shadow 0.15s ease;
}
#hg-launcher:hover { transform: translateY(-2px); box-shadow: 0 6px 20px rgba(232,173,0,0.45); }
#hg-launcher .hg-icon { font-size: 18px; line-height: 1; }
#hg-launcher .hg-badge {
  background: rgba(0,0,0,0.12); border-radius: 20px;
  padding: 2px 8px; font-size: 12px;
}

/* ---- Skeleton loader ---- */
#hg-launcher.hg-loading { background: #ccc; pointer-events: none; animation: hg-pulse 1.2s ease-in-out infinite; }
@keyframes hg-pulse { 0%,100%{opacity:1} 50%{opacity:0.5} }

/* ---- Mini panel ---- */
#hg-panel {
  position: fixed; bottom: 86px; right: 24px; z-index: 2147483001;
  width: 320px; background: #fff; border-radius: 16px;
  box-shadow: 0 8px 32px rgba(0,0,0,0.15); border: 1px solid #f6ecc9;
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
  background: linear-gradient(135deg, #e8ad00 0%, #c08f00 100%);
  color: #1a1a1a; padding: 20px;
}
.hg-panel-header .hg-name { font-size: 16px; font-weight: 700; margin-bottom: 4px; }
.hg-panel-header .hg-tier {
  display: inline-block; background: rgba(0,0,0,0.12);
  border-radius: 20px; padding: 2px 10px; font-size: 12px; font-weight: 600;
  text-transform: capitalize;
}
.hg-balance { font-size: 28px; font-weight: 700; margin: 12px 0 4px; }
.hg-panel-body { padding: 16px; }

/* ---- Progress bars ---- */
.hg-progress-label { display: flex; justify-content: space-between; font-size: 12px; color: #6b6b6b; margin-bottom: 4px; }
.hg-progress-track { background: #f6ecc9; border-radius: 4px; height: 6px; margin-bottom: 12px; overflow: hidden; }
.hg-progress-fill { background: #e8ad00; height: 100%; border-radius: 4px; transition: width 0.5s ease; }

/* ---- Panel CTA buttons ---- */
.hg-btn {
  display: block; width: 100%; text-align: center;
  border-radius: 8px; padding: 10px; font-size: 14px; font-weight: 600;
  cursor: pointer; border: none; text-decoration: none; margin-bottom: 8px;
}
.hg-btn-primary { background: #e8ad00; color: #1a1a1a; }
.hg-btn-secondary { background: #f6ecc9; color: #9c7600; }
.hg-btn:hover { opacity: 0.9; }

/* ---- Referral row ---- */
.hg-referral-row {
  display: flex; align-items: center; gap: 8px; margin-top: 8px;
  background: #f6ecc9; border-radius: 8px; padding: 10px 12px;
  font-size: 13px;
}
.hg-referral-link { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #666666; }
.hg-copy-btn { background: #e8ad00; color: #1a1a1a; border: none; border-radius: 6px; padding: 4px 10px; font-size: 12px; cursor: pointer; white-space: nowrap; }

/* ---- Nudges ---- */
.hg-nudge {
  position: fixed; z-index: 2147483000;
  background: #fff; border-radius: 12px;
  box-shadow: 0 4px 20px rgba(0,0,0,0.12); border: 1px solid #f6ecc9;
  padding: 16px; max-width: 300px;
  animation: hg-slide-up 0.25s ease forwards;
}
@keyframes hg-slide-up { from{transform:translateY(20px);opacity:0} to{transform:translateY(0);opacity:1} }
.hg-nudge-close {
  position: absolute; top: 8px; right: 10px; background: none; border: none;
  font-size: 18px; cursor: pointer; color: #6b6b6b; line-height: 1;
}
.hg-nudge-title { font-weight: 700; font-size: 14px; margin-bottom: 6px; color: #1a1a1a; }
.hg-nudge-body { font-size: 13px; color: #555; margin-bottom: 12px; }

/* nudge positions */
.hg-nudge-br { bottom: 86px; right: 24px; }
.hg-nudge-cart { margin: 12px 0; position: static; box-shadow: none; border: 1px solid #f6ecc9; border-radius: 8px; padding: 12px; max-width: 100%; }
.hg-nudge-header { top: 0; left: 0; right: 0; max-width: 100%; border-radius: 0 0 8px 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.08); display: flex; align-items: center; gap: 12px; padding: 10px 16px; }

/* ---- Product embed ---- */
#hg-product-embed {
  display: flex; align-items: center; gap: 8px;
  font-size: 13px; color: #9c7600; margin: 8px 0;
  padding: 8px 12px; background: #fdf6e3; border-radius: 6px;
}
#hg-product-embed .hg-pts { font-weight: 700; }

/* ---- Cart inline ---- */
#hg-cart-inline {
  margin: 12px 0; padding: 12px; background: #fdf6e3;
  border: 1px solid #f6ecc9; border-radius: 8px; font-size: 13px;
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
  background: linear-gradient(135deg, #e8ad00 0%, #c08f00 100%);
  color: #1a1a1a; padding: 20px 20px 0;
  flex-shrink: 0;
}
.hg-hub-header-top {
  display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 16px;
}
.hg-hub-name { font-size: 16px; font-weight: 700; }
.hg-hub-balance { font-size: 28px; font-weight: 800; }
.hg-hub-tier {
  display: inline-block; background: rgba(0,0,0,0.12);
  border-radius: 20px; padding: 2px 10px; font-size: 12px;
  font-weight: 600; text-transform: capitalize; margin-top: 4px;
}
.hg-hub-close {
  background: rgba(0,0,0,0.12); border: none; color: #1a1a1a;
  border-radius: 50%; width: 30px; height: 30px; font-size: 18px;
  cursor: pointer; display: flex; align-items: center; justify-content: center;
}
.hg-tabs {
  display: flex; border-bottom: none; padding: 0 4px;
}
.hg-tab {
  flex: 1; background: none; border: none; color: rgba(0,0,0,0.55);
  font-size: 12px; font-weight: 600; padding: 10px 4px;
  cursor: pointer; border-bottom: 3px solid transparent;
  transition: color 0.15s, border-color 0.15s;
}
.hg-tab.hg-active { color: #1a1a1a; border-bottom-color: #1a1a1a; }
.hg-hub-body { flex: 1; overflow-y: auto; padding: 20px; }
.hg-tab-panel { display: none; }
.hg-tab-panel.hg-active { display: block; }

/* Redemption tiles */
.hg-redeem-grid {
  display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; margin-bottom: 20px;
}
.hg-redeem-tile {
  background: #fdf6e3; border: 1.5px solid #f6ecc9; border-radius: 10px;
  padding: 12px 8px; text-align: center; cursor: pointer;
  transition: border-color 0.15s, transform 0.1s;
}
.hg-redeem-tile:hover { border-color: #e8ad00; transform: translateY(-2px); }
.hg-redeem-tile.hg-disabled { opacity: 0.4; cursor: not-allowed; }
.hg-redeem-tile .hg-tile-pts { font-size: 13px; font-weight: 700; color: #9c7600; }
.hg-redeem-tile .hg-tile-val { font-size: 15px; font-weight: 800; color: #1a1a1a; margin: 4px 0; }
.hg-redeem-tile .hg-tile-label { font-size: 10px; color: #666666; }

/* History list */
.hg-history-filter {
  display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 16px;
}
.hg-filter-btn {
  background: #f6ecc9; border: none; border-radius: 20px; padding: 4px 12px;
  font-size: 12px; cursor: pointer; color: #1a1a1a;
}
.hg-filter-btn.hg-active { background: #e8ad00; color: #1a1a1a; }
.hg-history-item {
  display: flex; justify-content: space-between; align-items: center;
  padding: 10px 0; border-bottom: 1px solid #f6ecc9; font-size: 13px;
}
.hg-history-item:last-child { border-bottom: none; }
.hg-history-delta { font-weight: 700; }
.hg-history-delta.hg-positive { color: #2e7d32; }
.hg-history-delta.hg-negative { color: #c62828; }
.hg-pagination { display: flex; gap: 8px; justify-content: center; margin-top: 16px; }
.hg-page-btn { background: #f6ecc9; border: none; border-radius: 6px; padding: 6px 14px; cursor: pointer; font-size: 13px; }
.hg-page-btn:disabled { opacity: 0.4; cursor: not-allowed; }

/* Skeleton loader rows */
.hg-skel {
  display: inline-block; background: #f0e6c5;
  animation: hg-pulse 1.2s ease-in-out infinite;
}
.hg-skeleton-row { opacity: 0.8; }

/* Referral section */
.hg-referral-card { background: #fdf6e3; border-radius: 12px; padding: 16px; margin-bottom: 16px; }
.hg-share-row { display: flex; gap: 8px; margin-top: 10px; flex-wrap: wrap; }
.hg-share-btn { flex: 1; min-width: 80px; padding: 8px; border-radius: 8px; border: none; font-size: 12px; font-weight: 600; cursor: pointer; }
.hg-share-whatsapp { background: #25d366; color: #fff; }
.hg-share-copy { background: #e8ad00; color: #1a1a1a; }
.hg-referral-stats { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; margin-bottom: 16px; }
.hg-stat-card { background: #f6ecc9; border-radius: 8px; padding: 10px; text-align: center; }
.hg-stat-val { font-size: 20px; font-weight: 800; color: #9c7600; }
.hg-stat-label { font-size: 11px; color: #666666; margin-top: 2px; }

/* My Rewards tab */
.hg-rewards-hero {
  background: linear-gradient(135deg, #e8ad00 0%, #c08f00 100%);
  border-radius: 14px; padding: 18px; margin-bottom: 20px; color: #1a1a1a;
}
.hg-rewards-pts { font-size: 36px; font-weight: 800; line-height: 1; }
.hg-rewards-pts-label { font-size: 13px; opacity: 0.85; margin-top: 2px; }
.hg-section { margin-bottom: 20px; }
.hg-section-title { font-weight: 700; font-size: 14px; margin-bottom: 10px; }
.hg-active-code-row {
  background: #fdf6e3; border-radius: 8px; padding: 10px 12px;
  margin-bottom: 8px; display: flex; justify-content: space-between;
  align-items: center; font-size: 13px;
}
.hg-redeem-msg {
  min-height: 24px; font-size: 13px; text-align: center; margin: 0 0 16px;
}
.hg-birthday-card {
  background: linear-gradient(135deg, #fdf6e3, #f6ecc9);
  border-radius: 12px; padding: 14px; margin-bottom: 20px;
  border: 1px solid #ead9a0;
}
.hg-reward-room {
  background: #1a1a1a; border-radius: 12px; padding: 16px;
  text-align: center; color: #fff; margin-bottom: 8px;
}
.hg-reward-room-btn {
  background: #e8ad00; color: #1a1a1a; opacity: 0.75;
  margin: 0; cursor: pointer;
}
.hg-coming-soon-tip {
  background: #333; color: #fff; border-radius: 6px;
  padding: 6px 12px; font-size: 12px; text-align: center;
  margin-top: 8px; animation: hg-slide-up 0.2s ease;
}

/* VIP tiers */
.hg-tier-cards { display: flex; flex-direction: column; gap: 12px; }
.hg-tier-card { border: 2px solid #f6ecc9; border-radius: 12px; padding: 16px; }
.hg-tier-card.hg-current-tier { border-color: #e8ad00; }
.hg-tier-card.hg-achieved-tier { opacity: 0.6; }
.hg-tier-card-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; gap: 8px; }
.hg-tier-name { font-size: 16px; font-weight: 800; flex: 1; }
.hg-current-badge {
  background: #e8ad00; color: #1a1a1a; border-radius: 20px;
  padding: 2px 8px; font-size: 11px; font-weight: 600; white-space: nowrap;
}
.hg-achieved-badge {
  background: #f6ecc9; color: #666666; border-radius: 20px;
  padding: 2px 8px; font-size: 11px; font-weight: 600; white-space: nowrap;
}
.hg-tier-benefit { font-size: 12px; color: #555; margin: 3px 0; }
.hg-tier-progress-section { margin-top: 16px; padding-top: 16px; border-top: 1px solid #f6ecc9; }

/* ---- Hub Tab 3: Referrals ---- */
.hg-referral-link-card { background: #fdf6e3; border-radius: 12px; padding: 16px; margin-bottom: 16px; }
.hg-referral-url { background: #fff; border: 1px solid #ead9a0; border-radius: 8px; padding: 10px; font-size: 12px; color: #6b6b6b; word-break: break-all; margin-bottom: 10px; }
.hg-btn { border: none; border-radius: 8px; padding: 9px 14px; font-size: 12px; font-weight: 700; cursor: pointer; text-decoration: none; display: inline-flex; align-items: center; justify-content: center; }
.hg-btn-wa { background: #25d366; color: #fff; flex: 1; }
.hg-btn-copy { background: #e8ad00; color: #1a1a1a; flex: 1; }
.hg-stats-row { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; margin-bottom: 20px; }
.hg-stat-box { background: #f6ecc9; border-radius: 10px; padding: 10px 6px; text-align: center; }
.hg-stat-num { font-size: 20px; font-weight: 800; color: #9c7600; }
.hg-stat-lbl { font-size: 11px; color: #666666; margin-top: 2px; }
.hg-social-note { font-size: 12px; color: #6b6b6b; margin-bottom: 10px; }
.hg-social-list { display: flex; flex-direction: column; gap: 8px; margin-bottom: 12px; }
.hg-social-row { display: flex; justify-content: space-between; align-items: center; background: #fdf6e3; border-radius: 10px; padding: 10px 12px; }
.hg-social-label { font-size: 13px; font-weight: 600; }
.hg-pts-badge { background: #e8ad00; color: #1a1a1a; border-radius: 20px; padding: 2px 7px; font-size: 11px; font-weight: 700; margin-left: 6px; }
.hg-btn-social { background: #e8ad00; color: #1a1a1a; border-radius: 8px; padding: 7px 12px; font-size: 12px; font-weight: 700; border: none; cursor: pointer; }
.hg-btn-social:disabled { opacity: 0.6; cursor: not-allowed; }
.hg-social-msg { min-height: 20px; font-size: 13px; text-align: center; margin-bottom: 16px; }
.hg-msg-ok { color: #2e7d32; }
.hg-msg-warn { color: #e65100; }
.hg-msg-err { color: #c62828; }
.hg-history-section { margin-bottom: 16px; }
.hg-history-label { font-weight: 600; font-size: 13px; }
.hg-history-date { font-size: 11px; color: #6b6b6b; margin-top: 2px; }
.hg-status-badge { font-size: 12px; text-transform: capitalize; padding: 3px 10px; border-radius: 20px; background: #f6ecc9; color: #9c7600; }
.hg-status-rewarded { background: #e8f5e9; color: #2e7d32; }
.hg-empty-state { font-size: 13px; color: #767676; text-align: center; padding: 16px 0; }
.hg-influencer-badge { background: #fff8e1; border: 1px solid #ffe082; border-radius: 10px; padding: 14px; margin-top: 16px; }
.hg-influencer-title { font-weight: 700; font-size: 13px; margin-bottom: 4px; }
.hg-influencer-rate { font-size: 12px; color: #555; margin-bottom: 4px; }
.hg-influencer-stats { font-size: 12px; color: #555; }
#hg-landing{max-width:860px;margin:0 auto;padding:0 16px}#hg-landing .s{padding:22px 0;border-bottom:1px solid #f6ecc9}#hg-landing .s:last-child{border-bottom:none}.hg-sh{display:block;text-align:center;margin-bottom:9px}.hg-eg{display:grid;grid-template-columns:repeat(auto-fit,minmax(110px,1fr));gap:6px}.hg-ei{text-align:center;padding:9px 3px;background:#fdf6e3;border-radius:7px}.hg-rt{width:100%;border-collapse:collapse;font-size:13px}.hg-rt th{background:#e8ad00;color:#1a1a1a;padding:6px}.hg-rt td{padding:6px;border-bottom:1px solid #f6ecc9}.hg-rt tr:nth-child(even) td{background:#fdf6e3}.hg-tg{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:7px}.hg-tc{border-radius:7px;padding:9px}#hg-landing details{border-bottom:1px solid #f6ecc9;padding:6px 0}#hg-landing summary{font-weight:700;font-size:13px;cursor:pointer}#hg-landing details p{font-size:12px;color:#555;margin-top:3px}

/* ---- Logged-out preview overlay (gold theme \u2014 matches Join & Earn flow) ---- */
#hg-launcher.hg-gold { background: #e8ad00; color: #1a1a1a; box-shadow: 0 4px 16px rgba(232,173,0,0.4); }
#hg-launcher.hg-gold:hover { box-shadow: 0 6px 20px rgba(232,173,0,0.5); }
#hg-launcher.hg-x { border-radius: 50%; width: 58px; height: 58px; padding: 0; justify-content: center; }
#hg-launcher.hg-x .hg-pv-x { font-size: 24px; line-height: 1; }

#hg-preview {
  position: fixed; right: 24px; bottom: 100px; z-index: 2147483011;
  width: 384px; max-width: calc(100vw - 32px); max-height: calc(100vh - 140px);
  background: #f4f4f5; border-radius: 16px; box-shadow: 0 12px 48px rgba(0,0,0,0.28);
  display: flex; flex-direction: column; overflow: hidden;
  opacity: 0; transform: translateY(16px) scale(0.98); pointer-events: none;
  transition: opacity 0.28s ease, transform 0.28s ease;
  font-size: 14px; color: #1f2937; line-height: 1.4;
}
#hg-preview.hg-open { opacity: 1; transform: translateY(0) scale(1); pointer-events: all; }
@media (max-width: 480px) {
  #hg-preview { right: 0; left: 0; bottom: 0; width: 100%; max-width: 100%; max-height: 88vh; border-radius: 16px 16px 0 0; }
}
.hg-pv-head {
  background: linear-gradient(135deg, #e8ad00 0%, #c08f00 100%); color: #1a1a1a;
  flex-shrink: 0; padding: 16px 18px; display: flex; align-items: center; gap: 10px;
}
.hg-pv-back, .hg-pv-close {
  background: transparent; border: none; cursor: pointer; color: #1a1a1a;
  line-height: 1; padding: 0; display: flex; align-items: center; font-size: 22px;
}
.hg-pv-close { margin-left: auto; }
.hg-pv-head-titles { display: flex; flex-direction: column; }
.hg-pv-eyebrow { font-size: 13px; opacity: 0.85; }
.hg-pv-title { font-size: 16px; font-weight: 800; }
.hg-pv-title-lg { font-size: 22px; font-weight: 900; }
.hg-pv-body { flex: 1; overflow-y: auto; padding: 14px; }
.hg-pv-screen { display: none; }
.hg-pv-screen.hg-active { display: block; animation: hg-pv-fade 0.25s ease; }
@keyframes hg-pv-fade { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: translateY(0); } }
.hg-pv-card { background: #fff; border-radius: 14px; padding: 18px; margin-bottom: 14px; box-shadow: 0 1px 3px rgba(0,0,0,0.06); }
.hg-pv-card-title { font-size: 16px; font-weight: 800; text-align: center; margin-bottom: 8px; color: #1a1a1a; }
.hg-pv-card-text { font-size: 13px; color: #6b7280; text-align: center; line-height: 1.5; margin-bottom: 14px; }
.hg-pv-btn {
  display: block; width: 100%; text-align: center; cursor: pointer;
  background: #e8ad00; color: #1a1a1a; border: none; border-radius: 10px;
  padding: 13px; font-size: 15px; font-weight: 700; text-decoration: none;
  box-shadow: 0 2px 8px rgba(232,173,0,0.35);
}
.hg-pv-btn:hover { background: #d6a000; }
.hg-pv-signin { text-align: center; font-size: 13px; color: #4b5563; margin-top: 12px; }
.hg-pv-signin a { color: #b07d00; font-weight: 700; text-decoration: underline; cursor: pointer; }
.hg-pv-row { display: flex; align-items: center; gap: 12px; padding: 14px 2px; border-top: 1px solid #f0f0f0; }
.hg-pv-row-nav { cursor: pointer; }
.hg-pv-nav-list .hg-pv-row:first-child, .hg-pv-list .hg-pv-row:first-child { border-top: none; }
.hg-pv-ic { font-size: 22px; width: 30px; text-align: center; flex-shrink: 0; line-height: 1; }
.hg-pv-row-main { flex: 1; min-width: 0; }
.hg-pv-row-title { font-size: 14px; font-weight: 600; color: #1a1a1a; }
.hg-pv-row-sub { font-size: 13px; color: #6b7280; margin-top: 1px; }
.hg-pv-chev { color: #c0c0c0; font-size: 18px; flex-shrink: 0; }
.hg-pv-pill { background: #eef0f4; border-radius: 10px; padding: 13px; text-align: center; font-size: 13px; color: #4b5563; margin: 6px 0 14px; }
.hg-pv-sub-title { font-size: 16px; font-weight: 800; margin: 4px 2px 10px; color: #1a1a1a; }
`;var x="/apps/loyalty";async function $(){try{let e=await fetch(`${x}/customer`);return e.ok?await e.json():null}catch{return null}}async function H(e=1,o=null){try{let t=new URLSearchParams({page:String(e)});o&&t.set("type",o);let n=await fetch(`${x}/history?${t}`);return n.ok?await n.json():{items:[],total:0}}catch{return{items:[],total:0}}}async function C(){try{let e=await fetch(`${x}/referral`);return e.ok?await e.json():null}catch{return null}}async function _(e){try{return await(await fetch(`${x}/redeem`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({requestedPoints:e})})).json()}catch{return{redeemed:!1,error:"network_error"}}}async function M(e){try{return(await fetch(`${x}/referral`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({referralSlug:e})})).ok}catch{return!1}}async function z(e){try{return await(await fetch(`${x}/social`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({platform:e})})).json()}catch{return{queued:!1}}}function b(e){return e.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;")}var P={silver:"\u25C8 Silver",gold:"\u2605 Gold",diamond:"\u25C6 Diamond"};function I(){if(document.getElementById("hg-launcher"))return;let e=document.createElement("button");e.id="hg-launcher",e.className="hg-loading",e.setAttribute("aria-label","Loyalty rewards"),e.innerHTML='<span class="hg-icon">\u25C8</span>',document.body.appendChild(e)}function S(){document.getElementById("hg-launcher")?.remove()}function A(e){let o=document.getElementById("hg-launcher");if(o&&!o.classList.contains("hg-loading"))return;let t=o??document.createElement("button");if(t.id="hg-launcher",t.className="hg-loading",!e.loggedIn||!e.member)t.classList.add("hg-gold"),t.setAttribute("aria-label","Join the loyalty program"),t.innerHTML='<span class="hg-icon">\u{1F381}</span><span>Join &amp; Earn</span>',t.addEventListener("click",()=>{let n=window;typeof n.__hgTogglePreview=="function"?n.__hgTogglePreview():window.location.href="/account/register"});else{let{tier:n,balance:i}=e.member;t.className="",t.setAttribute("aria-label","Open loyalty rewards panel"),t.setAttribute("aria-expanded","false"),t.setAttribute("aria-haspopup","dialog"),t.innerHTML=`
      <span class="hg-icon">\u25C8</span>
      <span class="hg-badge">${P[n]??n}</span>
      <span>${i.toLocaleString()} pts</span>
    `,t.addEventListener("click",te)}o||document.body.appendChild(t),setTimeout(()=>t.classList.remove("hg-loading"),1500)}function te(){let e=document.getElementById("hg-panel");e&&(e.classList.toggle("hg-open"),document.getElementById("hg-launcher")?.setAttribute("aria-expanded",String(e.classList.contains("hg-open"))))}function E(){document.getElementById("hg-panel")?.classList.remove("hg-open"),document.getElementById("hg-launcher")?.setAttribute("aria-expanded","false")}function N(e){if(document.getElementById("hg-panel")||!e.loggedIn||!e.member)return;let{member:o}=e,t=document.createElement("div");t.id="hg-panel",t.className="hg-widget";let n=Math.min(100,Math.floor(o.lifetimeSpend/5e4*100)),i=Math.min(100,Math.floor(o.lifetimeSpend/1e5*100)),r=o.referralSlug?`heygirl.pk?ref=${o.referralSlug}`:"";t.innerHTML=`
    <div class="hg-panel-header">
      <div class="hg-name">Hi, ${b(o.firstName??"there")}!</div>
      <span class="hg-tier">${P[o.tier]??o.tier}</span>
      <div class="hg-balance">${o.balance.toLocaleString()} pts</div>
    </div>
    <div class="hg-panel-body">
      <div class="hg-progress-label">
        <span>Silver \u2192 Gold</span><span>${n}%</span>
      </div>
      <div class="hg-progress-track">
        <div class="hg-progress-fill" style="width:${n}%"></div>
      </div>
      <div class="hg-progress-label">
        <span>Gold \u2192 Diamond</span><span>${i}%</span>
      </div>
      <div class="hg-progress-track">
        <div class="hg-progress-fill" style="width:${i}%"></div>
      </div>
      ${o.activeCodes.length>0?`
        <div style="margin-bottom:8px;font-size:13px;color:#9c7600;font-weight:600;">
          \u{1F389} You have ${o.activeCodes.length} active reward${o.activeCodes.length>1?"s":""}!
        </div>`:""}
      <button class="hg-btn hg-btn-primary" id="hg-redeem-btn">Redeem Points</button>
      <button class="hg-btn hg-btn-secondary" id="hg-hub-btn">View Full Dashboard \u2192</button>
      ${r?`
        <div class="hg-referral-row">
          <span class="hg-referral-link">${r}</span>
          <button class="hg-copy-btn" id="hg-copy-ref">Copy</button>
        </div>`:""}
    </div>
  `,document.body.appendChild(t),t.querySelector("#hg-hub-btn")?.addEventListener("click",()=>{let d=window.__hgOpenHub,p=document.getElementById("hg-launcher");typeof d=="function"?d(0,p??void 0):window.location.href="/pages/rewards",E()}),t.querySelector("#hg-redeem-btn")?.addEventListener("click",()=>{let d=window.__hgOpenHub,p=document.getElementById("hg-launcher");typeof d=="function"&&d(0,p??void 0),E()}),t.querySelector("#hg-copy-ref")?.addEventListener("click",d=>{let p=d.currentTarget;navigator.clipboard?.writeText(`https://${r}`).then(()=>{p.textContent="Copied!",setTimeout(()=>{p.textContent="Copy"},2e3)})}),document.addEventListener("click",d=>{let p=document.getElementById("hg-launcher"),l=d.target;!t.contains(l)&&!(p&&p.contains(l))&&E()})}var oe="/account/register",ne="/account/login",re=[{icon:"\u{1F464}",title:"Sign up",sub:"1,000 HeyGirl Points"},{icon:"\u25B6\uFE0F",title:"Subscribe on YouTube",sub:"1,000 HeyGirl Points"},{icon:"\u{1F6CD}\uFE0F",title:"Place an order",sub:"1 HeyGirl Point for every Rs1 spent"},{icon:"\u{1F4F7}",title:"Follow on Instagram",sub:"1,000 HeyGirl Points"},{icon:"\u{1F44D}",title:"Like on Facebook",sub:"1,000 HeyGirl Points"},{icon:"\u{1F517}",title:"Share on Facebook",sub:"1,000 HeyGirl Points"},{icon:"\u2B50",title:"Post a review",sub:"3,000 HeyGirl Points"},{icon:"\u{1F382}",title:"Celebrate a birthday",sub:"Birthday reward coupon"}],ie=[{icon:"\u{1F4B5}",value:"Rs100 off coupon",pts:"3,000 HeyGirl Points"},{icon:"\u{1F4B5}",value:"Rs250 off coupon",pts:"6,000 HeyGirl Points"},{icon:"\u{1F4B5}",value:"Rs500 off coupon",pts:"11,500 HeyGirl Points"},{icon:"\u{1F4B5}",value:"Rs1,000 off coupon",pts:"22,000 HeyGirl Points"},{icon:"\u{1F4B5}",value:"Rs5,000 off coupon",pts:"100,000 HeyGirl Points"},{icon:"\u{1F4B5}",value:"Rs10,000 off coupon",pts:"180,000 HeyGirl Points"}],w=`<a href="${oe}" class="hg-pv-btn">Join now</a>
  <p class="hg-pv-signin">Already have an account? <a href="${ne}">Sign in</a></p>`;function ae(){return re.map(e=>`<div class="hg-pv-row">
      <span class="hg-pv-ic">${e.icon}</span>
      <div class="hg-pv-row-main">
        <div class="hg-pv-row-title">${e.title}</div>
        <div class="hg-pv-row-sub">${e.sub}</div>
      </div>
    </div>`).join("")}function se(){return ie.map(e=>`<div class="hg-pv-row">
      <span class="hg-pv-ic">${e.icon}</span>
      <div class="hg-pv-row-main">
        <div class="hg-pv-row-title">${e.value}</div>
        <div class="hg-pv-row-sub">${e.pts}</div>
      </div>
    </div>`).join("")}function q(e){if(document.getElementById("hg-preview"))return;let o=document.createElement("div");o.id="hg-preview",o.className="hg-widget",o.innerHTML=`
    <div class="hg-pv-head">
      <button class="hg-pv-back" id="hg-pv-back" aria-label="Back" style="display:none">\u2039</button>
      <div class="hg-pv-head-titles">
        <span class="hg-pv-eyebrow" id="hg-pv-eyebrow">Welcome to</span>
        <span class="hg-pv-title" id="hg-pv-title">HeyGirl.pk Rewards</span>
      </div>
      <button class="hg-pv-close" id="hg-pv-close" aria-label="Close">\u2715</button>
    </div>
    <div class="hg-pv-body">
      <!-- Main screen -->
      <div class="hg-pv-screen hg-active" id="hg-pv-main">
        <div class="hg-pv-card">
          <div class="hg-pv-card-title">Become a member</div>
          <div class="hg-pv-card-text">With more ways to unlock exciting perks, this is your all access pass to exclusive rewards.</div>
          ${w}
        </div>
        <div class="hg-pv-card">
          <div class="hg-pv-card-title">HeyGirl Points</div>
          <div class="hg-pv-card-text">Earn more HeyGirl Points for different actions, and turn those HeyGirl Points into awesome rewards!</div>
          <div class="hg-pv-nav-list">
            <div class="hg-pv-row hg-pv-row-nav" id="hg-pv-go-earn" role="button" tabindex="0">
              <span class="hg-pv-ic">\u{1FA99}</span>
              <div class="hg-pv-row-main"><div class="hg-pv-row-title">Ways to earn</div></div>
              <span class="hg-pv-chev">\u203A</span>
            </div>
            <div class="hg-pv-row hg-pv-row-nav" id="hg-pv-go-redeem" role="button" tabindex="0">
              <span class="hg-pv-ic">\u{1F381}</span>
              <div class="hg-pv-row-main"><div class="hg-pv-row-title">Ways to redeem</div></div>
              <span class="hg-pv-chev">\u203A</span>
            </div>
          </div>
        </div>
        <div class="hg-pv-card">
          <div class="hg-pv-card-title">Refer &amp; Earn</div>
          <div class="hg-pv-card-text">Give your friends a reward and claim your own when they make a purchase.</div>
          <div class="hg-pv-list">
            <div class="hg-pv-row">
              <span class="hg-pv-ic">\u{1F69A}</span>
              <div class="hg-pv-row-main"><div class="hg-pv-row-title">They get</div><div class="hg-pv-row-sub">Free shipping coupon</div></div>
            </div>
            <div class="hg-pv-row">
              <span class="hg-pv-ic">\u{1F4B0}</span>
              <div class="hg-pv-row-main"><div class="hg-pv-row-title">You get</div><div class="hg-pv-row-sub">6,000 HeyGirl Points</div></div>
            </div>
          </div>
          <div style="margin-top:14px">${w}</div>
        </div>
      </div>

      <!-- Ways to earn screen -->
      <div class="hg-pv-screen" id="hg-pv-earn">
        <div class="hg-pv-sub-title">Ways to earn</div>
        <div class="hg-pv-card">${ae()}</div>
        <div class="hg-pv-pill">Join now for free to start earning</div>
        ${w}
      </div>

      <!-- Ways to redeem screen -->
      <div class="hg-pv-screen" id="hg-pv-redeem">
        <div class="hg-pv-sub-title">Ways to redeem</div>
        <div class="hg-pv-card">${se()}</div>
        ${w}
      </div>
    </div>`,document.body.appendChild(o);let t=o.querySelector(".hg-pv-body"),n=o.querySelector("#hg-pv-back"),i=o.querySelector("#hg-pv-eyebrow"),r=o.querySelector("#hg-pv-title"),d={main:o.querySelector("#hg-pv-main"),earn:o.querySelector("#hg-pv-earn"),redeem:o.querySelector("#hg-pv-redeem")};function p(s){Object.values(d).forEach(m=>m.classList.remove("hg-active")),d[s].classList.add("hg-active");let a=s==="main";n.style.display=a?"none":"flex",i.style.display=a?"block":"none",r.classList.toggle("hg-pv-title-lg",a),t.scrollTop=0,a||n.focus()}function l(s){let a=document.getElementById("hg-launcher");a&&(s?(a.classList.add("hg-x"),a.innerHTML='<span class="hg-pv-x">\u2715</span>',a.setAttribute("aria-label","Close rewards preview")):(a.classList.remove("hg-x"),a.innerHTML='<span class="hg-icon">\u{1F381}</span><span>Join &amp; Earn</span>',a.setAttribute("aria-label","Open HeyGirl Rewards")))}function f(s){if(s.key==="Escape"){g();return}if(s.key==="Tab"){let a=o.querySelectorAll('a[href], button:not([disabled]), input, select, textarea, [role="button"], [tabindex]:not([tabindex="-1"])');if(a.length===0)return;let m=a[0],v=a[a.length-1];s.shiftKey&&document.activeElement===m?(s.preventDefault(),v.focus()):!s.shiftKey&&document.activeElement===v&&(s.preventDefault(),m.focus())}}function u(){p("main"),o.classList.add("hg-open"),l(!0),document.addEventListener("keydown",f),o.querySelector("#hg-pv-close")?.focus()}function g(){o.classList.remove("hg-open"),l(!1),document.removeEventListener("keydown",f),document.getElementById("hg-launcher")?.focus()}function c(s,a){let m=o.querySelector(s);m?.addEventListener("click",()=>p(a)),m?.addEventListener("keydown",v=>{(v.key==="Enter"||v.key===" ")&&(v.preventDefault(),p(a))})}c("#hg-pv-go-earn","earn"),c("#hg-pv-go-redeem","redeem"),n.addEventListener("click",()=>p("main")),o.querySelector("#hg-pv-close")?.addEventListener("click",g);let h=window;h.__hgOpenPreview=u,h.__hgClosePreview=g,h.__hgTogglePreview=()=>o.classList.contains("hg-open")?g():u()}var j="hg_nudge1_shown",D="hg_nudge5_shown";function G(e,o){let t=e.nudgeSettings;if(t.nudge1_enabled&&!e.loggedIn&&!localStorage.getItem(j)&&setTimeout(()=>de(),3e3),o==="cart"&&e.loggedIn&&e.member){let{balance:n,activeCodes:i}=e.member;t.nudge3_enabled&&i.length>0?ce(i[0]):t.nudge2_enabled&&n>=3e3&&le(n)}if(t.nudge5_enabled&&e.loggedIn&&e.member&&(o==="product"||o==="other")&&!sessionStorage.getItem(D)){let{member:n}=e;n.nextTier==="gold"&&n.spendToNextTier<=t.tier_progress_gold_threshold?B(`Only Rs.${n.spendToNextTier.toLocaleString()} away from Gold tier!`):n.nextTier==="diamond"&&n.spendToNextTier<=t.tier_progress_diamond_threshold&&B(`Only Rs.${n.spendToNextTier.toLocaleString()} away from Diamond tier!`)}}function de(){let e=k("Earn points on every purchase","Sign up free and start earning Rs. rewards on every order at HeyGirl.pk.","Join & Earn","hg-nudge-br",()=>{window.location.href="/account/register"});document.body.appendChild(e),localStorage.setItem(j,"1")}function le(e){let o=O();if(!o)return;let t=k(`You have ${e.toLocaleString()} pts to spend`,"Redeem your points for a discount before checking out.","Redeem Now","hg-nudge-cart",()=>{let n=window.__hgOpenHub;typeof n=="function"&&n(0)});o.insertAdjacentElement("beforebegin",t)}function ce(e){let o=O();if(!o)return;let t=k(`You have an unused Rs.${e.discount_pkr} reward!`,`Apply code <strong>${b(e.code)}</strong> at checkout to save.`,"Copy Code","hg-nudge-cart",()=>{navigator.clipboard?.writeText(e.code)});o.insertAdjacentElement("beforebegin",t)}function B(e){setTimeout(()=>{if(document.querySelector(".hg-nudge-br"))return;let o=k("You're close to the next tier!",e,"View Tiers","hg-nudge-br",()=>{window.location.href="/pages/rewards"});document.body.appendChild(o)},3e3),sessionStorage.setItem(D,"1")}function O(){return document.querySelector(".cart__ctas")??document.querySelector('[name="checkout"]')?.closest("div")??document.querySelector(".cart")}function k(e,o,t,n,i){let r=document.createElement("div");return r.className=`hg-nudge hg-widget ${n}`,r.innerHTML=`
    <button class="hg-nudge-close" aria-label="Close">\xD7</button>
    <div class="hg-nudge-title">${e}</div>
    <div class="hg-nudge-body">${o}</div>
    <button class="hg-btn hg-btn-primary">${t}</button>
  `,r.querySelector(".hg-nudge-close")?.addEventListener("click",()=>r.remove()),r.querySelector(".hg-btn")?.addEventListener("click",()=>{i(),r.remove()}),r}function Y(e){if(document.getElementById("hg-product-embed"))return;let o=window.ShopifyAnalytics?.meta?.product?.price??0,n=Math.floor(o/100),i=document.createElement("div");i.id="hg-product-embed",i.className="hg-widget",e.loggedIn?i.innerHTML=`<span>\u{1F381}</span> Earn <span class="hg-pts">${n.toLocaleString()} pts</span> on this purchase`:i.innerHTML=`<span>\u{1F381}</span> <a href="/account/login" style="color:#9c7600;text-decoration:underline;">Sign in to earn ${n.toLocaleString()} pts</a> on this purchase`;let r=document.querySelector(".price__container")??document.querySelector(".product__info-wrapper .price")??document.querySelector("[data-product-price]");r&&r.insertAdjacentElement("afterend",i)}function F(e){if(document.getElementById("hg-cart-inline"))return;let o=document.createElement("div");if(o.id="hg-cart-inline",o.className="hg-widget",!e.loggedIn||!e.member)o.innerHTML='<span>\u{1F381}</span> <a href="/account/login" style="color:#9c7600;">Sign in</a> to earn &amp; redeem rewards.';else{let{balance:n,activeCodes:i}=e.member,r=pe(),d=r.some(l=>l.startsWith("REWARD-")),p=r.some(l=>!l.startsWith("REWARD-"));if(d)o.innerHTML="<span>\u2705</span> Your loyalty reward is applied. Enjoy the savings!";else if(p)o.innerHTML="<span>\u2139\uFE0F</span> A discount is already applied. Loyalty codes cannot stack.";else if(i.length>0){let l=i[0];o.innerHTML=`
        <div style="margin-bottom:6px;font-weight:600;">\u{1F389} You have a Rs.${l.discount_pkr} reward ready!</div>
        <div style="font-size:12px;color:#888;margin-bottom:8px;">Code: <strong>${b(l.code)}</strong></div>
        <button class="hg-btn hg-btn-primary" id="hg-apply-code" style="margin:0;padding:8px;">Apply Code</button>
      `,setTimeout(()=>{document.getElementById("hg-apply-code")?.addEventListener("click",()=>{window.location.href=`/discount/${encodeURIComponent(l.code)}?redirect=/cart`})},0)}else if(n>=3e3)o.innerHTML=`
        <div style="margin-bottom:4px;font-weight:600;">\u{1F48E} You have ${n.toLocaleString()} pts to redeem!</div>
        <div style="font-size:12px;color:#888;margin-bottom:8px;">Earn a reward code and apply it here.</div>
        <button class="hg-btn hg-btn-secondary" id="hg-open-redeem" style="margin:0;padding:8px;">Redeem Points</button>
      `,setTimeout(()=>{document.getElementById("hg-open-redeem")?.addEventListener("click",()=>{let l=window.__hgOpenHub;typeof l=="function"&&l(0)})},0);else{let l=3e3-n;o.innerHTML=`<span>\u{1F381}</span> Earn <strong>${l.toLocaleString()} more pts</strong> to unlock your first reward.`}}let t=document.querySelector('[name="checkout"]')??document.querySelector(".cart__checkout");t&&t.insertAdjacentElement("beforebegin",o)}function pe(){let e=window.Shopify?.checkout;return e?.discount?.applicable&&e.discount.code?[e.discount.code]:[]}var ge=[{points:3e3,discount_pkr:100},{points:6e3,discount_pkr:250},{points:11500,discount_pkr:500},{points:22e3,discount_pkr:1e3},{points:1e5,discount_pkr:5e3},{points:18e4,discount_pkr:1e4}],he=["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"],ue={silver:"Rs.250 gift code",gold:"Rs.500 gift code",diamond:"Rs.1,000 code + 1.2\xD7 points all month"};function W(e,o){if(!o.member){e.innerHTML="<p style='color:#888;padding:20px 0;'>Please log in to view rewards.</p>";return}let{member:t}=o,n=new Date().getMonth()+1,i=o.nudgeSettings?.tier_progress_gold_threshold??5e4,r=o.nudgeSettings?.tier_progress_diamond_threshold??1e5,d=Math.min(100,Math.round(t.lifetimeSpend/i*100)),p=Math.min(100,Math.round(t.lifetimeSpend/r*100)),l=`
    <div class="hg-rewards-hero">
      <div class="hg-rewards-pts">${t.balance.toLocaleString()}</div>
      <div class="hg-rewards-pts-label">points available</div>
      <div class="hg-progress-label" style="margin-top:14px;">
        <span>\u2605 Gold (Rs.${i.toLocaleString()})</span>
        <span>${d}%</span>
      </div>
      <div class="hg-progress-track">
        <div class="hg-progress-fill" style="width:${d}%"></div>
      </div>
      <div class="hg-progress-label">
        <span>\u25C6 Diamond (Rs.${r.toLocaleString()})</span>
        <span>${p}%</span>
      </div>
      <div class="hg-progress-track">
        <div class="hg-progress-fill" style="width:${p}%;background:linear-gradient(90deg,#9c27b0,#e8ad00)"></div>
      </div>
      ${t.nextTier?`<div style="font-size:12px;color:rgba(255,255,255,0.8);margin-top:4px;">Rs.${t.spendToNextTier.toLocaleString()} more to reach ${t.nextTier}</div>`:`<div style="font-size:12px;color:rgba(255,255,255,0.8);margin-top:4px;">You've reached the top tier! \u{1F389}</div>`}
    </div>
  `,f=t.activeCodes.length>0?`<div class="hg-section">
        <div class="hg-section-title">\u{1F389} Active Rewards</div>
        ${t.activeCodes.map(s=>{let a=b(s.code);return`
          <div class="hg-active-code-row">
            <div>
              <strong>${a}</strong>
              <div style="color:#888;font-size:11px;">Rs.${s.discount_pkr} off &middot; expires ${new Date(s.expires_at).toLocaleDateString()}</div>
            </div>
            <button class="hg-copy-btn hg-copy-code" data-code="${a}">Copy</button>
          </div>`}).join("")}
      </div>`:`<div class="hg-section">
        <div class="hg-section-title">Active Rewards</div>
        <p style="color:#888;font-size:13px;text-align:center;padding:12px 0;">No active codes \u2014 redeem points below!</p>
      </div>`,u=ge.map(s=>{let a=t.balance>=s.points,m=s.points%1e3===500?`${(s.points/1e3).toFixed(1)}k`:`${s.points/1e3}k`;return`
      <div class="hg-redeem-tile${a?"":" hg-disabled"}" data-points="${s.points}" data-pkr="${s.discount_pkr}" role="button" tabindex="${a?0:-1}">
        <div class="hg-tile-pts">${m} pts</div>
        <div class="hg-tile-val">Rs.${s.discount_pkr.toLocaleString()}</div>
        <div class="hg-tile-label">${a?"Tap to redeem":`Need ${(s.points-t.balance).toLocaleString()} more`}</div>
      </div>`}).join(""),g=t.birthdayMonth&&t.birthdayMonth===n?`<div class="hg-birthday-card">
        <div style="font-weight:700;font-size:15px;margin-bottom:6px;">\u{1F382} Happy Birthday Month!</div>
        <div style="font-size:13px;color:#555;">
          Your ${he[t.birthdayMonth-1]} reward: <strong>${ue[t.tier]??"a special gift"}</strong>
        </div>
      </div>`:"",c=`
    <div class="hg-reward-room">
      <div style="font-size:16px;font-weight:700;margin-bottom:4px;">\u{1F3C6} Reward Room</div>
      <div style="font-size:13px;color:#aaa;margin-bottom:12px;">Exclusive products redeemable with points \u2014 coming soon!</div>
      <button class="hg-btn hg-reward-room-btn">Enter Reward Room \u2192</button>
    </div>`;e.innerHTML=`
    ${l}
    ${f}
    <div class="hg-section">
      <div class="hg-section-title">Redeem Points</div>
      <div class="hg-redeem-grid" id="hg-redeem-grid">${u}</div>
      <div id="hg-redeem-msg" class="hg-redeem-msg"></div>
    </div>
    ${g}
    ${c}
  `,e.querySelectorAll(".hg-copy-code").forEach(s=>{s.addEventListener("click",()=>{let a=s.dataset.code??"";navigator.clipboard?.writeText(a).catch(()=>{}),s.textContent="Copied!",setTimeout(()=>{s.textContent="Copy"},2e3)})});let h=e.querySelector("#hg-redeem-msg");e.querySelectorAll(".hg-redeem-tile:not(.hg-disabled)").forEach(s=>{s.addEventListener("click",async()=>{let a=Number(s.dataset.points),m=Number(s.dataset.pkr);h.textContent="Generating your reward code\u2026",h.style.color="#888",s.classList.add("hg-disabled");let v=await _(a);if(v.redeemed&&v.code){let y=b(v.code),ee=v.discount_pkr??m;h.innerHTML=`\u2705 Code <strong>${y}</strong> \u2014 Rs.${ee.toLocaleString()} off! <button class="hg-copy-btn hg-copy-result" data-code="${y}">Copy</button>`,h.style.color="#2e7d32";let R=document.querySelector(".hg-hub-balance");R&&(R.textContent=`${Math.max(0,t.balance-a).toLocaleString()} pts`),t.balance=Math.max(0,t.balance-a);let L=h.querySelector(".hg-copy-result");L?.addEventListener("click",()=>{navigator.clipboard?.writeText(v.code).catch(()=>{}),L.textContent="Copied!",setTimeout(()=>{L.textContent="Copy"},2e3)})}else h.textContent=`Failed: ${v.error??"unknown error"}`,h.style.color="#c62828",s.classList.remove("hg-disabled")})}),e.querySelector(".hg-reward-room-btn")?.addEventListener("click",s=>{if(s.preventDefault(),e.querySelector(".hg-coming-soon-tip"))return;let m=document.createElement("div");m.className="hg-coming-soon-tip",m.textContent="Coming Soon! \u{1F680}",s.currentTarget.insertAdjacentElement("afterend",m),setTimeout(()=>m.remove(),2500)})}var me={purchase:"Purchase Reward",social_youtube:"YouTube (pending)",social_facebook:"Facebook (pending)",social_instagram:"Instagram (pending)",redemption:"Redeemed",referral:"Referral Bonus",signup:"Welcome Bonus",birthday:"Birthday Reward",adjustment:"Manual Adjustment",expiry:"Points Expired"},be={purchase:"\u{1F6CD}\uFE0F",social_youtube:"\u25B6\uFE0F",social_facebook:"\u{1F44D}",social_instagram:"\u{1F4F8}",redemption:"\u{1F381}",referral:"\u{1F465}",signup:"\u{1F389}",birthday:"\u{1F382}",adjustment:"\u270F\uFE0F",expiry:"\u23F0"},fe=[{key:null,label:"All"},{key:"purchase",label:"Purchases"},{key:"social",label:"Social"},{key:"redemption",label:"Redemptions"},{key:"referral",label:"Referrals"},{key:"other",label:"Other"}];function ve(e){let o=Date.now()-new Date(e).getTime(),t=Math.floor(o/864e5);if(t===0)return"Today";if(t===1)return"Yesterday";if(t<30)return`${t} days ago`;let n=Math.floor(t/30);if(n<12)return`${n} month${n>1?"s":""} ago`;let i=Math.floor(n/12);return`${i} year${i>1?"s":""} ago`}function J(){return Array.from({length:5},()=>`
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
  `).join("")}function U(e,o){e.innerHTML=`
    <div class="hg-history-filter" id="hg-history-filter">
      ${fe.map((r,d)=>`
        <button class="hg-filter-btn${d===0?" hg-active":""}" data-type="${r.key??""}">
          ${b(r.label)}
        </button>
      `).join("")}
    </div>
    <div id="hg-history-list">${J()}</div>
    <div class="hg-pagination" id="hg-history-pagination"></div>
  `;let t=1,n=null;async function i(r,d){let p=e.querySelector("#hg-history-list"),l=e.querySelector("#hg-history-pagination");p.innerHTML=J(),l.innerHTML="";let{items:f,total:u}=await H(r,d);if(f.length===0){p.innerHTML='<p style="color:#888;font-size:13px;text-align:center;padding:32px 0;">No history yet \u2014 start earning points!</p>';return}p.innerHTML=f.map(c=>{let h=me[c.action_type]??b(c.action_type),s=be[c.action_type]??"\u2B50",a=c.delta>=0,m=c.reason_note?`<div style="font-size:11px;color:#888;">${b(c.reason_note)}</div>`:"";return`
        <div class="hg-history-item">
          <div style="display:flex;align-items:center;gap:8px;">
            <span style="font-size:18px;line-height:1;">${s}</span>
            <div>
              <div style="font-weight:600;font-size:13px;">${h}</div>
              <div style="font-size:11px;color:#888;">${ve(c.created_at)}</div>
              ${m}
            </div>
          </div>
          <div class="hg-history-delta ${a?"hg-positive":"hg-negative"}">
            ${a?"+":""}${c.delta.toLocaleString()} pts
          </div>
        </div>
      `}).join("");let g=Math.ceil(u/50);g>1&&(l.innerHTML=`
        <button class="hg-page-btn" id="hg-hist-prev" ${r<=1?"disabled":""}>\u2190 Prev</button>
        <span style="font-size:13px;padding:6px 8px;">Page ${r} of ${g}</span>
        <button class="hg-page-btn" id="hg-hist-next" ${r>=g?"disabled":""}>Next \u2192</button>
      `,l.querySelector("#hg-hist-prev")?.addEventListener("click",()=>{t--,i(t,n)}),l.querySelector("#hg-hist-next")?.addEventListener("click",()=>{t++,i(t,n)}))}e.querySelector("#hg-history-filter")?.querySelectorAll(".hg-filter-btn").forEach(r=>{r.addEventListener("click",()=>{e.querySelectorAll(".hg-filter-btn").forEach(p=>p.classList.remove("hg-active")),r.classList.add("hg-active");let d=r.dataset.type??"";n=d===""?null:d,t=1,i(1,n)})}),i(1,null)}var xe=[{platform:"youtube",label:"YouTube",pts:1e3,icon:"\u25B6"},{platform:"facebook",label:"Facebook",pts:1e3,icon:"f"},{platform:"instagram",label:"Instagram",pts:1e3,icon:"\u{1F4F7}"}];async function K(e,o){e.innerHTML='<p style="color:#888;font-size:13px;text-align:center;padding:20px 0;">Loading\u2026</p>';let t=null;try{t=await C()}catch{e.innerHTML='<p class="hg-empty-state">Could not load referral data. Please try again later.</p>';return}if(!t){e.innerHTML='<p style="color:#888;font-size:13px;text-align:center;padding:20px 0;">Referral data unavailable.</p>';return}let{referralLink:n,totalReferrals:i,completedReferrals:r,totalPtsEarned:d,history:p,isInfluencer:l,referralRate:f}=t,u=b(n),g=encodeURIComponent(`Join HeyGirl.pk and earn 1,000 welcome points! Use my link: ${n}`),c=l?`<div class="hg-influencer-badge">
        <div class="hg-influencer-title">\u2B50 Influencer Account</div>
        <div class="hg-influencer-rate">Your referral earns <strong>${f.toLocaleString()} pts</strong> per conversion</div>
        <div class="hg-influencer-stats">Total referral earnings: <strong>${d.toLocaleString()} pts</strong></div>
      </div>`:"",h=p.length>0?`<div class="hg-section-title">Referral History</div>
         ${p.slice(0,10).map(a=>`<div class="hg-history-item">
               <div>
                 <div class="hg-history-label">Referral</div>
                 <div class="hg-history-date">${new Date(a.created_at).toLocaleDateString("en-PK",{day:"numeric",month:"short",year:"numeric"})}</div>
               </div>
               <div class="hg-status-badge hg-status-${b(a.status)}">${b(a.status)}</div>
             </div>`).join("")}`:'<div class="hg-empty-state">No referrals yet \u2014 share your link to get started!</div>';e.innerHTML=`
    <div class="hg-referral-link-card">
      <div class="hg-section-title">Your Referral Link</div>
      <div class="hg-referral-url">${u}</div>
      <div class="hg-share-row">
        <a class="hg-btn hg-btn-wa" href="https://wa.me/?text=${g}" target="_blank" rel="noopener noreferrer">\u{1F4F2} WhatsApp Share</a>
        <button class="hg-btn hg-btn-copy" id="hg-ref-copy">Copy Link</button>
      </div>
    </div>

    <div class="hg-stats-row">
      <div class="hg-stat-box">
        <div class="hg-stat-num">${i}</div>
        <div class="hg-stat-lbl">Friends Referred</div>
      </div>
      <div class="hg-stat-box">
        <div class="hg-stat-num">${r}</div>
        <div class="hg-stat-lbl">Completed</div>
      </div>
      <div class="hg-stat-box">
        <div class="hg-stat-num">${d.toLocaleString()}</div>
        <div class="hg-stat-lbl">Pts Earned</div>
      </div>
    </div>

    <div class="hg-section-title">Earn Social Points</div>
    <div class="hg-social-note">One-time per platform \xB7 Points arrive in ~24h after review</div>
    <div class="hg-social-list" id="hg-social-list">
      ${xe.map(a=>`<div class="hg-social-row">
          <div class="hg-social-label">${a.icon} ${b(a.label)} <span class="hg-pts-badge">+${a.pts} pts</span></div>
          <button class="hg-btn hg-btn-social" data-platform="${a.platform}">I Followed!</button>
        </div>`).join("")}
    </div>
    <div class="hg-social-msg" id="hg-social-msg"></div>

    <div class="hg-history-section">
      ${h}
    </div>

    ${c}
  `,e.querySelector("#hg-ref-copy")?.addEventListener("click",a=>{let m=a.currentTarget;navigator.clipboard?.writeText(n).then(()=>{m.textContent="Copied!",setTimeout(()=>{m.textContent="Copy Link"},2e3)})});let s=e.querySelector("#hg-social-msg");e.querySelectorAll("[data-platform]").forEach(a=>{a.addEventListener("click",async()=>{let m=a.dataset.platform,v=a.textContent;a.textContent="Submitting\u2026",a.disabled=!0;let y=await z(m);y.alreadyClaimed?(s.textContent="Already claimed for this platform.",s.className="hg-social-msg hg-msg-warn",a.textContent="Claimed \u2713"):y.queued?(s.textContent="Submitted! Points pending 24h review",s.className="hg-social-msg hg-msg-ok",a.textContent="Queued \u2713"):(s.textContent="Something went wrong. Please try again.",s.className="hg-social-msg hg-msg-err",a.textContent=v??"I Followed!",a.disabled=!1)})})}var ye=[{key:"silver",name:"\u25C8 Silver",color:"#9e9e9e",threshold:"Default",benefits:["Earn 1 pt per Rs.1 spent","Sign-up bonus: 1,000 pts","Birthday reward: Rs.250","Referral bonus: 6,000 pts","Points expire after 1 year (FIFO)"]},{key:"gold",name:"\u2605 Gold",color:"#f9a825",threshold:"Rs.50,000 lifetime spend",benefits:["Earn 1 pt per Rs.1 spent","Points never expire","Birthday reward: Rs.500","Referral bonus: 6,000 pts","Priority customer support"]},{key:"diamond",name:"\u25C6 Diamond",color:"#7b1fa2",threshold:"Rs.100,000 lifetime spend",benefits:["Earn 1.2\xD7 points in birthday month","Points never expire","Birthday reward: Rs.1,000","Referral bonus: 6,000 pts","Early access to new arrivals","Exclusive Reward Room access"]}];function V(e,o){if(!o.member){e.innerHTML="<p style='color:#888;text-align:center;padding:16px;'>Please log in to view tier info.</p>";return}let{tier:t,lifetimeSpend:n,spendToNextTier:i,nextTier:r}=o.member,d=o.nudgeSettings?.tier_progress_gold_threshold??5e4,p=o.nudgeSettings?.tier_progress_diamond_threshold??1e5,l=Math.min(100,Math.round(n/d*100)),f=Math.min(100,Math.round(n/p*100));e.innerHTML=`
    <div class="hg-tier-cards">
      ${ye.map(u=>{let g=t===u.key,c=t==="gold"&&u.key==="silver"||t==="diamond"&&(u.key==="silver"||u.key==="gold");return`
        <div class="hg-tier-card ${g?"hg-current-tier":""} ${c?"hg-achieved-tier":""}">
          <div class="hg-tier-card-header">
            <div class="hg-tier-name" style="color:${u.color};">${u.name}</div>
            ${g?'<span class="hg-current-badge">Your Current Tier</span>':""}
            ${c?'<span class="hg-achieved-badge">Achieved \u2713</span>':""}
          </div>
          <div style="font-size:12px;color:#888;margin-bottom:8px;">Unlocks at: ${u.threshold}</div>
          ${u.benefits.map(h=>`<div class="hg-tier-benefit">\u2713 ${h}</div>`).join("")}
        </div>
      `}).join("")}
    </div>

    <div class="hg-tier-progress-section">
      <div style="font-weight:700;font-size:14px;margin-bottom:12px;">Your Progress</div>
      <div style="font-size:13px;color:#555;margin-bottom:12px;">
        Lifetime spend: <strong>Rs.${n.toLocaleString()}</strong>
        ${r?` \xB7 Rs.${i.toLocaleString()} more to reach ${r.charAt(0).toUpperCase()+r.slice(1)}`:" \xB7 Maximum tier reached!"}
      </div>
      <div class="hg-progress-label">
        <span>Silver \u2192 Gold (Rs.${d.toLocaleString()})</span><span>${l}%</span>
      </div>
      <div class="hg-progress-track">
        <div class="hg-progress-fill" style="width:${l}%;background:#f9a825;"></div>
      </div>
      <div class="hg-progress-label" style="margin-top:8px;">
        <span>Gold \u2192 Diamond (Rs.${p.toLocaleString()})</span><span>${f}%</span>
      </div>
      <div class="hg-progress-track">
        <div class="hg-progress-fill" style="width:${f}%;background:#7b1fa2;"></div>
      </div>
    </div>
  `}var Q=["My Rewards","History","Referrals","VIP Tiers"],we={silver:"\u25C8 Silver",gold:"\u2605 Gold",diamond:"\u25C6 Diamond"};function X(e){if(!e.loggedIn||!e.member)return;let{member:o}=e,t=document.createElement("div");t.id="hg-hub-overlay",t.className="hg-widget";let n=document.createElement("div");n.id="hg-hub",n.innerHTML=`
    <div class="hg-hub-header">
      <div class="hg-hub-header-top">
        <div>
          <div class="hg-hub-name">Hi, ${b(o.firstName??"there")}!</div>
          <div class="hg-hub-balance">${o.balance.toLocaleString()} pts</div>
          <span class="hg-hub-tier">${we[o.tier]??b(o.tier)}</span>
        </div>
        <button class="hg-hub-close" id="hg-hub-close" aria-label="Close">\xD7</button>
      </div>
      <div class="hg-tabs" role="tablist" aria-label="Loyalty sections">
        ${Q.map((g,c)=>`
          <button class="hg-tab${c===0?" hg-active":""}" data-tab="${c}" role="tab" id="hg-tab-${c}" aria-selected="${c===0}" aria-controls="hg-panel-${c}">${g}</button>
        `).join("")}
      </div>
    </div>
    <div class="hg-hub-body">
      ${Q.map((g,c)=>`<div class="hg-tab-panel${c===0?" hg-active":""}" id="hg-panel-${c}" role="tabpanel" aria-labelledby="hg-tab-${c}"></div>`).join("")}
    </div>
  `,t.appendChild(n),document.body.appendChild(t),W(document.getElementById("hg-panel-0"),e);let i=new Set([0]);n.querySelectorAll(".hg-tab").forEach(g=>{g.addEventListener("click",()=>{let c=Number(g.dataset.tab);n.querySelectorAll(".hg-tab").forEach(s=>{s.classList.remove("hg-active"),s.setAttribute("aria-selected","false")}),g.classList.add("hg-active"),g.setAttribute("aria-selected","true"),n.querySelectorAll(".hg-tab-panel").forEach(s=>s.classList.remove("hg-active"));let h=document.getElementById(`hg-panel-${c}`);h.classList.add("hg-active"),i.has(c)||(i.add(c),c===1&&U(h,e),c===2&&K(h,e),c===3&&V(h,e))})}),n.querySelector("#hg-hub-close")?.addEventListener("click",u),t.addEventListener("click",g=>{g.target===t&&u()}),n.setAttribute("role","dialog"),n.setAttribute("aria-modal","true"),n.setAttribute("aria-label","Loyalty Rewards"),n.setAttribute("tabindex","-1");let r='a[href], button:not([disabled]), input, select, textarea, [tabindex]:not([tabindex="-1"])',d=null,p="",l=!1;function f(g){if(g.key==="Escape"){u();return}if(g.key==="Tab"){let c=n.querySelectorAll(r);if(c.length===0)return;let h=c[0],s=c[c.length-1];g.shiftKey&&document.activeElement===h?(g.preventDefault(),s.focus()):!g.shiftKey&&document.activeElement===s&&(g.preventDefault(),h.focus())}}window.__hgOpenHub=(g=0,c)=>{t.classList.add("hg-open");let h=n.querySelector(`[data-tab="${g}"]`);h&&h.click(),l||(p=document.body.style.overflow),l=!0,document.body.style.overflow="hidden",c&&(t._launcher=c),n.focus(),d&&document.removeEventListener("keydown",d),d=f,document.addEventListener("keydown",d)};function u(){t.classList.remove("hg-open"),document.body.style.overflow=p,l=!1,d&&(document.removeEventListener("keydown",d),d=null);let g=t._launcher;g&&g.focus()}}function Z(e){let o=document.querySelector("#hg-rewards-root"),t=o??document.querySelector("#MainContent")??document.querySelector("main")??document.body,n=e.loggedIn&&!!e.member,i=e.member?.referralSlug?b(e.member.referralSlug):"",r="#9c7600",d=n?'<button class="hg-btn hg-btn-primary" id="hg-lp-hub" style="max-width:150px;margin:4px auto">Start Earning</button><button class="hg-btn hg-btn-secondary" id="hg-lp-how" style="max-width:150px;margin:4px auto">How It Works</button>':'<a href="/account/register" class="hg-btn hg-btn-primary" style="max-width:150px;margin:4px auto">Start Earning</a><button class="hg-btn hg-btn-secondary" id="hg-lp-how" style="max-width:150px;margin:4px auto">How It Works</button>',p=n&&i?`<code style="display:block;background:#fff;border-radius:5px;padding:5px;font-size:11px;color:#6b6b6b;margin:6px auto;max-width:220px;word-break:break-all;font-family:inherit">https://heygirl.pk?ref=${i}</code><button class="hg-btn hg-btn-primary" id="hg-lp-copy" style="max-width:150px;margin:0 auto">Get My Referral Link</button>`:'<a href="/account/login" class="hg-btn hg-btn-primary" style="display:block;max-width:150px;margin:0 auto">Get My Referral Link</a>',l=document.createElement("div");if(l.id="hg-landing",l.innerHTML=`<div class="s" style="padding-top:0;border-bottom:none!important"><div style="background:linear-gradient(135deg,#e8ad00,#c08f00);color:#1a1a1a;border-radius:14px;padding:26px 14px;text-align:center"><h1 style="font-size:21px;font-weight:900;margin-bottom:5px">HeyGirl Rewards \u2728</h1><p style="font-size:13px;opacity:.9;margin-bottom:3px">Earn points. Unlock perks. Shop smarter.</p><small style="opacity:.6">Join 10,000+ members</small><div style="display:flex;gap:6px;justify-content:center;flex-wrap:wrap;margin-top:12px">${d}</div></div></div>
<div class="s" id="how-it-works"><b class="hg-sh">How to Earn Points</b><div class="hg-eg"><div class="hg-ei"><b style="color:${r}">1</b><br><small><b>+1,000 pts</b></small><br><small>Sign Up</small></div><div class="hg-ei"><b style="color:${r}">2</b><br><small><b>1 pt/Rs.1</b></small><br><small>Shop</small></div><div class="hg-ei"><b style="color:${r}">3</b><br><small><b>+6,000 pts</b></small><br><small>Refer Friend</small></div><div class="hg-ei"><b style="color:${r}">4</b><br><small><b>+1,000 pts</b></small><br><small>Social Share</small></div><div class="hg-ei"><b style="color:${r}">5</b><br><small><b>+3,000 pts</b></small><br><small>Leave Review</small></div></div></div>
<div class="s"><b class="hg-sh">Redemption Tiers</b><table class="hg-rt"><thead><tr><th>Points</th><th>Reward</th></tr></thead><tbody><tr><td>3,000</td><td>Rs.100 off</td></tr><tr><td>6,000</td><td>Rs.250 off</td></tr><tr><td>11,500</td><td>Rs.500 off</td></tr><tr><td>22,000</td><td>Rs.1,000 off</td></tr><tr><td>1,00,000</td><td>Rs.5,000 off</td></tr><tr><td>1,80,000</td><td>Rs.10,000 off</td></tr></tbody></table></div>
<div class="s"><b class="hg-sh">VIP Tiers</b><div class="hg-tg"><div class="hg-tc" style="border:2px solid #9e9e9e"><b style="color:#9e9e9e">\u{1F948} Silver</b><br><small style="color:#6b6b6b">Default</small><br><small>Earn &amp; save from day one</small></div><div class="hg-tc" style="border:2px solid #f9a825"><b style="color:#f9a825">\u{1F947} Gold</b><br><small style="color:#6b6b6b">Rs.50,000 spend</small><br><small>No expiry, better birthday</small></div><div class="hg-tc" style="border:2px solid #7b1fa2"><b style="color:#7b1fa2">\u{1F48E} Diamond</b><br><small style="color:#6b6b6b">Rs.100,000 spend</small><br><small>1.2\xD7 birthday pts, premium</small></div></div></div>
<div class="s"><div style="background:linear-gradient(135deg,#fdf6e3,#f6ecc9);border-radius:12px;padding:18px;text-align:center"><b>Refer Friends, Earn More</b><p style="font-size:13px;color:#4b4b4b;margin:5px 0 9px">Earn 6,000 pts per friend who shops. They get free shipping on first order.</p>${p}</div></div>
<div class="s"><div style="background:#1a1a1a;color:#fff;border-radius:12px;padding:18px;text-align:center"><b>\u{1F512} Reward Room Coming Soon</b><p style="font-size:13px;color:#b8b8b8;margin:5px 0 7px">Exclusive products redeemable with loyalty points.</p><small style="background:rgba(255,255,255,.1);border-radius:5px;padding:3px 9px;color:#ccc">Diamond members first</small></div></div>
<div class="s" style="text-align:center"><small style="color:#6b6b6b">Are you a content creator?</small><br><b>Apply for our influencer program</b><br><a href="mailto:rewards@heygirl.pk" style="color:${r};font-size:13px;margin-top:4px;display:inline-block">Apply Now \u2192</a></div>
<div class="s"><b class="hg-sh">FAQs</b><details><summary>When do points expire?</summary><p>Silver: 1 year. Gold &amp; Diamond: never.</p></details><details><summary>Can I stack codes?</summary><p>No \u2014 one loyalty code per order.</p></details><details><summary>When do I get points?</summary><p>When order is Fulfilled + Paid, usually within minutes.</p></details><details><summary>How does referral work?</summary><p>Friend's first order \u2192 6,000 pts for you, free shipping for them.</p></details><p style="font-size:11px;color:#6b6b6b;margin-top:12px;text-align:center">Program T&amp;Cs apply. Points non-transferable, no cash value.<br><a href="mailto:rewards@heygirl.pk" style="color:${r}">Contact Support</a></p></div>`,document.getElementById("hg-landing"))return;o&&(o.innerHTML=""),t.appendChild(l);let f=window;l.querySelector("#hg-lp-hub")?.addEventListener("click",()=>{typeof f.__hgOpenHub=="function"&&f.__hgOpenHub(0)}),l.querySelector("#hg-lp-how")?.addEventListener("click",()=>{document.getElementById("how-it-works")?.scrollIntoView({behavior:"smooth"})}),i&&n&&l.querySelector("#hg-lp-copy")?.addEventListener("click",u=>{let g=u.currentTarget;navigator.clipboard?.writeText(`https://heygirl.pk?ref=${e.member.referralSlug}`).then(()=>{g.textContent="Copied!",setTimeout(()=>{g.textContent="Get My Referral Link"},2e3)})})}(function(){"use strict";function e(){if(document.getElementById("hg-styles"))return;let i=document.createElement("style");i.id="hg-styles",i.textContent=T,document.head.appendChild(i)}function o(){let i=window.location.pathname;return i==="/pages/rewards"?"rewards":i.startsWith("/products/")?"product":i==="/cart"?"cart":"other"}async function t(){try{e();let i=o();i!=="rewards"&&I();let r=await $();if(!r||r.programEnabled===!1){S();return}let d=new URLSearchParams(window.location.search).get("ref");if(d)try{localStorage.setItem("hg_pending_ref",d)}catch{}if(r.loggedIn&&r.member){let p=null;try{p=localStorage.getItem("hg_pending_ref")}catch{}p&&p!==r.member.referralSlug&&M(p).then(l=>{if(l)try{localStorage.removeItem("hg_pending_ref")}catch{}})}i!=="rewards"&&(A(r),r.loggedIn&&r.member?(N(r),X(r)):q(r)),r.nudgeSettings&&G(r,i),i==="product"&&Y(r),i==="cart"&&F(r),i==="rewards"&&Z(r)}catch{try{S()}catch{}}}function n(){let i=window.requestIdleCallback;typeof i=="function"?i(()=>void t(),{timeout:3e3}):setTimeout(()=>void t(),200)}document.readyState==="loading"?document.addEventListener("DOMContentLoaded",n):n()})();})();
