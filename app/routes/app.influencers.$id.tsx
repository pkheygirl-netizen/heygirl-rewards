// app/routes/app.influencers.$id.tsx — One influencer: rate, campaign, discount code, her referrals
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useFetcher, useLoaderData } from "@remix-run/react";
import { useState } from "react";
import {
  Badge, Banner, BlockStack, Box, Button, Card, ChoiceList, FormLayout, IndexTable, InlineGrid, InlineStack,
  Layout, Link, Page, Text, TextField,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import { ConfirmModal, CopyButton, Pager, ResultBanner, fieldError, useActionToast } from "../components/admin-ui";
import { INFLUENCER_LIMITS, MULTIPLIER_PRESETS } from "../components/admin-constants";
import { fmtDate, fmtInt, fmtPkr, utcIsoToKarachiDate } from "../components/karachi";
import { downloadCsv } from "../lib/csv-download.client";
import { UUID_RE } from "../lib/admin-db.server";
import {
  getInfluencerDetail, parseInfluencerCodeForm, parseInfluencerRateForm,
} from "../lib/admin-influencers.server";
import { referralLink } from "../lib/admin-members.server";
import { getSettingsRow } from "../lib/admin-settings.server";
import { errorMessage, invalid, reasonText } from "../lib/admin-validate.server";
import { createInfluencerCode, removeInfluencerCode, setInfluencer } from "../lib/influencer.service";

const PAGE_SIZE = 25;

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const settings = await getSettingsRow();
  const standardPoints = Number(settings.referral_points ?? 6000);
  const pageRaw = Number(new URL(request.url).searchParams.get("page") ?? "0");
  const page = Number.isInteger(pageRaw) && pageRaw > 0 ? pageRaw : 0;
  const detail = await getInfluencerDetail(params.id ?? "", { standardPoints, page, pageSize: PAGE_SIZE });
  if (!detail) throw new Response("Influencer not found", { status: 404 });
  return json({
    detail, standardPoints, page,
    referralUrl: referralLink(detail.row.slug, session.shop),
    rateStarts: utcIsoToKarachiDate(detail.rateStartsAt, "start"),
    rateEnds: utcIsoToKarachiDate(detail.rateEndsAt, "end"),
    now: new Date().toISOString(),
  });
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const id = params.id ?? "";
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  const fail = (error: string, status = 400) => json({ ok: false as const, error, intent }, { status });
  const done = (message: string) => json({ ok: true as const, message, intent });
  if (!UUID_RE.test(id)) return fail("Influencer not found.", 404);

  try {
    switch (intent) {
      case "save_rate": {
        const parsed = parseInfluencerRateForm(form);
        if (!parsed.ok) return json({ ...invalid(parsed.errors), intent }, { status: 400 });
        const res = await setInfluencer(id, { isInfluencer: true, ...parsed.value });
        if (!res.ok) return fail(reasonText(res.reason, "The rate was not saved."));
        return done("Rate saved");
      }
      case "pause":
      case "resume": {
        const res = await setInfluencer(id, { isInfluencer: true, paused: intent === "pause" });
        if (!res.ok) return fail(reasonText(res.reason, "The change was not saved."));
        return done(intent === "pause" ? "Paused. She earns the standard reward until you resume" : "Resumed");
      }
      case "create_code": {
        const parsed = parseInfluencerCodeForm(form);
        if (!parsed.ok) return json({ ...invalid(parsed.errors), intent }, { status: 400 });
        const res = await createInfluencerCode({ memberId: id, ...parsed.value, shop: session.shop });
        if (!res.ok) return fail(reasonText(res.reason, "The code was not created."), 409);
        return done(`Discount code ${parsed.value.code} created in Shopify`);
      }
      case "remove_code": {
        const res = await removeInfluencerCode({ memberId: id, shop: session.shop });
        if (!res.ok) return fail(reasonText(res.reason, "The code was not removed."), 409);
        return done("Discount code removed from Shopify");
      }
      case "remove_influencer": {
        const res = await setInfluencer(id, { isInfluencer: false });
        if (!res.ok) return fail(reasonText(res.reason, "The change was not saved."));
        return json({ ok: true as const, message: "She is no longer an influencer", intent, removed: true });
      }
      default:
        return fail("Unknown action.");
    }
  } catch (e) {
    return fail(errorMessage(e), 500);
  }
};

