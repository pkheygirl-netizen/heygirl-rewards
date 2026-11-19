// app/routes/app.settings.tsx — Settings: redeeming switch (program_enabled), notifications, exports, health, privacy requests
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useFetcher, useLoaderData } from "@remix-run/react";
import { useState } from "react";
import {
  Badge, Banner, BlockStack, Box, Button, Card, IndexTable, InlineStack, Layout, Link, List, Page, Select, Text,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import { ConfirmModal, Pager, ResultBanner, useActionToast } from "../components/admin-ui";
import { fmtDateTime, fmtInt } from "../components/karachi";
import { downloadCsv } from "../lib/csv-download.client";
import { UUID_RE } from "../lib/admin-db.server";
import { getSystemHealth } from "../lib/admin-health.server";
import {
  getSettingsRow, listGdprRequests, notificationStatus, publishSettings, setGdprRequestStatus, updateSettings,
} from "../lib/admin-settings.server";
import { errorMessage } from "../lib/admin-validate.server";
import { NO_SCRIPT_SCOPE_TEXT, PROGRAM_OFF_EFFECTS } from "../components/admin-constants";
import { findLegacyScriptTags, removeLegacyScriptTags } from "../lib/legacy-scripttags.server";

const PAGE_SIZE = 25;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin } = await authenticate.admin(request);
  const pageRaw = Number(new URL(request.url).searchParams.get("page") ?? "0");
  const page = Number.isInteger(pageRaw) && pageRaw > 0 ? pageRaw : 0;
  const [settings, health, gdpr, legacy] = await Promise.all([
    getSettingsRow(), getSystemHealth(), listGdprRequests(page, PAGE_SIZE), findLegacyScriptTags(admin),
  ]);
  return json({
    programEnabled: settings.program_enabled !== false,
    // Booleans and the "from" address only. No credential ever reaches the browser.
    notifications: notificationStatus(settings),
    health, gdpr, page,
    // The v2 storefront script tag, if Shopify still has one (never throws).
    legacyScript: "tags" in legacy ? { found: legacy.tags.length, noScope: false } : { found: 0, noScope: legacy.reason === "no_scope" },
  });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin } = await authenticate.admin(request);
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  try {
    if (intent === "set_program") {
      const enabled = form.get("enabled") === "true";
      await updateSettings({ program_enabled: enabled });
      const { warning } = await publishSettings(admin);
      return json({ ok: true as const, message: enabled ? "Redeeming allowed again" : "Redeeming paused", warning });
    }
    if (intent === "set_whatsapp") {
      const enabled = form.get("enabled") === "true";
      await updateSettings({ whatsapp_enabled: enabled });
      const { warning } = await publishSettings(admin);
      return json({ ok: true as const, message: enabled ? "WhatsApp messages switched on" : "WhatsApp messages switched off", warning });
    }
    if (intent === "remove_legacy_script") {
      const res = await removeLegacyScriptTags(admin);
      if (res.reason === "no_scope") return json({ ok: false as const, error: NO_SCRIPT_SCOPE_TEXT }, { status: 403 });
      if (res.reason) return json({ ok: false as const, error: `${fmtInt(res.removed)} removed; ${fmtInt(res.found)} could not be removed. Try again.` }, { status: 502 });
      return json({ ok: true as const, message: res.removed > 0 ? "Old storefront script removed" : "No old storefront script was found" });
    }
    if (intent === "gdpr_status") {
      const id = String(form.get("id") ?? "");
      if (!UUID_RE.test(id)) return json({ ok: false as const, error: "That request could not be found." }, { status: 404 });
      const fulfilled = form.get("status") === "fulfilled";
      await setGdprRequestStatus(id, fulfilled ? "fulfilled" : "open");
      return json({ ok: true as const, message: fulfilled ? "Marked as answered" : "Reopened" });
    }
    return json({ ok: false as const, error: "Unknown action." }, { status: 400 });
  } catch (e) {
    return json({ ok: false as const, error: errorMessage(e) }, { status: 500 });
  }
};

