// app/routes/app.onsite.tsx — On-site: storefront text, nudges, FAQs, terms, theme checklist
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useFetcher, useLoaderData } from "@remix-run/react";
import { useState } from "react";
import {
  Banner, BlockStack, Box, Button, Card, Checkbox, Divider, FormLayout, InlineStack, Layout, List, Page, Text,
  TextField,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import { AdminExternalLink, ResultBanner, fieldError, fieldValue, useActionToast } from "../components/admin-ui";
import { ONSITE_LIMITS } from "../components/admin-constants";
import { fmtInt } from "../components/karachi";
import { blockDeepLink, discoverThemeBlocks, embedDeepLink, themeEditorUrl } from "../lib/admin-onsite.server";
import { getSettingsRow, parseOnsiteForm, publishSettings, readFaqs, updateSettings } from "../lib/admin-settings.server";
import { errorMessage, invalid } from "../lib/admin-validate.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const [s, blocks] = await Promise.all([getSettingsRow(), discoverThemeBlocks()]);
  const apiKey = process.env.SHOPIFY_API_KEY ?? "";
  return json({
    values: {
      program_name: String(s.program_name ?? ""),
      tagline: String(s.tagline ?? ""),
      terms_and_conditions: String(s.terms_and_conditions ?? ""),
      nudge_account_creation_enabled: s.nudge_account_creation_enabled !== false,
      nudge_points_spending_enabled: s.nudge_points_spending_enabled !== false,
      nudge_reward_usage_enabled: s.nudge_reward_usage_enabled !== false,
      nudge_tier_progress_enabled: s.nudge_tier_progress_enabled !== false,
      tier_progress_gold_threshold_pkr: fieldValue(s.tier_progress_gold_threshold_pkr, "5000"),
      tier_progress_diamond_threshold_pkr: fieldValue(s.tier_progress_diamond_threshold_pkr, "10000"),
    },
    faqs: readFaqs(s.faqs),
    version: String(s.updated_at ?? ""),
    editorUrl: themeEditorUrl(session.shop),
    embeds: blocks.filter((b) => b.kind === "embed").map((b) => ({ ...b, url: embedDeepLink(session.shop, apiKey, b.handle) })),
    blocks: blocks.filter((b) => b.kind === "block").map((b) => ({ ...b, url: blockDeepLink(session.shop, apiKey, b.handle, b.template) })),
  });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin } = await authenticate.admin(request);
  const form = await request.formData();
  try {
    if (form.get("intent") !== "save_onsite") return json({ ok: false as const, error: "Unknown action." }, { status: 400 });
    const parsed = parseOnsiteForm(form);
    if (!parsed.ok) return json(invalid(parsed.errors), { status: 400 });
    await updateSettings(parsed.patch);
    const { warning } = await publishSettings(admin);
    return json({ ok: true as const, message: "On-site content saved", warning });
  } catch (e) {
    return json({ ok: false as const, error: errorMessage(e) }, { status: 500 });
  }
};

const NUDGES = [
  { name: "nudge_account_creation_enabled", label: "Invite guests to create an account", help: "Shown to visitors who are not signed in." },
  { name: "nudge_points_spending_enabled", label: "Remind members they have points to spend", help: "Shown when she has enough points for a reward." },
  { name: "nudge_reward_usage_enabled", label: "Remind members of an unused reward code", help: "Shown in the cart when she holds a code she has not used." },
  { name: "nudge_tier_progress_enabled", label: "Show how close she is to the next tier", help: "Shown when her spend is within the distance set below." },
] as const;

export default function Onsite() {
  const d = useLoaderData<typeof loader>();
  // Remounting on a new settings version resets every field to what was saved.
  return <OnsiteForm key={d.version} d={d} />;
}

