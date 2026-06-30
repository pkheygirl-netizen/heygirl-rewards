// app/widget/styles.ts
// All widget CSS injected as a single <style> tag on init.
// Uses BEM-like class names prefixed with `hg-` to avoid collisions.
export const CSS = `
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
.hg-progress-label { display: flex; justify-content: space-between; font-size: 12px; color: #888; margin-bottom: 4px; }
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
.hg-referral-link { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #888; }
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
  font-size: 18px; cursor: pointer; color: #888; line-height: 1;
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
.hg-redeem-tile .hg-tile-label { font-size: 10px; color: #888; }

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
.hg-stat-label { font-size: 11px; color: #888; margin-top: 2px; }

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
  background: #f6ecc9; color: #888; border-radius: 20px;
  padding: 2px 8px; font-size: 11px; font-weight: 600; white-space: nowrap;
}
.hg-tier-benefit { font-size: 12px; color: #555; margin: 3px 0; }
.hg-tier-progress-section { margin-top: 16px; padding-top: 16px; border-top: 1px solid #f6ecc9; }

/* ---- Hub Tab 3: Referrals ---- */
.hg-referral-link-card { background: #fdf6e3; border-radius: 12px; padding: 16px; margin-bottom: 16px; }
.hg-referral-url { background: #fff; border: 1px solid #ead9a0; border-radius: 8px; padding: 10px; font-size: 12px; color: #888; word-break: break-all; margin-bottom: 10px; }
.hg-btn { border: none; border-radius: 8px; padding: 9px 14px; font-size: 12px; font-weight: 700; cursor: pointer; text-decoration: none; display: inline-flex; align-items: center; justify-content: center; }
.hg-btn-wa { background: #25d366; color: #fff; flex: 1; }
.hg-btn-copy { background: #e8ad00; color: #1a1a1a; flex: 1; }
.hg-stats-row { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; margin-bottom: 20px; }
.hg-stat-box { background: #f6ecc9; border-radius: 10px; padding: 10px 6px; text-align: center; }
.hg-stat-num { font-size: 20px; font-weight: 800; color: #9c7600; }
.hg-stat-lbl { font-size: 11px; color: #888; margin-top: 2px; }
.hg-social-note { font-size: 12px; color: #888; margin-bottom: 10px; }
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
.hg-history-date { font-size: 11px; color: #888; margin-top: 2px; }
.hg-status-badge { font-size: 12px; text-transform: capitalize; padding: 3px 10px; border-radius: 20px; background: #f6ecc9; color: #9c7600; }
.hg-status-rewarded { background: #e8f5e9; color: #2e7d32; }
.hg-empty-state { font-size: 13px; color: #aaa; text-align: center; padding: 16px 0; }
.hg-influencer-badge { background: #fff8e1; border: 1px solid #ffe082; border-radius: 10px; padding: 14px; margin-top: 16px; }
.hg-influencer-title { font-weight: 700; font-size: 13px; margin-bottom: 4px; }
.hg-influencer-rate { font-size: 12px; color: #555; margin-bottom: 4px; }
.hg-influencer-stats { font-size: 12px; color: #555; }
#hg-landing{max-width:860px;margin:0 auto;padding:0 16px}#hg-landing .s{padding:22px 0;border-bottom:1px solid #f6ecc9}#hg-landing .s:last-child{border-bottom:none}.hg-sh{display:block;text-align:center;margin-bottom:9px}.hg-eg{display:grid;grid-template-columns:repeat(auto-fit,minmax(110px,1fr));gap:6px}.hg-ei{text-align:center;padding:9px 3px;background:#fdf6e3;border-radius:7px}.hg-rt{width:100%;border-collapse:collapse;font-size:13px}.hg-rt th{background:#e8ad00;color:#1a1a1a;padding:6px}.hg-rt td{padding:6px;border-bottom:1px solid #f6ecc9}.hg-rt tr:nth-child(even) td{background:#fdf6e3}.hg-tg{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:7px}.hg-tc{border-radius:7px;padding:9px}#hg-landing details{border-bottom:1px solid #f6ecc9;padding:6px 0}#hg-landing summary{font-weight:700;font-size:13px;cursor:pointer}#hg-landing details p{font-size:12px;color:#555;margin-top:3px}

/* ---- Logged-out preview overlay (gold theme — matches Join & Earn flow) ---- */
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
.hg-pv-row-sub { font-size: 13px; color: #9ca3af; margin-top: 1px; }
.hg-pv-chev { color: #c0c0c0; font-size: 18px; flex-shrink: 0; }
.hg-pv-pill { background: #eef0f4; border-radius: 10px; padding: 13px; text-align: center; font-size: 13px; color: #4b5563; margin: 6px 0 14px; }
.hg-pv-sub-title { font-size: 16px; font-weight: 800; margin: 4px 2px 10px; color: #1a1a1a; }
`;

