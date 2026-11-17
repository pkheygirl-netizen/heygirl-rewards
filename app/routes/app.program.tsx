// app/routes/app.program.tsx — Program: ways to earn, ways to redeem, tiers, birthday, expiry
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useFetcher, useLoaderData, useSearchParams } from "@remix-run/react";
import { useEffect, useState } from "react";
import {
  Badge, Banner, BlockStack, Box, Button, Card, Checkbox, Divider, FormLayout, InlineStack, Layout, Modal,
  Page, Tabs, Text, TextField,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import { ConfirmModal, ResultBanner, fieldError, fieldValue, useActionToast } from "../components/admin-ui";
import { PROGRAM_LIMITS, type EarnRuleKey } from "../components/admin-constants";
import { fmtInt, fmtPkr } from "../components/karachi";
import {
  earnRuleViews, isEarnRuleKey, parseBirthdayRewardsForm, parseEarnRuleForm, parseExpiryForm,
  parseRedemptionTiersForm, parseTiersForm, readRedemptionTiers, toggleRulePatch,
} from "../lib/admin-program.server";
import { getSettingsRow, publishSettings, updateSettings } from "../lib/admin-settings.server";
import { errorMessage, invalid } from "../lib/admin-validate.server";

const TABS = [
  { id: "earn", content: "Earn and redeem" },
  { id: "tiers", content: "Tiers" },
  { id: "birthday", content: "Birthday" },
  { id: "expiry", content: "Expiry" },
] as const;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const s = await getSettingsRow();
  return json({
    rules: earnRuleViews(s),
    redemptionTiers: readRedemptionTiers(s.redemption_tiers),
    // Only the fields this page edits are sent to the browser.
    values: {
      purchase_points_rate: fieldValue(s.purchase_points_rate, "1"),
      signup_points: fieldValue(s.signup_points),
      referral_points: fieldValue(s.referral_points),
      referral_friend_free_shipping: s.referral_friend_free_shipping !== false,
      social_points_instagram: fieldValue(s.social_points_instagram),
      social_points_facebook: fieldValue(s.social_points_facebook),
      social_points_youtube: fieldValue(s.social_points_youtube),
      social_url_instagram: String(s.social_url_instagram ?? ""),
      social_url_facebook: String(s.social_url_facebook ?? ""),
      social_url_youtube: String(s.social_url_youtube ?? ""),
      review_points: fieldValue(s.review_points),
      review_release_hours: fieldValue(s.review_release_hours, "72"),
      tier_gold_threshold_pkr: fieldValue(s.tier_gold_threshold_pkr),
      tier_diamond_threshold_pkr: fieldValue(s.tier_diamond_threshold_pkr),
      tier_reward_gold_free_shipping: s.tier_reward_gold_free_shipping !== false,
      tier_reward_diamond_pkr: fieldValue(s.tier_reward_diamond_pkr, "500"),
      birthday_reward_silver_pkr: fieldValue(s.birthday_reward_silver_pkr),
      birthday_reward_gold_pkr: fieldValue(s.birthday_reward_gold_pkr),
      birthday_reward_diamond_pkr: fieldValue(s.birthday_reward_diamond_pkr),
      silver_expiry_days: fieldValue(s.silver_expiry_days, "365"),
      reward_code_expiry_days: fieldValue(s.reward_code_expiry_days, "30"),
    },
    version: String(s.updated_at ?? ""),
    storefrontUrl: process.env.STOREFRONT_URL && /^https?:\/\//.test(process.env.STOREFRONT_URL)
      ? process.env.STOREFRONT_URL : `https://${session.shop}`,
  });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin } = await authenticate.admin(request);
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  const fail = (error: string, status = 400) => json({ ok: false as const, error, intent }, { status });

  try {
    let parsed: { ok: true; patch: Record<string, unknown> } | { ok: false; errors: Record<string, string> };
    let message = "Saved";
    if (intent === "toggle_rule" || intent === "save_rule") {
      const key = String(form.get("rule") ?? "");
      if (!isEarnRuleKey(key)) return fail("Unknown way to earn.");
      const current = await getSettingsRow();
      if (intent === "toggle_rule") {
        const enabled = form.get("enabled") === "true";
        parsed = { ok: true, patch: toggleRulePatch(current, key, enabled) };
        message = enabled ? "Switched on. It now shows on the storefront" : "Switched off. It is hidden on the storefront and gives no new points";
      } else {
        parsed = parseEarnRuleForm(current, key, form);
      }
    } else if (intent === "save_redemption") {
      parsed = parseRedemptionTiersForm(form);
      message = "Ways to redeem saved";
    } else if (intent === "save_tiers") {
      parsed = parseTiersForm(form);
      message = "Tiers saved";
    } else if (intent === "save_birthday") {
      parsed = parseBirthdayRewardsForm(form);
      message = "Birthday rewards saved";
    } else if (intent === "save_expiry") {
      parsed = parseExpiryForm(form);
      message = "Expiry saved";
    } else {
      return fail("Unknown action.");
    }
    if (!parsed.ok) return json({ ...invalid(parsed.errors), intent }, { status: 400 });
    await updateSettings(parsed.patch);
    const { warning } = await publishSettings(admin);
    return json({ ok: true as const, message, warning, intent });
  } catch (e) {
    return fail(errorMessage(e), 500);
  }
};

