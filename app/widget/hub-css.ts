// app/widget/hub-css.ts — styles for the hub panel, injected once on first open.
// Text colours meet 4.5:1 on their backgrounds; every control is at least 44px.
// Bright gold (#e8ad00, 2:1 on white) is only ever a fill behind dark ink; every
// edge, underline or bar that carries meaning uses the accent gold (--gd: dark
// #7a5c00, 6:1, in the light style; light #f3bd1c in the dark style).
//
// Every colour is a custom property on .hg-hub. The "Dark" panel style (admin
// On-site page, config `panelTheme`) only redefines them on .hg-hub--dark; the
// launcher, toast and the cart/product lines live in the store's own page and
// keep their look. extension.test.ts checks every text/background pair of both
// token sets for 4.5:1.
//
// The panel sits inside the store's own page, so theme rules reach it. Dawn's
// base.css sets colour, font, letter-spacing and line-height on h1-h6 directly
// (`h2 { color: rgb(var(--color-foreground)) }`), which beats an inherited
// colour: in the Dark style every heading came out black on black. So every
// heading carries all of its own type styles under `.hg-hub .<class>` (higher
// than any theme element rule), every other text element type used in the
// markup gets an explicit colour under `.hg-hub`, and the theme's focus shadow
// is switched off. hub-css.test.ts checks that every text element type in the
// hub markup has such a rule.
export const HUB_LIGHT = "--g:#e8ad00;--gd:#7a5c00;--ink:#1a1a1a;--mute:#595959;--ln:#e9e2cc;--bg:#faf7ee;--card:#fff;--tint:#fbf1cf;--ok:#14491b;--okb:#e7f4e8;--err:#8a1c12;--errb:#fde8e6;--pos:#14611f;--pend:#eee;--fld:#8a8a8a;--trk:#eee4c2;--wrn:#fff4e0;--wrnl:#f0cf8a;--hb:linear-gradient(135deg,#f3bd1c,#e0a400);--ht:#1a1a1a;--hov:rgba(0,0,0,.1);--balb:#1a1a1a;--balln:#1a1a1a;--balt:#fff;--ball:#e6e6e6;--baln:#ffd24a;--ong:#1a1a1a";
export const HUB_DARK = "--gd:#f3bd1c;--ink:#f5f5f5;--mute:#bdbdbd;--ln:#3a3a3a;--bg:#121212;--card:#1e1e1e;--tint:#3d3212;--ok:#93e2a5;--okb:#15341d;--err:#ffaba1;--errb:#401a15;--pos:#86dc99;--pend:#333;--fld:#8a8a8a;--trk:#3a3a3a;--wrn:#33270a;--wrnl:#8a6a1f;--hb:#0b0b0b;--ht:#ffd24a;--hov:rgba(255,255,255,.12);--balb:linear-gradient(135deg,#f3bd1c,#e0a400);--balln:#e0a400;--balt:#1a1a1a;--ball:#1a1a1a;--baln:#111";
export const HUB_CSS = `
.hg-hub{${HUB_LIGHT};position:fixed;z-index:2147483001;right:16px;bottom:88px;width:384px;max-width:calc(100vw - 32px);height:min(660px,calc(100vh - 108px));display:flex;flex-direction:column;background:var(--bg);color:var(--ink);border-radius:16px;box-shadow:0 12px 40px rgba(0,0,0,.22);overflow:hidden;font-size:15px;line-height:1.45;letter-spacing:normal;text-align:left;opacity:0;transform:translateY(12px);transition:opacity .18s ease,transform .18s ease}
.hg-hub--dark{${HUB_DARK};color-scheme:dark;box-shadow:0 12px 40px rgba(0,0,0,.6)}
.hg-hub--dark .hg-hub__head{border-bottom:2px solid var(--gd)}
.hg-hub--left{right:auto;left:16px}
.hg-hub--open{opacity:1;transform:none}
.hg-hub[hidden],.hg-hub [hidden],.hg-bd[hidden]{display:none!important}
.hg-hub *,.hg-hub *:before,.hg-hub *:after{box-sizing:border-box;letter-spacing:normal}
.hg-hub p,.hg-hub h2,.hg-hub h3,.hg-hub ul{margin:0;padding:0;font-family:inherit}
.hg-hub ul{list-style:none}
.hg-hub :where(h2,h3,p,span,li,label,strong,option){color:inherit}
.hg-hub a{color:var(--gd)}
.hg-hub button,.hg-hub select,.hg-hub input{font:inherit;color:inherit}
.hg-hub :focus-visible{outline:3px solid var(--ink);outline-offset:2px;box-shadow:none}
.hg-hub__head :focus-visible{outline-color:var(--ht)}
.hg-hub:focus{outline:none}
.hg-bd{position:fixed;inset:0;z-index:2147483000;background:transparent}
.hg-sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.hg-ic,.hg-ico{width:22px;height:22px;flex:none}
.hg-ic{fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}
.hg-hub__head{display:flex;align-items:center;gap:4px;padding:10px 8px 10px 16px;background:var(--hb);color:var(--ht);flex:none}
.hg-hub__tt{flex:1;min-width:0}
.hg-hub__eb{font-size:13px}
.hg-hub .hg-hub__title{margin:0;color:var(--ht);font-family:inherit;font-style:normal;font-size:19px;font-weight:700;letter-spacing:normal;line-height:1.2;text-transform:none;word-break:normal;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.hg-hub__ib{width:44px;height:44px;flex:none;display:flex;align-items:center;justify-content:center;background:none;border:0;border-radius:50%;cursor:pointer;color:var(--ht)}
.hg-hub__ib:hover{background:var(--hov)}
.hg-hub__ib .hg-ic{width:24px;height:24px;stroke-width:2.2}
.hg-tabs{display:flex;flex:none;overflow-x:auto;background:var(--card);border-bottom:1px solid var(--ln);scrollbar-width:none}
.hg-tabs::-webkit-scrollbar{display:none}
.hg-tab{flex:1 0 auto;min-height:46px;padding:0 8px;background:none;border:0;border-bottom:3px solid transparent;font-size:14px;font-weight:600;color:var(--mute);cursor:pointer;white-space:nowrap}
.hg-tab[aria-selected=true]{color:var(--ink);border-bottom-color:var(--gd)}
.hg-msg{flex:none;margin:10px 12px 0;padding:10px 12px;border-radius:10px;background:var(--okb);color:var(--ok);font-size:14px;font-weight:600}
.hg-msg:empty{display:none}
.hg-msg--err{background:var(--errb);color:var(--err)}
.hg-hub__body{flex:1;overflow-y:auto;-webkit-overflow-scrolling:touch;padding:12px;overscroll-behavior:contain}
.hg-card{background:var(--card);border:1px solid var(--ln);border-radius:14px;padding:14px;margin-bottom:12px}
.hg-hub .hg-h{margin:0 0 4px;color:var(--ink);font-family:inherit;font-style:normal;font-size:16px;font-weight:700;letter-spacing:normal;line-height:1.3;text-transform:none;word-break:normal;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.hg-p{color:var(--mute);font-size:14px;margin-bottom:10px!important}
.hg-list>li+li{border-top:1px solid var(--ln)}
.hg-row,.hg-code,.hg-hrow{display:flex;align-items:center;gap:12px;padding:10px 0;min-height:56px}
.hg-row__ic{width:40px;height:40px;flex:none;border-radius:50%;background:var(--tint);color:var(--gd);display:flex;align-items:center;justify-content:center}
.hg-row__main{flex:1;min-width:0}
.hg-row__t{font-weight:600;font-size:15px}
.hg-row__s{color:var(--mute);font-size:13px}
.hg-row--form{display:block}
.hg-nav{width:100%;min-height:56px;display:flex;align-items:center;gap:12px;padding:8px 0;background:none;border:0;cursor:pointer;text-align:left}
.hg-nav__t{flex:1;font-weight:600;font-size:15px}
.hg-nav>.hg-ic{width:28px;height:28px;stroke-width:2.6;color:var(--ink)}
.hg-btn{display:inline-flex;align-items:center;justify-content:center;min-height:44px;padding:0 18px;border-radius:999px;border:2px solid var(--gd);background:var(--g);color:var(--ong)!important;font-weight:700;font-size:15px;text-decoration:none;cursor:pointer;white-space:nowrap}
.hg-btn:hover{background:#f3bd1c;color:var(--ong)!important}
.hg-btn--sm{padding:0 14px;font-size:14px;flex:none}
.hg-btn--ghost{background:var(--card);color:var(--ink)!important}
.hg-btn--block{display:flex;width:100%;margin-top:6px}
.hg-btn .hg-ic{width:20px;height:20px;margin-right:8px;stroke-width:2}
.hg-btn[disabled]{opacity:.55;cursor:default}
.hg-signin{text-align:center;font-size:14px;color:var(--mute);margin-top:10px!important}
.hg-signin a{display:inline-flex;align-items:center;min-height:44px;min-width:44px;padding:0 6px;font-weight:700}
.hg-foot{padding:0 4px 8px}
.hg-hub a.hg-nav{color:inherit;text-decoration:none}
.hg-nav--off{cursor:default}
.hg-nav[disabled]{opacity:.55}
.hg-earn-row .hg-row__t,.hg-earn-row .hg-row__s{display:block}
.hg-st{display:inline-flex;align-items:center;gap:3px;padding:1px 8px;border-radius:999px;background:var(--tint);color:var(--gd);font-size:12px;font-weight:700;white-space:nowrap;vertical-align:middle}
.hg-st--claimed,.hg-st--saved{background:var(--okb);color:var(--ok)}
.hg-st--pending{background:var(--pend);color:var(--mute)}
.hg-st .hg-ic{width:13px;height:13px;stroke-width:3.2}
.hg-need{color:var(--mute);font-size:13px;flex:none;text-align:right}
.hg-chip{display:inline-block;padding:2px 8px;border-radius:999px;background:var(--tint);color:var(--gd);font-size:12px;font-weight:700}
.hg-empty{color:var(--mute);font-size:14px;padding:8px 0}
.hg-bal{background:var(--balb);border:1px solid var(--balln);color:var(--balt);border-radius:14px;padding:16px;margin-bottom:12px}
.hg-bal__l{font-size:14px;color:var(--ball)}
.hg-bal__n{font-size:34px;font-weight:800;line-height:1.15;color:var(--baln);margin:2px 0 8px!important}
.hg-bal__n span{font-size:15px;font-weight:600;color:var(--balt)}
.hg-tier{display:inline-block;padding:3px 12px;border-radius:999px;font-size:13px;font-weight:700;background:#e4e4e4;color:#1a1a1a}
.hg-tier{border:1px solid #595959}
.hg-tier--gold{background:#f3bd1c;border-color:var(--gd)}
.hg-tier--diamond{background:#d9ccff}
.hg-hub--dark .hg-bal .hg-tier{border-color:var(--baln)}
.hg-note{display:flex;gap:10px;align-items:flex-start;background:var(--card);border:1px solid var(--ln);border-radius:12px;padding:10px 12px;margin-bottom:12px!important;font-size:14px}
.hg-note .hg-ic{color:var(--gd);margin-top:1px}
.hg-note--warn{background:var(--wrn);border-color:var(--wrnl)}
.hg-card>.hg-note:last-child{margin-bottom:0!important}
.hg-code{flex-wrap:wrap}
.hg-code__c{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:14px;font-weight:700;word-break:break-all}
.hg-code__a{display:flex;gap:8px;flex:none}
.hg-ref{display:flex;gap:8px;margin:10px 0 4px}
.hg-ref__i{flex:1;min-width:0;height:44px;padding:0 12px;border:1px solid var(--fld);border-radius:10px;background:var(--card);font-size:14px}
.hg-stats{display:flex;gap:8px;margin:6px 0 4px}
.hg-stats p{flex:1;background:var(--bg);border-radius:10px;padding:10px 6px;text-align:center;font-size:12px;color:var(--mute)}
.hg-stats strong{display:block;font-size:18px;color:var(--ink)}
.hg-bar{height:10px;border-radius:999px;background:var(--trk);overflow:hidden;margin:4px 0 8px}
.hg-bar{border:1px solid var(--gd)}
.hg-bar span{display:block;height:100%;background:var(--gd);border-radius:999px}
.hg-tcard--me{border:2px solid var(--gd)}
.hg-hub .hg-sec{margin:4px 2px 8px}
.hg-hub .hg-link{display:flex;align-items:center;gap:2px;min-height:44px;margin:-6px 0 6px;padding:0 4px;background:none;border:0;color:var(--gd);font-size:15px;font-weight:700;cursor:pointer;text-align:left}
.hg-link .hg-ic{width:18px;height:18px;stroke-width:2.6}
.hg-link:hover{text-decoration:underline}
.hg-perks li{display:flex;gap:8px;align-items:flex-start;font-size:14px;padding:4px 0}
.hg-perks .hg-ic{width:18px;height:18px;color:var(--pos);stroke-width:2.6;margin-top:2px}
.hg-chips{display:flex;gap:8px;overflow-x:auto;padding-bottom:10px;scrollbar-width:none}
.hg-fchip{flex:none;min-height:44px;padding:0 16px;border-radius:999px;border:1px solid var(--fld);background:var(--card);font-size:14px;font-weight:600;cursor:pointer}
.hg-fchip[aria-pressed=true]{background:var(--ink);color:var(--card);border-color:var(--ink)}
.hg-pts{font-weight:700;color:var(--pos);flex:none}
.hg-pts--neg{color:var(--err)}
.hg-bday__f{display:flex;gap:8px;margin:8px 0 6px;flex-wrap:wrap}
.hg-bday select{height:44px;padding:0 10px;border:1px solid var(--fld);border-radius:10px;background:var(--card);font-size:15px}
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
  // Ways to earn: generic shapes only (heart, thumbs-up, play, camera), never a platform's logo.
  P("heart", "M12 20.5C6 16.6 3 13.4 3 9.6 3 7 5 5 7.5 5c1.8 0 3.4 1 4.5 2.6C13.1 6 14.7 5 16.5 5 19 5 21 7 21 9.6c0 3.8-3 7-9 10.9z") +
  P("join", "M10 12a4 4 0 100-8 4 4 0 000 8zM3 20a7 7 0 0114 0M19 7.5v6M16 10.5h6") +
  P("cam", "M4.5 8h3L9 5.5h6L16.5 8h3A1.5 1.5 0 0121 9.5v8a1.5 1.5 0 01-1.5 1.5h-15A1.5 1.5 0 013 17.5v-8A1.5 1.5 0 014.5 8zM12 10.25a3.25 3.25 0 100 6.5 3.25 3.25 0 000-6.5z") +
  P("like", "M3.5 10.5h4V20h-4zM7.5 10.5L11 4c1.5 0 2.5 1.2 2.2 2.7l-.6 3.3h5.3a2 2 0 012 2.4l-1.2 6a2 2 0 01-2 1.6H7.5") +
  P("play", "M12 3a9 9 0 100 18 9 9 0 000-18zM10 8.3l5.6 3.7-5.6 3.7V8.3z") +
  P("bag", "M5 8h14l-1 12H6L5 8zM9 8V7a3 3 0 016 0v1") +
  // Ways to redeem: two currency notes (the gift stays on the launcher).
  P("notes", "M5 5.5h15a1.5 1.5 0 011.5 1.5v9M4 8h13a1.5 1.5 0 011.5 1.5v8A1.5 1.5 0 0117 19H4a1.5 1.5 0 01-1.5-1.5v-8A1.5 1.5 0 014 8zM10.5 11.25a2.25 2.25 0 100 4.5 2.25 2.25 0 000-4.5zM5.5 11v.01M15.5 16v.01") +
  P("cake", "M4 20h16M5 20v-7h14v7M5 16c1.2 1 2.3 1 3.5 0s2.3-1 3.5 0 2.3 1 3.5 0 2.3-1 3.5 0M12 13V9.5M12 6.5v.01") +
  P("friends", "M9 11a3.5 3.5 0 100-7 3.5 3.5 0 000 7zM2.5 20a6.5 6.5 0 0113 0M16 4.3a3.5 3.5 0 010 6.4M18 14.5a6.5 6.5 0 013.5 5.5") +
  P("truck", "M2.5 6.5h11v10h-11zM13.5 10h4l3 3v3.5h-7M7 19a2 2 0 100-4 2 2 0 000 4zM17 19a2 2 0 100-4 2 2 0 000 4z") +
  P("clock", "M12 3a9 9 0 100 18 9 9 0 000-18zM12 7.5V12l3 2") +
  // Share on WhatsApp: a plain chat bubble, never the WhatsApp logo.
  P("chat", "M5 4.5h14A2.5 2.5 0 0121.5 7v8a2.5 2.5 0 01-2.5 2.5h-8l-5 3.5v-3.5H5A2.5 2.5 0 012.5 15V7A2.5 2.5 0 015 4.5zM8 11v.01M12 11v.01M16 11v.01") +
  P("crown", "M4 18.5h16M4.5 15L3 7l5 3.5L12 5l4 5.5L21 7l-1.5 8h-15z") +
  `</svg>`;
