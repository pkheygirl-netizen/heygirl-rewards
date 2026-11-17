// app/routes/app._index.tsx — Home
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { Form, useFetcher, useLoaderData, useSearchParams } from "@remix-run/react";
import { useState } from "react";
import {
  Badge, Banner, BlockStack, Box, Button, ButtonGroup, Card, IndexTable, InlineGrid, InlineStack, Layout,
  Link, Page, ProgressBar, Text, TextField,
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
import { actorFromSession } from "../lib/admin-members.server";
import { getSettingsRow } from "../lib/admin-settings.server";
import { errorMessage } from "../lib/admin-validate.server";
import { UUID_RE } from "../lib/admin-db.server";
import { ACTIVITY_FILTERS } from "../components/admin-constants";
import { rejectReviewClaim } from "../lib/review-claims.service";

const LIST_PAGE = 25;
const ACTIVITY_PAGE = 10;

function pageParam(sp: URLSearchParams, name: string): number {
  const n = Number(sp.get(name) ?? "0");
  return Number.isInteger(n) && n > 0 && n < 100000 ? n : 0;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  const sp = new URL(request.url).searchParams;
  const period = periodRange(parsePeriodKey(sp.get("period")));
  const filter = parseActivityFilter(sp.get("activity"));
  const activityPage = pageParam(sp, "apage");
  const view = sp.get("view") === "claims" ? "claims" : sp.get("view") === "expiring" ? "expiring" : null;
  const listPage = pageParam(sp, "page");

  const [stats, previous, series, tiers, attention, health, activity, settings, claims, expiring] = await Promise.all([
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
  ]);

  return json({
    period, stats, previous, series: groupSeries(series), tiers, attention, health,
    activity, filter, activityPage, view, listPage, claims, expiring,
    programEnabled: settings.program_enabled !== false,
    reviewReleaseHours: Number(settings.review_release_hours ?? 72),
    now: new Date().toISOString(),
  });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  try {
    if (intent === "reject_claim") {
      const claimId = String(form.get("claim_id") ?? "");
      if (!UUID_RE.test(claimId)) return json({ ok: false as const, error: "That claim could not be found." }, { status: 400 });
      const res = await rejectReviewClaim(claimId, actorFromSession(session));
      if (!res.ok) {
        return json({ ok: false as const, error: "The claim was not rejected. It may already have been released or rejected." }, { status: 409 });
      }
      return json({ ok: true as const, message: "Review claim rejected. No points will be released" });
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
  const [rejecting, setRejecting] = useState<{ id: string; name: string } | null>(null);

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
  const nothingWaiting =
    d.attention.referralsFlagged === 0 && d.attention.reviewClaimsPending === 0 &&
    d.attention.expiringMembers === 0 && d.attention.gdprOpen === 0;

  return (
    <Page
      title="Home"
      titleMetadata={d.programEnabled ? <Badge tone="success">Program live</Badge> : <Badge tone="critical">Program switched off</Badge>}
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
            <Banner tone="warning" title="The program is switched off" action={{ content: "Open Settings", url: "/app/settings" }}>
              <p>Customers cannot earn or redeem and the storefront panel is hidden until it is switched on again.</p>
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
              {d.attention.referralsFlagged > 0 ? (
                <AttentionRow
                  title={`${fmtInt(d.attention.referralsFlagged)} referral${d.attention.referralsFlagged === 1 ? "" : "s"} held for review`}
                  detail="Friend and referrer share a network address. Approve or reject each one."
                  action={<Button url="/app/referrals?status=flagged">Review</Button>}
                />
              ) : null}
              {d.attention.reviewClaimsPending > 0 ? (
                <AttentionRow
                  title={`${fmtInt(d.attention.reviewClaimsPending)} review claim${d.attention.reviewClaimsPending === 1 ? "" : "s"} waiting`}
                  detail={`Points release automatically ${d.reviewReleaseHours} hours after the claim unless you reject it.`}
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
                <Box padding="400"><Text as="p" tone="subdued">No claims are waiting. New claims appear here until their points are released.</Text></Box>
              ) : (
                <IndexTable
                  selectable={false}
                  itemCount={d.claims.rows.length}
                  resourceName={{ singular: "claim", plural: "claims" }}
                  headings={[{ title: "Customer" }, { title: "Points" }, { title: "Claimed" }, { title: "Releases" }, { title: "Action" }]}
                >
                  {d.claims.rows.map((c, i) => (
                    <IndexTable.Row id={c.id} key={c.id} position={i}>
                      <IndexTable.Cell><Link url={`/app/customers/${c.memberId}`}>{c.memberName}</Link></IndexTable.Cell>
                      <IndexTable.Cell>{fmtInt(c.points)}</IndexTable.Cell>
                      <IndexTable.Cell>{fmtDateTime(c.claimedAt)}</IndexTable.Cell>
                      <IndexTable.Cell>
                        {fmtDateTime(c.releaseAt)}
                        <Text as="span" tone="subdued"> ({new Date(c.releaseAt) > new Date(d.now) ? `in ${fmtAge(c.releaseAt, new Date(d.now))}` : "due now"})</Text>
                      </IndexTable.Cell>
                      <IndexTable.Cell>
                        <Button tone="critical" variant="plain" onClick={() => setRejecting({ id: c.id, name: c.memberName })}>Reject</Button>
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
              title="Sales using a reward" value={fmtPkr(d.stats.rewardSalesPkr)}
              sub={`Reward cost ${fmtPkr(d.stats.rewardCostPkr)} on ${fmtInt(d.stats.rewardOrders)} order${d.stats.rewardOrders === 1 ? "" : "s"}`}
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

      <ConfirmModal
        open={rejecting !== null}
        title="Reject this review claim?"
        confirmLabel="Reject claim"
        loading={fetcher.state !== "idle"}
        onClose={() => setRejecting(null)}
        onConfirm={() => {
          if (!rejecting) return;
          fetcher.submit({ intent: "reject_claim", claim_id: rejecting.id }, { method: "post" });
          setRejecting(null);
        }}
      >
        <Text as="p">
          {rejecting?.name} will not receive the review points for this claim. This cannot be undone from here.
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
