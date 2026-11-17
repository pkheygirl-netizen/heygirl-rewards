// app/widget/views.ts
// Pure HTML builders for the hub panel. Every number and text that can be
// configured comes from the storefront config or the member payload; nothing
// here touches the DOM, so the output is unit-tested as strings.
import { campaignNote, codeValue, discountUrl, esc, fmt, fmtDate, GIFT_ICON, pts, rateText, rs, tierProgress, TIER_NAME, type Config, type MemberData, type MemberState, type Tier } from "./shared";

export type Ctx = {
  cfg: Config;
  member: MemberData | null;
  loginUrl: string;
  path: string;
  origin: string;
  /** The shop's "all products" route, for the "Place an order" row ("" = no link). */
  shopUrl?: string;
  now?: number;
};

export type ReferralSummary = { rewardPoints?: number; total: number; completed: number; pointsEarned: number; rows: Array<{ status: string; at: string }> };
export type HistoryRow = { id: string; type: string; label: string; points: number; at: string; note: string | null };

export const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

export function ico(name: string): string {
  return `<svg class="hg-ic" aria-hidden="true" focusable="false"><use href="#hg-i-${name}"/></svg>`;
}

function row(icon: string, title: string, sub: string, right = ""): string {
  return `<li class="hg-row"><span class="hg-row__ic">${icon}</span><div class="hg-row__main"><p class="hg-row__t">${title}</p>${sub ? `<p class="hg-row__s">${sub}</p>` : ""}</div>${right}</li>`;
}

/** Earn-row state, always spelled out in words (colour is only a second cue). */
export type EarnState = "" | "available" | "claimed" | "pending" | "saved";
const STATE_TEXT: Record<Exclude<EarnState, "">, string> = { available: "Available", claimed: "Claimed", pending: "Pending", saved: "Saved" };

/** One icon per way to earn: original line drawings, never a platform's logo. */
export const EARN_ICON = { signup: "join", purchase: "bag", instagram: "cam", facebook: "like", youtube: "play", review: "star", birthday: "cake", referral: "friends" } as const;

/**
 * One "ways to earn" row: round icon badge, title, points and the state in
 * words. With `tap` (button attributes, or `href="…"` for a link) the whole row
 * is a single tap target ending in a chevron; without it the row is plain text.
 */
function earnRow(icon: string, title: string, sub: string, state: EarnState = "", tap = ""): string {
  const tag = !tap ? "div" : tap.indexOf("href=") === 0 ? "a" : "button";
  const st = state ? ` <span class="hg-st hg-st--${state}">${state === "claimed" || state === "saved" ? ico("check") : ""}${STATE_TEXT[state]}</span>` : "";
  return (
    `<li><${tag}${tag === "button" ? ' type="button"' : ""} class="hg-nav hg-earn-row${tap ? "" : " hg-nav--off"}"${tap ? " " + tap : ""}>` +
    `<span class="hg-row__ic">${ico(icon)}</span><span class="hg-row__main"><span class="hg-row__t">${title}</span><span class="hg-row__s">${sub}${st}</span></span>` +
    `${tap ? ico("chev") : ""}</${tag}></li>`
  );
}

function on(cfg: Config, key: keyof Config["earnRules"]): boolean {
  const r = cfg.earnRules && cfg.earnRules[key];
  return !r || r.enabled !== false;
}

/** "@handle" from the Instagram profile URL in settings ("" when unknown). */
export function instagramHandle(cfg: Config): string {
  const m = /instagram\.com\/([A-Za-z0-9._]+)/.exec((cfg.social.instagram && cfg.social.instagram.url) || "");
  return m ? "@" + m[1] : "";
}

function birthdayAmount(cfg: Config, tier: Tier): number {
  return cfg.birthday[tier] || 0;
}

const SOCIAL: Array<{ key: "instagram" | "facebook" | "youtube"; title: string }> = [
  { key: "instagram", title: "Follow on Instagram" },
  { key: "facebook", title: "Like on Facebook" },
  { key: "youtube", title: "Subscribe on YouTube" },
];

/** Same-site path only ("/collections/all"); anything else is not linked. */
function localPath(u: string | undefined): string {
  return u && u.charAt(0) === "/" && u.charAt(1) !== "/" && u.charAt(1) !== "\\" ? u : "";
}

