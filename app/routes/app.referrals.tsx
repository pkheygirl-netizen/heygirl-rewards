import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData, useSearchParams, useFetcher, Form } from "@remix-run/react";
import {
  Page, Card, IndexTable, Badge, Select, Button, Text, InlineGrid, Box, BlockStack, Banner,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import {
  listReferrals, referralSummary, reviewAndUnblock, type ReferralStatus,
} from "../lib/admin-referrals.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  const url = new URL(request.url);
  const status = (url.searchParams.get("status") as ReferralStatus | "") || undefined;
  const [referrals, summary] = await Promise.all([
    listReferrals({ status }),
    referralSummary(),
  ]);
  return json({ referrals, summary, status: status ?? "" });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  await authenticate.admin(request);
  const form = await request.formData();
  try {
    await reviewAndUnblock(String(form.get("referralId")));
    return json({ ok: true });
  } catch (e) {
    return json({ ok: false, error: (e as Error).message }, { status: 400 });
  }
};

function statusBadge(s: string, ipMatch: boolean) {
  if (s === "blocked") return <Badge tone="critical">Blocked</Badge>;
  if (s === "flagged") return <Badge tone="warning">{ipMatch ? "Flagged · IP match" : "Flagged"}</Badge>;
  if (s === "completed") return <Badge tone="success">Completed</Badge>;
  return <Badge>Pending</Badge>;
}

export default function Referrals() {
  const { referrals, summary, status } = useLoaderData<typeof loader>();
  const [params, setParams] = useSearchParams();
  const fetcher = useFetcher<{ ok: boolean; error?: string }>();

  return (
    <Page title="Referrals">
      <BlockStack gap="400">
        <InlineGrid columns={{ xs: 1, md: 3 }} gap="400">
          <Card><Box padding="400"><BlockStack gap="100"><Text as="span" tone="subdued">Total referrals</Text><Text as="span" variant="headingLg">{summary.total}</Text></BlockStack></Box></Card>
          <Card><Box padding="400"><BlockStack gap="100"><Text as="span" tone="subdued">Conversion rate</Text><Text as="span" variant="headingLg">{(summary.conversionRate * 100).toFixed(0)}%</Text></BlockStack></Box></Card>
          <Card><Box padding="400"><BlockStack gap="100"><Text as="span" tone="subdued">Rewards issued</Text><Text as="span" variant="headingLg">{summary.rewardsIssued}</Text></BlockStack></Box></Card>
        </InlineGrid>

        {fetcher.data && !fetcher.data.ok ? <Banner tone="critical">{fetcher.data.error}</Banner> : null}

        <Card>
          <Box padding="400">
            <Form method="get">
              <Select
                label="Status" labelHidden name="status" value={status}
                options={[
                  { label: "All", value: "" },
                  { label: "Pending", value: "pending" },
                  { label: "Completed", value: "completed" },
                  { label: "Flagged", value: "flagged" },
                  { label: "Blocked", value: "blocked" },
                ]}
                onChange={(v) => {
                  const next = new URLSearchParams(params);
                  if (v) next.set("status", v); else next.delete("status");
                  setParams(next);
                }}
              />
            </Form>
          </Box>
          {referrals.length === 0 ? (
            <Box padding="400"><Text as="p" tone="subdued">No referrals match this filter.</Text></Box>
          ) : (
            <IndexTable
              resourceName={{ singular: "referral", plural: "referrals" }}
              itemCount={referrals.length}
              selectable={false}
              headings={[
                { title: "Referrer" }, { title: "Referred email" }, { title: "Status" },
                { title: "Created" }, { title: "Action" },
              ]}
            >
              {referrals.map((r, i) => (
                <IndexTable.Row id={r.id} key={r.id} position={i}>
                  <IndexTable.Cell>{r.referrerName}</IndexTable.Cell>
                  <IndexTable.Cell>{r.referredEmail}</IndexTable.Cell>
                  <IndexTable.Cell>{statusBadge(r.status, r.ipMatch)}</IndexTable.Cell>
                  <IndexTable.Cell>{r.createdAt.slice(0, 10)}</IndexTable.Cell>
                  <IndexTable.Cell>
                    {r.status === "blocked" || r.status === "flagged" ? (
                      <fetcher.Form method="post">
                        <input type="hidden" name="referralId" value={r.id} />
                        <Button submit size="slim">Review &amp; Unblock</Button>
                      </fetcher.Form>
                    ) : null}
                  </IndexTable.Cell>
                </IndexTable.Row>
              ))}
            </IndexTable>
          )}
        </Card>
      </BlockStack>
    </Page>
  );
}
