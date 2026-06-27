import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData, useActionData, useSubmit, useNavigation } from "@remix-run/react";
import { useState } from "react";
import {
  Page, Card, BlockStack, Box, Text, Checkbox, TextField, Button, Banner, FormLayout,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import { getSettings, updateSettings } from "../lib/admin-settings.server";

const NUDGES = [
  { key: "nudge_account_creation_enabled", label: "Account creation" },
  { key: "nudge_points_spending_enabled", label: "Points spending" },
  { key: "nudge_reward_usage_enabled", label: "Reward usage" },
  { key: "nudge_post_purchase_enabled", label: "Post-purchase (email only on Basic)" },
  { key: "nudge_tier_progress_enabled", label: "Tier progress" },
] as const;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return json({ settings: await getSettings() });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  await authenticate.admin(request);
  const form = await request.formData();
  const masterOff = form.get("master_disable") === "true";
  const patch: Record<string, unknown> = {
    tier_progress_gold_threshold_pkr: Number(form.get("tier_progress_gold_threshold_pkr")),
    tier_progress_diamond_threshold_pkr: Number(form.get("tier_progress_diamond_threshold_pkr")),
  };
  for (const n of NUDGES) {
    patch[n.key] = masterOff ? false : form.get(n.key) === "true";
  }
  try {
    await updateSettings(patch);
    return json({ ok: true, error: undefined as string | undefined });
  } catch (e) {
    return json({ ok: false, error: (e as Error).message }, { status: 400 });
  }
};

export default function Nudges() {
  const { settings } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const submit = useSubmit();
  const nav = useNavigation();

  const [masterOff, setMasterOff] = useState(false);
  const [toggles, setToggles] = useState<Record<string, boolean>>(
    Object.fromEntries(NUDGES.map((n) => [n.key, Boolean(settings[n.key])])),
  );
  const [goldThreshold, setGoldThreshold] = useState(
    String(settings.tier_progress_gold_threshold_pkr ?? 5000),
  );
  const [diamondThreshold, setDiamondThreshold] = useState(
    String(settings.tier_progress_diamond_threshold_pkr ?? 10000),
  );

  const onSave = () => {
    submit(
      {
        master_disable: String(masterOff),
        tier_progress_gold_threshold_pkr: goldThreshold,
        tier_progress_diamond_threshold_pkr: diamondThreshold,
        ...Object.fromEntries(NUDGES.map((n) => [n.key, String(toggles[n.key])])),
      },
      { method: "post" },
    );
  };

  return (
    <Page title="Nudges">
      <BlockStack gap="400">
        {actionData?.ok ? <Banner tone="success">Nudges saved.</Banner> : null}
        {actionData && !actionData.ok ? <Banner tone="critical">{actionData.error}</Banner> : null}

        <Card>
          <Box padding="400">
            <BlockStack gap="300">
              <Checkbox
                label="Disable all nudges (master switch)"
                checked={masterOff}
                onChange={setMasterOff}
              />
              <Text as="p" tone="subdued">When enabled, all nudges below are turned off on save.</Text>
              {NUDGES.map((n) => (
                <Checkbox
                  key={n.key}
                  label={n.label}
                  checked={!masterOff && toggles[n.key]}
                  disabled={masterOff}
                  onChange={(v) => setToggles((t) => ({ ...t, [n.key]: v }))}
                />
              ))}
            </BlockStack>
          </Box>
        </Card>

        <Card>
          <Box padding="400">
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">Tier progress thresholds (Rs.)</Text>
              <FormLayout>
                <FormLayout.Group>
                  <TextField
                    label="Within Rs. of Gold"
                    type="number"
                    autoComplete="off"
                    value={goldThreshold}
                    onChange={setGoldThreshold}
                  />
                  <TextField
                    label="Within Rs. of Diamond"
                    type="number"
                    autoComplete="off"
                    value={diamondThreshold}
                    onChange={setDiamondThreshold}
                  />
                </FormLayout.Group>
              </FormLayout>
            </BlockStack>
          </Box>
        </Card>

        <Button variant="primary" loading={nav.state === "submitting"} onClick={onSave}>Save nudges</Button>
      </BlockStack>
    </Page>
  );
}
