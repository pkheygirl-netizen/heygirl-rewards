import { db } from "../db.server";
import { sendEmail } from "./email.service";

export function buildBirthdayEmail(
  member: { email: string },
  code: string,
  discountPkr: number,
): { subject: string; html: string; text: string } {
  const subject = `Happy Birthday! Your Rs.${discountPkr} gift is here`;
  const html = `<p>Happy Birthday from HeyGirl.pk!</p>
<p>Your birthday reward: <strong>${code}</strong></p>
<p>Enjoy Rs.${discountPkr} off your next order. Valid for 30 days.</p>
<p>Copy your code and paste it in the discount box at checkout.</p>
<p>— The HeyGirl.pk Team</p>`;
  const text = `Happy Birthday! Your Rs.${discountPkr} birthday code: ${code}. Valid 30 days. Paste at checkout.`;
  return { subject, html, text };
}

export function buildTierUpgradeEmail(
  member: { email: string; first_name?: string | null },
  newTier: string,
): { subject: string; html: string; text: string } {
  const name = member.first_name ?? "there";
  const tierLabel = newTier.charAt(0).toUpperCase() + newTier.slice(1);
  const subject = `You've reached ${tierLabel} tier!`;
  const html = `<p>Congratulations, ${name}!</p>
<p>You've unlocked <strong>${tierLabel}</strong> status in HeyGirl.pk Rewards.</p>
<p>Log in to your account to see your new benefits.</p>
<p>— The HeyGirl.pk Team</p>`;
  const text = `Congratulations! You've reached ${tierLabel} tier in HeyGirl.pk Rewards. Log in to see your benefits.`;
  return { subject, html, text };
}

export function buildRedemptionEmail(
  member: { email: string },
  code: string,
  discountPkr: number,
): { subject: string; html: string; text: string } {
  const subject = `Your reward is waiting — Rs.${discountPkr} off`;
  const html = `<p>Your loyalty reward code: <strong>${code}</strong></p>
<p>Get Rs.${discountPkr} off your next purchase. Valid for 30 days.</p>
<p>Copy your code and paste it in the discount box at checkout.</p>
<p>— The HeyGirl.pk Team</p>`;
  const text = `Your Rs.${discountPkr} reward code: ${code}. Valid 30 days. Paste at checkout.`;
  return { subject, html, text };
}

export function buildReferralSuccessEmail(
  member: { email: string },
  points: number,
): { subject: string; html: string; text: string } {
  const subject = `Your friend shopped — you earned ${points.toLocaleString()} pts!`;
  const html = `<p>Great news! Your referral placed an order.</p>
<p>You've earned <strong>${points.toLocaleString()} points</strong>!</p>
<p>Log in to HeyGirl.pk to see your balance.</p>
<p>— The HeyGirl.pk Team</p>`;
  const text = `Your referral placed an order! You earned ${points.toLocaleString()} points. Log in to check your balance.`;
  return { subject, html, text };
}

export function buildReferralBonusEmail(
  member: { email: string },
  code: string,
): { subject: string; html: string; text: string } {
  const subject = "Welcome! Your free shipping reward is here";
  const html = `<p>Welcome to HeyGirl.pk!</p>
<p>As a thank you for joining through a friend's referral, here's your free shipping code: <strong>${code}</strong></p>
<p>Paste it at checkout. Valid for 30 days.</p>
<p>— The HeyGirl.pk Team</p>`;
  const text = `Welcome! Your free shipping referral code: ${code}. Paste at checkout. Valid 30 days.`;
  return { subject, html, text };
}

export function buildExpiryWarningEmail(
  member: { email: string },
  expiringPoints: number,
  expiresAt: string,
): { subject: string; html: string; text: string } {
  const date = new Date(expiresAt).toLocaleDateString("en-PK", {
    day: "numeric",
    month: "long",
    year: "numeric",
  });
  const subject = `Your ${expiringPoints.toLocaleString()} points expire on ${date}`;
  const html = `<p><strong>${expiringPoints.toLocaleString()} of your HeyGirl.pk points expire on ${date}.</strong></p>
<p>Don't let them go to waste! Log in and redeem your points before they expire.</p>
<p>— The HeyGirl.pk Team</p>`;
  const text = `Your ${expiringPoints.toLocaleString()} HeyGirl.pk points expire on ${date}. Log in to redeem them!`;
  return { subject, html, text };
}

export async function notifyMember(
  memberId: string,
  eventType: string,
  data: Record<string, unknown>,
): Promise<void> {
  const { data: member } = await db
    .from("members")
    .select("email, first_name")
    .eq("id", memberId)
    .maybeSingle();
  if (!member) {
    console.warn(`[notifyMember] no member ${memberId} for event ${eventType}`);
    return;
  }

  let emailContent: { subject: string; html: string; text: string } | null = null;

  switch (eventType) {
    case "birthday_reward":
      emailContent = buildBirthdayEmail(member, String(data.code), Number(data.discountPkr));
      break;
    case "tier_upgrade":
      emailContent = buildTierUpgradeEmail(member, String(data.newTier));
      break;
    case "redemption_confirmed":
      emailContent = buildRedemptionEmail(member, String(data.code), Number(data.discountPkr));
      break;
    case "referral_success":
      emailContent = buildReferralSuccessEmail(member, Number(data.points));
      break;
    case "referral_bonus":
      emailContent = buildReferralBonusEmail(member, String(data.code));
      break;
    case "expiry_warning":
      emailContent = buildExpiryWarningEmail(
        member,
        Number(data.expiringPoints),
        String(data.expiresAt),
      );
      break;
    default:
      console.warn(`[notifyMember] unknown event type: ${eventType}`);
      return;
  }

  if (emailContent) {
    const result = await sendEmail({ to: member.email, ...emailContent });
    if (!result.sent) {
      console.log(
        `[notifyMember] email not sent (${result.reason}) for ${eventType} to ${memberId}`,
      );
    }
  }
}
