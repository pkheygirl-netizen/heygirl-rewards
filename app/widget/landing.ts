import type { CustomerResponse } from "./api";
import { escHtml } from "./utils";

export function renderLandingPage(data: CustomerResponse) {
  const target =
    document.querySelector<HTMLElement>("#MainContent") ??
    document.querySelector<HTMLElement>("main") ??
    document.body;

  const li = data.loggedIn && !!data.member;
  const slug = data.member?.referralSlug ? escHtml(data.member.referralSlug) : "";
  const P = "#9c7600";

  const heroBtns = li
    ? `<button class="hg-btn hg-btn-primary" id="hg-lp-hub" style="max-width:150px;margin:4px auto">Start Earning</button><button class="hg-btn hg-btn-secondary" id="hg-lp-how" style="max-width:150px;margin:4px auto">How It Works</button>`
    : `<a href="/account/register" class="hg-btn hg-btn-primary" style="max-width:150px;margin:4px auto">Start Earning</a><button class="hg-btn hg-btn-secondary" id="hg-lp-how" style="max-width:150px;margin:4px auto">How It Works</button>`;

  const refCta = li && slug
    ? `<code style="display:block;background:#fff;border-radius:5px;padding:5px;font-size:11px;color:#888;margin:6px auto;max-width:220px;word-break:break-all;font-family:inherit">https://heygirl.pk?ref=${slug}</code><button class="hg-btn hg-btn-primary" id="hg-lp-copy" style="max-width:150px;margin:0 auto">Get My Referral Link</button>`
    : `<a href="/account/login" class="hg-btn hg-btn-primary" style="display:block;max-width:150px;margin:0 auto">Get My Referral Link</a>`;

  const div = document.createElement("div");
  div.id = "hg-landing";
  div.innerHTML =
`<div class="s" style="padding-top:0;border-bottom:none!important"><div style="background:linear-gradient(135deg,#e8ad00,#c08f00);color:#1a1a1a;border-radius:14px;padding:26px 14px;text-align:center"><h1 style="font-size:21px;font-weight:900;margin-bottom:5px">HeyGirl Rewards ✨</h1><p style="font-size:13px;opacity:.9;margin-bottom:3px">Earn points. Unlock perks. Shop smarter.</p><small style="opacity:.6">Join 10,000+ members</small><div style="display:flex;gap:6px;justify-content:center;flex-wrap:wrap;margin-top:12px">${heroBtns}</div></div></div>
<div class="s" id="how-it-works"><b class="hg-sh">How to Earn Points</b><div class="hg-eg"><div class="hg-ei"><b style="color:${P}">1</b><br><small><b>+1,000 pts</b></small><br><small>Sign Up</small></div><div class="hg-ei"><b style="color:${P}">2</b><br><small><b>1 pt/Rs.1</b></small><br><small>Shop</small></div><div class="hg-ei"><b style="color:${P}">3</b><br><small><b>+6,000 pts</b></small><br><small>Refer Friend</small></div><div class="hg-ei"><b style="color:${P}">4</b><br><small><b>+1,000 pts</b></small><br><small>Social Share</small></div><div class="hg-ei"><b style="color:${P}">5</b><br><small><b>+3,000 pts</b></small><br><small>Leave Review</small></div></div></div>
<div class="s"><b class="hg-sh">Redemption Tiers</b><table class="hg-rt"><thead><tr><th>Points</th><th>Reward</th></tr></thead><tbody><tr><td>3,000</td><td>Rs.100 off</td></tr><tr><td>6,000</td><td>Rs.250 off</td></tr><tr><td>11,500</td><td>Rs.500 off</td></tr><tr><td>22,000</td><td>Rs.1,000 off</td></tr><tr><td>1,00,000</td><td>Rs.5,000 off</td></tr><tr><td>1,80,000</td><td>Rs.10,000 off</td></tr></tbody></table></div>
<div class="s"><b class="hg-sh">VIP Tiers</b><div class="hg-tg"><div class="hg-tc" style="border:2px solid #9e9e9e"><b style="color:#9e9e9e">🥈 Silver</b><br><small style="color:#888">Default</small><br><small>Earn &amp; save from day one</small></div><div class="hg-tc" style="border:2px solid #f9a825"><b style="color:#f9a825">🥇 Gold</b><br><small style="color:#888">Rs.50,000 spend</small><br><small>No expiry, better birthday</small></div><div class="hg-tc" style="border:2px solid #7b1fa2"><b style="color:#7b1fa2">💎 Diamond</b><br><small style="color:#888">Rs.100,000 spend</small><br><small>1.2× birthday pts, premium</small></div></div></div>
<div class="s"><div style="background:linear-gradient(135deg,#fdf6e3,#f6ecc9);border-radius:12px;padding:18px;text-align:center"><b>Refer Friends, Earn More</b><p style="font-size:13px;color:#555;margin:5px 0 9px">Earn 6,000 pts per friend who shops. They get free shipping on first order.</p>${refCta}</div></div>
<div class="s"><div style="background:#1a1a1a;color:#fff;border-radius:12px;padding:18px;text-align:center"><b>🔒 Reward Room Coming Soon</b><p style="font-size:13px;color:#aaa;margin:5px 0 7px">Exclusive products redeemable with loyalty points.</p><small style="background:rgba(255,255,255,.1);border-radius:5px;padding:3px 9px;color:#ccc">Diamond members first</small></div></div>
<div class="s" style="text-align:center"><small style="color:#888">Are you a content creator?</small><br><b>Apply for our influencer program</b><br><a href="mailto:rewards@heygirl.pk" style="color:${P};font-size:13px;margin-top:4px;display:inline-block">Apply Now →</a></div>
<div class="s"><b class="hg-sh">FAQs</b><details><summary>When do points expire?</summary><p>Silver: 1 year. Gold &amp; Diamond: never.</p></details><details><summary>Can I stack codes?</summary><p>No — one loyalty code per order.</p></details><details><summary>When do I get points?</summary><p>When order is Fulfilled + Paid, usually within minutes.</p></details><details><summary>How does referral work?</summary><p>Friend's first order → 6,000 pts for you, free shipping for them.</p></details><p style="font-size:11px;color:#888;margin-top:12px;text-align:center">Program T&amp;Cs apply. Points non-transferable, no cash value.<br><a href="mailto:rewards@heygirl.pk" style="color:${P}">Contact Support</a></p></div>`;

  target.innerHTML = "";
  target.appendChild(div);

  const win = window as unknown as Record<string, unknown>;
  div.querySelector("#hg-lp-hub")?.addEventListener("click", () => {
    if (typeof win.__hgOpenHub === "function") (win.__hgOpenHub as (t?: number) => void)(0);
  });
  div.querySelector("#hg-lp-how")?.addEventListener("click", () => {
    document.getElementById("how-it-works")?.scrollIntoView({ behavior: "smooth" });
  });
  if (slug && li) {
    div.querySelector("#hg-lp-copy")?.addEventListener("click", (e) => {
      const btn = e.currentTarget as HTMLButtonElement;
      navigator.clipboard?.writeText(`https://heygirl.pk?ref=${data.member!.referralSlug}`).then(() => {
        btn.textContent = "Copied!";
        setTimeout(() => { btn.textContent = "Get My Referral Link"; }, 2e3);
      });
    });
  }
}
