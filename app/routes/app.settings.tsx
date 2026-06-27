import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData, useActionData, useSubmit, useNavigation } from "@remix-run/react";
import { useState } from "react";
import {
  Page, Card, FormLayout, TextField, Checkbox, Button, Banner, BlockStack, Box, Text,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import { getSettings, updateSettings } from "../lib/admin-settings.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return json({ settings: await getSettings() });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  await authenticate.admin(request);
  const form = await request.formData();
  const patch: Record<string, unknown> = {
    program_name: String(form.get("program_name") ?? ""),
    tagline: String(form.get("tagline") ?? ""),
    brand_color_primary: String(form.get("brand_color_primary") ?? ""),
    brand_color_secondary: String(form.get("brand_color_secondary") ?? ""),
    tier_gold_threshold_pkr: Number(form.get("tier_gold_threshold_pkr")),
    tier_diamond_threshold_pkr: Number(form.get("tier_diamond_threshold_pkr")),
    signup_points: Number(form.get("signup_points")),
    referral_points: Number(form.get("referral_points")),
    review_points: Number(form.get("review_points")),
    social_points_youtube: Number(form.get("social_points_youtube")),
    social_points_facebook: Number(form.get("social_points_facebook")),
    social_points_instagram: Number(form.get("social_points_instagram")),
    birthday_reward_silver_pkr: Number(form.get("birthday_reward_silver_pkr")),
    birthday_reward_gold_pkr: Number(form.get("birthday_reward_gold_pkr")),
    birthday_reward_diamond_pkr: Number(form.get("birthday_reward_diamond_pkr")),
    silver_expiry_days: Number(form.get("silver_expiry_days")),
    bonus_campaign_default_multiplier: Number(form.get("bonus_campaign_default_multiplier")),
    influencer_cta_link: String(form.get("influencer_cta_link") ?? ""),
    whatsapp_enabled: form.get("whatsapp_enabled") === "true",
    whatsapp_provider: String(form.get("whatsapp_provider") ?? ""),
    whatsapp_api_key: String(form.get("whatsapp_api_key") ?? ""),
    wa_referral_template: String(form.get("wa_referral_template") ?? ""),
    shopify_email_injection_enabled: form.get("shopify_email_injection_enabled") === "true",
    terms_and_conditions: String(form.get("terms_and_conditions") ?? ""),
  };
  try {
    await updateSettings(patch);
    return json({ ok: true, error: undefined as string | undefined });
  } catch (e) {
    return json({ ok: false, error: (e as Error).message }, { status: 400 });
  }
};

function s(v: unknown, fallback = ""): string {
  return v === null || v === undefined ? fallback : String(v);
}