type Values = ReturnType<typeof useLoaderData<typeof loader>>["values"];
type TierRow = { points: string; discount_pkr: string };

export default function Program() {
  const d = useLoaderData<typeof loader>();
  const [sp, setSp] = useSearchParams();
  const fetcher = useFetcher<typeof action>();
  useActionToast(fetcher.data);
  const busy = fetcher.state !== "idle";
  const result = fetcher.data;
  const tabIndex = Math.max(0, TABS.findIndex((t) => t.id === sp.get("tab")));
  const tab = TABS[tabIndex].id;

  const [editing, setEditing] = useState<EarnRuleKey | null>(null);
  const [turningOff, setTurningOff] = useState<{ key: EarnRuleKey; title: string } | null>(null);

  useEffect(() => {
    if (result?.ok === true && result.intent === "save_rule") setEditing(null);
  }, [result]);

  return (
    <Page
      title="Program"
      subtitle="Changes show on the storefront as soon as you save"
      secondaryActions={[{ content: "View storefront", url: d.storefrontUrl, external: true }]}
    >
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            {result && !(result.ok === false && result.intent === "save_rule" && editing) ? <ResultBanner data={result} /> : null}
            <Tabs
              tabs={TABS.map((t) => ({ id: t.id, content: t.content }))}
              selected={tabIndex}
              onSelect={(i) => {
                const next = new URLSearchParams(sp);
                if (i === 0) next.delete("tab"); else next.set("tab", TABS[i].id);
                setSp(next, { preventScrollReset: true });
              }}
            />

            {tab === "earn" ? (
              <>
                <Card>
                  <BlockStack gap="300">
                    <Text as="h2" variant="headingMd">Ways to earn</Text>
                    {d.rules.map((r, i) => (
                      <BlockStack gap="300" key={r.key}>
                        {i > 0 ? <Divider /> : null}
                        <InlineStack align="space-between" blockAlign="center" gap="300" wrap>
                          <BlockStack gap="050">
                            <Text as="span" fontWeight="semibold">{r.title}</Text>
                            <Text as="span" tone="subdued" variant="bodySm">{r.when}</Text>
                            {r.problem ? <Text as="span" tone="caution" variant="bodySm">{r.problem}</Text> : null}
                          </BlockStack>
                          <InlineStack gap="300" blockAlign="center">
                            <Text as="span">{r.value}</Text>
                            <Badge tone={r.enabled ? "success" : undefined}>{r.enabled ? "On" : "Off"}</Badge>
                            <Button
                              variant="plain" loading={busy}
                              onClick={() => r.enabled
                                ? setTurningOff({ key: r.key, title: r.title })
                                : fetcher.submit({ intent: "toggle_rule", rule: r.key, enabled: "true" }, { method: "post" })}
                            >
                              {r.enabled ? "Turn off" : "Turn on"}
                            </Button>
                            <Button onClick={() => setEditing(r.key)}>Edit</Button>
                          </InlineStack>
                        </InlineStack>
                      </BlockStack>
                    ))}
                  </BlockStack>
                </Card>
                <RedemptionEditor
                  key={`redeem-${d.version}`}
                  initial={d.redemptionTiers}
                  codeExpiryDays={d.values.reward_code_expiry_days}
                  busy={busy}
                  result={result?.intent === "save_redemption" ? result : null}
                  onSave={(rows) => fetcher.submit({ intent: "save_redemption", tiers: JSON.stringify(rows) }, { method: "post" })}
                />
              </>
            ) : null}

            {tab === "tiers" ? (
              <SettingsCard
                key={`tiers-${d.version}`} title="Tiers" intent="save_tiers" fetcher={fetcher}
                intro="Tiers are set by lifetime spend and are never taken away. A member's tier is checked again when her next order is paid."
                fields={[
                  { name: "tier_gold_threshold_pkr", label: "Gold from lifetime spend of", prefix: "Rs.", range: PROGRAM_LIMITS.tierPkr },
                  { name: "tier_diamond_threshold_pkr", label: "Diamond from lifetime spend of", prefix: "Rs.", range: PROGRAM_LIMITS.tierPkr, help: "Must be higher than the Gold threshold." },
                  { name: "tier_reward_diamond_pkr", label: "Reward on reaching Diamond", prefix: "Rs.", range: PROGRAM_LIMITS.rewardPkr, help: "A one-time discount code. 0 means no code." },
                ]}
                checkboxes={[{ name: "tier_reward_gold_free_shipping", label: "Give a free-shipping code on reaching Gold" }]}
                values={d.values}
              />
            ) : null}

            {tab === "birthday" ? (
              <SettingsCard
                key={`birthday-${d.version}`} title="Birthday rewards" intent="save_birthday" fetcher={fetcher}
                intro="On the 1st of her birthday month each member receives a discount code for the amount of her tier. Diamond members also earn 1.2× points on orders placed in their birthday month. Switch birthday rewards on or off under Earn and redeem."
                fields={[
                  { name: "birthday_reward_silver_pkr", label: "Silver", prefix: "Rs.", range: PROGRAM_LIMITS.rewardPkr },
                  { name: "birthday_reward_gold_pkr", label: "Gold", prefix: "Rs.", range: PROGRAM_LIMITS.rewardPkr },
                  { name: "birthday_reward_diamond_pkr", label: "Diamond", prefix: "Rs.", range: PROGRAM_LIMITS.rewardPkr },
                ]}
                values={d.values}
              />
            ) : null}

            {tab === "expiry" ? (
              <SettingsCard
                key={`expiry-${d.version}`} title="Expiry" intent="save_expiry" fetcher={fetcher}
                intro="Silver members' points expire a set number of days after they are earned. Gold and Diamond points do not expire. A new number applies to points earned from now on."
                fields={[
                  { name: "silver_expiry_days", label: "Silver points expire after", suffix: "days", range: PROGRAM_LIMITS.expiryDays },
                  { name: "reward_code_expiry_days", label: "Reward codes expire after", suffix: "days", range: PROGRAM_LIMITS.codeExpiryDays },
                ]}
                values={d.values}
              />
            ) : null}
          </BlockStack>
        </Layout.Section>
      </Layout>

      {editing ? (
        <RuleModal
          key={editing}
          rule={editing}
          title={d.rules.find((r) => r.key === editing)?.title ?? ""}
          enabled={d.rules.find((r) => r.key === editing)?.enabled ?? true}
          values={d.values}
          busy={busy}
          result={result?.intent === "save_rule" ? result : null}
          onClose={() => setEditing(null)}
          onSave={(fields) => fetcher.submit({ intent: "save_rule", rule: editing, ...fields }, { method: "post" })}
        />
      ) : null}

      <ConfirmModal
        open={turningOff !== null}
        title={`Turn off "${turningOff?.title ?? ""}"?`}
        confirmLabel="Turn off"
        loading={busy}
        onClose={() => setTurningOff(null)}
        onConfirm={() => {
          if (!turningOff) return;
          fetcher.submit({ intent: "toggle_rule", rule: turningOff.key, enabled: "false" }, { method: "post" });
          setTurningOff(null);
        }}
      >
        <Text as="p">
          It is hidden on the storefront and gives no new points until you turn it on again. Points already given are not affected.
        </Text>
      </ConfirmModal>
    </Page>
  );
}

