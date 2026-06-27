import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import {
  Page,
  Layout,
  Card,
  BlockStack,
  InlineGrid,
  Box,
  Text,
  EmptyState,
} from "@shopify/polaris";
import { DonutChart, LineChart } from "@shopify/polaris-viz";
import "@shopify/polaris-viz/build/esm/styles.css";
import { ClientOnly } from "../components/ClientOnly";
import { authenticate } from "../shopify.server";
import { registerScriptTagAndPage } from "../lib/scripttag.server";
import {
  getTierBreakdown,
  getPointsIssuedSeries,
  getActivityFeed,
  getOverviewKpis,
} from "../lib/admin-data.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin } = await authenticate.admin(request);

  // Self-heal the storefront widget script tag on each Overview load. The
  // afterAuth hook only registers it at install time, so a host change (e.g.
  // SHOPIFY_APP_URL moving from Railway to app.heygirl.pk) would otherwise
  // leave a stale tag until reinstall. registerScriptTagAndPage is idempotent
  // (it no-ops when the current URL is already registered) and non-fatal.
  await registerScriptTagAndPage(admin);

  const to = new Date();
  const from = new Date(to.getTime() - 30 * 24 * 60 * 60 * 1000);
  const [tiers, series, feed, kpis] = await Promise.all([
    getTierBreakdown(),
    getPointsIssuedSeries(from, to),
    getActivityFeed(20),
    getOverviewKpis(),
  ]);
  return json({ tiers, series, feed, kpis });
};

function Kpi({ label, value }: { label: string; value: string }) {
  return (
    <Card>
      <Box padding="400">
        <BlockStack gap="100">
          <Text as="span" variant="bodySm" tone="subdued">{label}</Text>
          <Text as="span" variant="headingLg">{value}</Text>
        </BlockStack>
      </Box>
    </Card>
  );
}

export default function Overview() {
  const { tiers, series, feed, kpis } = useLoaderData<typeof loader>();
  const totalMembers = tiers.silver + tiers.gold + tiers.diamond;

  return (
    <Page title="Overview">
      <Layout>
        <Layout.Section>
          <InlineGrid columns={{ xs: 2, md: 4 }} gap="400">
            <Kpi label="New members today" value={String(kpis.todayNewMembers)} />
            <Kpi label="Redemptions today" value={String(kpis.todayRedemptions)} />
            <Kpi label="Points awarded today" value={kpis.todayPointsAwarded.toLocaleString()} />
            <Kpi label="Active referrals" value={String(kpis.activeReferrals)} />
          </InlineGrid>
        </Layout.Section>

        <Layout.Section>
          <InlineGrid columns={{ xs: 1, md: 2 }} gap="400">
            <Card>
              <Box padding="400">
                <BlockStack gap="300">
                  <Text as="h2" variant="headingMd">Members by tier</Text>
                  {totalMembers === 0 ? (
                    <Text as="p" tone="subdued">No members yet.</Text>
                  ) : (
                    <ClientOnly fallback={<Text as="p" tone="subdued">Loading chart…</Text>}>
                      {() => (
                        <DonutChart
                          data={[
                            { name: "Silver", data: [{ key: "Silver", value: tiers.silver }] },
                            { name: "Gold", data: [{ key: "Gold", value: tiers.gold }] },
                            { name: "Diamond", data: [{ key: "Diamond", value: tiers.diamond }] },
                          ]}
                        />
                      )}
                    </ClientOnly>
                  )}
                </BlockStack>
              </Box>
            </Card>
            <Card>
              <Box padding="400">
                <BlockStack gap="300">
                  <Text as="h2" variant="headingMd">Points issued (30 days)</Text>
                  <Text as="p" tone="subdued">
                    Conversion rate: {(kpis.redemptionConversionRate * 100).toFixed(1)}%
                  </Text>
                  {series.length === 0 ? (
                    <Text as="p" tone="subdued">No points issued in this range.</Text>
                  ) : (
                    <ClientOnly fallback={<Text as="p" tone="subdued">Loading chart…</Text>}>
                      {() => (
                        <LineChart
                          data={[
                            {
                              name: "Points issued",
                              data: series.map((p) => ({ key: p.date, value: p.points })),
                            },
                          ]}
                        />
                      )}
                    </ClientOnly>
                  )}
                </BlockStack>
              </Box>
            </Card>
          </InlineGrid>
        </Layout.Section>

        <Layout.Section>
          <Card>
            <Box padding="400">
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">Recent activity (7 days)</Text>
                {feed.length === 0 ? (
                  <EmptyState heading="No recent activity" image="">
                    <p>Member activity from the last 7 days will appear here.</p>
                  </EmptyState>
                ) : (
                  <BlockStack gap="200">
                    {feed.map((item) => (
                      <Text as="p" key={item.id}>
                        <strong>{item.memberName}</strong> {item.detail} ·{" "}
                        <Text as="span" tone="subdued">
                          {new Date(item.at).toLocaleString()}
                        </Text>
                      </Text>
                    ))}
                  </BlockStack>
                )}
              </BlockStack>
            </Box>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
