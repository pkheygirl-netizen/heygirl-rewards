// app/widget/hub-css.ts — styles for the hub panel, injected once on first open.
// Text colours meet 4.5:1 on their backgrounds; every control is at least 44px.
export const HUB_CSS = `
.hg-hub{--g:#e8ad00;--gd:#7a5c00;--ink:#1a1a1a;--mute:#595959;--ln:#e9e2cc;--bg:#faf7ee;position:fixed;z-index:2147483001;right:16px;bottom:88px;width:384px;max-width:calc(100vw - 32px);height:min(660px,calc(100vh - 108px));display:flex;flex-direction:column;background:var(--bg);color:var(--ink);border-radius:16px;box-shadow:0 12px 40px rgba(0,0,0,.22);overflow:hidden;font-size:15px;line-height:1.45;letter-spacing:normal;text-align:left;opacity:0;transform:translateY(12px);transition:opacity .18s ease,transform .18s ease}
.hg-hub--left{right:auto;left:16px}
.hg-hub--open{opacity:1;transform:none}
.hg-hub[hidden],.hg-hub [hidden],.hg-bd[hidden]{display:none!important}
.hg-hub *,.hg-hub *:before,.hg-hub *:after{box-sizing:border-box;letter-spacing:normal}
.hg-hub p,.hg-hub h2,.hg-hub h3,.hg-hub ul{margin:0;padding:0;font-family:inherit}
.hg-hub ul{list-style:none}
.hg-hub a{color:var(--gd)}
.hg-hub button,.hg-hub select,.hg-hub input{font:inherit;color:inherit}
.hg-hub :focus-visible{outline:3px solid #1a1a1a;outline-offset:2px}
.hg-hub:focus{outline:none}
.hg-bd{position:fixed;inset:0;z-index:2147483000;background:transparent}
.hg-sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.hg-ic,.hg-ico{width:22px;height:22px;flex:none}
.hg-ic{fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}
.hg-hub__head{display:flex;align-items:center;gap:4px;padding:10px 8px 10px 16px;background:linear-gradient(135deg,#f3bd1c,#e0a400);color:var(--ink);flex:none}
.hg-hub__tt{flex:1;min-width:0}
.hg-hub__eb{font-size:13px}
.hg-hub__title{font-size:19px;font-weight:700;line-height:1.2;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.hg-hub__ib{width:44px;height:44px;flex:none;display:flex;align-items:center;justify-content:center;background:none;border:0;border-radius:50%;cursor:pointer;color:var(--ink)}
.hg-hub__ib:hover{background:rgba(0,0,0,.1)}
.hg-hub__ib .hg-ic{width:24px;height:24px;stroke-width:2.2}
.hg-tabs{display:flex;flex:none;overflow-x:auto;background:#fff;border-bottom:1px solid var(--ln);scrollbar-width:none}
.hg-tabs::-webkit-scrollbar{display:none}
.hg-tab{flex:1 0 auto;min-height:46px;padding:0 13px;background:none;border:0;border-bottom:3px solid transparent;font-size:14px;font-weight:600;color:var(--mute);cursor:pointer;white-space:nowrap}
.hg-tab[aria-selected=true]{color:var(--ink);border-bottom-color:var(--g)}
.hg-msg{flex:none;margin:10px 12px 0;padding:10px 12px;border-radius:10px;background:#e7f4e8;color:#14491b;font-size:14px;font-weight:600}
.hg-msg:empty{display:none}
.hg-msg--err{background:#fde8e6;color:#8a1c12}
.hg-hub__body{flex:1;overflow-y:auto;-webkit-overflow-scrolling:touch;padding:12px;overscroll-behavior:contain}
.hg-card{background:#fff;border:1px solid var(--ln);border-radius:14px;padding:14px;margin-bottom:12px}
.hg-h{font-size:16px;font-weight:700;margin-bottom:4px!important;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.hg-p{color:var(--mute);font-size:14px;margin-bottom:10px!important}
.hg-list>li+li{border-top:1px solid var(--ln)}
.hg-row,.hg-code,.hg-hrow{display:flex;align-items:center;gap:12px;padding:10px 0;min-height:56px}
.hg-row__ic{width:40px;height:40px;flex:none;border-radius:50%;background:#fbf1cf;color:var(--gd);display:flex;align-items:center;justify-content:center}
.hg-row__main{flex:1;min-width:0}
.hg-row__t{font-weight:600;font-size:15px}
.hg-row__s{color:var(--mute);font-size:13px}
.hg-row--form{display:block}
.hg-nav{width:100%;min-height:56px;display:flex;align-items:center;gap:12px;padding:8px 0;background:none;border:0;cursor:pointer;text-align:left}
.hg-nav__t{flex:1;font-weight:600;font-size:15px}
.hg-nav>.hg-ic{width:28px;height:28px;stroke-width:2.6;color:var(--ink)}
.hg-btn{display:inline-flex;align-items:center;justify-content:center;min-height:44px;padding:0 18px;border-radius:999px;border:2px solid var(--g);background:var(--g);color:var(--ink)!important;font-weight:700;font-size:15px;text-decoration:none;cursor:pointer;white-space:nowrap}
.hg-btn:hover{background:#f3bd1c}
.hg-btn--sm{padding:0 14px;font-size:14px;flex:none}
.hg-btn--ghost{background:#fff}
.hg-btn--block{display:flex;width:100%;margin-top:6px}
.hg-btn[disabled]{opacity:.55;cursor:default}
.hg-signin{text-align:center;font-size:14px;color:var(--mute);margin-top:10px!important}
.hg-signin a{display:inline-block;padding:10px 4px;font-weight:700}
.hg-foot{padding:0 4px 8px}
.hg-done{display:inline-flex;align-items:center;gap:4px;color:#14611f;font-weight:700;font-size:14px;flex:none}
.hg-done .hg-ic{width:18px;height:18px;stroke-width:2.6}
.hg-need{color:var(--mute);font-size:13px;flex:none;text-align:right}
.hg-chip{display:inline-block;padding:2px 8px;border-radius:999px;background:#fbf1cf;color:var(--gd);font-size:12px;font-weight:700}
.hg-empty{color:var(--mute);font-size:14px;padding:8px 0}
.hg-bal{background:#1a1a1a;color:#fff;border-radius:14px;padding:16px;margin-bottom:12px}
.hg-bal__l{font-size:14px;color:#e6e6e6}
.hg-bal__n{font-size:34px;font-weight:800;line-height:1.15;color:#ffd24a;margin:2px 0 8px!important}
.hg-bal__n span{font-size:15px;font-weight:600;color:#fff}
.hg-tier{display:inline-block;padding:3px 12px;border-radius:999px;font-size:13px;font-weight:700;background:#e4e4e4;color:#1a1a1a}
.hg-tier--gold{background:#f3bd1c}
.hg-tier--diamond{background:#d9ccff}
.hg-note{display:flex;gap:10px;align-items:flex-start;background:#fff;border:1px solid var(--ln);border-radius:12px;padding:10px 12px;margin-bottom:12px!important;font-size:14px}
.hg-note .hg-ic{color:var(--gd);margin-top:1px}
.hg-note--warn{background:#fff4e0;border-color:#f0cf8a}
.hg-code{flex-wrap:wrap}
.hg-code__c{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:14px;font-weight:700;word-break:break-all}
.hg-code__a{display:flex;gap:8px;flex:none}
.hg-ref{display:flex;gap:8px;margin:10px 0 4px}
.hg-ref__i{flex:1;min-width:0;height:44px;padding:0 12px;border:1px solid #8a8a8a;border-radius:10px;background:#fff;font-size:14px}
.hg-stats{display:flex;gap:8px;margin:6px 0 4px}
.hg-stats p{flex:1;background:var(--bg);border-radius:10px;padding:10px 6px;text-align:center;font-size:12px;color:var(--mute)}
.hg-stats strong{display:block;font-size:18px;color:var(--ink)}
.hg-bar{height:10px;border-radius:999px;background:#eee4c2;overflow:hidden;margin:4px 0 8px}
.hg-bar span{display:block;height:100%;background:var(--g);border-radius:999px}
.hg-tcard--me{border:2px solid var(--g)}
.hg-perks li{display:flex;gap:8px;align-items:flex-start;font-size:14px;padding:4px 0}
.hg-perks .hg-ic{width:18px;height:18px;color:#14611f;stroke-width:2.6;margin-top:2px}
.hg-chips{display:flex;gap:8px;overflow-x:auto;padding-bottom:10px;scrollbar-width:none}
.hg-fchip{flex:none;min-height:44px;padding:0 16px;border-radius:999px;border:1px solid #8a8a8a;background:#fff;font-size:14px;font-weight:600;cursor:pointer}
.hg-fchip[aria-pressed=true]{background:var(--ink);color:#fff;border-color:var(--ink)}
.hg-pts{font-weight:700;color:#14611f;flex:none}
.hg-pts--neg{color:#8a1c12}
.hg-bday__f{display:flex;gap:8px;margin:8px 0 6px;flex-wrap:wrap}
.hg-bday select{height:44px;padding:0 10px;border:1px solid #8a8a8a;border-radius:10px;background:#fff;font-size:15px}
.hg-load{padding:28px 0;text-align:center;color:var(--mute)}
@media (max-width:600px){
.hg-hub,.hg-hub--left{left:0;right:0;bottom:0;width:auto;max-width:none;height:92vh;height:92dvh;border-radius:16px 16px 0 0;transform:translateY(24px)}
.hg-hub--open{transform:none}
.hg-bd{background:rgba(0,0,0,.45)}
}
@media (prefers-reduced-motion:reduce){.hg-hub{transition:none;transform:none}}
`;