/**
 * Ways to earn. Rules switched off in the admin are not listed. Guests see a
 * plain preview; for members every row that can be acted on is one tap target.
 */
export function earnList(c: Ctx): string {
  const { cfg } = c;
  const m = c.member;
  const mm = m ? m.member : null;
  const out: string[] = [];

  if (on(cfg, "signup") && cfg.signupPoints > 0) {
    out.push(earnRow(EARN_ICON.signup, "Join " + esc(cfg.programName), pts(cfg.signupPoints), m ? "claimed" : ""));
  }
  if (on(cfg, "purchase") && cfg.pointsRate > 0) {
    const note = campaignNote(cfg, c.now);
    const shop = m ? localPath(c.shopUrl) : "";
    out.push(
      earnRow(
        EARN_ICON.purchase,
        "Place an order",
        esc(rateText(cfg.pointsRate)) + (note ? `<br><span class="hg-chip">${esc(note)}</span>` : ""),
        m ? "available" : "",
        shop ? `href="${esc(shop)}"` : "",
      ),
    );
  }
  for (const s of SOCIAL) {
    const sc = cfg.social[s.key];
    if (!on(cfg, s.key) || !sc || !sc.enabled || !sc.url || sc.points <= 0) continue;
    const claimed = !!m && m.social[s.key] === "claimed";
    out.push(
      earnRow(
        EARN_ICON[s.key],
        s.title,
        pts(sc.points),
        !m ? "" : claimed ? "claimed" : "available",
        m && !claimed ? `data-act="social" data-p="${s.key}" data-url="${esc(sc.url)}"` : "",
      ),
    );
  }
  if (on(cfg, "review") && cfg.reviewPoints > 0) {
    const handle = instagramHandle(cfg);
    let sub = pts(cfg.reviewPoints) + (handle ? ` · tag ${esc(handle)} in your review` : "");
    let state: EarnState = "";
    let tap = "";
    if (m) {
      if (m.review.eligible) {
        state = "available";
        tap = `data-act="review"`;
        sub += `<br>Posted it? Tap here to claim.`;
      } else if (m.review.pending > 0) {
        state = "pending";
        sub += `<br>Thanks! Your points are on the way.`;
      } else sub += `<br>Available after your next delivered order.`;
    }
    out.push(earnRow(EARN_ICON.review, "Post a review", sub, state, tap));
  }
  if (on(cfg, "birthday")) {
    const amount = birthdayAmount(cfg, mm ? mm.tier : "silver");
    if (amount > 0) {
      let sub = `${rs(amount)} gift code in your birthday month`;
      if (mm && mm.birthday) sub += `<br>Your birthday: ${mm.birthday.day} ${MONTHS[mm.birthday.month - 1] || ""}`;
      out.push(earnRow(EARN_ICON.birthday, "Celebrate your birthday", sub, mm && mm.birthday ? "saved" : mm && mm.canSetBirthday ? "available" : ""));
      if (mm && mm.canSetBirthday) out.push(birthdayForm());
    }
  }
  const youGet = referralReward(c);
  if (on(cfg, "referral") && youGet > 0) {
    out.push(earnRow(EARN_ICON.referral, "Refer a friend", pts(youGet), m ? "available" : "", m ? `data-go="refer"` : ""));
  }
  return `<ul class="hg-list">${out.join("")}</ul>`;
}

/** What this visitor earns per referral: an influencer's own rate, else the standard points. */
export function referralReward(c: Ctx, summary?: ReferralSummary | null): number {
  const inf = c.member && c.member.member.isInfluencer ? c.member.influencer : null;
  if (inf && inf.rewardPoints > 0) return inf.rewardPoints;
  if (c.member && summary && summary.rewardPoints && summary.rewardPoints > 0) return summary.rewardPoints;
  return c.cfg.referralPoints;
}