type FieldDef = {
  name: keyof Values & string; label: string; prefix?: string; suffix?: string;
  range: { min: number; max: number }; help?: string;
};

/**
 * One settings form with Shopify's save bar (data-save-bar on the form): the
 * bar's Save submits the form and Discard resets it. The Save button in the
 * card does the same thing, so the form works even where the bar is not shown.
 */
function SettingsCard(props: {
  title: string; intent: string; intro: string; fields: FieldDef[];
  checkboxes?: Array<{ name: keyof Values & string; label: string }>;
  values: Values; fetcher: ReturnType<typeof useFetcher<typeof action>>;
}) {
  const initial = () => Object.fromEntries(props.fields.map((f) => [f.name, String(props.values[f.name])]));
  const initialChecks = () => Object.fromEntries((props.checkboxes ?? []).map((c) => [c.name, props.values[c.name] === true]));
  const [vals, setVals] = useState<Record<string, string>>(initial);
  const [checks, setChecks] = useState<Record<string, boolean>>(initialChecks);
  const result = props.fetcher.data?.intent === props.intent ? props.fetcher.data : null;
  const F = props.fetcher.Form;
  return (
    <Card>
      <F method="post" data-save-bar onReset={() => { setVals(initial()); setChecks(initialChecks()); }}>
        <input type="hidden" name="intent" value={props.intent} />
        <BlockStack gap="400">
          <Text as="h2" variant="headingMd">{props.title}</Text>
          <Text as="p" tone="subdued">{props.intro}</Text>
          <FormLayout>
            {props.fields.map((f) => (
              <TextField
                key={f.name} name={f.name} label={f.label} type="number" inputMode="numeric" autoComplete="off"
                prefix={f.prefix} suffix={f.suffix} min={f.range.min} max={f.range.max}
                value={vals[f.name] ?? ""} onChange={(v) => setVals((s) => ({ ...s, [f.name]: v }))}
                error={fieldError(result, f.name)}
                helpText={`${f.help ? `${f.help} ` : ""}Between ${fmtInt(f.range.min)} and ${fmtInt(f.range.max)}. Blank is not accepted.`}
              />
            ))}
            {(props.checkboxes ?? []).map((c) => (
              <Checkbox
                key={c.name} name={c.name} value="true" label={c.label}
                checked={checks[c.name] ?? false} onChange={(v) => setChecks((s) => ({ ...s, [c.name]: v }))}
              />
            ))}
          </FormLayout>
          <InlineStack>
            <Button submit variant="primary" loading={props.fetcher.state !== "idle"}>Save</Button>
          </InlineStack>
        </BlockStack>
      </F>
    </Card>
  );
}