const P = (id: string, d: string) => `<symbol id="hg-i-${id}" viewBox="0 0 24 24"><path d="${d}"/></symbol>`;

/** Line icons (stroke = currentColor). The gift icon is defined by the embed. */
export const HUB_ICONS =
  `<svg xmlns="http://www.w3.org/2000/svg" width="0" height="0" style="position:absolute" aria-hidden="true">` +
  P("chev", "M9 5l7 7-7 7") +
  P("back", "M15 5l-7 7 7 7") +
  P("x", "M6 6l12 12M18 6L6 18") +
  P("check", "M5 12.5l4.5 4.5L19 7.5") +
  P("coin", "M12 3a9 9 0 100 18 9 9 0 000-18zM12 7v10M14.5 9.5H11a1.75 1.75 0 000 3.5h2a1.75 1.75 0 010 3.5H9.5") +
  P("user", "M12 12a4 4 0 100-8 4 4 0 000 8zM4.5 20a7.5 7.5 0 0115 0") +
  P("bag", "M5 8h14l-1 12H6L5 8zM9 8V7a3 3 0 016 0v1") +
  P("instagram", "M7.5 3.5h9a4 4 0 014 4v9a4 4 0 01-4 4h-9a4 4 0 01-4-4v-9a4 4 0 014-4zM12 8.5a3.5 3.5 0 100 7 3.5 3.5 0 000-7zM17 7h.01") +
  P("facebook", "M14 21v-7h2.5l.5-3h-3V9.2c0-.9.3-1.7 1.7-1.7H17V4.8c-.3 0-1.2-.1-2.2-.1-2.3 0-3.8 1.4-3.8 3.9V11H8.5v3H11v7") +
  P("youtube", "M3.5 8.5a3 3 0 013-3h11a3 3 0 013 3v7a3 3 0 01-3 3h-11a3 3 0 01-3-3v-7zM10.5 9.5l4 2.5-4 2.5v-5z") +
  P("star", "M12 3.5l2.6 5.3 5.9.9-4.2 4.1 1 5.8L12 16.9l-5.3 2.7 1-5.8-4.2-4.1 5.9-.9L12 3.5z") +
  P("cake", "M4 20h16M5 20v-7h14v7M5 16c1.2 1 2.3 1 3.5 0s2.3-1 3.5 0 2.3 1 3.5 0 2.3-1 3.5 0M12 13V9.5M12 6.5v.01") +
  P("friends", "M9 11a3.5 3.5 0 100-7 3.5 3.5 0 000 7zM2.5 20a6.5 6.5 0 0113 0M16 4.3a3.5 3.5 0 010 6.4M18 14.5a6.5 6.5 0 013.5 5.5") +
  P("truck", "M2.5 6.5h11v10h-11zM13.5 10h4l3 3v3.5h-7M7 19a2 2 0 100-4 2 2 0 000 4zM17 19a2 2 0 100-4 2 2 0 000 4z") +
  P("clock", "M12 3a9 9 0 100 18 9 9 0 000-18zM12 7.5V12l3 2") +
  P("crown", "M4 18.5h16M4.5 15L3 7l5 3.5L12 5l4 5.5L21 7l-1.5 8h-15z") +
  `</svg>`;
