// app/routes/app.campaigns._index.tsx — Bonus campaigns
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useFetcher, useLoaderData } from "@remix-run/react";
import { useEffect, useState } from "react";
import {
  Badge, Banner, BlockStack, Button, Card, Checkbox, FormLayout, IndexTable, InlineStack, Layout, Modal, Page,
  Text, TextField,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import { ConfirmModal, EmptyBlock, ResultBanner, fieldError, useActionToast } from "../components/admin-ui";
import { CAMPAIGN_LIMITS, CAMPAIGN_STATUS_LABELS } from "../components/admin-constants";
import { fmtDateTime, fmtInt, fmtPkr, utcIsoToKarachiLocal } from "../components/karachi";
import {
  deleteCampaign, listCampaigns, parseCampaignForm, saveCampaign, setCampaignActive,
} from "../lib/admin-campaigns.server";
import { publishSettings } from "../lib/admin-settings.server";
import { errorMessage, invalid } from "../lib/admin-validate.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return json({ campaigns: await listCampaigns() });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin } = await authenticate.admin(request);
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  const fail = (error: string, status = 400) => json({ ok: false as const, error, intent }, { status });
  try {
    if (intent === "save") {
      const parsed = parseCampaignForm(form);
      if (!parsed.ok) return json({ ...invalid(parsed.errors), intent }, { status: 400 });
      const id = String(form.get("id") ?? "") || null;
      const res = await saveCampaign(id, parsed.value, { replaceOverlapping: form.get("replace_overlapping") === "true" });
      // The storefront copy is rewritten after every save attempt, whatever its
      // outcome, so it can never lag behind what the campaigns table says.
      const { warning } = await publishSettings(admin);
      if (!res.ok) {
        if ("conflicts" in res) {
          return json({ ok: false as const, intent, conflicts: res.conflicts, error: "Another active campaign overlaps these dates." }, { status: 409 });
        }
        return fail(res.error, 409);
      }
      const off = res.switchedOff.length ? ` ${res.switchedOff.join(", ")} switched off.` : "";
      return json({ ok: true as const, intent, message: `Campaign saved.${off}`, warning });
    }
    if (intent === "set_active") {
      const active = form.get("active") === "true";
      const res = await setCampaignActive(String(form.get("id") ?? ""), active);
      const { warning } = await publishSettings(admin);
      if (!res.ok) {
        if ("conflicts" in res) {
          return fail(`It overlaps ${res.conflicts.map((c) => c.name).join(", ")}. Switch that off or change the dates first.`, 409);
        }
        return fail(res.error, 409);
      }
      return json({
        ok: true as const, intent, warning,
        message: active ? "Campaign switched on" : "Campaign switched off. Orders already placed during it keep its multiplier",
      });
    }
    if (intent === "delete") {
      const res = await deleteCampaign(String(form.get("id") ?? ""));
      const { warning } = await publishSettings(admin);
      if (!res.ok) return fail(res.error, 409);
      return json({ ok: true as const, intent, message: "Campaign deleted", warning });
    }
    return fail("Unknown action.");
  } catch (e) {
    return fail(errorMessage(e), 500);
  }
};

type Campaign = ReturnType<typeof useLoaderData<typeof loader>>["campaigns"][number];
type Draft = { id: string; name: string; multiplier: string; starts_at: string; ends_at: string; is_active: boolean };

const EMPTY: Draft = { id: "", name: "", multiplier: "2", starts_at: "", ends_at: "", is_active: true };

function tone(status: string): "success" | "info" | "attention" | undefined {
  return status === "live" ? "success" : status === "scheduled" ? "info" : status === "off" ? "attention" : undefined;
}

