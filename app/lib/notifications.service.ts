// app/lib/notifications.service.ts
// Member notifications (rule 19): one branded email layout, plus WhatsApp
// through the provider interface (a no-op unless enabled and configured).
import { db } from "../db.server";
import { renderEmailLayout, sendEmail } from "./email.service";
import { getSettings } from "./settings.server";
import { getWhatsAppProvider } from "./whatsapp.service";

export const NOTIFICATION_EVENTS = [
  "welcome",
  "points_earned",
  "reward_code_issued",
  "tier_upgrade",
  "birthday",
  "referral_completed",
  "points_expiring",
  "review_released",
] as const;
export type NotificationEvent = (typeof NOTIFICATION_EVENTS)[number];

// Job names used before v3, still accepted so queued jobs are not lost.
const LEGACY_EVENT_NAMES: Record<string, NotificationEvent> = {
  birthday_reward: "birthday",
  redemption_confirmed: "reward_code_issued",
  referral_success: "referral_completed",
  referral_bonus: "reward_code_issued",
  expiry_warning: "points_expiring",
};

export function resolveEvent(name: string): NotificationEvent | null {
  if ((NOTIFICATION_EVENTS as readonly string[]).includes(name)) return name as NotificationEvent;
  return LEGACY_EVENT_NAMES[name] ?? null;
}

export type EmailContent = { subject: string; html: string; text: string };
type Ctx = { programName: string; firstName: string | null; rewardsUrl: string | null };

const fmt = (n: unknown): string => Math.round(Number(n) || 0).toLocaleString("en-PK");
const rs = (n: unknown): string => `Rs. ${fmt(n)}`;

/** Dates are shown in Pakistan time. */
export function formatDatePk(iso: unknown): string {
  const d = new Date(String(iso ?? ""));
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "Asia/Karachi" });
}

function tierLabel(tier: unknown): string {
  const t = String(tier ?? "");
  return t ? t.charAt(0).toUpperCase() + t.slice(1) : "";
}

type Draft = {
  subject: string;
  heading: string;
  paragraphs: string[];
  code?: string | null;
  ctaLabel?: string;
  /** WhatsApp template body parameters, in order (after the first name). */
  whatsappParams: string[];
};

function draftFor(event: NotificationEvent, data: Record<string, unknown>, ctx: Ctx): Draft {
  const hello = ctx.firstName ? `Hi ${ctx.firstName},` : "Hi,";
  switch (event) {
    case "welcome":
      return {
        subject: `Welcome to ${ctx.programName}: ${fmt(data.points)} points are yours`,
        heading: "Welcome, your points are waiting",
        paragraphs: [
          hello,
          `Thank you for joining ${ctx.programName}. We have added ${fmt(data.points)} welcome points to your account.`,
          "You earn points on every order, and you can turn them into money off whenever you like.",
        ],
        ctaLabel: "See your rewards",
        whatsappParams: [fmt(data.points)],
      };
    case "points_earned":
      return {
        subject: `You earned ${fmt(data.points)} points`,
        heading: `${fmt(data.points)} points added`,
        paragraphs: [
          hello,
          `${data.reason ? `${String(data.reason)}: ` : ""}${fmt(data.points)} points have been added to your account.`,
        ],
        ctaLabel: "See your balance",
        whatsappParams: [fmt(data.points)],
      };
    case "reward_code_issued": {
      const kind = String(data.kind ?? "reward");
      const freeShipping = data.freeShipping === true || kind === "referral_friend" || kind === "tier_gold";
      const what = freeShipping ? "free shipping" : `${rs(data.discountPkr)} off`;
      const until = formatDatePk(data.expiresAt);
      return {
        subject: `Your reward code: ${what}`,
        heading: `Here is your code for ${what}`,
        paragraphs: [
          hello,
          kind === "referral_friend"
            ? "A friend invited you, so your first order ships free. Enter this code at checkout."
            : `Enter this code at checkout to get ${what} on your next order.`,
          `The code works once, only on your account${until ? `, until ${until}` : ""}. It cannot be combined with another discount code.`,
        ],
        code: String(data.code ?? ""),
        ctaLabel: "Shop now",
        whatsappParams: [what, String(data.code ?? "")],
      };
    }
    case "tier_upgrade": {
      const tier = tierLabel(data.newTier);
      const codes = Array.isArray(data.codes) ? (data.codes as Array<Record<string, unknown>>) : [];
      const gifts = codes.map((c) =>
        c.freeShipping === true ? `Free shipping code: ${String(c.code)}` : `${rs(c.discountPkr)} off code: ${String(c.code)}`,
      );
      return {
        subject: `You are now a ${tier} member`,
        heading: `Welcome to ${tier}`,
        paragraphs: [
          hello,
          `Congratulations, you have reached ${tier} in ${ctx.programName}. Your points no longer expire.`,
          ...(gifts.length > 0 ? ["A thank-you from us:", ...gifts, "Each code works once, only on your account."] : []),
        ],
        ctaLabel: "See your benefits",
        whatsappParams: [tier],
      };
    }
    case "birthday": {
      const until = formatDatePk(data.expiresAt);
      return {
        subject: `Happy birthday month! ${rs(data.discountPkr)} off, from us`,
        heading: "Happy birthday month",
        paragraphs: [
          hello,
          `It is your birthday month, so here is ${rs(data.discountPkr)} off your next order.`,
          `Enter this code at checkout. It works once, only on your account${until ? `, until ${until}` : ""}.`,
        ],
        code: String(data.code ?? ""),
        ctaLabel: "Treat yourself",
        whatsappParams: [rs(data.discountPkr), String(data.code ?? "")],
      };
    }
    case "referral_completed":
      return {
        subject: `Your friend ordered: ${fmt(data.points)} points for you`,
        heading: "Thank you for sharing",
        paragraphs: [
          hello,
          `Your friend's first order has been delivered, and ${fmt(data.points)} points have been added to your account.`,
          "Keep sharing your link to earn more.",
        ],
        ctaLabel: "Share your link",
        whatsappParams: [fmt(data.points)],
      };
    case "points_expiring": {
      const on = formatDatePk(data.expiresAt);
      return {
        subject: `${fmt(data.expiringPoints)} of your points expire${on ? ` on ${on}` : " soon"}`,
        heading: "Use your points before they expire",
        paragraphs: [
          hello,
          `${fmt(data.expiringPoints)} of your points will expire${on ? ` on ${on}` : " within 30 days"}.`,
          "Turn them into a reward code today so they are not lost.",
        ],
        ctaLabel: "Redeem points",
        whatsappParams: [fmt(data.expiringPoints), on],
      };
    }
    case "review_released":
      return {
        subject: `Thanks for your review: ${fmt(data.points)} points added`,
        heading: "Thank you for your review",
        paragraphs: [hello, `We have added ${fmt(data.points)} points to your account as a thank-you for your review.`],
        ctaLabel: "See your balance",
        whatsappParams: [fmt(data.points)],
      };
  }
}