/** An influencer's public discount code with a copy button ("" for everyone else). */
export function influencerBox(c: Ctx): string {
  const m = c.member;
  const inf = m && m.member.isInfluencer ? m.influencer : null;
  if (!inf || !inf.code) return "";
  const off = inf.percent ? `${esc(String(inf.percent))}% off` : "a discount";
  return (
    `<section class="hg-card"><h3 class="hg-h">Your creator code</h3><p class="hg-p">Shoppers who use your code get ${off}. You earn ${pts(inf.rewardPoints)} when a new customer's first order with it is delivered and paid.</p>` +
    `<div class="hg-ref"><label class="hg-sr" for="hg-inf-code">Your creator code</label><input id="hg-inf-code" class="hg-ref__i hg-code__c" type="text" readonly value="${esc(inf.code)}">` +
    `<button type="button" class="hg-btn hg-btn--sm" data-copy="${esc(inf.code)}">Copy</button></div></section>`
  );
}

export function birthdayForm(): string {
  const months = MONTHS.map((n, i) => `<option value="${i + 1}">${n}</option>`).join("");
  let days = "";
  for (let d = 1; d <= 31; d++) days += `<option value="${d}">${d}</option>`;
  return (
    `<li class="hg-row hg-row--form"><form class="hg-bday" data-form="birthday">` +
    `<p class="hg-row__t">Add your birthday</p>` +
    `<div class="hg-bday__f"><label><span class="hg-sr">Day</span><select name="day" required><option value="">Day</option>${days}</select></label>` +
    `<label><span class="hg-sr">Month</span><select name="month" required><option value="">Month</option>${months}</select></label>` +
    `<button type="submit" class="hg-btn hg-btn--sm">Save</button></div>` +
    `<p class="hg-row__s">It can't be changed later, so please check it.</p></form></li>`
  );
}

/** Ways to redeem. Members get a Redeem button on every tier they can afford. */
export function redeemList(c: Ctx): string {
  const balance = c.member ? c.member.member.pointsBalance : 0;
  const items = c.cfg.redemptionTiers.map((t) => {
    let right = "";
    if (c.member) {
      right =
        balance >= t.points
          ? `<button type="button" class="hg-btn hg-btn--sm" data-act="redeem" data-points="${t.points}" data-pkr="${t.discountPkr}">Redeem</button>`
          : `<span class="hg-need">${fmt(t.points - balance)} more</span>`;
    }
    return row(GIFT_ICON, `${rs(t.discountPkr)} off`, pts(t.points), right);
  });
  if (!items.length) return `<p class="hg-empty">No rewards are available right now.</p>`;
  return `<ul class="hg-list">${items.join("")}</ul>`;
}

function referPerks(c: Ctx, youGet: number): string {
  const rows: string[] = [];
  if (c.cfg.friendFreeShipping) rows.push(row(ico("truck"), "They get", "Free shipping on their first order"));
  rows.push(row(ico("coin"), "You get", pts(youGet)));
  return `<ul class="hg-list">${rows.join("")}</ul>`;
}

function joinCta(c: Ctx): string {
  return `<a class="hg-btn hg-btn--block" href="${esc(c.loginUrl)}">Join now</a><p class="hg-signin">Already a member? <a href="${esc(c.loginUrl)}">Sign in</a></p>`;
}

function navRow(icon: string, label: string, go: string): string {
  return `<li><button type="button" class="hg-nav" data-go="${go}"><span class="hg-row__ic">${icon}</span><span class="hg-nav__t">${label}</span>${ico("chev")}</button></li>`;
}

/** Guest preview home: everything from config, no request to the app server. */
export function guestHome(c: Ctx): string {
  const { cfg } = c;
  const refer =
    on(cfg, "referral") && cfg.referralPoints > 0
      ? `<section class="hg-card"><h3 class="hg-h">Refer &amp; Earn</h3><p class="hg-p">Invite a friend. You are rewarded when their first order is delivered and paid.</p>${referPerks(c, cfg.referralPoints)}</section>`
      : "";
  return (
    `<section class="hg-card"><h3 class="hg-h">Become a member</h3><p class="hg-p">${esc(cfg.tagline || "Earn points every time you shop and turn them into rewards.")}</p>${joinCta(c)}</section>` +
    `<section class="hg-card"><h3 class="hg-h">Points</h3><p class="hg-p">Earn points in different ways, then swap them for money off.</p><ul class="hg-list hg-list--nav">` +
    navRow(ico("coin"), "Ways to earn", "earn") +
    navRow(GIFT_ICON, "Ways to redeem", "redeem") +
    navRow(ico("crown"), "VIP tiers", "tiers") +
    `</ul></section>` +
    refer
  );
}

