// app/routes/app.analytics._index.tsx — Analytics
import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import {
  BlockStack, Box, Card, DataTable, InlineGrid, InlineStack, Layout, Link, Page, Text,
} from "@shopify/polaris";
import { LineChart } from "@shopify/polaris-viz";
import "@shopify/polaris-viz/build/esm/styles.css";
import { authenticate } from "../shopify.server";
import { ClientOnly } from "../components/ClientOnly";
import { PeriodSelect } from "../components/admin-ui";
import {
  fmtChange, fmtDate, fmtInt, fmtPercent, fmtPkr, parsePeriodKey, periodRange,
} from "../components/karachi";
import { downloadCsv } from "../lib/csv-download.client";
import { getAnalytics } from "../lib/admin-analytics.server";
import { groupSeries } from "../lib/admin-data.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  const period = periodRange(parsePeriodKey(new URL(request.url).searchParams.get("period"), true));
  const a = await getAnalytics(period);
  return json({ period, ...a, series: groupSeries(a.series), daily: a.series.length });
};

function pct(part: number, whole: number): string {
  return whole > 0 ? fmtPercent(part / whole) : "0%";
}

export default function Analytics() {
  const d = useLoaderData<typeof loader>();
  const s = d.stats;
  const p = d.previous;
  const label = (day: string) => fmtDate(`${day}T07:00:00Z`).replace(/ \d{4}$/, "");
  const noMovement = s.pointsEarned === 0 && s.pointsRedeemed === 0 && s.pointsExpired === 0;
  const o = d.outstanding;

  return (
    <Page
      title="Analytics"
      subtitle={`${d.period.label} compared with the ${d.period.key === "month" ? "same days of last month" : "period before"}. Pakistan time.`}
      secondaryActions={[{
        content: "Export CSV",
        onAction: () => downloadCsv(`/app/analytics/export.csv?period=${d.period.key}`, `points-by-day-${d.period.key}.csv`),
      }]}
    >
      <Layout>
        <Layout.Section>
          <PeriodSelect value={d.period.key} extra={[{ value: "90d", label: "Last 90 days" }]} />
        </Layout.Section>

        <Layout.Section>
          <InlineGrid columns={{ xs: 1, sm: 2, lg: 4 }} gap="400">
            <Metric title="Redemption rate" value={fmtPercent(s.redemptionRate)}
              sub={`Points redeemed ÷ points earned. Previous period ${fmtPercent(p.redemptionRate)}`} />
            <Metric title="Points earned" value={fmtInt(s.pointsEarned)} change={fmtChange(s.pointsEarned, p.pointsEarned)}
              sub={`Previous period ${fmtInt(p.pointsEarned)}`} />
            <Metric title="Points redeemed" value={fmtInt(s.pointsRedeemed)} change={fmtChange(s.pointsRedeemed, p.pointsRedeemed)}
              sub={`${fmtInt(s.redemptions)} reward code${s.redemptions === 1 ? "" : "s"} created. Net of cancelled codes, counted on the day of the cancellation`} />
            <Metric title="Points expired" value={fmtInt(s.pointsExpired)} change={fmtChange(s.pointsExpired, p.pointsExpired)}
              sub={`${fmtInt(s.pointsReversed)} reversed for refunds and cancellations`} />
          </InlineGrid>
        </Layout.Section>

        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">Earned, redeemed and expired</Text>
              {noMovement ? (
                <Text as="p" tone="subdued">No points moved in this period. Try a longer period, or check that orders are being delivered and marked paid.</Text>
              ) : (
                <Box minHeight="280px">
                  <ClientOnly fallback={<Text as="p" tone="subdued">Loading chart…</Text>}>
                    {() => (
                      <LineChart
                        theme="Light"
                        data={[
                          { name: "Earned", data: d.series.map((x) => ({ key: label(x.day), value: x.earned })) },
                          { name: "Redeemed", data: d.series.map((x) => ({ key: label(x.day), value: x.redeemed })) },
                          { name: "Expired", data: d.series.map((x) => ({ key: label(x.day), value: x.expired })) },
                        ]}
                      />
                    )}
                  </ClientOnly>
                </Box>
              )}
              {d.series.length < d.daily ? <Text as="p" tone="subdued" variant="bodySm">Shown by week. The CSV export has every day.</Text> : null}
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section>
          <InlineGrid columns={{ xs: 1, md: 2 }} gap="400">
            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">Order value using a reward against reward cost</Text>
                <Row label="Orders placed with a reward code" value={fmtInt(s.rewardOrders)} />
                <Row label="Order value, before refunds" value={fmtPkr(s.rewardSalesPkr)} />
                <Row label="Discount given by those codes" value={fmtPkr(s.rewardCostPkr)} />
                <Row label="Cost as a share of that order value" value={pct(s.rewardCostPkr, s.rewardSalesPkr)} />
                <Text as="p" tone="subdued" variant="bodySm">
                  Counts orders placed in the period that used a code bought with points. Order value is the product value of each order as it was placed:
                  after discounts, without shipping and tax. Refunds made later are not taken off, so this is not net sales. Cancelled orders are left out.
                  Previous period: {fmtPkr(p.rewardSalesPkr)} order value, {fmtPkr(p.rewardCostPkr)} cost.
                </Text>
              </BlockStack>
            </Card>
            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">Outstanding points</Text>
                <Row label="Points customers hold now" value={fmtInt(o.points)} />
                <Row label="Members holding points" value={fmtInt(o.members)} />
                <Row label="Pending, waiting for payment" value={fmtInt(s.pointsPending)} />
                <Row
                  label="Value at the base redemption rate"
                  value={o.baseTier ? fmtPkr(o.valuePkr) : "No reward is shown"}
                />
                <Text as="p" tone="subdued" variant="bodySm">
                  {o.baseTier
                    ? `Base rate is the lowest reward customers can choose: ${fmtInt(o.baseTier.points)} points for ${fmtPkr(o.baseTier.discount_pkr)} off. Hidden rewards are not counted. Larger rewards give more per point, so the real cost if everyone redeemed could be higher.`
                    : "No reward is shown to customers, so there is no rate to value points at. Add or show a reward on the Program page."}{" "}
                  <Link url="/app/program">Ways to redeem</Link>
                </Text>
              </BlockStack>
            </Card>
          </InlineGrid>
        </Layout.Section>

        <Layout.Section>
          <InlineGrid columns={{ xs: 1, md: 2 }} gap="400">
            <TopList title="Top earners" empty="Nobody earned points in this period." rows={d.topEarners} />
            <TopList title="Top redeemers" empty="Nobody redeemed points in this period." rows={d.topRedeemers} />
          </InlineGrid>
        </Layout.Section>

        <Layout.Section>
          <InlineGrid columns={{ xs: 1, md: 2 }} gap="400">
            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">Referral funnel</Text>
                <Row label="Friends who signed in with a link" value={fmtInt(d.funnel.recorded)} />
                <Row label="Placed a first order" value={`${fmtInt(d.funnel.withOrder)} (${pct(d.funnel.withOrder, d.funnel.recorded)})`} />
                <Row label="Completed (delivered and paid)" value={`${fmtInt(d.funnel.completed)} (${pct(d.funnel.completed, d.funnel.recorded)})`} />
                <Row label="Held for review" value={fmtInt(d.funnel.flagged)} />
                <Row label="Rejected or blocked" value={fmtInt(d.funnel.rejected + d.funnel.blocked)} />
                <Row label="Points paid to referrers" value={fmtInt(d.funnel.pointsPaid)} />
                <Text as="p" tone="subdued" variant="bodySm">Referrals recorded in the period. Points paid is net of rewards taken back after a refund or cancellation. <Link url="/app/referrals?status=all">Open referrals</Link></Text>
              </BlockStack>
            </Card>
            <Card>
              <BlockStack gap="300">
                <InlineStack align="space-between">
                  <Text as="h2" variant="headingMd">Influencers compared</Text>
                  <Link url={`/app/influencers?period=${d.period.key}`}>See all</Link>
                </InlineStack>
                {d.influencers.length === 0 ? (
                  <Text as="p" tone="subdued">No influencers yet. <Link url="/app/influencers">Add one</Link> to compare their order value here.</Text>
                ) : (
                  <DataTable
                    columnContentTypes={["text", "numeric", "numeric", "numeric", "numeric"]}
                    headings={["Influencer", "Completed", "Orders", "Order value", "Points paid"]}
                    rows={d.influencers.map((r) => [
                      <Link url={`/app/influencers/${r.id}`} key={r.id}>{r.name}</Link>,
                      fmtInt(r.completed), fmtInt(r.orders), fmtPkr(r.salesPkr), fmtInt(r.pointsPaid),
                    ])}
                  />
                )}
              </BlockStack>
            </Card>
          </InlineGrid>
        </Layout.Section>
      </Layout>
    </Page>
  );
}