function OnsiteForm({ d }: { d: ReturnType<typeof useLoaderData<typeof loader>> }) {
  const fetcher = useFetcher<typeof action>();
  useActionToast(fetcher.data);
  const result = fetcher.data;
  const [text, setText] = useState({
    program_name: d.values.program_name, tagline: d.values.tagline, terms_and_conditions: d.values.terms_and_conditions,
    tier_progress_gold_threshold_pkr: d.values.tier_progress_gold_threshold_pkr,
    tier_progress_diamond_threshold_pkr: d.values.tier_progress_diamond_threshold_pkr,
  });
  const initialNudges = () => Object.fromEntries(NUDGES.map((n) => [n.name, d.values[n.name]])) as Record<string, boolean>;
  const [nudges, setNudges] = useState(initialNudges);
  const [faqs, setFaqs] = useState(d.faqs);
  const set = (k: keyof typeof text) => (v: string) => setText((s) => ({ ...s, [k]: v }));
  const reset = () => {
    setText({
      program_name: d.values.program_name, tagline: d.values.tagline, terms_and_conditions: d.values.terms_and_conditions,
      tier_progress_gold_threshold_pkr: d.values.tier_progress_gold_threshold_pkr,
      tier_progress_diamond_threshold_pkr: d.values.tier_progress_diamond_threshold_pkr,
    });
    setNudges(initialNudges());
    setFaqs(d.faqs);
  };
  const nothingShipped = d.embeds.length === 0 && d.blocks.length === 0;

  return (
    <Page title="On-site" subtitle="What customers see on the storefront, and how to switch it on in your theme">
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            <ResultBanner data={result} />

            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">Show the program in your theme</Text>
                <Text as="p" tone="subdued">
                  The rewards panel and blocks are part of this app, but your theme only shows them after you switch them on in the theme editor. Do this once for each theme you publish.
                </Text>
                {nothingShipped ? (
                  <Banner tone="warning">
                    <p>
                      This copy of the app has no theme blocks to link to. Open the theme editor, choose App embeds in the left sidebar, and switch on the HeyGirl Rewards embed.
                    </p>
                  </Banner>
                ) : null}
                <List type="number">
                  <List.Item>
                    <BlockStack gap="100">
                      <Text as="span" fontWeight="semibold">Switch on the app embed</Text>
                      {d.embeds.length > 0 ? d.embeds.map((b) => (
                        <Text as="span" key={b.handle}>
                          <AdminExternalLink url={b.url}>Open the theme editor with “{b.name}” switched on</AdminExternalLink>
                        </Text>
                      )) : (
                        <Text as="span"><AdminExternalLink url={d.editorUrl}>Open the theme editor</AdminExternalLink>, then App embeds in the sidebar.</Text>
                      )}
                    </BlockStack>
                  </List.Item>
                  {d.blocks.length > 0 ? (
                    <List.Item>
                      <BlockStack gap="100">
                        <Text as="span" fontWeight="semibold">Add the blocks where you want them</Text>
                        {d.blocks.map((b) => (
                          <Text as="span" key={b.handle}>
                            <AdminExternalLink url={b.url}>Add “{b.name}”</AdminExternalLink>
                            {b.template ? ` to the ${b.template} template` : " (opens the home page; in the editor you can add it to other templates with Add block → Apps)"}
                          </Text>
                        ))}
                      </BlockStack>
                    </List.Item>
                  ) : null}
                  <List.Item>
                    <Text as="span" fontWeight="semibold">Press Save in the theme editor.</Text>{" "}
                    The link only previews the change; nothing is live until you save there.
                  </List.Item>
                  <List.Item>Open your store in a private window and check the rewards panel appears.</List.Item>
                </List>
                <Text as="p" tone="subdued" variant="bodySm">
                  This page cannot tell whether the embed is already on, because the app has no permission to read your theme. The theme editor shows its state under App embeds.
                </Text>
              </BlockStack>
            </Card>

            <fetcher.Form method="post" data-save-bar onReset={reset}>
              <input type="hidden" name="intent" value="save_onsite" />
              <input type="hidden" name="faqs" value={JSON.stringify(faqs)} />
              <BlockStack gap="400">
                <Card>
                  <BlockStack gap="300">
                    <Text as="h2" variant="headingMd">Program name and panel text</Text>
                    <FormLayout>
                      <TextField
                        name="program_name" label="Program name" autoComplete="off" maxLength={ONSITE_LIMITS.programName}
                        value={text.program_name} onChange={set("program_name")} error={fieldError(result, "program_name")}
                        helpText="Shown on the launcher button and at the top of the rewards panel."
                      />
                      <TextField
                        name="tagline" label="Tagline" autoComplete="off" maxLength={ONSITE_LIMITS.tagline}
                        value={text.tagline} onChange={set("tagline")} error={fieldError(result, "tagline")}
                        helpText="One short line under the program name."
                      />
                    </FormLayout>
                  </BlockStack>
                </Card>

                <Card>
                  <BlockStack gap="300">
                    <Text as="h2" variant="headingMd">Reminders on the storefront</Text>
                    {NUDGES.map((n) => (
                      <Checkbox
                        key={n.name} name={n.name} value="true" label={n.label} helpText={n.help}
                        checked={nudges[n.name] ?? false} onChange={(v) => setNudges((s) => ({ ...s, [n.name]: v }))}
                      />
                    ))}
                    <FormLayout>
                      <FormLayout.Group>
                        <TextField
                          name="tier_progress_gold_threshold_pkr" label="Remind Silver members when within" prefix="Rs." suffix="of Gold"
                          type="number" inputMode="numeric" autoComplete="off"
                          value={text.tier_progress_gold_threshold_pkr} onChange={set("tier_progress_gold_threshold_pkr")}
                          error={fieldError(result, "tier_progress_gold_threshold_pkr")}
                          helpText={`0 to ${fmtInt(ONSITE_LIMITS.withinMax)}. Blank is not accepted.`}
                        />
                        <TextField
                          name="tier_progress_diamond_threshold_pkr" label="Remind Gold members when within" prefix="Rs." suffix="of Diamond"
                          type="number" inputMode="numeric" autoComplete="off"
                          value={text.tier_progress_diamond_threshold_pkr} onChange={set("tier_progress_diamond_threshold_pkr")}
                          error={fieldError(result, "tier_progress_diamond_threshold_pkr")}
                          helpText={`0 to ${fmtInt(ONSITE_LIMITS.withinMax)}. Blank is not accepted.`}
                        />
                      </FormLayout.Group>
                    </FormLayout>
                  </BlockStack>
                </Card>

                <Card>
                  <BlockStack gap="300">
                    <InlineStack align="space-between" blockAlign="center">
                      <Text as="h2" variant="headingMd">Questions and answers</Text>
                      <Button disabled={faqs.length >= ONSITE_LIMITS.faqCount} onClick={() => setFaqs((f) => [...f, { q: "", a: "" }])}>Add question</Button>
                    </InlineStack>
                    {fieldError(result, "faqs") ? <Banner tone="critical"><p>{fieldError(result, "faqs")}</p></Banner> : null}
                    {faqs.length === 0 ? (
                      <Text as="p" tone="subdued">No questions yet. Press Add question to write the first one, for example “When do I get my points?”.</Text>
                    ) : (
                      faqs.map((f, i) => (
                        <BlockStack gap="200" key={i}>
                          {i > 0 ? <Divider /> : null}
                          <TextField
                            label={`Question ${i + 1}`} autoComplete="off" maxLength={ONSITE_LIMITS.faqQuestion}
                            value={f.q} onChange={(v) => setFaqs((all) => all.map((x, k) => (k === i ? { ...x, q: v } : x)))}
                            error={fieldError(result, `faq_q_${i}`)}
                          />
                          <TextField
                            label="Answer" autoComplete="off" multiline={3} maxLength={ONSITE_LIMITS.faqAnswer}
                            value={f.a} onChange={(v) => setFaqs((all) => all.map((x, k) => (k === i ? { ...x, a: v } : x)))}
                            error={fieldError(result, `faq_a_${i}`)}
                          />
                          <InlineStack gap="200">
                            <Button size="slim" disabled={i === 0} onClick={() => setFaqs((all) => { const c = [...all]; [c[i - 1], c[i]] = [c[i], c[i - 1]]; return c; })}>Move up</Button>
                            <Button size="slim" disabled={i === faqs.length - 1} onClick={() => setFaqs((all) => { const c = [...all]; [c[i + 1], c[i]] = [c[i], c[i + 1]]; return c; })}>Move down</Button>
                            <Button size="slim" variant="plain" tone="critical" onClick={() => setFaqs((all) => all.filter((_, k) => k !== i))}>Remove</Button>
                          </InlineStack>
                        </BlockStack>
                      ))
                    )}
                    <Text as="p" tone="subdued" variant="bodySm">A removed question disappears from the storefront when you save. Until then Discard brings it back.</Text>
                  </BlockStack>
                </Card>

                <Card>
                  <BlockStack gap="300">
                    <Text as="h2" variant="headingMd">Terms and conditions</Text>
                    <TextField
                      name="terms_and_conditions" label="Terms and conditions" labelHidden autoComplete="off" multiline={10}
                      maxLength={ONSITE_LIMITS.terms} showCharacterCount
                      value={text.terms_and_conditions} onChange={set("terms_and_conditions")}
                      error={fieldError(result, "terms_and_conditions")}
                      helpText="Plain text. Shown from the link at the bottom of the rewards panel."
                    />
                  </BlockStack>
                </Card>

                <Box>
                  <Button submit variant="primary" loading={fetcher.state !== "idle"}>Save</Button>
                </Box>
              </BlockStack>
            </fetcher.Form>
          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
