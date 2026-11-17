import nodemailer from "nodemailer";

export const BRAND_GOLD = "#E8AD00";
const INK = "#1F1F1F";
const MUTED = "#5C5C5C";

export function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export type EmailLayoutInput = {
  programName: string;
  /** Short line shown by mail apps next to the subject. */
  preheader: string;
  heading: string;
  /** Plain-text paragraphs; escaped here. */
  paragraphs: string[];
  /** A code to show in a box, e.g. a discount code. */
  code?: string | null;
  cta?: { label: string; url: string } | null;
  footerNote?: string | null;
};

/**
 * The one branded layout every email uses: brand gold on white, a single
 * column, system fonts, no images. Tables with role="presentation" for mail
 * clients; real headings, a lang attribute and dark text on white (the gold is
 * used for bars and borders, never as text on white, where it is too faint to
 * read).
 */
export function renderEmailLayout(input: EmailLayoutInput): string {
  const paragraphs = input.paragraphs
    .filter((p) => p && p.trim())
    .map((p) => `<p style="margin:0 0 16px 0;font-size:16px;line-height:24px;color:${INK};">${escapeHtml(p)}</p>`)
    .join("\n");
  const code = input.code
    ? `<p style="margin:8px 0 24px 0;padding:14px 16px;border:2px dashed ${BRAND_GOLD};border-radius:8px;font-family:Consolas,Menlo,monospace;font-size:20px;line-height:28px;letter-spacing:1px;text-align:center;color:${INK};background:#FFFBEA;">${escapeHtml(input.code)}</p>`
    : "";
  const cta =
    input.cta && /^https:\/\//i.test(input.cta.url)
      ? `<p style="margin:8px 0 24px 0;"><a href="${escapeHtml(input.cta.url)}" style="display:inline-block;padding:12px 22px;border-radius:8px;background:${BRAND_GOLD};color:${INK};font-size:16px;line-height:20px;font-weight:bold;text-decoration:none;">${escapeHtml(input.cta.label)}</a></p>`
      : "";
  const footer = input.footerNote
    ? `<p style="margin:0 0 8px 0;font-size:13px;line-height:20px;color:${MUTED};">${escapeHtml(input.footerNote)}</p>`
    : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(input.heading)}</title>
</head>
<body style="margin:0;padding:0;background:#FFFFFF;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${escapeHtml(input.preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#FFFFFF;">
<tr><td align="center" style="padding:24px 12px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
<tr><td style="height:6px;background:${BRAND_GOLD};font-size:0;line-height:0;">&nbsp;</td></tr>
<tr><td style="padding:24px 24px 8px 24px;">
<p style="margin:0 0 20px 0;font-size:14px;line-height:20px;font-weight:bold;letter-spacing:1px;text-transform:uppercase;color:${INK};">${escapeHtml(input.programName)}</p>
<h1 style="margin:0 0 16px 0;font-size:24px;line-height:32px;color:${INK};">${escapeHtml(input.heading)}</h1>
${paragraphs}
${code}
${cta}
</td></tr>
<tr><td style="padding:16px 24px 24px 24px;border-top:1px solid #E6E6E6;">
${footer}
<p style="margin:0;font-size:13px;line-height:20px;color:${MUTED};">You are receiving this because you are a member of ${escapeHtml(input.programName)}.</p>
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;
}

let transporter: ReturnType<typeof nodemailer.createTransport> | null = null;

function getTransporter() {
  if (transporter) return transporter;
  const port = Number(process.env.SMTP_PORT ?? 587);
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port,
    secure: port === 465,
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
  });
  return transporter;
}

/** Test hook. */
export function resetEmailTransport(): void {
  transporter = null;
}

export async function sendEmail(opts: {
  to: string;
  subject: string;
  html: string;
  text?: string;
}): Promise<{ sent: boolean; reason?: string }> {
  if (!process.env.SMTP_HOST) {
    // No recipient in the log: addresses are personal data.
    console.log("[email] SMTP not configured, not sent:", opts.subject);
    return { sent: false, reason: "smtp_not_configured" };
  }
  try {
    await getTransporter().sendMail({
      from: process.env.SMTP_FROM ?? process.env.SMTP_USER,
      to: opts.to,
      subject: opts.subject,
      html: opts.html,
      text: opts.text,
    });
    return { sent: true };
  } catch (err) {
    console.error("[email] sendMail error:", err instanceof Error ? err.message : err);
    return { sent: false, reason: "send_error" };
  }
}
