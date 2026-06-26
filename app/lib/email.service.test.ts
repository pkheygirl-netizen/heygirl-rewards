import { expect, test, vi, beforeEach } from "vitest";

vi.mock("nodemailer", () => ({
  default: {
    createTransport: vi.fn(() => ({
      sendMail: vi.fn().mockResolvedValue({ messageId: "test-id" }),
    })),
  },
}));

beforeEach(() => {
  vi.resetModules();
  delete process.env.SMTP_HOST;
  delete process.env.SMTP_PORT;
  delete process.env.SMTP_USER;
  delete process.env.SMTP_PASS;
  delete process.env.SMTP_FROM;
});

test("sendEmail: returns sent=false when SMTP_HOST not set", async () => {
  const { sendEmail } = await import("./email.service");
  const result = await sendEmail({ to: "a@b.com", subject: "Test", html: "<p>hi</p>" });
  expect(result.sent).toBe(false);
  expect(result.reason).toBe("smtp_not_configured");
});

test("sendEmail: returns sent=true when SMTP configured", async () => {
  process.env.SMTP_HOST = "smtp.example.com";
  process.env.SMTP_PORT = "587";
  process.env.SMTP_USER = "user";
  process.env.SMTP_PASS = "pass";
  process.env.SMTP_FROM = "no-reply@heygirl.pk";
  const { sendEmail } = await import("./email.service");
  const result = await sendEmail({ to: "a@b.com", subject: "Test", html: "<p>hi</p>" });
  expect(result.sent).toBe(true);
});
