import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData, useActionData, Form, useNavigation } from "@remix-run/react";
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
    whatsapp_enabled: form.get("whatsapp_enabled") === "on",
    whatsapp_provider: String(form.get("whatsapp_provider") ?? ""),
    whatsapp_api_key: String(form.get("whatsapp_api_key") ?? ""),
    wa_referral_template: String(form.get("wa_referral_template") ?? ""),
    shopify_email_injection_enabled: form.get("shopify_email_injection_enabled") === "on",
    terms_and_conditions: String(form.get("terms_and_conditions") ?? ""),
  };
  try {
    await updateSettings(patch);
    return json({ ok: true });
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
  const nav = useNavigation();
  const saving = nav.state === "submitting";

  return (
    <Page title="Settings">
      <Form method="post">
        <BlockStack gap="400">
          {actionData?.ok ? <Banner tone="success">Settings saved.</Banner> : null}
          {actionData && !actionData.ok ? <Banner tone="critical">{actionData.error}</Banner> : null}

          <Card>
            <Box padding="400">
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">Branding</Text>
                <FormLayout>
                  <TextField label="Program name" name="program_name" autoComplete="off" value={undefined} defaultValue={s(settings.program_name)} />
                  <TextField label="Tagline" name="tagline" autoComplete="off" value={undefined} defaultValue={s(settings.tagline)} />
                  <FormLayout.Group>
                    <TextField label="Primary colour" name="brand_color_primary" autoComplete="off" value={undefined} defaultValue={s(settings.brand_color_primary)} />
                    <TextField label="Secondary colour" name="brand_color_secondary" autoComplete="off" value={undefined} defaultValue={s(settings.brand_color_secondary)} />
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
                    <TextField label="Gold threshold (Rs.)" name="tier_gold_threshold_pkr" type="number" autoComplete="off" value={undefined} defaultValue={s(settings.tier_gold_threshold_pkr)} />
                    <TextField label="Diamond threshold (Rs.)" name="tier_diamond_threshold_pkr" type="number" autoComplete="off" value={undefined} defaultValue={s(settings.tier_diamond_threshold_pkr)} />
                  </FormLayout.Group>
                  <FormLayout.Group>
                    <TextField label="Signup points" name="signup_points" type="number" autoComplete="off" value={undefined} defaultValue={s(settings.signup_points)} />
                    <TextField label="Referral points" name="referral_points" type="number" autoComplete="off" value={undefined} defaultValue={s(settings.referral_points)} />
                    <TextField label="Review points" name="review_points" type="number" autoComplete="off" value={undefined} defaultValue={s(settings.review_points)} />
                  </FormLayout.Group>
                  <FormLayout.Group>
                    <TextField label="YouTube points" name="social_points_youtube" type="number" autoComplete="off" value={undefined} defaultValue={s(settings.social_points_youtube, "1000")} />
                    <TextField label="Facebook points" name="social_points_facebook" type="number" autoComplete="off" value={undefined} defaultValue={s(settings.social_points_facebook, "1000")} />
                    <TextField label="Instagram points" name="social_points_instagram" type="number" autoComplete="off" value={undefined} defaultValue={s(settings.social_points_instagram, "1000")} />
                  </FormLayout.Group>
                  <TextField label="Silver points expiry (days)" name="silver_expiry_days" type="number" autoComplete="off" value={undefined} defaultValue={s(settings.silver_expiry_days, "365")} />
                  <TextField label="Campaign default multiplier" name="bonus_campaign_default_multiplier" type="number" autoComplete="off" value={undefined} defaultValue={s(settings.bonus_campaign_default_multiplier, "2")} />
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
                    <TextField label="Silver" name="birthday_reward_silver_pkr" type="number" autoComplete="off" value={undefined} defaultValue={s(settings.birthday_reward_silver_pkr, "250")} />
                    <TextField label="Gold" name="birthday_reward_gold_pkr" type="number" autoComplete="off" value={undefined} defaultValue={s(settings.birthday_reward_gold_pkr, "500")} />
                    <TextField label="Diamond" name="birthday_reward_diamond_pkr" type="number" autoComplete="off" value={undefined} defaultValue={s(settings.birthday_reward_diamond_pkr, "1000")} />
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
                  <TextField label="Influencer CTA link" name="influencer_cta_link" autoComplete="off" value={undefined} defaultValue={s(settings.influencer_cta_link)} />
                  <Checkbox label="Enable WhatsApp notifications" name="whatsapp_enabled" checked={undefined} defaultChecked={Boolean(settings.whatsapp_enabled)} />
                  <FormLayout.Group>
                    <TextField label="WhatsApp provider" name="whatsapp_provider" autoComplete="off" value={undefined} defaultValue={s(settings.whatsapp_provider)} />
                    <TextField label="WhatsApp API key" name="whatsapp_api_key" autoComplete="off" value={undefined} defaultValue={s(settings.whatsapp_api_key)} />
                  </FormLayout.Group>
                  <TextField label="WhatsApp referral template" name="wa_referral_template" multiline={3} autoComplete="off" value={undefined} defaultValue={s(settings.wa_referral_template)} />
                  <Checkbox label="Inject loyalty content into Shopify Email" name="shopify_email_injection_enabled" checked={undefined} defaultChecked={Boolean(settings.shopify_email_injection_enabled)} />
                  <TextField label="Terms & Conditions" name="terms_and_conditions" multiline={5} autoComplete="off" value={undefined} defaultValue={s(settings.terms_and_conditions)} />
                </FormLayout>
              </BlockStack>
            </Box>
          </Card>

          <Button submit variant="primary" loading={saving}>Save settings</Button>
        </BlockStack>
      </Form>
    </Page>
  );
}
