// app/routes/app._index.tsx — Home
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { Form, useFetcher, useLoaderData, useSearchParams } from "@remix-run/react";
import { useState } from "react";
import {
  Badge, Banner, BlockStack, Box, Button, ButtonGroup, Card, IndexTable, InlineGrid, InlineStack, Layout,
  Link, List, Page, ProgressBar, Text, TextField,
} from "@shopify/polaris";
import { LineChart } from "@shopify/polaris-viz";
import "@shopify/polaris-viz/build/esm/styles.css";
import { authenticate } from "../shopify.server";
import { ClientOnly } from "../components/ClientOnly";
import {
  ConfirmModal, EmptyBlock, Pager, PeriodSelect, ResultBanner, StatCard, useActionToast,
} from "../components/admin-ui";
import {
  fmtAge, fmtChange, fmtDate, fmtDateTime, fmtInt, fmtPercent, fmtPkr, fmtSigned, parsePeriodKey, periodRange,
} from "../components/karachi";
import {
  getActivity, getAttention, getPeriodStats, getPointsSeries, getTierCounts, groupSeries,
  listExpiringMembers, listPendingReviewClaims, parseActivityFilter,
} from "../lib/admin-data.server";
import { getSystemHealth } from "../lib/admin-health.server";
import { readRedemptionTiers, visibleRedemptionTiers } from "../lib/admin-program.server";
import { actorFromSession } from "../lib/admin-members.server";
import { getSettingsRow } from "../lib/admin-settings.server";
import { errorMessage } from "../lib/admin-validate.server";
import { ACTIVITY_FILTERS, PROGRAM_OFF_EFFECTS } from "../components/admin-constants";
import { handleReviewClaimIntent } from "../lib/admin-review-claims.server";
import { blockReferrer, dismissReferralAlert, listReferralOrderAlerts, shopifyOrderUrl } from "../lib/admin-referrals.server";
import { ReviewClaimConfirm, type ClaimDecision } from "../components/review-claim-confirm";

const LIST_PAGE = 25;
const ACTIVITY_PAGE = 10;

function pageParam(sp: URLSearchParams, name: string): number {
  const n = Number(sp.get(name) ?? "0");
  return Number.isInteger(n) && n > 0 && n < 100000 ? n : 0;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const sp = new URL(request.url).searchParams;
  const period = periodRange(parsePeriodKey(sp.get("period")));
  const filter = parseActivityFilter(sp.get("activity"));
  const activityPage = pageParam(sp, "apage");
  const view = sp.get("view") === "claims" ? "claims" : sp.get("view") === "expiring" ? "expiring" : null;
  const listPage = pageParam(sp, "page");

  const [stats, previous, series, tiers, attention, health, activity, settings, claims, expiring, referralAlerts] = await Promise.all([
    getPeriodStats(period.from, period.to),
    getPeriodStats(period.prevFrom, period.prevTo),
    getPointsSeries(period.from, period.to),
    getTierCounts(),
    getAttention(30),
    getSystemHealth(),
    getActivity({ filter, page: activityPage, pageSize: ACTIVITY_PAGE }),
    getSettingsRow(),
    view === "claims" ? listPendingReviewClaims(listPage, LIST_PAGE) : null,
    view === "expiring" ? listExpiringMembers(30, listPage, LIST_PAGE) : null,
    listReferralOrderAlerts(10),
  ]);

  return json({
    period, stats, previous, series: groupSeries(series), tiers, attention, health,
    activity, filter, activityPage, view, listPage, claims, expiring,
    // Only reason codes are kept: no phone number or address reaches the page.
    referralAlerts: referralAlerts.map((a) => ({ ...a, orderUrl: shopifyOrderUrl(session.shop, a.orderId) })),
    programEnabled: settings.program_enabled !== false,
    // rewards customers can choose right now (hidden rewards are not available)
    rewardsShown: visibleRedemptionTiers(readRedemptionTiers(settings.redemption_tiers)).length,
    rewardsTotal: readRedemptionTiers(settings.redemption_tiers).length,
    now: new Date().toISOString(),
  });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  try {
    // Review claims: points only when staff approve (rule 14).
    const claim = await handleReviewClaimIntent(intent, form.get("claim_id"), actorFromSession(session));
    if (claim) {
      return claim.ok
        ? json({ ok: true as const, message: claim.message })
        : json({ ok: false as const, error: claim.error }, { status: claim.status });
    }
    // Referral order alerts: block the referrer, or dismiss the alert.
    if (intent === "block_referrer" || intent === "dismiss_referral_alert") {
      const id = String(form.get("referral_id") ?? "");
      const res = intent === "block_referrer" ? await blockReferrer(id, actorFromSession(session)) : await dismissReferralAlert(id);
      return res.ok ? json({ ok: true as const, message: res.message }) : json({ ok: false as const, error: res.error }, { status: 409 });
    }
    return json({ ok: false as const, error: "Unknown action." }, { status: 400 });
  } catch (e) {
    return json({ ok: false as const, error: errorMessage(e) }, { status: 500 });
  }
};

