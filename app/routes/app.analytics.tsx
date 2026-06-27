import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData, useSearchParams, Form } from "@remix-run/react";
import {
  Page, Card, Select, BlockStack, Box, Text, InlineGrid, IndexTable, EmptyState,
} from "@shopify/polaris";
import { StackedAreaChart } from "@shopify/polaris-viz";
import "@shopify/polaris-viz/build/esm/styles.css";
import { ClientOnly } from "../components/ClientOnly";
import { authenticate } from "../shopify.server";
import {
  parseRange, getPointsFlowSeries, getTopEarners, getTopRedeemers,
  getPopularRedemptionTier, getReferralFunnel,
} from "../lib/admin-analytics.server";
import { getTierBreakdown } from "../lib/admin-data.server";
import { getInfluencers } from "../lib/admin-influencers.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  const url = new URL(request.url);
  const { from, to } = parseRange(url.searchParams);
  const [flow, earners, redeemers, popular, funnel, tiers, influencers] = await Promise.all([
    getPointsFlowSeries(from, to),
    getTopEarners(10),
    getTopRedeemers(10),
    getPopularRedemptionTier(),
    getReferralFunnel(),
    getTierBreakdown(),
    getInfluencers(),
  ]);
  return json({
    flow, earners, redeemers, popular, funnel, tiers, influencers,
    range: url.searchParams.get("range") ?? "30d",
  });
};

export default function Analytics() {
  const data = useLoaderData<typeof loader>();
  const [params, setParams] = useSearchParams();

  return (
    <Page
      title="Analytics"
      primaryAction={{ content: "Export CSV", url: `/app/analytics/export.csv?range=${data.range}` }}
    >
      <BlockStack gap="400">
        <Card>
          <Box padding="400">
            <Form method="get">
              <Select
                label="Range" labelHidden name="range" value={data.range}
                options={[
                  { label: "Last 7 days", value: "7d" },
                  { label: "Last 30 days", value: "30d" },
                  { label: "Last 90 days", value: "90d" },
                ]}
                onChange={(v) => {
                  const next = new URLSearchParams(params);
                  next.set("range", v);
                  setParams(next);
                }}
              />
            </Form>
          </Box>
        </Card>

        <Card>
          <Box padding="400">
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">Points issued / redeemed / expired</Text>
              {data.flow.length === 0 ? (
                <Text as="p" tone="subdued">No ledger activity in this range.</Text>
              ) : (
                <ClientOnly fallback={<Text as="p" tone="subdued">Loading chart…</Text>}>
                  {() => (
                    <StackedAreaChart
                      data={[
                        { name: "Issued", data: data.flow.map((d) => ({ key: d.date, value: d.issued })) },
                        { name: "Redeemed", data: data.flow.map((d) => ({ key: d.date, value: d.redeemed })) },
                        { name: "Expired", data: data.flow.map((d) => ({ key: d.date, value: d.expired })) },
                      ]}
                    />
                  )}
                </ClientOnly>
              )}
            </BlockStack>
          </Box>
        </Card>

        <InlineGrid columns={{ xs: 1, md: 2 }} gap="400">
          <Card>
            <Box padding="400">
              <BlockStack gap="200">
                <Text as="h2" variant="headingMd">Top earners</Text>
                {data.earners.length === 0 ? <Text as="p" tone="subdued">No data.</Text> :
                  data.earners.map((e) => (
                    <Text as="p" key={e.email}>{e.name} — {e.points.toLocaleString()} pts</Text>
                  ))}
              </BlockStack>
            </Box>
          </Card>
          <Card>
            <Box padding="400">
              <BlockStack gap="200">
                <Text as="h2" variant="headingMd">Top redeemers</Text>
                {data.redeemers.length === 0 ? <Text as="p" tone="subdued">No data.</Text> :
                  data.redeemers.map((e) => (
                    <Text as="p" key={e.email}>{e.name} — {e.points.toLocaleString()} pts</Text>
                  ))}
              </BlockStack>
            </Box>
          </Card>
        </InlineGrid>

        <InlineGrid columns={{ xs: 1, md: 2 }} gap="400">
          <Card>
            <Box padding="400">
              <BlockStack gap="200">
                <Text as="h2" variant="headingMd">Referral funnel</Text>
                <Text as="p">Clicks: {data.funnel.clicks}</Text>
                <Text as="p">With order: {data.funnel.withOrder}</Text>
                <Text as="p">Completed: {data.funnel.completed}</Text>
              </BlockStack>
            </Box>
          </Card>
          <Card>
            <Box padding="400">
              <BlockStack gap="200">
                <Text as="h2" variant="headingMd">Most popular redemption</Text>
                {data.popular ? (
                  <Text as="p">Rs.{data.popular.pkr} off — used {data.popular.count} times</Text>
                ) : (
                  <Text as="p" tone="subdued">No redemptions yet.</Text>
                )}
                <Text as="span" tone="subdued">
                  Members: {data.tiers.silver} Silver · {data.tiers.gold} Gold · {data.tiers.diamond} Diamond
                </Text>
              </BlockStack>
            </Box>
          </Card>
        </InlineGrid>

        <Card>
          <Box padding="400">
            <Text as="h2" variant="headingMd">Influencer comparison</Text>
          </Box>
          {data.influencers.length === 0 ? (
            <Box padding="400">
              <EmptyState heading="No influencers tagged" image="">
                <p>Tag members as influencers from the Members tab to compare performance.</p>
              </EmptyState>
            </Box>
          ) : (
            <IndexTable
              resourceName={{ singular: "influencer", plural: "influencers" }}
              itemCount={data.influencers.length}
              selectable={false}
              headings={[
                { title: "Name" }, { title: "Conversions" }, { title: "Conv %" }, { title: "Pts" },
              ]}
            >
              {data.influencers.map((inf, i) => (
                <IndexTable.Row id={inf.id} key={inf.id} position={i}>
                  <IndexTable.Cell>{inf.name}</IndexTable.Cell>
                  <IndexTable.Cell>{inf.conversions}</IndexTable.Cell>
                  <IndexTable.Cell>{(inf.conversionRate * 100).toFixed(0)}%</IndexTable.Cell>
                  <IndexTable.Cell>{inf.pointsEarned.toLocaleString()}</IndexTable.Cell>
                </IndexTable.Row>
              ))}
            </IndexTable>
          )}
        </Card>
      </BlockStack>
    </Page>
  );
}