export function guestSub(c: Ctx, screen: "earn" | "redeem" | "tiers"): string {
  const body = screen === "earn" ? earnList(c) : screen === "redeem" ? redeemList(c) : tiersView(c);
  return `<section class="hg-card">${body}</section><div class="hg-foot">${joinCta(c)}</div>`;
}

export function codesList(c: Ctx): string {
  const m = c.member;
  if (!m || !m.codes.length) return `<p class="hg-empty">No rewards yet. Redeem your points below.</p>`;
  return (
    `<ul class="hg-list">` +
    m.codes
      .map(
        (k) =>
          `<li class="hg-code"><div class="hg-row__main"><p class="hg-row__t">${esc(codeValue(k))}</p><p class="hg-code__c">${esc(k.code)}</p>${k.expiresAt ? `<p class="hg-row__s">Use by ${esc(fmtDate(k.expiresAt))}</p>` : ""}</div>` +
          `<div class="hg-code__a"><button type="button" class="hg-btn hg-btn--sm hg-btn--ghost" data-copy="${esc(k.code)}">Copy</button>` +
          `<a class="hg-btn hg-btn--sm" href="${esc(discountUrl(k.code, c.path))}">Apply</a></div></li>`,
      )
      .join("") +
    `</ul>`
  );
}

export function referralUrl(c: Ctx): string {
  const link = c.member ? c.member.member.referralLink : "";
  if (!link) return "";
  try {
    return new URL(link, c.origin).href;
  } catch {
    return "";
  }
}

export function referBox(c: Ctx): string {
  const url = referralUrl(c);
  if (!url) return "";
  return (
    `<div class="hg-ref"><label class="hg-sr" for="hg-ref-link">Your referral link</label><input id="hg-ref-link" class="hg-ref__i" type="text" readonly value="${esc(url)}">` +
    `<button type="button" class="hg-btn hg-btn--sm" data-copy="${esc(url)}">Copy</button></div>`
  );
}

/** Member home tab: balance, pending points, next expiry, codes, redeem, refer. */
export function rewardsTab(c: Ctx): string {
  const m = c.member!;
  const mm = m.member;
  const notes: string[] = [];
  if (mm.pendingPoints > 0) {
    notes.push(`<p class="hg-note">${ico("clock")}<span><strong>${pts(mm.pendingPoints)}</strong> pending. They are added once your order is delivered and paid.</span></p>`);
  }
  if (m.nextExpiry && m.nextExpiry.points > 0) {
    notes.push(`<p class="hg-note hg-note--warn">${ico("clock")}<span><strong>${pts(m.nextExpiry.points)}</strong> will expire on ${esc(fmtDate(m.nextExpiry.at))}.</span></p>`);
  }
  const refer =
    on(c.cfg, "referral") && referralUrl(c)
      ? `<section class="hg-card"><h3 class="hg-h">Refer &amp; Earn</h3><p class="hg-p">Share your link. You earn when a friend's first order is delivered and paid.</p>${referBox(c)}</section>`
      : "";
  return (
    `<section class="hg-bal"><p class="hg-bal__l">Hi ${esc(mm.firstName || "there")}, you have</p><p class="hg-bal__n">${fmt(mm.pointsBalance)} <span>points</span></p><span class="hg-tier hg-tier--${mm.tier}">${TIER_NAME[mm.tier]} member</span></section>` +
    notes.join("") +
    `<section class="hg-card"><h3 class="hg-h">Your rewards</h3>${codesList(c)}</section>` +
    `<section class="hg-card"><h3 class="hg-h">Redeem points</h3>${redeemList(c)}</section>` +
    refer
  );
}

export function earnTab(c: Ctx): string {
  return `<section class="hg-card"><h3 class="hg-h">Ways to earn</h3>${earnList(c)}</section>${influencerBox(c)}`;
}

const STATUS_LABEL: Record<string, string> = {
  pending: "Waiting for their first order",
  completed: "Completed",
  not_eligible: "Not eligible",
};