export function buildNotification(
  event: NotificationEvent,
  data: Record<string, unknown>,
  ctx: Ctx,
): EmailContent & { whatsapp: { template: string; params: string[] } } {
  const d = draftFor(event, data, ctx);
  const html = renderEmailLayout({
    programName: ctx.programName,
    preheader: d.paragraphs[1] ?? d.heading,
    heading: d.heading,
    paragraphs: d.paragraphs,
    code: d.code ?? null,
    cta: ctx.rewardsUrl && d.ctaLabel ? { label: d.ctaLabel, url: ctx.rewardsUrl } : null,
  });
  const text = [d.heading, "", ...d.paragraphs, ...(d.code ? ["", `Code: ${d.code}`] : []), ...(ctx.rewardsUrl ? ["", ctx.rewardsUrl] : [])].join("\n");
  return {
    subject: d.subject,
    html,
    text,
    // Template names to create in WhatsApp Business: hg_welcome, hg_points_earned, ...
    whatsapp: { template: `hg_${event}`, params: [ctx.firstName ?? "there", ...d.whatsappParams] },
  };
}

/** Public rewards page, when the store address is configured (STOREFRONT_URL). */
export function rewardsPageUrl(env: Record<string, string | undefined> = process.env): string | null {
  const base = (env.STOREFRONT_URL ?? "").trim().replace(/\/+$/, "");
  return /^https:\/\//i.test(base) ? `${base}/pages/rewards` : null;
}

export async function notifyMember(
  memberId: string,
  eventName: string,
  data: Record<string, unknown>,
): Promise<{ email: boolean; whatsapp: boolean; reason?: string }> {
  const event = resolveEvent(eventName);
  if (!event) {
    console.warn(`[notifyMember] unknown event: ${eventName}`);
    return { email: false, whatsapp: false, reason: "unknown_event" };
  }

  const { data: member } = await db
    .from("members")
    .select("email, phone, first_name, opted_out")
    .eq("id", memberId)
    .maybeSingle();
  if (!member) return { email: false, whatsapp: false, reason: "member_not_found" };
  if (member.opted_out) return { email: false, whatsapp: false, reason: "opted_out" };

  const settings = await getSettings();
  const content = buildNotification(event, data, {
    programName: settings.program_name,
    firstName: member.first_name,
    rewardsUrl: rewardsPageUrl(),
  });

  let emailSent = false;
  if (member.email && !member.email.endsWith("@redacted.invalid")) {
    const result = await sendEmail({ to: member.email, subject: content.subject, html: content.html, text: content.text });
    emailSent = result.sent;
  }

  let whatsappSent = false;
  if (member.phone) {
    const result = await getWhatsAppProvider(settings).send({
      to: member.phone,
      template: content.whatsapp.template,
      params: content.whatsapp.params,
    });
    whatsappSent = result.sent;
  }
  return { email: emailSent, whatsapp: whatsappSent };
}
