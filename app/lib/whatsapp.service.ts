// app/lib/whatsapp.service.ts
// WhatsApp goes through a provider interface (rule 19). Unless WhatsApp is
// switched on in settings AND both credentials are present in the environment,
// the provider is a no-op that sends nothing and reports why.
//
// The Cloud API provider sends pre-approved TEMPLATE messages only (WhatsApp
// does not allow free text to a customer who has not written first). The
// templates named below must exist and be approved in the WhatsApp Business
// account before it is switched on. This provider has not been exercised
// against the live API.
import type { AppSettings } from "./settings.server";

export type WhatsAppMessage = {
  /** Customer phone number in any common format. */
  to: string;
  /** Approved template name. */
  template: string;
  /** Body parameters, in order. */
  params: string[];
  languageCode?: string;
};

export type WhatsAppResult = { sent: boolean; reason?: string };

export interface WhatsAppProvider {
  readonly name: string;
  send(message: WhatsAppMessage): Promise<WhatsAppResult>;
}

export const noopWhatsAppProvider: WhatsAppProvider = {
  name: "noop",
  async send() {
    return { sent: false, reason: "whatsapp_not_configured" };
  },
};

/** Digits only, with Pakistan's leading 0 turned into 92. Null when it cannot be a full number. */
export function normalisePhone(raw: string | null | undefined): string | null {
  let d = String(raw ?? "").replace(/\D/g, "");
  if (d.startsWith("00")) d = d.slice(2);
  if (d.length === 11 && d.startsWith("0")) d = `92${d.slice(1)}`;
  if (d.length < 10 || d.length > 15) return null;
  return d;
}

const GRAPH_VERSION = "v21.0";

export function createCloudApiProvider(
  token: string,
  phoneNumberId: string,
  fetchImpl: typeof fetch = fetch,
): WhatsAppProvider {
  return {
    name: "whatsapp_cloud_api",
    async send(message) {
      const to = normalisePhone(message.to);
      if (!to) return { sent: false, reason: "invalid_phone" };
      try {
        const res = await fetchImpl(`https://graph.facebook.com/${GRAPH_VERSION}/${encodeURIComponent(phoneNumberId)}/messages`, {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            messaging_product: "whatsapp",
            to,
            type: "template",
            template: {
              name: message.template,
              language: { code: message.languageCode ?? "en" },
              components: [
                { type: "body", parameters: message.params.map((text) => ({ type: "text", text: String(text) })) },
              ],
            },
          }),
        });
        if (!res.ok) {
          // Status only: the response body can echo the phone number.
          console.error(`[whatsapp] send failed with HTTP ${res.status} for template ${message.template}`);
          return { sent: false, reason: `http_${res.status}` };
        }
        return { sent: true };
      } catch (err) {
        console.error("[whatsapp] request error:", err instanceof Error ? err.message : err);
        return { sent: false, reason: "request_error" };
      }
    },
  };
}

export function getWhatsAppProvider(
  settings: Pick<AppSettings, "whatsapp_enabled">,
  env: Record<string, string | undefined> = process.env,
): WhatsAppProvider {
  const token = env.WHATSAPP_TOKEN;
  const phoneNumberId = env.WHATSAPP_PHONE_NUMBER_ID;
  if (!settings.whatsapp_enabled || !token || !phoneNumberId) return noopWhatsAppProvider;
  return createCloudApiProvider(token, phoneNumberId);
}