function RedemptionEditor(props: {
  initial: Array<{ points: number; discount_pkr: number }>; codeExpiryDays: string; busy: boolean;
  result: unknown; onSave: (rows: TierRow[]) => void;
}) {
  const L = PROGRAM_LIMITS.redemption;
  const [rows, setRows] = useState<TierRow[]>(
    props.initial.map((t) => ({ points: String(t.points), discount_pkr: String(t.discount_pkr) })),
  );
  const [removing, setRemoving] = useState<number | null>(null);
  const dirty = JSON.stringify(rows) !== JSON.stringify(props.initial.map((t) => ({ points: String(t.points), discount_pkr: String(t.discount_pkr) })));
  const setRow = (i: number, patch: Partial<TierRow>) => setRows((r) => r.map((row, k) => (k === i ? { ...row, ...patch } : row)));
  return (
    <Card>
      <BlockStack gap="300">
        <InlineStack align="space-between" blockAlign="center">
          <Text as="h2" variant="headingMd">Ways to redeem</Text>
          <Button disabled={rows.length >= L.maxRows} onClick={() => setRows((r) => [...r, { points: "", discount_pkr: "" }])}>Add reward</Button>
        </InlineStack>
        {fieldError(props.result, "tiers") ? <Banner tone="critical"><p>{fieldError(props.result, "tiers")}</p></Banner> : null}
        {rows.length === 0 ? (
          <Text as="p" tone="subdued">No rewards yet, so customers have nothing to redeem. Press Add reward to create the first one.</Text>
        ) : (
          rows.map((row, i) => (
            <InlineStack key={i} gap="300" blockAlign="start" wrap={false}>
              <Box width="40%">
                <TextField
                  label="Reward" labelHidden={i > 0} type="number" inputMode="numeric" autoComplete="off" prefix="Rs." suffix="off"
                  value={row.discount_pkr} onChange={(v) => setRow(i, { discount_pkr: v })}
                  error={fieldError(props.result, `discount_pkr_${i}`)}
                />
              </Box>
              <Box width="40%">
                <TextField
                  label="Points needed" labelHidden={i > 0} type="number" inputMode="numeric" autoComplete="off" suffix="points"
                  value={row.points} onChange={(v) => setRow(i, { points: v })}
                  error={fieldError(props.result, `points_${i}`)}
                />
              </Box>
              <Box paddingBlockStart={i === 0 ? "600" : "100"}>
                <Button variant="plain" tone="critical" onClick={() => setRemoving(i)}>Remove</Button>
              </Box>
            </InlineStack>
          ))
        )}
        <Text as="p" tone="subdued">
          Discount Rs.{fmtInt(L.minPkr)} to {fmtPkr(L.maxPkr)}; points {fmtInt(L.minPoints)} to {fmtInt(L.maxPoints)}. A bigger discount must cost more points.
          Codes are single-use, tied to the customer, and expire after {props.codeExpiryDays} days. Codes already issued keep working.
        </Text>
        <InlineStack gap="200">
          <Button variant="primary" disabled={!dirty} loading={props.busy} onClick={() => props.onSave(rows)}>Save rewards</Button>
          {dirty ? <Text as="span" tone="caution">Unsaved changes</Text> : null}
        </InlineStack>
      </BlockStack>
      <ConfirmModal
        open={removing !== null}
        title="Remove this reward?"
        confirmLabel="Remove"
        onClose={() => setRemoving(null)}
        onConfirm={() => { setRows((r) => r.filter((_, k) => k !== removing)); setRemoving(null); }}
      >
        <Text as="p">Customers will no longer be able to choose it once you press Save rewards. Codes already issued keep working.</Text>
      </ConfirmModal>
    </Card>
  );
}

