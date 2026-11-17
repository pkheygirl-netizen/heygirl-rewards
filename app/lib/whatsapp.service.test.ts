import { describe, expect, it, vi } from "vitest";
import { createCloudApiProvider, getWhatsAppProvider, noopWhatsAppProvider, normalisePhone } from "./whatsapp.service";

describe("getWhatsAppProvider: a safe no-op unless enabled AND both credentials exist", () => {
  const creds = { WHATSAPP_TOKEN: "t", WHATSAPP_PHONE_NUMBER_ID: "123" };
  it("no-op cases", async () => {
    expect(getWhatsAppProvider({ whatsapp_enabled: false }, creds)).toBe(noopWhatsAppProvider);
    expect(getWhatsAppProvider({ whatsapp_enabled: true }, {})).toBe(noopWhatsAppProvider);
    expect(getWhatsAppProvider({ whatsapp_enabled: true }, { WHATSAPP_TOKEN: "t" })).toBe(noopWhatsAppProvider);
    expect(getWhatsAppProvider({ whatsapp_enabled: true }, { WHATSAPP_PHONE_NUMBER_ID: "1" })).toBe(noopWhatsAppProvider);
    expect(await noopWhatsAppProvider.send({ to: "+923001234567", template: "hg_welcome", params: [] })).toEqual({
      sent: false,
      reason: "whatsapp_not_configured",
    });
  });
  it("the no-op makes no network request", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await getWhatsAppProvider({ whatsapp_enabled: false }, creds).send({ to: "0300", template: "x", params: [] });
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
  it("real provider only when everything is present", () => {
    expect(getWhatsAppProvider({ whatsapp_enabled: true }, creds).name).toBe("whatsapp_cloud_api");
  });
});

describe("cloud API provider", () => {
  it("posts a template message with a bearer token", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    const p = createCloudApiProvider("secret-token", "555", fetchImpl as unknown as typeof fetch);
    const r = await p.send({ to: "0300 1234567", template: "hg_welcome", params: ["Sara", "1,000"] });
    expect(r).toEqual({ sent: true });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://graph.facebook.com/v21.0/555/messages");
    expect(init.headers.Authorization).toBe("Bearer secret-token");
    expect(JSON.parse(init.body)).toEqual({
      messaging_product: "whatsapp",
      to: "923001234567",
      type: "template",
      template: {
        name: "hg_welcome",
        language: { code: "en" },
        components: [{ type: "body", parameters: [{ type: "text", text: "Sara" }, { type: "text", text: "1,000" }] }],
      },
    });
  });

  it("failures are reported, never thrown, and the token is never logged", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const bad = createCloudApiProvider("secret-token", "555", (vi.fn().mockResolvedValue({ ok: false, status: 401 }) as unknown) as typeof fetch);
    expect(await bad.send({ to: "+923001234567", template: "t", params: [] })).toEqual({ sent: false, reason: "http_401" });
    const thrown = createCloudApiProvider("secret-token", "555", (vi.fn().mockRejectedValue(new Error("down")) as unknown) as typeof fetch);
    expect(await thrown.send({ to: "+923001234567", template: "t", params: [] })).toEqual({ sent: false, reason: "request_error" });
    expect(await bad.send({ to: "12", template: "t", params: [] })).toEqual({ sent: false, reason: "invalid_phone" });
    expect(JSON.stringify(err.mock.calls)).not.toContain("secret-token");
    err.mockRestore();
  });
});

describe("normalisePhone", () => {
  it("handles Pakistani formats", () => {
    expect(normalisePhone("0300-1234567")).toBe("923001234567");
    expect(normalisePhone("+92 300 1234567")).toBe("923001234567");
    expect(normalisePhone("00923001234567")).toBe("923001234567");
    expect(normalisePhone("123")).toBeNull();
    expect(normalisePhone(null)).toBeNull();
  });
});
