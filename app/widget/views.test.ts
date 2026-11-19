import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { EARN_ICON, REDEEM_ICON, REVIEW_PENDING_TEXT, reviewTitle, earnList, earnTab, errorText, guestHome, guestSub, historyRows, influencerBox, instagramHandle, REDEEM_PAUSED_TEXT, redeemList, referralReward, OTHER_LEVELS_TITLE, PERKS_LINK_TEXT, progressCard, referTab, rewardsTab, stateMessage, tierCards, TOP_LEVEL_TEXT, type Ctx } from "./views";
import { makeConfig, makeMember } from "./test-fixtures";
import { HUB_CSS, HUB_ICONS } from "./hub-css";

/** WCAG contrast ratio of two #rgb / #rrggbb colours. */
function contrast(a: string, b: string): number {
  const lum = (h: string) => {
    const hex = h.length === 4 ? "#" + h[1] + h[1] + h[2] + h[2] + h[3] + h[3] : h;
    const [r, g, bl] = [1, 3, 5].map((i) => {
      const c = parseInt(hex.slice(i, i + 2), 16) / 255;
      return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}
/** The <li> rows of an earn list, keyed by their title text. */
function rows(html: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const li of html.split("<li").slice(1)) {
    const t = /class="hg-row__t">([^<]+)</.exec(li);
    if (t) out[t[1]] = "<li" + li;
  }
  return out;
}

const ctx = (over: Partial<Ctx> = {}): Ctx => ({ cfg: makeConfig(), member: null, loginUrl: "/customer_authentication/login", path: "/", origin: "https://shop.example", ...over });

describe("guest preview (config only)", () => {
  it("uses the login route, config numbers and the Refer & Earn heading", () => {
    const h = guestHome(ctx());
    expect(h).toContain('href="/customer_authentication/login"');
    expect(h).toContain("Refer &amp; Earn");
    expect(h).toContain("6,000 points");
    expect(h).toContain('data-go="earn"');
    expect(h).toContain('data-go="redeem"');
    expect(h).not.toMatch(/[\u{1F300}-\u{1FAFF}]/u); // no emoji icons
  });

  it("lists only enabled earn rules, with points from config", () => {
    const cfg = makeConfig({ signupPoints: 1500 });
    cfg.earnRules.review.enabled = false;
    cfg.social.facebook.enabled = false;
    const h = earnList(ctx({ cfg }));
    expect(h).toContain("1,500 points");
    expect(h).not.toContain("Post your order review");
    expect(h).not.toContain("Facebook");
    expect(h).toContain("Follow on Instagram");
    expect(h).not.toContain("<button"); // guests get no action buttons
  });

  it("derives the review tag from the Instagram URL in settings", () => {
    expect(instagramHandle(makeConfig())).toBe("@heygirl.pk");
    expect(earnList(ctx())).toContain(">Post your order review &amp; tag @heygirl.pk<");
  });
});

describe("member views", () => {
  it("social rows carry the profile URL to open before claiming", () => {
    const h = earnList(ctx({ member: makeMember({}, { social: { instagram: "available", facebook: "claimed", youtube: "available" } }) }));
    expect(h).toContain('data-act="social" data-p="instagram" data-url="https://instagram.com/heygirl.pk"');
    expect(h).not.toContain('data-p="facebook"');
  });

  it("shows birthday entry once, review claim only when eligible", () => {
    const can = earnList(ctx({ member: makeMember({ canSetBirthday: true }, { review: { eligible: true, pending: 0 } }) }));
    expect(can).toContain('data-form="birthday"');
    expect(can).toContain('data-act="review"');
    const set = earnList(ctx({ member: makeMember({ canSetBirthday: false, birthday: { month: 3, day: 12 } }) }));
    expect(set).not.toContain('data-form="birthday"');
    expect(set).toContain("12 March");
    expect(set).not.toContain('data-act="review"');
  });

  it("redeem buttons only on affordable tiers", () => {
    const h = redeemList(ctx({ member: makeMember({ pointsBalance: 4500 }) }));
    expect(h).toContain('data-act="redeem" data-points="3000" data-pkr="100"');
    expect(h).not.toContain('data-points="6000"');
    expect(h).toContain("1,500 more");
  });

  it("referral wording says delivered AND paid on the guest home, the Rewards tab and the Refer tab (rule 10)", () => {
    const m = makeMember();
    const pages = { guest: guestHome(ctx()), rewards: rewardsTab(ctx({ member: m })), refer: referTab(ctx({ member: m }), null) };
    for (const [name, html] of Object.entries(pages)) {
      expect(html, name).toContain("first order is delivered and paid.");
      expect(html, name).not.toMatch(/first order is delivered\./);
    }
  });

  it("rewards tab shows pending points, next expiry and Refer & Earn above the link", () => {
    const m = makeMember({ pendingPoints: 1200 }, { nextExpiry: { points: 800, at: "2026-12-01T10:00:00Z" } });
    const h = rewardsTab(ctx({ member: m }));
    expect(h).toContain("1,200 points</strong> pending");
    expect(h).toContain("800 points</strong> will expire on 1 Dec 2026");
    expect(h.indexOf("Refer &amp; Earn")).toBeGreaterThan(-1);
    expect(h.indexOf("Refer &amp; Earn")).toBeLessThan(h.indexOf("https://shop.example/?ref=aisha-1234"));
  });

  it("Your progress uses real thresholds, and comes before the tier cards on the Rewards tab", () => {
    const c = ctx({ member: makeMember({ lifetimeSpendPkr: 5000 }) });
    const p = progressCard(c);
    expect(p).toMatch(/^<section class="hg-card hg-prog"><h3 class="hg-h">Your progress<\/h3>/);
    expect(p).toContain('aria-valuenow="10"');
    expect(p).toContain("Spend Rs. 45,000 more to reach Gold (Rs. 50,000 in total)");
    expect(progressCard(ctx())).toBe(""); // guests have no progress
    const h = rewardsTab(c);
    expect(h.indexOf("Your progress")).toBeLessThan(h.indexOf("Everyone starts here"));
  });

  it("refer tab renders for influencers and before the summary loads", () => {
    const m = makeMember({ isInfluencer: true });
    expect(() => referTab(ctx({ member: m }), null)).not.toThrow();
    const h = referTab(ctx({ member: m }), { rewardPoints: 9000, total: 3, completed: 1, pointsEarned: 9000, rows: [{ status: "pending", at: "2026-11-01T00:00:00Z" }] });
    expect(h).toContain("9,000 points");
    expect(h).toContain("Waiting for their first order");
    expect(h).toContain("Refer &amp; Earn");
  });

  it("history rows use readable labels, signs and only the customer note", () => {
    const h = historyRows([
      { id: "1", type: "referral_earned", label: "Friend referred", points: 6000, at: "2026-11-01T00:00:00Z", note: null },
      { id: "2", type: "refund_deduction", label: "Order refunded", points: -500, at: "2026-11-02T00:00:00Z", note: "Order #1001 <b>" },
    ]);
    expect(h).toContain("Friend referred");
    expect(h).toContain("+6,000");
    expect(h).toContain("−500");
    expect(h).toContain("Order #1001 &lt;b&gt;");
    expect(h).not.toContain("referral_earned");
  });

  it("gives opted-out and blocked members a clear state", () => {
    expect(stateMessage(ctx({ member: makeMember({ optedOut: true }) }))).toContain("opted out");
    expect(stateMessage(ctx({ member: makeMember({ blocked: true }) }))).toContain("on hold");
    expect(stateMessage(ctx())).toContain('data-act="retry"');
  });

  it("maps the single `error` field to a message, with a fallback", () => {
    expect(errorText("insufficient_points")).toContain("enough points");
    expect(errorText("something_new")).toContain("Something went wrong");
    expect(errorText(undefined)).toContain("Something went wrong");
  });
});

describe("review fixes: views", () => {
  const INF = { code: "SARA10", percent: 10, rewardPoints: 9000 };

  it("item 3: an influencer sees her real reward and her code with a copy button", () => {
    const m = makeMember({ isInfluencer: true }, { influencer: INF });
    const c = ctx({ member: m });
    expect(referralReward(c)).toBe(9000);
    const earn = earnTab(c);
    expect(earn).toContain("9,000 points");
    expect(earn).not.toContain("6,000 points");
    expect(earn).toContain('data-copy="SARA10"');
    const refer = referTab(c, null); // before the summary request returns
    expect(refer).toContain("9,000 points");
    expect(refer).toContain('data-copy="SARA10"');
    expect(refer).toContain("10% off");
  });

  it("item 3: nothing influencer-specific for ordinary members, or without a code", () => {
    expect(influencerBox(ctx({ member: makeMember() }))).toBe("");
    expect(influencerBox(ctx({ member: makeMember({ isInfluencer: false }, { influencer: INF }) }))).toBe("");
    expect(influencerBox(ctx({ member: makeMember({ isInfluencer: true }, { influencer: { code: null, percent: null, rewardPoints: 9000 } }) }))).toBe("");
    expect(referralReward(ctx({ member: makeMember() }))).toBe(6000);
    expect(referralReward(ctx())).toBe(6000);
  });

  it("item 4: not-enrolled is its own state, not a connection error", () => {
    const none = stateMessage(ctx(), "not_enrolled");
    expect(none).toContain("being set up");
    expect(none).not.toContain("connection");
    expect(stateMessage(ctx(), "error")).toContain("connection");
  });

  it("item 5: a fractional rate is shown as it is", () => {
    expect(earnList(ctx({ cfg: makeConfig({ pointsRate: 0.5 }) }))).toContain("1 point for every Rs. 2 spent");
    expect(earnList(ctx({ cfg: makeConfig({ pointsRate: 2 }) }))).toContain("2 points for every Rs. 1 spent");
  });

  it("item 10: no duration is quoted for social points, and unused attributes are gone", () => {
    for (const f of ["app/widget/hub.ts", "app/widget/views.ts", "app/widget/core.ts"]) {
      const src = readFileSync(f, "utf8");
      expect(src).not.toMatch(/24[ -]hours?/i);
    }
    expect(earnList(ctx({ member: makeMember() }))).not.toContain("data-points=");
  });

  it("item 11: campaign text in the earn list is time-checked", () => {
    const campaign = { name: "11.11", multiplier: 2, startsAt: "2026-11-10T00:00:00Z", endsAt: "2026-11-20T00:00:00Z" };
    const cfg = makeConfig({ campaign });
    expect(earnList(ctx({ cfg, now: Date.parse("2026-11-16T00:00:00Z") }))).toContain("11.11: 2x points until 20 Nov 2026");
    expect(earnList(ctx({ cfg, now: Date.parse("2026-11-21T00:00:00Z") }))).not.toContain("11.11");
  });
});

describe("ways to earn: icons, tap targets and states (owner request)", () => {
  const TITLES = ["Join HeyGirl Rewards", "Place an order", "Follow on Instagram", "Like on Facebook", "Subscribe on YouTube", "Post your order review &amp; tag @heygirl.pk", "Celebrate your birthday", "Refer a friend"];
  const REVIEW = "Post your order review &amp; tag @heygirl.pk";

  it("every way to earn has its own icon, all defined once in the sprite in one style", () => {
    const names = Object.values(EARN_ICON);
    expect(Object.keys(EARN_ICON).sort()).toEqual(["birthday", "facebook", "instagram", "purchase", "referral", "review", "signup", "youtube"]);
    expect(new Set(names).size).toBe(8);
    const paths = names.map((n) => {
      const m = new RegExp(`<symbol id="hg-i-${n}" viewBox="0 0 24 24"><path d="([^"]+)"/></symbol>`).exec(HUB_ICONS);
      expect(m, `symbol ${n}`).not.toBeNull();
      return m![1];
    });
    expect(new Set(paths).size).toBe(8); // eight different drawings
    // Stroke-only line icons that take the badge colour; no fills, no brand colours.
    expect(HUB_ICONS).not.toMatch(/fill=|#[0-9a-f]{3,6}/i);
    expect(HUB_CSS).toMatch(/\.hg-ic\{fill:none;stroke:currentColor;stroke-width:1\.8/);
    // Platform logos are not shipped under any name.
    for (const id of ["instagram", "facebook", "youtube"]) expect(HUB_ICONS).not.toContain(`hg-i-${id}"`);
  });

  it("each row shows its own icon inside the round tinted badge, with the platform named in words", () => {
    const m = makeMember({}, { review: { eligible: true, pending: 0 } });
    for (const c of [ctx(), ctx({ member: m })]) {
      const r = rows(earnList(c));
      expect(Object.keys(r).filter((t) => t !== "Add your birthday")).toEqual(TITLES);
      const icon = (t: string) => /<span class="hg-row__ic"><svg class="hg-ic" aria-hidden="true" focusable="false"><use href="#hg-i-([a-z]+)"\/><\/svg><\/span>/.exec(r[t])![1];
      expect(TITLES.map(icon)).toEqual(["join", "bag", "heart", "like", "play", "cam", "cake", "friends"]);
    }
    expect(HUB_CSS).toMatch(/\.hg-row__ic\{width:40px;height:40px;flex:none;border-radius:50%;background:var\(--tint\);color:var\(--gd\)/);
    expect(contrast("#7a5c00", "#fbf1cf")).toBeGreaterThanOrEqual(4.5);
  });

  it("an actionable row is one tap target (a single button or link) ending in a chevron", () => {
    const m = makeMember({}, { review: { eligible: true, pending: 0 } });
    const r = rows(earnList(ctx({ member: m, shopUrl: "/collections/all" })));
    const tappable = ["Place an order", "Follow on Instagram", "Like on Facebook", "Subscribe on YouTube", REVIEW, "Refer a friend"];
    for (const t of tappable) {
      // The control wraps the whole row: it opens right after <li> and closes right before </li>.
      expect(r[t], t).toMatch(/^<li><(button type="button"|a) class="hg-nav hg-earn-row" [^>]+>.*<use href="#hg-i-chev"\/><\/svg><\/(button|a)><\/li>/);
      expect((r[t].match(/<button|<a /g) || []).length, t).toBe(1);
      // Only phrasing content inside a button.
      expect(r[t]).not.toMatch(/<(p|div)[ >]/);
    }
    expect(r["Place an order"]).toContain('<a class="hg-nav hg-earn-row" href="/collections/all">');
    expect(r["Refer a friend"]).toContain('data-go="refer"');
    expect(r[REVIEW]).toContain('data-act="review"');
    // Rows with nothing to do are plain text: no control and no chevron.
    for (const t of ["Join HeyGirl Rewards", "Celebrate your birthday"]) {
      expect(r[t]).toContain('<div class="hg-nav hg-earn-row hg-nav--off">');
      expect(r[t]).not.toContain("hg-i-chev");
    }
    // 44px rule: the row control is at least 56px tall and full width; the chevron is enlarged.
    expect(HUB_CSS).toMatch(/\.hg-nav\{width:100%;min-height:56px;/);
    expect(HUB_CSS).toMatch(/\.hg-nav>\.hg-ic\{width:28px;height:28px;stroke-width:2\.6/);
  });

  it("the order row is linked only to a same-site path", () => {
    const m = makeMember();
    for (const bad of [undefined, "", "//evil.example", "https://evil.example", "javascript:alert(1)"]) {
      expect(rows(earnList(ctx({ member: m, shopUrl: bad })))["Place an order"]).not.toContain("<a ");
    }
    expect(rows(earnList(ctx({ shopUrl: "/collections/all" })))["Place an order"]).not.toContain("<a "); // guest preview
  });

  it("state is written in words: Claimed, Available, Pending approval, Saved", () => {
    const m = makeMember({ canSetBirthday: false, birthday: { month: 3, day: 12 } }, { social: { instagram: "available", facebook: "claimed", youtube: "available" }, review: { eligible: false, pending: 1 } });
    const r = rows(earnList(ctx({ member: m })));
    const state = (t: string) => (/<span class="hg-st hg-st--[a-z]+">(?:<svg[^>]*><use[^>]*\/><\/svg>)?([A-Za-z ]+)<\/span>/.exec(r[t]) || [])[1];
    expect(state("Join HeyGirl Rewards")).toBe("Claimed");
    expect(state("Place an order")).toBe("Available");
    expect(state("Follow on Instagram")).toBe("Available");
    expect(state("Like on Facebook")).toBe("Claimed");
    expect(state(REVIEW)).toBe("Pending approval");
    expect(r[REVIEW]).toContain(REVIEW_PENDING_TEXT);
    expect(state("Celebrate your birthday")).toBe("Saved");
    expect(state("Refer a friend")).toBe("Available");
    // A claimed or pending row can no longer be tapped.
    expect(r["Like on Facebook"]).not.toMatch(/<button|data-act/);
    expect(r[REVIEW]).not.toMatch(/<button|data-act/);
    // Review not yet possible: explained in words, no state label and no control.
    const none = rows(earnList(ctx({ member: makeMember() })))[REVIEW];
    expect(none).toContain("Available after your next delivered order.");
    expect(none).not.toMatch(/hg-st|<button/);
    // Guests see a preview with no states.
    expect(earnList(ctx())).not.toContain("hg-st");
  });

  it("the social row keeps its two taps: the first opens the profile and relabels the row, never replacing its content", () => {
    const hub = readFileSync("app/widget/hub.ts", "utf8");
    const branch = hub.slice(hub.indexOf('a === "social" && m'), hub.indexOf('a === "social-claim" && m'));
    expect(branch).toContain('window.open(url, "_blank", "noopener")');
    expect(branch).toContain('b.setAttribute("data-act", "social-claim")');
    expect(branch).toContain('b.querySelector(".hg-st")');
    expect(branch).not.toContain("b.textContent"); // would wipe the icon, title and chevron
    expect(HUB_CSS).toContain(".hg-nav[disabled]{opacity:.55}");
  });

  it("state label colours reach 4.5:1 on their own background", () => {
    // Colours are tokens (light values below; the dark set is checked in extension.test.ts).
    expect(HUB_CSS).toMatch(/\.hg-st\{[^}]*background:var\(--tint\);color:var\(--gd\)/);
    expect(HUB_CSS).toMatch(/\.hg-st--claimed,\.hg-st--saved\{background:var\(--okb\);color:var\(--ok\)\}/);
    expect(HUB_CSS).toMatch(/\.hg-st--pending\{background:var\(--pend\);color:var\(--mute\)\}/);
    expect(HUB_CSS).toContain("--tint:#fbf1cf;--ok:#14491b;--okb:#e7f4e8;");
    expect(HUB_CSS).toContain("--pend:#eee;");
    expect(contrast("#7a5c00", "#fbf1cf")).toBeGreaterThanOrEqual(4.5);
    expect(contrast("#14491b", "#e7f4e8")).toBeGreaterThanOrEqual(4.5);
    expect(contrast("#595959", "#eee")).toBeGreaterThanOrEqual(4.5);
    expect(contrast("#595959", "#ffffff")).toBeGreaterThanOrEqual(4.5); // row sub text
  });
});

describe("owner notes (coding changes.txt) 1-3", () => {
  const embed = readFileSync("extensions/hg-loyalty/blocks/embed.liquid", "utf8");

  it("1: the rewards tab says Refer & Earn directly above the referral link", () => {
    const h = rewardsTab(ctx({ member: makeMember() }));
    const last = h.slice(h.lastIndexOf('<section class="hg-card">'));
    expect(last).toMatch(/^<section class="hg-card"><h3 class="hg-h">Refer &amp; Earn<\/h3>/);
    expect(last).toContain('id="hg-ref-link"');
  });

  it("2 (panel v5): Your progress is its own card directly below the balance card on the Rewards tab", () => {
    const h = rewardsTab(ctx({ member: makeMember() }));
    expect(h).toMatch(/^<section class="hg-bal">.*?<\/section><section class="hg-card hg-prog"><h3 class="hg-h">Your progress<\/h3>/);
  });

  it("ways to redeem: every reward row and the Ways to redeem entry show currency notes, not the gift", () => {
    expect(REDEEM_ICON).toBe("notes");
    const notes = '<span class="hg-row__ic"><svg class="hg-ic" aria-hidden="true" focusable="false"><use href="#hg-i-notes"/></svg></span>';
    const home = guestHome(ctx());
    expect(home).toContain(notes + '<span class="hg-nav__t">Ways to redeem</span>');
    for (const html of [redeemList(ctx()), redeemList(ctx({ member: makeMember({ pointsBalance: 9000 }) })), guestSub(ctx(), "redeem"), rewardsTab(ctx({ member: makeMember({ pointsBalance: 9000 }) }))]) {
      expect(html).toContain(notes);
      expect(html).not.toContain("hg-i-gift");
    }
    expect((redeemList(ctx()).match(/hg-i-notes/g) || []).length).toBe(2); // one per reward
    expect(HUB_ICONS).toMatch(/<symbol id="hg-i-notes" viewBox="0 0 24 24"><path d="[^"]+"\/><\/symbol>/);
    expect(embed).not.toMatch(/[\u{1F300}-\u{1FAFF}]/u);
  });

  it("3: the chevron after Ways to earn / Ways to redeem is larger and darker than a normal icon", () => {
    const home = guestHome(ctx());
    for (const label of ["Ways to earn", "Ways to redeem"]) {
      expect(home).toMatch(new RegExp(`<span class="hg-nav__t">${label}</span><svg class="hg-ic" aria-hidden="true" focusable="false"><use href="#hg-i-chev"/></svg></button>`));
    }
    const base = /\.hg-ic,\.hg-ico\{width:(\d+)px/.exec(HUB_CSS)!;
    const chev = /\.hg-nav>\.hg-ic\{width:(\d+)px;height:(\d+)px;stroke-width:([\d.]+);color:var\(--ink\)\}/.exec(HUB_CSS)!;
    expect(Number(chev[1])).toBeGreaterThan(Number(base[1]));
    expect(Number(chev[3])).toBeGreaterThan(1.8);
    expect(embed).toContain('"shop": {{ routes.all_products_collection_url | json }}');
  });
});

describe("rule 20: redeeming paused (the program switch)", () => {
  const paused = () => makeConfig({ redeemPaused: true });
  const CODE = { id: "c1", code: "REWARD-AB12", kind: "reward", discountPkr: 250, expiresAt: "2026-12-16T00:00:00Z" };

  it("the member panel stays: balance, codes with Copy and Apply, and a notice instead of the Redeem buttons", () => {
    const m = makeMember({ pointsBalance: 9000 }, { codes: [CODE] });
    const h = rewardsTab(ctx({ cfg: paused(), member: m }));
    expect(h).toContain("9,000 <span>points</span>");
    expect(h).toContain('<h3 class="hg-h">Redeem points</h3>');
    expect(h).toContain(REDEEM_PAUSED_TEXT);
    expect(REDEEM_PAUSED_TEXT).toContain("You are still earning points");
    expect(REDEEM_PAUSED_TEXT).not.toMatch(/code/i); // it does not claim issued codes are blocked
    expect(h).not.toContain('data-act="redeem"');
    expect(h).not.toContain(">Redeem<");
    expect(h).not.toContain("more</span>"); // no "N more" either
    // Issued codes keep working at checkout: unchanged.
    expect(h).toContain('data-copy="REWARD-AB12"');
    expect(h).toContain('href="/discount/REWARD-AB12?redirect=%2F"');
    // The same member with redeeming on gets the buttons.
    expect(rewardsTab(ctx({ member: m }))).toContain('data-act="redeem"');
    expect(rewardsTab(ctx({ member: m }))).not.toContain(REDEEM_PAUSED_TEXT);
  });

  it("no code yet: the empty line does not point to the paused Redeem section", () => {
    const h = rewardsTab(ctx({ cfg: paused(), member: makeMember() }));
    expect(h).toContain("No rewards yet.</p>");
    expect(h).not.toContain("Redeem your points below");
  });

  it("the guest 'ways to redeem' preview says redeeming is paused and still shows what points are worth", () => {
    const h = guestSub(ctx({ cfg: paused() }), "redeem");
    expect(h).toContain(REDEEM_PAUSED_TEXT);
    expect(h).toContain("Rs. 100 off");
    expect(h).not.toContain("<button");
    expect(guestSub(ctx(), "redeem")).not.toContain(REDEEM_PAUSED_TEXT);
    expect(redeemList(ctx({ cfg: makeConfig({ redeemPaused: true, redemptionTiers: [] }) }))).toContain(REDEEM_PAUSED_TEXT);
  });

  it("everything about earning is unchanged while paused", () => {
    const m = makeMember({}, { review: { eligible: true, pending: 0 } });
    expect(earnTab(ctx({ cfg: paused(), member: m }))).toBe(earnTab(ctx({ member: m })));
    expect(guestHome(ctx({ cfg: paused() }))).toBe(guestHome(ctx()));
    expect(tierCards(ctx({ cfg: paused(), member: m }))).toBe(tierCards(ctx({ member: m })));
    expect(progressCard(ctx({ cfg: paused(), member: m }))).toBe(progressCard(ctx({ member: m })));
    expect(referTab(ctx({ cfg: paused(), member: m }), null)).toBe(referTab(ctx({ member: m }), null));
  });

  it("a redeem refused by the server explains the pause", () => {
    expect(errorText("program_disabled")).toBe(REDEEM_PAUSED_TEXT);
  });
});

describe("feedback 18 Nov: review row, icons and Diamond wording", () => {
  const page = readFileSync("extensions/hg-loyalty/blocks/rewards-page.liquid", "utf8");

  it("the review row reads 'Post your order review & tag @heygirl.pk' with its points, and uses the camera", () => {
    const r = rows(earnList(ctx()));
    const row = r["Post your order review &amp; tag @heygirl.pk"];
    expect(row).toContain('<span class="hg-row__s">3,000 points</span>');
    expect(row).toContain('<use href="#hg-i-cam"/>');
    expect(reviewTitle(makeConfig({ social: { ...makeConfig().social, instagram: { points: 500, url: "", enabled: false } } }))).toBe("Post your order review");
    expect(page).toContain("Post your order review{% if hg_ig != blank and cfg.social.instagram.url contains 'instagram.com/' %} &amp; tag @{{ hg_ig | escape }}{% endif %}");
    expect(page).not.toContain("Post a review");
  });

  it("Instagram has its own generic heart, distinct from every other icon (no logo)", () => {
    expect(EARN_ICON.instagram).toBe("heart");
    expect(EARN_ICON.review).toBe("cam");
    expect(HUB_ICONS).not.toContain('id="hg-i-star"'); // the old review icon is gone
    expect(rows(earnList(ctx()))["Follow on Instagram"]).toContain('<use href="#hg-i-heart"/>');
  });

  it("a claim waits for approval: no time or date is promised anywhere", () => {
    const m = makeMember({}, { review: { eligible: false, pending: 1 } });
    const row = rows(earnList(ctx({ member: m })))["Post your order review &amp; tag @heygirl.pk"];
    expect(row).toContain('<span class="hg-st hg-st--pending">Pending approval</span>');
    expect(row).toContain("We'll add your points once we've seen your review.");
    const hub = readFileSync("app/widget/hub.ts", "utf8");
    const branch = hub.slice(hub.indexOf('a === "review" && m'), hub.indexOf('a === "redeem" && m'));
    expect(branch).toContain("REVIEW_PENDING_TEXT");
    expect(branch).not.toMatch(/releaseAt|fmtDate|added by/);
    for (const src of [hub, readFileSync("app/widget/views.ts", "utf8")]) expect(src).not.toMatch(/on the way|hours/);
  });

  it("Diamond: bonus points on orders during your birthday month (panel and rewards page)", () => {
    const h = tierCards(ctx());
    expect(h).toContain("Bonus points on orders during your birthday month");
    expect(h).not.toContain("orders in your birthday month");
    expect(page).toContain("<li>Bonus points on orders during your birthday month</li>");
    expect(page).not.toContain("orders in your birthday month");
  });
});

describe("panel v6 (owner, 19 Nov 2026): her level near the top, other levels at the bottom, 'level' wording", () => {
  const order = (h: string, parts: string[]) => {
    const at = parts.map((p) => h.indexOf(p));
    at.forEach((i, n) => expect(i, `missing: ${parts[n]}`).toBeGreaterThan(-1));
    for (let n = 1; n < at.length; n++) expect(at[n], `${parts[n - 1]} before ${parts[n]}`).toBeGreaterThan(at[n - 1]);
  };
  const silverAt = (spend: number) => makeMember({ pendingPoints: 1200, lifetimeSpendPkr: spend }, { nextExpiry: { points: 800, at: "2026-12-01T10:00:00Z" } });

  it("Silver, top to bottom: balance, progress, her Silver card, View all VIP perks, rewards, redeem, notices, Refer & Earn, Other VIP levels (Gold, Diamond)", () => {
    const h = rewardsTab(ctx({ member: silverAt(1300) }));
    order(h, [
      '<section class="hg-bal">',
      "Your progress</h3>",
      "Spend Rs. 48,700 more to reach Gold (Rs. 50,000 in total).",
      '<section class="hg-card hg-tcard hg-tcard--me" id="hg-level"><h3 class="hg-h"><span class="hg-tier hg-tier--silver">Silver</span><span class="hg-chip">Your level</span></h3>',
      "Everyone starts here.",
      `<button type="button" class="hg-link" data-act="perks">${PERKS_LINK_TEXT}<svg class="hg-ic" aria-hidden="true" focusable="false"><use href="#hg-i-chev"/></svg></button>`,
      "Your rewards</h3>",
      "Redeem points</h3>",
      "1,200 points</strong> pending",
      "800 points</strong> will expire on",
      "Refer &amp; Earn</h3>",
      'id="hg-ref-link"',
      `<div class="hg-tiers" id="hg-tiers"><h3 class="hg-h hg-sec" tabindex="-1">Other VIP levels</h3>`,
      "hg-tier--gold",
      "Spend Rs. 50,000 in total.",
      "hg-tier--diamond",
      "Spend Rs. 100,000 in total.",
    ]);
    // Her level appears once (at the top); the bottom holds only the others.
    expect((h.match(/hg-tier--silver/g) || []).length).toBe(2); // balance badge + her card
    expect(h.match(/Everyone starts here\./g)!.length).toBe(1);
    expect(h.match(/Your level</g)!.length).toBe(1);
    const bottom = h.slice(h.indexOf('id="hg-tiers"'));
    expect(bottom).not.toContain("hg-tier--silver");
    expect(bottom).not.toContain("hg-tcard--me");
    expect(h.endsWith("</section></div>")).toBe(true);
  });

  it("Gold: her Gold card on top; Silver then Diamond at the bottom, in level order", () => {
    const h = rewardsTab(ctx({ member: makeMember({ tier: "gold", lifetimeSpendPkr: 60000 }) }));
    order(h, ["Your progress</h3>", 'id="hg-level"><h3 class="hg-h"><span class="hg-tier hg-tier--gold">Gold</span><span class="hg-chip">Your level</span>', "Points never expire", PERKS_LINK_TEXT, "Your rewards</h3>", 'id="hg-tiers"', "hg-tier--silver", "Everyone starts here.", "hg-tier--diamond"]);
    const bottom = h.slice(h.indexOf('id="hg-tiers"'));
    expect(bottom).not.toContain("hg-tier--gold");
    expect(bottom).not.toContain("hg-tcard--me");
    expect(h.match(/Your level</g)!.length).toBe(1);
  });

  it("Diamond: top-level line, her Diamond card, then Silver and Gold at the bottom for comparison", () => {
    const h = rewardsTab(ctx({ member: makeMember({ tier: "diamond", lifetimeSpendPkr: 150000 }) }));
    expect(TOP_LEVEL_TEXT).toBe("You're at our top level.");
    order(h, ["Your progress</h3>", TOP_LEVEL_TEXT, 'id="hg-level"><h3 class="hg-h"><span class="hg-tier hg-tier--diamond">Diamond</span><span class="hg-chip">Your level</span>', PERKS_LINK_TEXT, "Your rewards</h3>", `<h3 class="hg-h hg-sec" tabindex="-1">${OTHER_LEVELS_TITLE}</h3>`, "hg-tier--silver", "Everyone starts here.", "hg-tier--gold", "Spend Rs. 50,000 in total."]);
    expect(h).toContain('aria-label="Progress to top level"');
    const bottom = h.slice(h.indexOf('id="hg-tiers"'));
    expect(bottom).not.toContain("hg-tier--diamond");
    expect(bottom).not.toContain("hg-tcard--me");
    expect(h.match(/Your level</g)!.length).toBe(1);
  });

  it("the notices sit just above Refer & Earn, and the bottom section stays without a referral card", () => {
    const h = rewardsTab(ctx({ member: makeMember({ referralLink: "", pendingPoints: 500 }) }));
    expect(h).not.toContain("Refer &amp; Earn");
    order(h, ["Redeem points</h3>", "500 points</strong> pending", 'id="hg-tiers"']);
  });

  it("customer-facing text says 'level', never 'tier' (panel, nudge, rewards page)", () => {
    const m = makeMember();
    const all = [
      rewardsTab(ctx({ member: m })),
      rewardsTab(ctx({ member: makeMember({ tier: "diamond", lifetimeSpendPkr: 150000 }) })),
      guestHome(ctx()),
      guestSub(ctx(), "tiers"),
      earnTab(ctx({ member: m })),
      referTab(ctx({ member: m }), null),
    ];
    // Visible text and labels only (class names, ids and data values keep "tier").
    const text = (h: string) => h.replace(/<[^>]*>/g, " ") + " " + [...h.matchAll(/aria-label="([^"]*)"/g)].map((x) => x[1]).join(" ");
    for (const h of all) expect(text(h)).not.toMatch(/tier/i);
    const hub = readFileSync("app/widget/hub.ts", "utf8");
    expect(hub).toContain('tiers: "VIP levels"');
    expect(hub).not.toMatch(/"[^"]*VIP tiers[^"]*"/);
    const core = readFileSync("app/widget/core.ts", "utf8");
    expect(core).toContain('{ label: "See VIP levels", screen: "tiers" }');
    expect(core).not.toMatch(/label: "[^"]*tier/i);
    const page = readFileSync("extensions/hg-loyalty/blocks/rewards-page.liquid", "utf8");
    expect(page).toContain('<h2 id="hg-lp-tiers">VIP levels</h2>');
    expect(page.replace(/<[^>]*>|\{[%{][\s\S]*?[%}]\}/g, " ").replace(/<style>[\s\S]*?<\/style>/g, "")).not.toMatch(/\btiers?\b/i);
  });

  it("guests keep the VIP levels entry and its screen (all three level cards, no progress, none marked)", () => {
    expect(guestHome(ctx())).toContain('data-go="tiers"><span class="hg-row__ic"><svg class="hg-ic" aria-hidden="true" focusable="false"><use href="#hg-i-crown"/></svg></span><span class="hg-nav__t">VIP levels</span>');
    const g = guestSub(ctx(), "tiers");
    order(g, ["Everyone starts here.", "Spend Rs. 50,000 in total.", "Spend Rs. 100,000 in total."]);
    expect(g).not.toContain("Your progress");
    expect(g).not.toContain("Your level");
    expect(g).not.toContain('id="hg-level"');
  });

  it("the View all VIP perks line is a real button, a 44px gold text link", () => {
    expect(HUB_CSS).toMatch(/\.hg-hub \.hg-link\{[^}]*min-height:44px;[^}]*background:none;border:0;color:var\(--gd\);/);
  });

  it("Share on WhatsApp is the filled gold button with a chat-bubble icon; Copy is the outlined button", () => {
    const h = referTab(ctx({ member: makeMember() }), null);
    expect(h).toMatch(/<a class="hg-btn hg-btn--block" target="_blank" rel="noopener" href="https:\/\/wa\.me\/\?text=[^"]+"><svg class="hg-ic" aria-hidden="true" focusable="false"><use href="#hg-i-chat"\/><\/svg>Share on WhatsApp<\/a>/);
    expect(h).toContain('<button type="button" class="hg-btn hg-btn--sm hg-btn--ghost" data-copy="https://shop.example/?ref=aisha-1234">Copy</button>');
    // Link field first, then the main button below it.
    expect(h.indexOf('id="hg-ref-link"')).toBeLessThan(h.indexOf("Share on WhatsApp"));
    expect(HUB_ICONS).toMatch(/<symbol id="hg-i-chat" viewBox="0 0 24 24"><path d="[^"]+"\/><\/symbol>/);
    expect(HUB_ICONS).not.toMatch(/whatsapp/i);
    expect(HUB_CSS).toMatch(/\.hg-btn \.hg-ic\{width:20px;height:20px;margin-right:8px/);
  });

  it("the tab bar keeps 44px+ tap height and the gold underline with tighter padding", () => {
    const tab = /\.hg-tab\{([^}]*)\}/.exec(HUB_CSS)![1];
    expect(Number(/min-height:(\d+)px/.exec(tab)![1])).toBeGreaterThanOrEqual(44);
    expect(tab).toContain("padding:0 8px");
    expect(tab).toContain("white-space:nowrap");
    expect(HUB_CSS).toMatch(/\.hg-tab\[aria-selected=true\]\{color:var\(--ink\);border-bottom-color:var\(--gd\)\}/);
  });
});
