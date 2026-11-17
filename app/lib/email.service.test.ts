import { expect, test, vi, beforeEach, describe } from "vitest";

const sendMail = vi.hoisted(() => vi.fn());
vi.mock("nodemailer", () => ({ default: { createTransport: vi.fn(() => ({ sendMail })) } }));

import { BRAND_GOLD, escapeHtml, renderEmailLayout, resetEmailTransport, sendEmail } from "./email.service";

beforeEach(() => {
  sendMail.mockReset().mockResolvedValue({ messageId: "test-id" });
  resetEmailTransport();
  for (const k of ["SMTP_HOST", "SMTP_PORT", "SMTP_USER", "SMTP_PASS", "SMTP_FROM"]) delete process.env[k];
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("sendEmail", () => {
  test("returns sent=false when SMTP_HOST is not set, and does not log the recipient", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const result = await sendEmail({ to: "private@example.com", subject: "Test", html: "<p>hi</p>" });
    expect(result).toEqual({ sent: false, reason: "smtp_not_configured" });
    expect(JSON.stringify(log.mock.calls)).not.toContain("private@example.com");
  });

  test("sends through SMTP when configured", async () => {
    Object.assign(process.env, { SMTP_HOST: "smtp.example.com", SMTP_PORT: "587", SMTP_USER: "user", SMTP_PASS: "pass", SMTP_FROM: "rewards@example.com" });
    const result = await sendEmail({ to: "a@b.com", subject: "Test", html: "<p>hi</p>", text: "hi" });
    expect(result.sent).toBe(true);
    expect(sendMail).toHaveBeenCalledWith({ from: "rewards@example.com", to: "a@b.com", subject: "Test", html: "<p>hi</p>", text: "hi" });
  });

  test("a failed send is reported, not thrown", async () => {
    process.env.SMTP_HOST = "smtp.example.com";
    sendMail.mockRejectedValue(new Error("connection refused"));
    expect(await sendEmail({ to: "a@b.com", subject: "T", html: "x" })).toEqual({ sent: false, reason: "send_error" });
  });
});

describe("renderEmailLayout (the one branded layout)", () => {
  const html = renderEmailLayout({
    programName: "HeyGirl.pk Rewards",
    preheader: "Short summary",
    heading: "Your code",
    paragraphs: ["Hi Sara,", "Enjoy <b>this</b>."],
    code: "REWARD-ABC",
    cta: { label: "Shop now", url: "https://www.example.com/pages/rewards" },
  });

  test("brand gold on white, plain single column", () => {
    expect(html).toContain(BRAND_GOLD);
    expect(BRAND_GOLD).toBe("#E8AD00");
    expect(html).toContain("background:#FFFFFF");
    expect(html).not.toMatch(/<img/i);
  });

  test("accessible structure: lang, title, one h1, presentation tables, dark body text", () => {
    expect(html).toMatch(/<html lang="en">/);
    expect(html).toContain("<title>Your code</title>");
    expect(html.match(/<h1/g)).toHaveLength(1);
    expect(html.match(/<table/g)!.length).toBe(html.match(/role="presentation"/g)!.length);
    // gold is used for bars, borders and the button background, never as text colour
    expect(html).not.toContain(`color:${BRAND_GOLD}`);
    expect(html).toContain("font-size:16px");
  });

  test("content is escaped; code and button are shown", () => {
    expect(html).toContain("Enjoy &lt;b&gt;this&lt;/b&gt;.");
    expect(html).toContain("REWARD-ABC");
    expect(html).toContain('href="https://www.example.com/pages/rewards"');
    expect(html).toContain("Short summary");
  });

  test("a non-https link is dropped", () => {
    const out = renderEmailLayout({ programName: "P", preheader: "p", heading: "h", paragraphs: ["x"], cta: { label: "Go", url: "javascript:alert(1)" } });
    expect(out).not.toContain("<a ");
  });

  test("escapeHtml", () => {
    expect(escapeHtml(`<a href="x">Tom & 'Jerry'</a>`)).toBe("&lt;a href=&quot;x&quot;&gt;Tom &amp; &#39;Jerry&#39;&lt;/a&gt;");
    expect(escapeHtml(null)).toBe("");
  });
});