function RuleModal(props: {
  rule: EarnRuleKey; title: string; enabled: boolean; values: Values; busy: boolean; result: unknown;
  onClose: () => void; onSave: (fields: Record<string, string>) => void;
}) {
  const v = props.values;
  const L = PROGRAM_LIMITS;
  const social = props.rule === "instagram" || props.rule === "facebook" || props.rule === "youtube";
  const pointsField =
    props.rule === "signup" ? "signup_points"
      : props.rule === "referral" ? "referral_points"
        : props.rule === "review" ? "review_points"
          : social ? `social_points_${props.rule}` : null;
  const [enabled, setEnabled] = useState(props.enabled);
  const [points, setPoints] = useState(pointsField ? String(v[pointsField as keyof Values]) : "");
  const [rate, setRate] = useState(v.purchase_points_rate);
  const [url, setUrl] = useState(social ? String(v[`social_url_${props.rule}` as keyof Values]) : "");
  const [hours, setHours] = useState(v.review_release_hours);
  const [friendShip, setFriendShip] = useState(v.referral_friend_free_shipping);
  const range = props.rule === "referral" ? L.referralPoints : L.points;

  const save = () => {
    const fields: Record<string, string> = { enabled: String(enabled) };
    if (props.rule === "purchase") fields.purchase_points_rate = rate.trim();
    if (pointsField) fields[pointsField] = points.trim();
    if (social) fields[`social_url_${props.rule}`] = url.trim();
    if (props.rule === "review") fields.review_release_hours = hours.trim();
    if (props.rule === "referral") fields.referral_friend_free_shipping = String(friendShip);
    props.onSave(fields);
  };
  const failed = props.result as { ok?: boolean; error?: string } | null;

  return (
    <Modal
      open onClose={props.onClose} title={`Edit: ${props.title}`}
      primaryAction={{ content: "Save", loading: props.busy, onAction: save }}
      secondaryActions={[{ content: "Cancel", onAction: props.onClose }]}
    >
      <Modal.Section>
        <BlockStack gap="300">
          {failed && failed.ok === false ? <Banner tone="critical"><p>{failed.error}</p></Banner> : null}
          <FormLayout>
            {props.rule === "purchase" ? (
              <TextField
                label="Points per Rs.1 paid" type="number" inputMode="decimal" step={0.01} autoComplete="off"
                value={rate} onChange={setRate} error={fieldError(props.result, "purchase_points_rate")}
                helpText={`Between ${L.purchaseRate.min} and ${L.purchaseRate.max}. Counted on what she paid for products: shipping, tax and gift-card payments are left out. A running campaign multiplies it.`}
              />
            ) : null}
            {pointsField ? (
              <TextField
                label="Points given" type="number" inputMode="numeric" autoComplete="off"
                value={points} onChange={setPoints} error={fieldError(props.result, pointsField)}
                helpText={`Must be between ${fmtInt(range.min)} and ${fmtInt(range.max)}. Blank values are not accepted.${props.rule === "referral" ? " Influencers can have their own rate on the Influencers page." : ""}`}
              />
            ) : null}
            {social ? (
              <TextField
                label="Profile link" type="url" autoComplete="off" placeholder="https://"
                value={url} onChange={setUrl} error={fieldError(props.result, `social_url_${props.rule}`)}
                helpText="The storefront button opens this page in a new tab before she can confirm. Needed while this is switched on."
              />
            ) : null}
            {props.rule === "review" ? (
              <TextField
                label="Hours before the points are released" type="number" inputMode="numeric" autoComplete="off"
                value={hours} onChange={setHours} error={fieldError(props.result, "review_release_hours")}
                helpText={`Between ${L.reviewReleaseHours.min} and ${L.reviewReleaseHours.max}. You can reject a claim from Home while it waits.`}
              />
            ) : null}
            {props.rule === "referral" ? (
              <Checkbox
                label="Give the friend a free-shipping code when she first signs in"
                checked={friendShip} onChange={setFriendShip}
              />
            ) : null}
            {props.rule === "birthday" ? (
              <Text as="p" tone="subdued">Birthday reward amounts are on the Birthday tab. This switch turns the monthly birthday codes on or off.</Text>
            ) : null}
            <Checkbox label="Show this in the rewards panel and give points for it" checked={enabled} onChange={setEnabled} />
          </FormLayout>
        </BlockStack>
      </Modal.Section>
    </Modal>
  );
}