export function referTab(c: Ctx, summary: ReferralSummary | null): string {
  const youGet = referralReward(c, summary);
  let stats = "";
  if (summary) {
    stats =
      `<section class="hg-card"><h3 class="hg-h">Your referrals</h3><div class="hg-stats"><p><strong>${fmt(summary.total)}</strong>Friends invited</p><p><strong>${fmt(summary.completed)}</strong>Completed</p><p><strong>${fmt(summary.pointsEarned)}</strong>Points earned</p></div>` +
      (summary.rows.length
        ? `<ul class="hg-list">${summary.rows.map((r) => `<li class="hg-hrow"><div class="hg-row__main"><p class="hg-row__t">${esc(STATUS_LABEL[r.status] || "In progress")}</p><p class="hg-row__s">${esc(fmtDate(r.at))}</p></div></li>`).join("")}</ul>`
        : `<p class="hg-empty">No referrals yet. Share your link to get started.</p>`) +
      `</section>`;
  }
  const url = referralUrl(c);
  const share = url
    ? `<a class="hg-btn hg-btn--block hg-btn--ghost" target="_blank" rel="noopener" href="https://wa.me/?text=${encodeURIComponent(`Shop with my link and get a welcome gift: ${url}`)}">Share on WhatsApp</a>`
    : "";
  return `<section class="hg-card"><h3 class="hg-h">Refer &amp; Earn</h3><p class="hg-p">Invite a friend. You are rewarded when their first order is delivered and paid.</p>${referPerks(c, youGet)}${referBox(c)}${share}</section>${influencerBox(c)}${stats}`;
}

/** "Your progress" comes first, then the three tiers with perks from config. */
export function tiersView(c: Ctx): string {
  const { cfg } = c;
  let progress = "";
  const mm = c.member ? c.member.member : null;
  if (mm) {
    const p = tierProgress(mm.lifetimeSpendPkr, mm.tier, cfg.tiers);
    progress =
      `<section class="hg-card hg-prog"><h3 class="hg-h">Your progress</h3><p class="hg-p">You are a <strong>${TIER_NAME[p.tier]}</strong> member.</p>` +
      `<div class="hg-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${p.pct}" aria-label="Progress to ${p.next ? TIER_NAME[p.next] : "top tier"}"><span style="width:${p.pct}%"></span></div>` +
      (p.next
        ? `<p class="hg-row__s">Spend ${rs(p.remaining)} more to reach ${TIER_NAME[p.next]} (${rs(p.target)} in total).</p>`
        : `<p class="hg-row__s">You have reached the top tier.</p>`) +
      `</section>`;
  }
  const perk = (t: string) => `<li>${ico("check")}<span>${t}</span></li>`;
  const bday = (t: Tier) => (on(cfg, "birthday") && cfg.birthday[t] > 0 ? perk(`${rs(cfg.birthday[t])} birthday gift code`) : "");
  const card = (t: Tier, need: string, perks: string) =>
    `<section class="hg-card hg-tcard${mm && mm.tier === t ? " hg-tcard--me" : ""}"><h3 class="hg-h"><span class="hg-tier hg-tier--${t}">${TIER_NAME[t]}</span>${mm && mm.tier === t ? `<span class="hg-chip">Your tier</span>` : ""}</h3><p class="hg-p">${need}</p><ul class="hg-perks">${perks}</ul></section>`;
  return (
    progress +
    card("silver", "Everyone starts here.", perk("Earn points on every order") + (cfg.expiryDays > 0 ? perk(`Points stay valid for ${fmt(cfg.expiryDays)} days`) : "") + bday("silver")) +
    card(
      "gold",
      `Spend ${rs(cfg.tiers.gold)} in total.`,
      perk("Points never expire") + (cfg.tierRewards.goldFreeShipping ? perk("Free shipping code when you reach Gold") : "") + bday("gold"),
    ) +
    card(
      "diamond",
      `Spend ${rs(cfg.tiers.diamond)} in total.`,
      perk("Points never expire") +
        (cfg.tierRewards.diamondPkr > 0 ? perk(`${rs(cfg.tierRewards.diamondPkr)} reward code when you reach Diamond`) : "") +
        bday("diamond") +
        (on(cfg, "birthday") ? perk("Bonus points on orders in your birthday month") : ""),
    )
  );
}