function initialChoice(multiplier: number | null): string {
  if (multiplier === null) return "standard";
  return (MULTIPLIER_PRESETS as readonly number[]).includes(multiplier) ? String(multiplier) : "custom";
}

export default function InfluencerDetailPage() {
  const d = useLoaderData<typeof loader>();
  const r = d.detail.row;
  const fetcher = useFetcher<typeof action>();
  useActionToast(fetcher.data);
  const busy = fetcher.state !== "idle";
  const result = fetcher.data;
  const removed = Boolean(result && result.ok === true && "removed" in result);

  const [choice, setChoice] = useState(initialChoice(r.multiplier));
  const [custom, setCustom] = useState(r.multiplier !== null && initialChoice(r.multiplier) === "custom" ? String(r.multiplier) : "");
  const [campaign, setCampaign] = useState(r.campaign ?? "");
  const [starts, setStarts] = useState(d.rateStarts);
  const [ends, setEnds] = useState(d.rateEnds);
  const [code, setCode] = useState("");
  const [percent, setPercent] = useState("10");
  const [confirm, setConfirm] = useState<"remove_code" | "remove_influencer" | "pause" | null>(null);

  const chosen = choice === "standard" ? null : choice === "custom" ? Number(custom) : Number(choice);
  const previewPoints = chosen && Number.isFinite(chosen) && chosen > 0 ? Math.round(d.standardPoints * chosen) : d.standardPoints;
  const rateErr = result && result.ok === false && result.intent === "save_rate" ? result : null;
  const codeErr = result && result.ok === false && result.intent === "create_code" ? result : null;
  const notStarted = d.detail.rateStartsAt && new Date(d.detail.rateStartsAt) > new Date(d.now);
  const finished = d.detail.rateEndsAt && new Date(d.detail.rateEndsAt) <= new Date(d.now);

  if (removed) {
    return (
      <Page title={r.name} backAction={{ content: "Influencers", url: "/app/influencers" }}>
        <Banner tone="success" title="She is no longer an influencer" action={{ content: "Back to influencers", url: "/app/influencers" }}>
          <p>Her referrals now earn the standard reward. Her past results are kept.</p>
        </Banner>
      </Page>
    );
  }

  return (
    <Page
      title={r.name}
      backAction={{ content: "Influencers", url: "/app/influencers" }}
      titleMetadata={r.paused ? <Badge tone="warning">Paused</Badge> : <Badge tone="success">Active</Badge>}
      subtitle={r.email ?? undefined}
      primaryAction={r.paused
        ? { content: "Resume", loading: busy, onAction: () => fetcher.submit({ intent: "resume" }, { method: "post" }) }
        : { content: "Pause", loading: busy, onAction: () => setConfirm("pause") }}
      secondaryActions={[
        { content: "View customer profile", url: `/app/customers/${r.id}` },
        { content: "Export her referrals", onAction: () => downloadCsv(`/app/influencers/export.csv?id=${r.id}`, "influencer-referrals.csv") },
        { content: "Remove influencer status", destructive: true, onAction: () => setConfirm("remove_influencer") },
      ]}
    >
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            <ResultBanner data={result} />
            {r.paused ? (
              <Banner tone="warning" title="Her rate is paused">
                <p>While paused her referrals earn the standard {fmtInt(d.standardPoints)} points. Her link and code keep working.</p>
              </Banner>
            ) : null}

            <InlineGrid columns={{ xs: 2, md: 4 }} gap="400">
              <Tile label="Friends referred" value={fmtInt(r.friends)} sub={`${fmtInt(r.completed)} completed`} />
              <Tile label="Orders attributed" value={fmtInt(r.orders)} sub={`${fmtInt(r.codeOrders)} with her code`} />
              <Tile label="Sales attributed" value={fmtPkr(r.salesPkr)} sub="Link and code, all time" />
              <Tile label="Points paid" value={fmtInt(r.pointsPaid)} sub={`Now ${fmtInt(r.pointsPerReferral)} per referral`} />
            </InlineGrid>

            <Card>
              <fetcher.Form method="post">
                <input type="hidden" name="intent" value="save_rate" />
                <input type="hidden" name="multiplier_choice" value={choice} />
                <BlockStack gap="400">
                  <Text as="h2" variant="headingMd">Points per referral</Text>
                  {notStarted ? <Banner tone="info"><p>Her rate starts on {fmtDate(d.detail.rateStartsAt)}. Until then she earns the standard reward.</p></Banner> : null}
                  {finished ? <Banner tone="info"><p>Her rate ended on {d.rateEnds ? fmtDate(`${d.rateEnds}T07:00:00Z`) : ""}. She earns the standard reward now.</p></Banner> : null}
                  <FormLayout>
                    <ChoiceList
                      title="Multiplier on the standard referral reward"
                      selected={[choice]} onChange={(v) => setChoice(v[0])}
                      error={fieldError(rateErr, "multiplier_choice")}
                      choices={[
                        { label: `Standard (${fmtInt(d.standardPoints)} points)`, value: "standard" },
                        ...MULTIPLIER_PRESETS.map((m) => ({ label: `${m}× (${fmtInt(Math.round(d.standardPoints * m))} points)`, value: String(m) })),
                        { label: "Custom", value: "custom" },
                      ]}
                    />
                    {choice === "custom" ? (
                      <TextField
                        name="multiplier_custom" label="Custom multiplier" type="number" inputMode="decimal" step={0.05} suffix="×" autoComplete="off"
                        value={custom} onChange={setCustom} error={fieldError(rateErr, "multiplier_custom")}
                        helpText={`Between ${INFLUENCER_LIMITS.multiplier.min} and ${INFLUENCER_LIMITS.multiplier.max}, up to two decimal places.`}
                      />
                    ) : null}
                    <Text as="p">
                      Each completed referral will pay her <Text as="span" fontWeight="bold">{fmtInt(previewPoints)} points</Text>.
                      The same reward is paid once for each new customer's first order that uses her discount code.
                    </Text>
                    <TextField
                      name="campaign" label="Campaign" autoComplete="off" maxLength={INFLUENCER_LIMITS.campaign}
                      value={campaign} onChange={setCampaign} error={fieldError(rateErr, "campaign")}
                      helpText="A label for grouping influencers, for example Winter Glow. Leave empty for none."
                    />
                    <FormLayout.Group>
                      <TextField
                        name="rate_starts" label="Rate starts, optional" type="date" autoComplete="off"
                        value={starts} onChange={setStarts} error={fieldError(rateErr, "rate_starts")}
                        helpText="From the start of this day, Pakistan time."
                      />
                      <TextField
                        name="rate_ends" label="Rate ends, optional" type="date" autoComplete="off"
                        value={ends} onChange={setEnds} error={fieldError(rateErr, "rate_ends")}
                        helpText={`Through the end of this day. Afterwards she returns to the standard ${fmtInt(d.standardPoints)} points.`}
                      />
                    </FormLayout.Group>
                  </FormLayout>
                  <InlineStack><Button submit variant="primary" loading={busy}>Save</Button></InlineStack>
                </BlockStack>
              </fetcher.Form>
            </Card>

            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">Discount code</Text>
                {r.code ? (
                  <>
                    <InlineStack gap="300" blockAlign="center">
                      <Text as="span" variant="headingLg">{r.code}</Text>
                      <Badge>{`${r.codePercent}% off`}</Badge>
                      <CopyButton text={r.code} label="Copy code" />
                    </InlineStack>
                    <Text as="p" tone="subdued">
                      Anyone can use it and it does not combine with other discount codes. Orders that use it are counted for her; she is paid for each new customer's first order.
                    </Text>
                    <InlineStack><Button tone="critical" onClick={() => setConfirm("remove_code")}>Remove code</Button></InlineStack>
                  </>
                ) : (
                  <fetcher.Form method="post">
                    <input type="hidden" name="intent" value="create_code" />
                    <BlockStack gap="300">
                      <Text as="p" tone="subdued">
                        Create one public Shopify discount code for her followers. Orders that use it are attributed to her.
                      </Text>
                      <FormLayout>
                        <FormLayout.Group>
                          <TextField
                            name="code" label="Code" autoComplete="off" placeholder="SANA10"
                            value={code} onChange={(v) => setCode(v.toUpperCase().replace(/\s+/g, ""))}
                            error={fieldError(codeErr, "code")} helpText="3 to 32 letters or numbers, no spaces."
                          />
                          <TextField
                            name="percent_off" label="Percent off" type="number" inputMode="numeric" suffix="%" autoComplete="off"
                            min={INFLUENCER_LIMITS.codePercent.min} max={INFLUENCER_LIMITS.codePercent.max}
                            value={percent} onChange={setPercent} error={fieldError(codeErr, "percent_off")}
                            helpText={`Between ${INFLUENCER_LIMITS.codePercent.min} and ${INFLUENCER_LIMITS.codePercent.max}.`}
                          />
                        </FormLayout.Group>
                      </FormLayout>
                      <InlineStack><Button submit loading={busy} disabled={!code.trim()}>Create code in Shopify</Button></InlineStack>
                    </BlockStack>
                  </fetcher.Form>
                )}
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="200">
                <Text as="h2" variant="headingMd">Her referral link</Text>
                <Text as="p" breakWord>{d.referralUrl}</Text>
                <InlineStack><CopyButton text={d.referralUrl} /></InlineStack>
              </BlockStack>
            </Card>

            <Card padding="0">
              <Box padding="400"><Text as="h2" variant="headingMd">Her referrals</Text></Box>
              {d.detail.referrals.length === 0 ? (
                <Box padding="400" paddingBlockStart="0">
                  <Text as="p" tone="subdued">No referrals yet. Send her the link above; a friend appears here once she opens it and signs in.</Text>
                </Box>
              ) : (
                <IndexTable
                  selectable={false} itemCount={d.detail.referrals.length}
                  resourceName={{ singular: "referral", plural: "referrals" }}
                  headings={[{ title: "Friend" }, { title: "Stage" }, { title: "Date" }, { title: "Points", alignment: "end" }]}
                >
                  {d.detail.referrals.map((x, i) => (
                    <IndexTable.Row id={x.id} key={x.id} position={i}>
                      <IndexTable.Cell>{x.friend}</IndexTable.Cell>
                      <IndexTable.Cell>
                        {x.status === "flagged" ? <Link url="/app/referrals?status=flagged">{x.stage}</Link> : x.stage}
                      </IndexTable.Cell>
                      <IndexTable.Cell>{fmtDate(x.createdAt)}</IndexTable.Cell>
                      <IndexTable.Cell>
                        <Text as="span" alignment="end" tone={x.status === "completed" ? "success" : "subdued"}>
                          {x.status === "completed" && x.points !== null ? `+${fmtInt(x.points)}` : x.status === "pending" ? "Pending" : "None"}
                        </Text>
                      </IndexTable.Cell>
                    </IndexTable.Row>
                  ))}
                </IndexTable>
              )}
              <Box padding="300"><Pager page={d.page} pageSize={PAGE_SIZE} total={d.detail.referralsTotal} /></Box>
            </Card>
          </BlockStack>
        </Layout.Section>
      </Layout>

      <ConfirmModal
        open={confirm !== null}
        loading={busy}
        title={confirm === "remove_code" ? "Remove her discount code?" : confirm === "pause" ? "Pause her rate?" : "Remove influencer status?"}
        confirmLabel={confirm === "remove_code" ? "Remove code" : confirm === "pause" ? "Pause" : "Remove status"}
        destructive={confirm !== "pause"}
        onClose={() => setConfirm(null)}
        onConfirm={() => {
          if (!confirm) return;
          fetcher.submit({ intent: confirm }, { method: "post" });
          setConfirm(null);
        }}
      >
        <Text as="p">
          {confirm === "remove_code"
            ? `${r.code ?? "The code"} is deleted in Shopify and stops working at checkout straight away. Orders already placed with it stay attributed to her.`
            : confirm === "pause"
              ? `Her referrals earn the standard ${fmtInt(d.standardPoints)} points until you resume. Her link and code keep working.`
              : "Her referrals go back to the standard reward and she leaves this list. Remove her discount code first if she has one."}
        </Text>
      </ConfirmModal>
    </Page>
  );
}

function Tile({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <Card>
      <BlockStack gap="100">
        <Text as="p" tone="subdued" variant="bodySm">{label}</Text>
        <Text as="p" variant="headingLg">{value}</Text>
        <Text as="p" tone="subdued" variant="bodySm">{sub}</Text>
      </BlockStack>
    </Card>
  );
}
