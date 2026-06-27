import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData, useFetcher } from "@remix-run/react";
import { useState } from "react";
import {
  Page, Card, IndexTable, Text, Banner, Button, TextField, Box, InlineStack,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import {
  getInfluencers, updateReferralSlug, type InfluencerRow,
} from "../lib/admin-influencers.server";
import { adjustPoints } from "../lib/admin-members.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return json({ influencers: await getInfluencers() });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  await authenticate.admin(request);
  const form = await request.formData();
  const intent = form.get("intent");
  const memberId = String(form.get("memberId"));
  try {
    if (intent === "slug") {
      await updateReferralSlug(memberId, String(form.get("slug") ?? ""));
    } else if (intent === "adjust") {
      await adjustPoints({
        memberId,
        points: Number(form.get("points")),
        reason: String(form.get("reason") ?? ""),
      });
    }
    return json({ ok: true });
  } catch (e) {
    return json({ ok: false, error: (e as Error).message }, { status: 400 });
  }
};

function SlugEditor({ influencer }: { influencer: InfluencerRow }) {
  const fetcher = useFetcher<{ ok: boolean; error?: string }>();
  const [slug, setSlug] = useState(influencer.slug);
  return (
    <fetcher.Form method="post">
      <input type="hidden" name="intent" value="slug" />
      <input type="hidden" name="memberId" value={influencer.id} />
      <InlineStack gap="100">
        <TextField label="Slug" labelHidden name="slug" autoComplete="off" value={slug} onChange={setSlug} />
        <Button submit loading={fetcher.state !== "idle"}>Save</Button>
      </InlineStack>
    </fetcher.Form>
  );
}

export default function Influencers() {
  const { influencers } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<{ ok: boolean; error?: string }>();

  return (
    <Page
      title="Influencers"
      primaryAction={{ content: "Export CSV", url: "/app/influencers/export.csv", external: false }}
    >
      {fetcher.data && !fetcher.data.ok ? (
        <Box paddingBlockEnd="300"><Banner tone="critical">{fetcher.data.error}</Banner></Box>
      ) : null}
      <Card>
        {influencers.length === 0 ? (
          <Box padding="400"><Text as="p" tone="subdued">No influencer-tagged members yet.</Text></Box>
        ) : (
          <IndexTable
            resourceName={{ singular: "influencer", plural: "influencers" }}
            itemCount={influencers.length}
            selectable={false}
            headings={[
              { title: "Name" }, { title: "Tier" }, { title: "Custom rate" },
              { title: "Clicks" }, { title: "Conversions" }, { title: "Conv %" },
              { title: "Pts earned" }, { title: "Rs. equiv" }, { title: "Slug" },
            ]}
          >
            {influencers.map((inf, i) => (
              <IndexTable.Row id={inf.id} key={inf.id} position={i}>
                <IndexTable.Cell>{inf.name}</IndexTable.Cell>
                <IndexTable.Cell>{inf.tier}</IndexTable.Cell>
                <IndexTable.Cell>{inf.customRate ?? "—"}</IndexTable.Cell>
                <IndexTable.Cell>{inf.clicks}</IndexTable.Cell>
                <IndexTable.Cell>{inf.conversions}</IndexTable.Cell>
                <IndexTable.Cell>{(inf.conversionRate * 100).toFixed(0)}%</IndexTable.Cell>
                <IndexTable.Cell>{inf.pointsEarned.toLocaleString()}</IndexTable.Cell>
                <IndexTable.Cell>Rs.{inf.rsEquivalent.toLocaleString()}</IndexTable.Cell>
                <IndexTable.Cell>
                  <SlugEditor influencer={inf} />
                </IndexTable.Cell>
              </IndexTable.Row>
            ))}
          </IndexTable>
        )}
      </Card>
    </Page>
  );
}