export default function Campaigns() {
  const { campaigns } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  useActionToast(fetcher.data);
  const busy = fetcher.state !== "idle";
  const result = fetcher.data;
  const [draft, setDraft] = useState<Draft | null>(null);
  const [confirm, setConfirm] = useState<{ kind: "delete" | "off"; c: Campaign } | null>(null);

  useEffect(() => {
    if (result?.ok === true && result.intent === "save") setDraft(null);
  }, [result]);

  // A conflict answer is shown once; Cancel returns to the form with the dates still filled in.
  const [dismissed, setDismissed] = useState<unknown>(null);
  const conflicts: Array<{ id: string; name: string }> | null =
    result && result !== dismissed && result.ok === false && "conflicts" in result && Array.isArray(result.conflicts)
      ? (result.conflicts as Array<{ id: string; name: string }>) : null;
  const saveErr = result && result.ok === false && result.intent === "save" && !("conflicts" in result) ? result : null;
  const submitDraft = (replace: boolean) => {
    if (!draft) return;
    fetcher.submit(
      { intent: "save", ...draft, is_active: String(draft.is_active), replace_overlapping: String(replace) },
      { method: "post" },
    );
  };
  const edit = (c: Campaign) => setDraft({
    id: c.id, name: c.name, multiplier: String(c.multiplier),
    starts_at: utcIsoToKarachiLocal(c.startsAt), ends_at: utcIsoToKarachiLocal(c.endsAt), is_active: c.isActive,
  });

  return (
    <Page
      title="Campaigns"
      subtitle="Multiply purchase points for a set time. All times are Pakistan time."
      primaryAction={{ content: "Create campaign", onAction: () => setDraft({ ...EMPTY }) }}
    >
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            {result && !(draft && result.ok === false && result.intent === "save") ? <ResultBanner data={result} /> : null}
            <Banner tone="info">
              <p>
                An order earns the multiplier of the campaign that was running when it was placed, even if it is paid after the campaign ends or is switched off.
                Only one campaign can be on at any moment. Order value is the product value of the orders placed under a campaign: after discounts,
                without shipping and tax, before refunds; cancelled orders are left out.
              </p>
            </Banner>
            <Card padding="0">
              {campaigns.length === 0 ? (
                <EmptyBlock heading="No campaigns yet" action={{ content: "Create campaign", onAction: () => setDraft({ ...EMPTY }) }}>
                  <p>Run double points for Eid or a weekend sale. Choose a multiplier and the start and end times.</p>
                </EmptyBlock>
              ) : (
                <IndexTable
                  selectable={false} itemCount={campaigns.length}
                  resourceName={{ singular: "campaign", plural: "campaigns" }}
                  headings={[
                    { title: "Campaign" }, { title: "Status" }, { title: "Multiplier" }, { title: "Starts" }, { title: "Ends" },
                    { title: "Orders", alignment: "end" }, { title: "Order value", alignment: "end" },
                    { title: "Points issued", alignment: "end" }, { title: "Actions" },
                  ]}
                >
                  {campaigns.map((c, i) => (
                    <IndexTable.Row id={c.id} key={c.id} position={i}>
                      <IndexTable.Cell><Text as="span" fontWeight="semibold">{c.name}</Text></IndexTable.Cell>
                      <IndexTable.Cell><Badge tone={tone(c.status)}>{CAMPAIGN_STATUS_LABELS[c.status]}</Badge></IndexTable.Cell>
                      <IndexTable.Cell>{c.multiplier}×</IndexTable.Cell>
                      <IndexTable.Cell>{fmtDateTime(c.startsAt)}</IndexTable.Cell>
                      <IndexTable.Cell>{fmtDateTime(c.endsAt)}</IndexTable.Cell>
                      <IndexTable.Cell><Text as="span" alignment="end">{fmtInt(c.results.orders)}</Text></IndexTable.Cell>
                      <IndexTable.Cell><Text as="span" alignment="end">{fmtPkr(c.results.salesPkr)}</Text></IndexTable.Cell>
                      <IndexTable.Cell>
                        <BlockStack gap="050" inlineAlign="end">
                          <Text as="span">{fmtInt(c.results.pointsIssued)}</Text>
                          {c.results.pointsPending > 0 ? <Text as="span" tone="subdued" variant="bodySm">{`${fmtInt(c.results.pointsPending)} pending`}</Text> : null}
                        </BlockStack>
                      </IndexTable.Cell>
                      <IndexTable.Cell>
                        <InlineStack gap="200" wrap={false}>
                          <Button size="slim" onClick={() => edit(c)}>Edit</Button>
                          {c.status === "ended" ? null : c.isActive ? (
                            <Button size="slim" variant="plain" onClick={() => setConfirm({ kind: "off", c })}>{c.status === "live" ? "End now" : "Switch off"}</Button>
                          ) : (
                            <Button size="slim" variant="plain" loading={busy}
                              onClick={() => fetcher.submit({ intent: "set_active", id: c.id, active: "true" }, { method: "post" })}>
                              Switch on
                            </Button>
                          )}
                          {c.results.orders === 0 ? (
                            <Button size="slim" variant="plain" tone="critical" onClick={() => setConfirm({ kind: "delete", c })}>Delete</Button>
                          ) : null}
                        </InlineStack>
                      </IndexTable.Cell>
                    </IndexTable.Row>
                  ))}
                </IndexTable>
              )}
            </Card>
          </BlockStack>
        </Layout.Section>
      </Layout>

      <Modal
        open={draft !== null && !conflicts}
        onClose={() => setDraft(null)}
        title={draft?.id ? "Edit campaign" : "Create campaign"}
        primaryAction={{ content: "Save campaign", loading: busy, onAction: () => submitDraft(false) }}
        secondaryActions={[{ content: "Cancel", onAction: () => setDraft(null) }]}
      >
        <Modal.Section>
          {draft ? (
            <BlockStack gap="300">
              {saveErr ? <Banner tone="critical"><p>{saveErr.error}</p></Banner> : null}
              <FormLayout>
                <TextField
                  label="Name" autoComplete="off" maxLength={CAMPAIGN_LIMITS.name}
                  value={draft.name} onChange={(v) => setDraft({ ...draft, name: v })} error={fieldError(saveErr, "name")}
                  helpText="Customers see this name on the storefront while the campaign runs."
                />
                <TextField
                  label="Multiplier" type="number" inputMode="decimal" step={0.1} suffix="×" autoComplete="off"
                  value={draft.multiplier} onChange={(v) => setDraft({ ...draft, multiplier: v })} error={fieldError(saveErr, "multiplier")}
                  helpText={`Between ${CAMPAIGN_LIMITS.multiplier.min} and ${CAMPAIGN_LIMITS.multiplier.max}, one decimal place. 2 means double points on purchases.`}
                />
                <FormLayout.Group>
                  <TextField
                    label="Starts (Pakistan time)" type="datetime-local" autoComplete="off"
                    value={draft.starts_at} onChange={(v) => setDraft({ ...draft, starts_at: v })} error={fieldError(saveErr, "starts_at")}
                  />
                  <TextField
                    label="Ends (Pakistan time)" type="datetime-local" autoComplete="off"
                    value={draft.ends_at} onChange={(v) => setDraft({ ...draft, ends_at: v })} error={fieldError(saveErr, "ends_at")}
                  />
                </FormLayout.Group>
                <Checkbox
                  label="Switched on" checked={draft.is_active} onChange={(v) => setDraft({ ...draft, is_active: v })}
                  helpText="A campaign that is switched on starts and ends by itself at the times above. Un-ticking this for a campaign that is running ends it now."
                />
              </FormLayout>
              {draft.id ? (
                <Text as="p" tone="subdued">
                  Changing the multiplier or dates does not change points already given or pending for orders already placed.
                </Text>
              ) : null}
            </BlockStack>
          ) : null}
        </Modal.Section>
      </Modal>

      <ConfirmModal
        open={draft !== null && Boolean(conflicts)}
        title="Another campaign overlaps these dates"
        confirmLabel="Switch it off and save"
        loading={busy}
        onClose={() => setDismissed(result)}
        onConfirm={() => submitDraft(true)}
      >
        <Text as="p">
          {(conflicts ?? []).map((c) => c.name).join(", ")} {conflicts && conflicts.length > 1 ? "are" : "is"} switched on for some of the same time.
          Only one campaign can run at a time. Saving will switch {conflicts && conflicts.length > 1 ? "them" : "it"} off in the same step: a campaign that is running ends now and orders already placed during it keep its multiplier; one that has not started keeps its dates. Campaigns that do not overlap are left alone.
          Choose Cancel to go back and change the dates instead.
        </Text>
      </ConfirmModal>

      <ConfirmModal
        open={confirm !== null}
        loading={busy}
        title={confirm?.kind === "delete" ? `Delete "${confirm.c.name}"?` : confirm?.c.status === "live" ? `End "${confirm.c.name}" now?` : `Switch off "${confirm?.c.name ?? ""}"?`}
        confirmLabel={confirm?.kind === "delete" ? "Delete campaign" : confirm?.c.status === "live" ? "End campaign now" : "Switch off"}
        onClose={() => setConfirm(null)}
        onConfirm={() => {
          if (!confirm) return;
          fetcher.submit(
            confirm.kind === "delete" ? { intent: "delete", id: confirm.c.id } : { intent: "set_active", id: confirm.c.id, active: "false" },
            { method: "post" },
          );
          setConfirm(null);
        }}
      >
        <Text as="p">
          {confirm?.kind === "delete"
            ? "No orders were placed under this campaign, so it can be removed completely."
            : confirm?.c.status === "live"
              ? "The campaign's end time is set to now. New orders stop earning the multiplier straight away; every order already placed during the campaign keeps it, including orders that are paid later. To run it again, edit its end time and switch it on."
              : "It has not started yet, so no order is affected. Its dates are kept and you can switch it on again."}
        </Text>
      </ConfirmModal>
    </Page>
  );
}
