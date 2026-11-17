// Shared fixtures for widget unit tests (not bundled).
import type { Config, MemberData } from "./shared";

export function makeConfig(over: Partial<Config> = {}): Config {
  return {
    enabled: true,
    programName: "HeyGirl Rewards",
    tagline: "Earn points. Unlock perks.",
    pointsRate: 1,
    signupPoints: 1000,
    referralPoints: 6000,
    reviewPoints: 3000,
    social: {
      instagram: { points: 1000, url: "https://instagram.com/heygirl.pk", enabled: true },
      facebook: { points: 1000, url: "https://facebook.com/heygirl.pk", enabled: true },
      youtube: { points: 1000, url: "https://www.youtube.com/c/heygirlpk", enabled: true },
    },
    earnRules: {
      purchase: { enabled: true },
      signup: { enabled: true },
      referral: { enabled: true },
      instagram: { enabled: true },
      facebook: { enabled: true },
      youtube: { enabled: true },
      review: { enabled: true },
      birthday: { enabled: true },
    },
    tiers: { gold: 50000, diamond: 100000 },
    redemptionTiers: [
      { points: 3000, discountPkr: 100 },
      { points: 6000, discountPkr: 250 },
    ],
    birthday: { silver: 250, gold: 500, diamond: 1000 },
    nudges: { accountCreation: true, pointsSpending: true, rewardUsage: true, tierProgress: true, goldWithin: 5000, diamondWithin: 10000 },
    campaign: null,
    expiryDays: 365,
    codeExpiryDays: 30,
    reviewReleaseHours: 72,
    friendFreeShipping: true,
    tierRewards: { goldFreeShipping: true, diamondPkr: 500 },
    ...over,
  };
}

export function makeMember(over: Partial<MemberData["member"]> = {}, rest: Partial<MemberData> = {}): MemberData {
  return {
    member: {
      firstName: "Aisha",
      tier: "silver",
      pointsBalance: 4500,
      pendingPoints: 0,
      lifetimeSpendPkr: 5000,
      referralLink: "/?ref=aisha-1234",
      birthday: null,
      canSetBirthday: true,
      isInfluencer: false,
      optedOut: false,
      blocked: false,
      ...over,
    },
    codes: [],
    social: { instagram: "available", facebook: "available", youtube: "available" },
    review: { eligible: false, pending: 0 },
    nextExpiry: null,
    ...rest,
  };
}