const FILTER_LABELS: Record<string, string> = {
  all: "All", earned: "Earned", redeemed: "Redeemed", referrals: "Referrals", adjustments: "Adjustments",
};

export default function Home() {
  const d = useLoaderData<typeof loader>();
  const [sp, setSp] = useSearchParams();
  const fetcher = useFetcher<typeof action>();
  useActionToast(fetcher.data);
  const [search, setSearch] = useState("");
  const [deciding, setDeciding] = useState<ClaimDecision | null>(null);
  const [blockingReferrer, setBlockingReferrer] = useState<{ id: string; name: string } | null>(null);

  const withParams = (changes: Record<string, string | null>) => {
    const next = new URLSearchParams(sp);
    for (const [k, v] of Object.entries(changes)) {
      if (v === null) next.delete(k);
      else next.set(k, v);
    }
    return next;
  };
  const periodQuery = `?period=${d.period.key}`;
  const totalMembers = d.tiers.silver + d.tiers.gold + d.tiers.diamond;
  const healthTone = d.health.status === "healthy" ? "success" : d.health.status === "attention" ? "critical" : "attention";
  const healthLabel = d.health.status === "healthy" ? "Healthy" : d.health.status === "attention" ? "Needs attention" : "Not reporting yet";
  const nothingToRedeem = d.programEnabled && d.rewardsShown === 0;
  const nothingWaiting =
    !nothingToRedeem && d.attention.referralsFlagged === 0 && d.attention.reviewClaimsPending === 0 &&
    d.attention.expiringMembers === 0 && d.attention.gdprOpen === 0 && d.referralAlerts.length === 0;

  return (
    <Page
      title="Home"
      titleMetadata={d.programEnabled ? <Badge tone="success">Program live</Badge> : <Badge tone="warning">Redeeming paused</Badge>}
      subtitle={`${d.period.label}, Pakistan time`}
    >
      <Layout>
        <Layout.Section>
          <InlineStack align="space-between" blockAlign="end" gap="300" wrap>
            <PeriodSelect value={d.period.key} />
            <Form method="get" action="/app/customers">
              <InlineStack gap="200" blockAlign="end" wrap={false}>
                <TextField
                  label="Find a customer" labelHidden name="q" autoComplete="off"
                  placeholder="Name, email or phone" value={search} onChange={setSearch}
                />
                <Button submit>Find a customer</Button>
              </InlineStack>
            </Form>
          </InlineStack>
        </Layout.Section>

        {!d.programEnabled ? (
          <Layout.Section>
            <Banner tone="warning" title="Redeeming is paused" action={{ content: "Open Settings", url: "/app/settings" }}>
              <List type="bullet">
                {PROGRAM_OFF_EFFECTS.map((t) => <List.Item key={t}>{t}</List.Item>)}
              </List>
            </Banner>
          </Layout.Section>
        ) : null}

        <Layout.Section>
          <ResultBanner data={fetcher.data} />
        </Layout.Section>

        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">Needs your attention</Text>
              {nothingWaiting ? (
                <Text as="p" tone="subdued">Nothing is waiting for you. Held referrals, review claims and expiring points appear here.</Text>
              ) : null}
              {nothingToRedeem ? (
                <AttentionRow
                  title="Customers currently have nothing to redeem"
                  detail={d.rewardsTotal > 0
                    ? `All ${fmtInt(d.rewardsTotal)} reward${d.rewardsTotal === 1 ? " is" : "s are"} hidden. Show at least one so customers can use their points.`
                    : "There are no rewards. Add one so customers can use their points."}
                  action={<Button url="/app/program">Open ways to redeem</Button>}
                />
              ) : null}
              {d.referralAlerts.map((a) => (
                <AttentionRow
                  key={`ref-alert-${a.referralId}`}
                  title={a.title}
                  detail={`Referrer: ${a.referrerName}. ${a.detail}`}
                  action={
                    <ButtonGroup>
                      {a.orderUrl ? <Button url={a.orderUrl} target="_top">Open order in Shopify</Button> : null}
                      <Button url={`/app/referrals?referral=${a.referralId}`}>View referral</Button>
                      {a.referrerReferralsBlocked ? null : (
                        <Button tone="critical" onClick={() => setBlockingReferrer({ id: a.referralId, name: a.referrerName })}>Block this referrer</Button>
                      )}
                      <Button variant="plain" onClick={() => fetcher.submit({ intent: "dismiss_referral_alert", referral_id: a.referralId }, { method: "post" })}>Dismiss</Button>
                    </ButtonGroup>
                  }
                />
              ))}
              {d.attention.referralOrderAlerts > d.referralAlerts.length ? (
                <Text as="p" tone="subdued">{`${fmtInt(d.attention.referralOrderAlerts - d.referralAlerts.length)} more referral order alert(s): see Referrals.`}</Text>
              ) : null}
              {d.attention.referralsFlagged > 0 ? (
                <AttentionRow
                  title={`${fmtInt(d.attention.referralsFlagged)} referral${d.attention.referralsFlagged === 1 ? "" : "s"} held for review`}
                  detail="The friend looks like the referrer (similar email, same full name, or her order delivers to the referrer's address). Approve or reject each one."
                  action={<Button url="/app/referrals?status=flagged">Review</Button>}
                />
              ) : null}
              {d.attention.reviewClaimsPending > 0 ? (
                <AttentionRow
                  title={`${fmtInt(d.attention.reviewClaimsPending)} review claim${d.attention.reviewClaimsPending === 1 ? "" : "s"} waiting`}
                  detail="Nothing is added automatically. Check that she posted a public review of her order and tagged @heygirl.pk, then approve or reject each claim."
                  action={<Button onClick={() => setSp(withParams({ view: "claims", page: null }), { preventScrollReset: true })}>View claims</Button>}
                />
              ) : null}
              {d.attention.expiringMembers > 0 ? (
                <AttentionRow
                  title={`${fmtInt(d.attention.expiringMembers)} member${d.attention.expiringMembers === 1 ? " has" : "s have"} points expiring in 30 days`}
                  detail={`${fmtInt(d.attention.expiringPoints)} points in total. A reminder goes out 30 days before expiry.${d.attention.expiringOverdueMembers > 0 ? ` ${fmtInt(d.attention.expiringOverdueMembers)} of them ${d.attention.expiringOverdueMembers === 1 ? "has" : "have"} points expiring now: the date has passed and they are removed at the next nightly run.` : ""}`}
                  action={<Button onClick={() => setSp(withParams({ view: "expiring", page: null }), { preventScrollReset: true })}>See list</Button>}
                />
              ) : null}
              {d.attention.gdprOpen > 0 ? (
                <AttentionRow
                  title={`${fmtInt(d.attention.gdprOpen)} privacy request${d.attention.gdprOpen === 1 ? "" : "s"} open`}
                  detail="A customer data request must be answered within 30 days."
                  action={<Button url="/app/settings">Open list</Button>}
                />
              ) : null}
              <AttentionRow
                title="System health"
                detail={d.health.summary}
                action={
                  <InlineStack gap="200" blockAlign="center">
                    <Badge tone={healthTone}>{healthLabel}</Badge>
                    <Button url="/app/settings" variant="plain">Details</Button>
                  </InlineStack>
                }
              />
            </BlockStack>
          </Card>
        </Layout.Section>

        {d.view === "claims" && d.claims ? (
          <Layout.Section>
            <Card padding="0">
              <Box padding="400">
                <InlineStack align="space-between" blockAlign="center">
                  <Text as="h2" variant="headingMd">Review claims waiting</Text>
                  <Button variant="plain" onClick={() => setSp(withParams({ view: null, page: null }), { preventScrollReset: true })}>Close</Button>
                </InlineStack>
              </Box>
              {d.claims.rows.length === 0 ? (
                <Box padding="400"><Text as="p" tone="subdued">No claims are waiting. New claims appear here until you approve or reject them.</Text></Box>
              ) : (
                <IndexTable
                  selectable={false}
                  itemCount={d.claims.rows.length}
                  resourceName={{ singular: "claim", plural: "claims" }}
                  headings={[{ title: "Customer" }, { title: "Points" }, { title: "Claimed" }, { title: "Action" }]}
                >
                  {d.claims.rows.map((c, i) => (
                    <IndexTable.Row id={c.id} key={c.id} position={i}>
                      <IndexTable.Cell><Link url={`/app/customers/${c.memberId}`}>{c.memberName}</Link></IndexTable.Cell>
                      <IndexTable.Cell>{fmtInt(c.points)}</IndexTable.Cell>
                      <IndexTable.Cell>
                        {fmtDateTime(c.claimedAt)}
                        <Text as="span" tone="subdued"> ({fmtAge(c.claimedAt, new Date(d.now))} ago)</Text>
                      </IndexTable.Cell>
                      <IndexTable.Cell>
                        <ButtonGroup>
                          <Button variant="primary" onClick={() => setDeciding({ kind: "approve", id: c.id, name: c.memberName, points: c.points })}>Approve</Button>
                          <Button tone="critical" onClick={() => setDeciding({ kind: "reject", id: c.id, name: c.memberName, points: c.points })}>Reject</Button>
                        </ButtonGroup>
                      </IndexTable.Cell>
                    </IndexTable.Row>
                  ))}
                </IndexTable>
              )}
              <Box padding="300"><Pager page={d.listPage} pageSize={LIST_PAGE} total={d.claims.total} /></Box>
            </Card>
          </Layout.Section>
        ) : null}

        {d.view === "expiring" && d.expiring ? (
          <Layout.Section>
            <Card padding="0">
              <Box padding="400">
                <InlineStack align="space-between" blockAlign="center">
                  <Text as="h2" variant="headingMd">Points expiring in the next 30 days</Text>
                  <Button variant="plain" onClick={() => setSp(withParams({ view: null, page: null }), { preventScrollReset: true })}>Close</Button>
                </InlineStack>
              </Box>
              {d.expiring.rows.length === 0 ? (
                <Box padding="400"><Text as="p" tone="subdued">No points expire in the next 30 days.</Text></Box>
              ) : (
                <IndexTable
                  selectable={false}
                  itemCount={d.expiring.rows.length}
                  resourceName={{ singular: "member", plural: "members" }}
                  headings={[{ title: "Customer" }, { title: "Contact" }, { title: "Points expiring" }, { title: "First expiry" }]}
                >
                  {d.expiring.rows.map((m, i) => (
                    <IndexTable.Row id={m.memberId} key={m.memberId} position={i}>
                      <IndexTable.Cell><Link url={`/app/customers/${m.memberId}`}>{m.name}</Link></IndexTable.Cell>
                      <IndexTable.Cell>{m.email ?? m.phone ?? ""}</IndexTable.Cell>
                      <IndexTable.Cell>{fmtInt(m.points)}</IndexTable.Cell>
                      <IndexTable.Cell>
                        {new Date(m.firstExpiry) < new Date(d.now) ? <Badge tone="attention">{`Expiring now (due ${fmtDate(m.firstExpiry)})`}</Badge> : fmtDate(m.firstExpiry)}
                      </IndexTable.Cell>
                    </IndexTable.Row>
                  ))}
                </IndexTable>
              )}
              <Box padding="300"><Pager page={d.listPage} pageSize={LIST_PAGE} total={d.expiring.total} /></Box>
            </Card>
          </Layout.Section>
        ) : null}

        <Layout.Section>
          <InlineGrid columns={{ xs: 1, sm: 2, lg: 4 }} gap="400">
            <StatCard
              title="Members" value={fmtInt(d.stats.membersTotal)}
              sub={`+${fmtInt(d.stats.membersNew)} new in this period`}
              change={fmtChange(d.stats.membersNew, d.previous.membersNew)}
              url="/app/customers" linkLabel="See customers"
            />
            <StatCard
              title="Points earned" value={fmtInt(d.stats.pointsEarned)}
              sub={`${fmtInt(d.stats.pointsPending)} still pending payment`}
              change={fmtChange(d.stats.pointsEarned, d.previous.pointsEarned)}
              url={`/app/analytics${periodQuery}`} linkLabel="Open analytics"
            />
            <StatCard
              title="Redemption rate" value={fmtPercent(d.stats.redemptionRate)}
              sub={`Points redeemed divided by points earned. Was ${fmtPercent(d.previous.redemptionRate)}`}
              url={`/app/analytics${periodQuery}`} linkLabel="Open analytics"
            />
            <StatCard
              title="Order value using a reward" value={fmtPkr(d.stats.rewardSalesPkr)}
              sub={`Product value of ${fmtInt(d.stats.rewardOrders)} order${d.stats.rewardOrders === 1 ? "" : "s"} placed with a reward code: after discounts, without shipping and tax, before refunds. Cancelled orders left out. Reward cost ${fmtPkr(d.stats.rewardCostPkr)}`}
              change={fmtChange(d.stats.rewardSalesPkr, d.previous.rewardSalesPkr)}
              url={`/app/analytics${periodQuery}`} linkLabel="Open analytics"
            />
          </InlineGrid>
        </Layout.Section>

        <Layout.Section>
          <InlineGrid columns={{ xs: 1, md: ["twoThirds", "oneThird"] }} gap="400">
            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">Points earned and redeemed</Text>
                {d.stats.pointsEarned === 0 && d.stats.pointsRedeemed === 0 ? (
                  <Text as="p" tone="subdued">
                    No points moved in this period. Points appear here when orders are delivered and paid.
                  </Text>
                ) : (
                  <Box minHeight="260px">
                    <ClientOnly fallback={<Text as="p" tone="subdued">Loading chart…</Text>}>
                      {() => (
                        <LineChart
                          theme="Light"
                          data={[
                            { name: "Earned", data: d.series.map((p) => ({ key: fmtDate(`${p.day}T07:00:00Z`).replace(/ \d{4}$/, ""), value: p.earned })) },
                            { name: "Redeemed", data: d.series.map((p) => ({ key: fmtDate(`${p.day}T07:00:00Z`).replace(/ \d{4}$/, ""), value: p.redeemed })) },
                          ]}
                        />
                      )}
                    </ClientOnly>
                  </Box>
                )}
              </BlockStack>
            </Card>
            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">Members by tier</Text>
                {totalMembers === 0 ? (
                  <Text as="p" tone="subdued">No members yet. Customers join when they sign in or place an order.</Text>
                ) : (
                  (["silver", "gold", "diamond"] as const).map((t) => (
                    <BlockStack gap="100" key={t}>
                      <InlineStack align="space-between">
                        <Link url={`/app/customers?tier=${t}`} removeUnderline>{t === "silver" ? "Silver" : t === "gold" ? "Gold" : "Diamond"}</Link>
                        <Text as="span">{fmtInt(d.tiers[t])}</Text>
                      </InlineStack>
                      <ProgressBar progress={(d.tiers[t] / totalMembers) * 100} size="small" tone={t === "silver" ? "primary" : "highlight"} />
                    </BlockStack>
                  ))
                )}
                {d.tiers.nearGold > 0 ? (
                  <Text as="p" tone="subdued">
                    {fmtInt(d.tiers.nearGold)} Silver member{d.tiers.nearGold === 1 ? " is" : "s are"} within {fmtPkr(d.tiers.nearGoldWithinPkr)} of Gold.{" "}
                    <Link url="/app/customers?tier=silver&sort=spend&dir=desc">See who</Link>
                  </Text>
                ) : null}
                {d.tiers.nearDiamond > 0 ? (
                  <Text as="p" tone="subdued">
                    {fmtInt(d.tiers.nearDiamond)} Gold member{d.tiers.nearDiamond === 1 ? " is" : "s are"} within {fmtPkr(d.tiers.nearDiamondWithinPkr)} of Diamond.{" "}
                    <Link url="/app/customers?tier=gold&sort=spend&dir=desc">See who</Link>
                  </Text>
                ) : null}
              </BlockStack>
            </Card>
          </InlineGrid>
        </Layout.Section>

        <Layout.Section>
          <Card padding="0">
            <Box padding="400">
              <InlineStack align="space-between" blockAlign="center" gap="300" wrap>
                <Text as="h2" variant="headingMd">Activity</Text>
                <ButtonGroup variant="segmented">
                  {ACTIVITY_FILTERS.map((f) => (
                    <Button
                      key={f} pressed={d.filter === f}
                      onClick={() => setSp(withParams({ activity: f === "all" ? null : f, apage: null }), { preventScrollReset: true })}
                    >
                      {FILTER_LABELS[f]}
                    </Button>
                  ))}
                </ButtonGroup>
              </InlineStack>
            </Box>
            {d.activity.items.length === 0 ? (
              <EmptyBlock
                heading={d.filter === "all" ? "No activity yet" : "Nothing matches this filter"}
                action={d.filter === "all" ? { content: "Check the program", url: "/app/program" } : { content: "Show all activity", onAction: () => setSp(withParams({ activity: null, apage: null }), { preventScrollReset: true }) }}
              >
                <p>{d.filter === "all" ? "Points earned, redeemed and adjusted will be listed here with a link to each customer." : "Try another filter to see other kinds of activity."}</p>
              </EmptyBlock>
            ) : (
              <IndexTable
                selectable={false}
                itemCount={d.activity.items.length}
                resourceName={{ singular: "entry", plural: "entries" }}
                headings={[{ title: "Customer" }, { title: "What happened" }, { title: "Points", alignment: "end" }, { title: "When" }]}
              >
                {d.activity.items.map((a, i) => (
                  <IndexTable.Row id={a.id} key={a.id} position={i}>
                    <IndexTable.Cell><Link url={`/app/customers/${a.memberId}`}>{a.memberName}</Link></IndexTable.Cell>
                    <IndexTable.Cell>
                      <BlockStack gap="050">
                        <Text as="span">{a.title}</Text>
                        {a.detail ? <Text as="span" tone="subdued" variant="bodySm">{a.detail}</Text> : null}
                      </BlockStack>
                    </IndexTable.Cell>
                    <IndexTable.Cell>
                      <Text as="span" alignment="end" tone={a.pointsLabel ? "subdued" : a.points < 0 ? "critical" : "success"}>
                        {a.pointsLabel ?? fmtSigned(a.points)}
                      </Text>
                    </IndexTable.Cell>
                    <IndexTable.Cell>{fmtDateTime(a.at)}</IndexTable.Cell>
                  </IndexTable.Row>
                ))}
              </IndexTable>
            )}
            <Box padding="300">
              <Pager page={d.activityPage} pageSize={ACTIVITY_PAGE} param="apage" hasMore={d.activity.hasMore} />
            </Box>
          </Card>
        </Layout.Section>
      </Layout>

      <ReviewClaimConfirm
        decision={deciding}
        loading={fetcher.state !== "idle"}
        onClose={() => setDeciding(null)}
        onConfirm={(c) => {
          fetcher.submit({ intent: c.kind === "approve" ? "approve_claim" : "reject_claim", claim_id: c.id }, { method: "post" });
          setDeciding(null);
        }}
      />

      <ConfirmModal
        open={blockingReferrer !== null}
        title="Block this referrer?"
        confirmLabel="Block referrer"
        loading={fetcher.state !== "idle"}
        onClose={() => setBlockingReferrer(null)}
        onConfirm={() => {
          if (!blockingReferrer) return;
          fetcher.submit({ intent: "block_referrer", referral_id: blockingReferrer.id }, { method: "post" });
          setBlockingReferrer(null);
        }}
      >
        <Text as="p">
          {blockingReferrer?.name}'s referral link will stop earning, and no referral of hers that is still waiting will be paid. You can allow her referrals again from her profile. Her own points and orders are not changed.
        </Text>
      </ConfirmModal>
    </Page>
  );
}

function AttentionRow(props: { title: string; detail: string; action: React.ReactNode }) {
  return (
    <Box paddingBlock="200" borderBlockStartWidth="025" borderColor="border">
      <InlineStack align="space-between" blockAlign="center" gap="300" wrap={false}>
        <BlockStack gap="050">
          <Text as="p" fontWeight="semibold">{props.title}</Text>
          <Text as="p" tone="subdued" variant="bodySm">{props.detail}</Text>
        </BlockStack>
        {props.action}
      </InlineStack>
    </Box>
  );
}