const LEDGER_PERIODS = [
  { label: "Last 30 days", value: "30d" },
  { label: "Last 7 days", value: "7d" },
  { label: "This month", value: "month" },
  { label: "Last 90 days", value: "90d" },
  { label: "All time (first 100,000 rows)", value: "all" },
];

export default function Settings() {
  const d = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  useActionToast(fetcher.data);
  const busy = fetcher.state !== "idle";
  const [confirm, setConfirm] = useState<{ kind: "program_off" } | { kind: "gdpr"; id: string } | null>(null);
  const [ledgerPeriod, setLedgerPeriod] = useState("30d");
  const n = d.notifications;
  const h = d.health;
  const post = (fields: Record<string, string>) => fetcher.submit(fields, { method: "post" });

  return (
    <Page title="Settings">
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            <ResultBanner data={fetcher.data} />

            {d.legacyScript.found > 0 || d.legacyScript.noScope ? (
              <Card>
                <BlockStack gap="300">
                  <InlineStack align="space-between" blockAlign="center" gap="300">
                    <Text as="h2" variant="headingMd">Old storefront script</Text>
                    {d.legacyScript.found > 0 ? (
                      <Button loading={busy} onClick={() => post({ intent: "remove_legacy_script" })}>Remove old storefront script</Button>
                    ) : null}
                  </InlineStack>
                  <Text as="p" tone="subdued">
                    {d.legacyScript.found > 0
                      ? "An earlier version of this app added a script to every storefront page. It is no longer used and only slows pages down."
                      : NO_SCRIPT_SCOPE_TEXT}
                  </Text>
                </BlockStack>
              </Card>
            ) : null}

            <Card>
              <BlockStack gap="300">
                <InlineStack align="space-between" blockAlign="center">
                  <InlineStack gap="200" blockAlign="center">
                    <Text as="h2" variant="headingMd">Redeeming</Text>
                    {d.programEnabled ? <Badge tone="success">Allowed</Badge> : <Badge tone="warning">Paused</Badge>}
                  </InlineStack>
                  {d.programEnabled
                    ? <Button tone="critical" onClick={() => setConfirm({ kind: "program_off" })}>Pause redeeming</Button>
                    : <Button variant="primary" loading={busy} onClick={() => post({ intent: "set_program", enabled: "true" })}>Allow redeeming</Button>}
                </InlineStack>
                <Text as="p" tone="subdued">
                  {d.programEnabled
                    ? "Allow customers to redeem points. Pause it during a sale so reward codes are not used on top of sale prices; customers keep earning either way."
                    : "Customers cannot redeem points right now. They are still earning as normal."}
                </Text>
                <BlockStack gap="100">
                  <Text as="p" fontWeight="semibold">{d.programEnabled ? "If you pause redeeming:" : "While redeeming is paused:"}</Text>
                  <List type="bullet">
                    {PROGRAM_OFF_EFFECTS.map((t) => <List.Item key={t}>{t}</List.Item>)}
                  </List>
                </BlockStack>
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">Notifications</Text>
                <InlineStack align="space-between" blockAlign="center" gap="300">
                  <BlockStack gap="050">
                    <Text as="span" fontWeight="semibold">Email</Text>
                    <Text as="span" tone="subdued" variant="bodySm">
                      {n.emailConfigured
                        ? `Sending${n.emailFrom ? ` from ${n.emailFrom}` : ""}: welcome, points earned, reward code, tier upgrade, birthday, referral completed, points expiring and review released.`
                        : "Not set up, so no emails are sent. Your developer adds the mail server details (SMTP_HOST and related values) to the app's hosting settings."}
                    </Text>
                  </BlockStack>
                  {n.emailConfigured ? <Badge tone="success">Configured</Badge> : <Badge tone="attention">Not configured</Badge>}
                </InlineStack>
                <InlineStack align="space-between" blockAlign="center" gap="300">
                  <BlockStack gap="050">
                    <Text as="span" fontWeight="semibold">WhatsApp</Text>
                    <Text as="span" tone="subdued" variant="bodySm">
                      {!n.whatsappCredentialsPresent
                        ? "No WhatsApp account is connected. The switch has no effect until your developer adds WHATSAPP_TOKEN and WHATSAPP_PHONE_NUMBER_ID to the app's hosting settings."
                        : n.whatsappEnabled
                          ? "An account is connected and messages are being sent."
                          : "An account is connected. Messages are switched off."}
                    </Text>
                  </BlockStack>
                  <InlineStack gap="200" blockAlign="center">
                    {n.whatsappEnabled && n.whatsappCredentialsPresent ? <Badge tone="success">Sending</Badge>
                      : n.whatsappEnabled ? <Badge tone="attention">On, not connected</Badge> : <Badge>Off</Badge>}
                    <Button loading={busy} onClick={() => post({ intent: "set_whatsapp", enabled: String(!n.whatsappEnabled) })}>
                      {n.whatsappEnabled ? "Switch off" : "Switch on"}
                    </Button>
                  </InlineStack>
                </InlineStack>
                <Text as="p" tone="subdued" variant="bodySm">Passwords and tokens are kept on the server and are never shown here.</Text>
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">Data export</Text>
                <InlineStack align="space-between" blockAlign="center" gap="300">
                  <BlockStack gap="050">
                    <Text as="span" fontWeight="semibold">Customers</Text>
                    <Text as="span" tone="subdued" variant="bodySm">Every member with tier, balance and lifetime spend.</Text>
                  </BlockStack>
                  <Button onClick={() => downloadCsv("/app/customers/export.csv", "customers.csv")}>Download CSV</Button>
                </InlineStack>
                <InlineStack align="space-between" blockAlign="center" gap="300">
                  <BlockStack gap="050">
                    <Text as="span" fontWeight="semibold">Points ledger</Text>
                    <Text as="span" tone="subdued" variant="bodySm">Every points change, with the internal reason and the customer note.</Text>
                  </BlockStack>
                  <InlineStack gap="200" blockAlign="center">
                    <Select label="Period" labelHidden options={LEDGER_PERIODS} value={ledgerPeriod} onChange={setLedgerPeriod} />
                    <Button onClick={() => downloadCsv(`/app/campaigns/ledger.csv?period=${ledgerPeriod}`, "points-ledger.csv")}>Download CSV</Button>
                  </InlineStack>
                </InlineStack>
                <Text as="p" tone="subdued" variant="bodySm">
                  Text that begins with =, +, - or @ is exported with a leading apostrophe so a spreadsheet does not run it as a formula.
                  Influencer and analytics exports are on their own pages. To bring members over from Smile, open <Link url="/app/import">Import</Link>.
                </Text>
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="300">
                <InlineStack gap="200" blockAlign="center">
                  <Text as="h2" variant="headingMd">System health</Text>
                  <Badge tone={h.status === "healthy" ? "success" : h.status === "attention" ? "critical" : "attention"}>
                    {h.status === "healthy" ? "Healthy" : h.status === "attention" ? "Needs attention" : "Not reporting yet"}
                  </Badge>
                </InlineStack>
                <Text as="p">{h.summary}</Text>
                {h.status === "attention" ? (
                  <Banner tone="critical">
                    <p>Points for delivered orders may be delayed. Send this page to your developer; the worker process may have stopped or jobs are failing.</p>
                  </Banner>
                ) : null}
                <Text as="p" tone="subdued" variant="bodySm">
                  Failed background jobs: {h.failedJobs === null ? "could not be read (the job queue did not answer)" : fmtInt(h.failedJobs)}
                </Text>
                {h.heartbeats.length === 0 ? (
                  <Text as="p" tone="subdued">No signals recorded yet. They appear once the background worker has run.</Text>
                ) : (
                  <IndexTable
                    selectable={false} itemCount={h.heartbeats.length} condensed={false}
                    resourceName={{ singular: "signal", plural: "signals" }}
                    headings={[{ title: "Signal" }, { title: "Last seen" }, { title: "Detail" }]}
                  >
                    {h.heartbeats.map((b, i) => (
                      <IndexTable.Row id={b.key} key={b.key} position={i}>
                        <IndexTable.Cell>
                          <InlineStack gap="200" blockAlign="center">
                            <Text as="span">{b.key}</Text>
                            {b.kind === "alert" ? <Badge tone="critical">Alert</Badge> : b.stale ? <Badge tone="critical">Stale</Badge> : null}
                          </InlineStack>
                        </IndexTable.Cell>
                        <IndexTable.Cell>{fmtDateTime(b.at)}</IndexTable.Cell>
                        <IndexTable.Cell><Box maxWidth="360px"><Text as="span" breakWord>{b.detail}</Text></Box></IndexTable.Cell>
                      </IndexTable.Row>
                    ))}
                  </IndexTable>
                )}
              </BlockStack>
            </Card>

            <Card padding="0">
              <Box padding="400">
                <BlockStack gap="200">
                  <Text as="h2" variant="headingMd">Privacy requests</Text>
                  <Text as="p" tone="subdued">
                    Requests Shopify sends when a customer asks for her data or asks to be erased. A data request must be answered within 30 days.
                    A shop erasure request is only logged here; nothing is deleted automatically.
                  </Text>
                </BlockStack>
              </Box>
              {d.gdpr.rows.length === 0 ? (
                <Box padding="400" paddingBlockStart="0">
                  <Text as="p" tone="subdued">No requests have been received. There is nothing you need to do.</Text>
                </Box>
              ) : (
                <IndexTable
                  selectable={false} itemCount={d.gdpr.rows.length}
                  resourceName={{ singular: "request", plural: "requests" }}
                  headings={[{ title: "Received" }, { title: "Request" }, { title: "Shopify customer" }, { title: "Status" }, { title: "Action" }]}
                >
                  {d.gdpr.rows.map((r, i) => (
                    <IndexTable.Row id={r.id} key={r.id} position={i}>
                      <IndexTable.Cell>{fmtDateTime(r.createdAt)}</IndexTable.Cell>
                      <IndexTable.Cell>{r.typeLabel}</IndexTable.Cell>
                      <IndexTable.Cell>{r.shopifyCustomerId ?? ""}</IndexTable.Cell>
                      <IndexTable.Cell>{r.status === "open" ? <Badge tone="attention">Open</Badge> : <Badge tone="success">Answered</Badge>}</IndexTable.Cell>
                      <IndexTable.Cell>
                        {r.status === "open"
                          ? <Button size="slim" onClick={() => setConfirm({ kind: "gdpr", id: r.id })}>Mark as answered</Button>
                          : <Button size="slim" variant="plain" onClick={() => post({ intent: "gdpr_status", id: r.id, status: "open" })}>Reopen</Button>}
                      </IndexTable.Cell>
                    </IndexTable.Row>
                  ))}
                </IndexTable>
              )}
              <Box padding="300"><Pager page={d.page} pageSize={PAGE_SIZE} total={d.gdpr.total} /></Box>
            </Card>
          </BlockStack>
        </Layout.Section>
      </Layout>

      <ConfirmModal
        open={confirm !== null}
        loading={busy}
        destructive={confirm?.kind === "program_off"}
        title={confirm?.kind === "program_off" ? "Pause redeeming?" : "Mark this request as answered?"}
        confirmLabel={confirm?.kind === "program_off" ? "Pause redeeming" : "Mark as answered"}
        onClose={() => setConfirm(null)}
        onConfirm={() => {
          if (!confirm) return;
          if (confirm.kind === "program_off") post({ intent: "set_program", enabled: "false" });
          else post({ intent: "gdpr_status", id: confirm.id, status: "fulfilled" });
          setConfirm(null);
        }}
      >
        {confirm?.kind === "program_off" ? (
          <BlockStack gap="200">
            <Text as="p">This takes effect straight away:</Text>
            <List type="bullet">
              {PROGRAM_OFF_EFFECTS.map((t) => <List.Item key={t}>{t}</List.Item>)}
            </List>
          </BlockStack>
        ) : (
          <Text as="p">Only do this after you have sent the customer her data, or completed the erasure. This page records that it was handled.</Text>
        )}
      </ConfirmModal>
    </Page>
  );
}