export const HISTORY_FILTERS: Array<{ key: string; label: string }> = [
  { key: "all", label: "All" },
  { key: "earned", label: "Earned" },
  { key: "redeemed", label: "Redeemed" },
  { key: "referral", label: "Referrals" },
  { key: "other", label: "Other" },
];

export function historyFilters(active: string): string {
  return (
    `<div class="hg-chips" role="group" aria-label="Filter history">` +
    HISTORY_FILTERS.map((f) => `<button type="button" class="hg-fchip" data-filter="${f.key}" aria-pressed="${f.key === active}">${f.label}</button>`).join("") +
    `</div>`
  );
}

export function historyRows(rows: HistoryRow[]): string {
  return rows
    .map((r) => {
      const sign = r.points > 0 ? "+" : r.points < 0 ? "−" : "";
      const sub = esc(fmtDate(r.at)) + (r.note ? ` · ${esc(r.note)}` : "");
      return `<li class="hg-hrow"><div class="hg-row__main"><p class="hg-row__t">${esc(r.label || "Points update")}</p><p class="hg-row__s">${sub}</p></div><span class="hg-pts${r.points < 0 ? " hg-pts--neg" : ""}">${sign}${fmt(Math.abs(r.points))}</span></li>`;
    })
    .join("");
}

export function stateMessage(c: Ctx, state: MemberState = "error"): string {
  const mm = c.member ? c.member.member : null;
  if (!mm && state === "paused") {
    return `<section class="hg-card"><h3 class="hg-h">Rewards are paused</h3><p class="hg-p">${esc(c.cfg.programName)} is taking a short break. Your points are safe, so please check back soon.</p></section>`;
  }
  if (!mm && state === "not_enrolled") {
    return `<section class="hg-card"><h3 class="hg-h">Your rewards are being set up</h3><p class="hg-p">We are getting your ${esc(c.cfg.programName)} account ready. Please check again in a few minutes.</p><button type="button" class="hg-btn hg-btn--block" data-act="retry">Check again</button></section>`;
  }
  if (mm && mm.optedOut) {
    return `<section class="hg-card"><h3 class="hg-h">You have opted out</h3><p class="hg-p">You are not part of ${esc(c.cfg.programName)} at the moment, so orders do not earn points. Contact us if you would like to join again.</p></section>`;
  }
  if (mm && mm.blocked) {
    return `<section class="hg-card"><h3 class="hg-h">Your rewards are on hold</h3><p class="hg-p">We have paused this rewards account. Please contact us and we will help.</p></section>`;
  }
  return `<section class="hg-card"><h3 class="hg-h">We could not load your rewards</h3><p class="hg-p">Please check your connection and try again.</p><button type="button" class="hg-btn hg-btn--block" data-act="retry">Try again</button></section>`;
}

const ERRORS: Record<string, string> = {
  insufficient_points: "You do not have enough points for that reward yet.",
  insufficient_balance: "You do not have enough points for that reward yet.",
  invalid_points: "That reward is no longer available. Please refresh the page to see the latest rewards.",
  invalid_tier: "That reward is no longer available. Please refresh the page to see the latest rewards.",
  opted_out: "You have opted out of the rewards program.",
  blocked: "Your rewards account is on hold. Please contact us.",
  redeem_unclear: "We could not finish this reward. If points were taken, they come back within 30 minutes, so please check your balance before trying again.",
  rate_limited: "Too many tries. Please wait a minute and try again.",
  already_set: "Your birthday is already saved. Contact us to change it.",
  invalid_date: "Please choose a valid day and month.",
  no_eligible_order: "You can claim a review after your next delivered order.",
  disabled: "This way to earn is not available right now.",
  program_disabled: "The rewards program is paused right now.",
  not_signed_in: "Please sign in again.",
  unauthorized: "Please refresh the page and try again.",
};

/** One error field everywhere (`error`); unknown codes get a generic line. */
export function errorText(code: unknown): string {
  return (typeof code === "string" && ERRORS[code]) || "Something went wrong. Please try again.";
}