export default function Settings() {
  const { settings } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const submit = useSubmit();
  const nav = useNavigation();
  const saving = nav.state === "submitting";

  // Controlled string fields keyed by form field name.
  const [fields, setFields] = useState<Record<string, string>>({
    program_name: s(settings.program_name),
    tagline: s(settings.tagline),
    brand_color_primary: s(settings.brand_color_primary),
    brand_color_secondary: s(settings.brand_color_secondary),
    tier_gold_threshold_pkr: s(settings.tier_gold_threshold_pkr),
    tier_diamond_threshold_pkr: s(settings.tier_diamond_threshold_pkr),
    signup_points: s(settings.signup_points),
    referral_points: s(settings.referral_points),
    review_points: s(settings.review_points),
    social_points_youtube: s(settings.social_points_youtube, "1000"),
    social_points_facebook: s(settings.social_points_facebook, "1000"),
    social_points_instagram: s(settings.social_points_instagram, "1000"),
    silver_expiry_days: s(settings.silver_expiry_days, "365"),
    bonus_campaign_default_multiplier: s(settings.bonus_campaign_default_multiplier, "2"),
    birthday_reward_silver_pkr: s(settings.birthday_reward_silver_pkr, "250"),
    birthday_reward_gold_pkr: s(settings.birthday_reward_gold_pkr, "500"),
    birthday_reward_diamond_pkr: s(settings.birthday_reward_diamond_pkr, "1000"),
    influencer_cta_link: s(settings.influencer_cta_link),
    whatsapp_provider: s(settings.whatsapp_provider),
    whatsapp_api_key: s(settings.whatsapp_api_key),
    wa_referral_template: s(settings.wa_referral_template),
    terms_and_conditions: s(settings.terms_and_conditions),
  });
  const [whatsappEnabled, setWhatsappEnabled] = useState(Boolean(settings.whatsapp_enabled));
  const [emailInjection, setEmailInjection] = useState(
    settings.shopify_email_injection_enabled === undefined
      ? true
      : Boolean(settings.shopify_email_injection_enabled),
  );

  const set = (name: string) => (value: string) =>
    setFields((f) => ({ ...f, [name]: value }));

  const onSave = () => {
    submit(
      {
        ...fields,
        whatsapp_enabled: String(whatsappEnabled),
        shopify_email_injection_enabled: String(emailInjection),
      },
      { method: "post" },
    );
  };

  const field = (name: string, label: string, type: "text" | "number" = "text") => (
    <TextField
      label={label}
      autoComplete="off"
      type={type === "number" ? "number" : "text"}
      value={fields[name]}
      onChange={set(name)}
    />
  );

  return (
    <Page title="Settings">
      <BlockStack gap="400">
        {actionData?.ok ? <Banner tone="success">Settings saved.</Banner> : null}
        {actionData && !actionData.ok ? <Banner tone="critical">{actionData.error}</Banner> : null}

        <Card>
          <Box padding="400">
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">Branding</Text>
              <FormLayout>
                {field("program_name", "Program name")}
                {field("tagline", "Tagline")}
                <FormLayout.Group>
                  {field("brand_color_primary", "Primary colour")}
                  {field("brand_color_secondary", "Secondary colour")}
                </FormLayout.Group>
              </FormLayout>
            </BlockStack>
          </Box>
        </Card>

        <Card>
          <Box padding="400">
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">Points & tiers</Text>
              <FormLayout>
                <FormLayout.Group>
                  {field("tier_gold_threshold_pkr", "Gold threshold (Rs.)", "number")}
                  {field("tier_diamond_threshold_pkr", "Diamond threshold (Rs.)", "number")}
                </FormLayout.Group>
                <FormLayout.Group>
                  {field("signup_points", "Signup points", "number")}
                  {field("referral_points", "Referral points", "number")}
                  {field("review_points", "Review points", "number")}
                </FormLayout.Group>
                <FormLayout.Group>
                  {field("social_points_youtube", "YouTube points", "number")}
                  {field("social_points_facebook", "Facebook points", "number")}
                  {field("social_points_instagram", "Instagram points", "number")}
                </FormLayout.Group>
                {field("silver_expiry_days", "Silver points expiry (days)", "number")}
                {field("bonus_campaign_default_multiplier", "Campaign default multiplier", "number")}
              </FormLayout>
            </BlockStack>
          </Box>
        </Card>

        <Card>
          <Box padding="400">
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">Birthday rewards (Rs.)</Text>
              <FormLayout>
                <FormLayout.Group>
                  {field("birthday_reward_silver_pkr", "Silver", "number")}
                  {field("birthday_reward_gold_pkr", "Gold", "number")}
                  {field("birthday_reward_diamond_pkr", "Diamond", "number")}
                </FormLayout.Group>
              </FormLayout>
            </BlockStack>
          </Box>
        </Card>

        <Card>
          <Box padding="400">
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">Integrations & content</Text>
              <FormLayout>
                {field("influencer_cta_link", "Influencer CTA link")}
                <Checkbox
                  label="Enable WhatsApp notifications"
                  checked={whatsappEnabled}
                  onChange={setWhatsappEnabled}
                />
                <FormLayout.Group>
                  {field("whatsapp_provider", "WhatsApp provider")}
                  {field("whatsapp_api_key", "WhatsApp API key")}
                </FormLayout.Group>
                <TextField
                  label="WhatsApp referral template"
                  autoComplete="off"
                  multiline={3}
                  value={fields.wa_referral_template}
                  onChange={set("wa_referral_template")}
                />
                <Checkbox
                  label="Inject loyalty content into Shopify Email"
                  checked={emailInjection}
                  onChange={setEmailInjection}
                />
                <TextField
                  label="Terms & Conditions"
                  autoComplete="off"
                  multiline={5}
                  value={fields.terms_and_conditions}
                  onChange={set("terms_and_conditions")}
                />
              </FormLayout>
            </BlockStack>
          </Box>
        </Card>

        <Button variant="primary" loading={saving} onClick={onSave}>Save settings</Button>
      </BlockStack>
    </Page>
  );
}
