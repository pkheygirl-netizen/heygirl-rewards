import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData, useFetcher } from "@remix-run/react";
import { useState } from "react";
import {
  Page, Card, IndexTable, Badge, Button, Modal, TextField, Checkbox, BlockStack, Box, Text, Banner, InlineStack,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import {
  listCampaigns, createCampaign, updateCampaign, deleteCampaign,
} from "../lib/admin-campaigns.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return json({ campaigns: await listCampaigns() });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  await authenticate.admin(request);
  const form = await request.formData();
  const intent = form.get("intent");
  try {
    if (intent === "delete") {
      await deleteCampaign(String(form.get("id")));
    } else {
      const input = {
        name: String(form.get("name") ?? ""),
        multiplier: Number(form.get("multiplier")),
        startsAt: String(form.get("startsAt")),
        endsAt: String(form.get("endsAt")),
        isActive: form.get("isActive") === "true",
      };
      if (intent === "create") await createCampaign(input);
      else if (intent === "update") await updateCampaign(String(form.get("id")), input);
    }
    return json({ ok: true });
  } catch (e) {
    return json({ ok: false, error: (e as Error).message }, { status: 400 });
  }
};

export default function Campaigns() {
  const { campaigns } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<{ ok: boolean; error?: string }>();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [multiplier, setMultiplier] = useState("2");
  const [startsAt, setStartsAt] = useState("");
  const [endsAt, setEndsAt] = useState("");
  const [isActive, setIsActive] = useState(true);

  return (
    <Page
      title="Points & Campaigns"
      primaryAction={{ content: "New campaign", onAction: () => setOpen(true) }}
      secondaryActions={[{ content: "Export ledger CSV", url: "/app/campaigns/ledger.csv" }]}
    >
      <BlockStack gap="400">
        {fetcher.data && !fetcher.data.ok ? <Banner tone="critical">{fetcher.data.error}</Banner> : null}
        <Card>
          {campaigns.length === 0 ? (
            <Box padding="400"><Text as="p" tone="subdued">No campaigns yet.</Text></Box>
          ) : (
            <IndexTable
              resourceName={{ singular: "campaign", plural: "campaigns" }}
              itemCount={campaigns.length}
              selectable={false}
              headings={[
                { title: "Name" }, { title: "Multiplier" }, { title: "Window" },
                { title: "Status" }, { title: "" },
              ]}
            >
              {campaigns.map((c, i) => (
                <IndexTable.Row id={c.id} key={c.id} position={i}>
                  <IndexTable.Cell>{c.name}</IndexTable.Cell>
                  <IndexTable.Cell>{c.multiplier}×</IndexTable.Cell>
                  <IndexTable.Cell>{c.startsAt.slice(0, 10)} → {c.endsAt.slice(0, 10)}</IndexTable.Cell>
                  <IndexTable.Cell>{c.isActive ? <Badge tone="success">Active</Badge> : <Badge>Inactive</Badge>}</IndexTable.Cell>
                  <IndexTable.Cell>
                    <fetcher.Form method="post">
                      <input type="hidden" name="intent" value="delete" />
                      <input type="hidden" name="id" value={c.id} />
                      <Button submit size="slim" tone="critical">Delete</Button>
                    </fetcher.Form>
                  </IndexTable.Cell>
                </IndexTable.Row>
              ))}
            </IndexTable>
          )}
        </Card>
      </BlockStack>

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="New campaign"
        primaryAction={{
          content: "Create",
          onAction: () => {
            fetcher.submit(
              { intent: "create", name, multiplier, startsAt, endsAt, isActive: String(isActive) },
              { method: "post" },
            );
            setOpen(false);
          },
        }}
      >
        <Modal.Section>
          <BlockStack gap="300">
            <TextField label="Name" value={name} onChange={setName} autoComplete="off" />
            <TextField label="Multiplier" type="number" value={multiplier} onChange={setMultiplier} autoComplete="off" />
            <InlineStack gap="300">
              <TextField label="Starts at" type="datetime-local" value={startsAt} onChange={setStartsAt} autoComplete="off" />
              <TextField label="Ends at" type="datetime-local" value={endsAt} onChange={setEndsAt} autoComplete="off" />
            </InlineStack>
            <Checkbox label="Set as the active campaign" checked={isActive} onChange={setIsActive} />
          </BlockStack>
        </Modal.Section>
      </Modal>
    </Page>
  );
}