function Metric(props: { title: string; value: string; sub: string; change?: { text: string; tone: "up" | "down" | "flat" } }) {
  return (
    <Card>
      <BlockStack gap="150">
        <Text as="h3" variant="headingSm" tone="subdued">{props.title}</Text>
        <Text as="p" variant="headingXl">{props.value}</Text>
        {props.change ? <Text as="p" variant="bodySm" tone="subdued">{props.change.text}</Text> : null}
        <Text as="p" variant="bodySm" tone="subdued">{props.sub}</Text>
      </BlockStack>
    </Card>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <InlineStack align="space-between" gap="300">
      <Text as="span" tone="subdued">{label}</Text>
      <Text as="span" fontWeight="semibold">{value}</Text>
    </InlineStack>
  );
}

function TopList(props: { title: string; empty: string; rows: Array<{ memberId: string; name: string; points: number }> }) {
  return (
    <Card>
      <BlockStack gap="300">
        <Text as="h2" variant="headingMd">{props.title}</Text>
        {props.rows.length === 0 ? (
          <Text as="p" tone="subdued">{props.empty}</Text>
        ) : (
          props.rows.map((r, i) => (
            <InlineStack align="space-between" key={r.memberId} gap="300">
              <Text as="span">{i + 1}. <Link url={`/app/customers/${r.memberId}`}>{r.name}</Link></Text>
              <Text as="span" fontWeight="semibold">{fmtInt(r.points)}</Text>
            </InlineStack>
          ))
        )}
      </BlockStack>
    </Card>
  );
}
