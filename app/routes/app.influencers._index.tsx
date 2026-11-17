// app/routes/app.influencers._index.tsx — Influencers list
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useFetcher, useLoaderData, useNavigate, useSearchParams } from "@remix-run/react";
import { useEffect, useState } from "react";
import {
  Badge, Banner, BlockStack, Box, Button, Card, IndexTable, InlineGrid, InlineStack, Layout, Link, Modal, Page,
  Select, Text, TextField,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import { EmptyBlock, ResultBanner, useActionToast } from "../components/admin-ui";
import { fmtInt, fmtPkr, parsePeriodKey, periodRange } from "../components/karachi";
import { downloadCsv } from "../lib/csv-download.client";
import { UUID_RE } from "../lib/admin-db.server";
import { listInfluencers, totalsOf } from "../lib/admin-influencers.server";
import { searchCustomers } from "../lib/admin-members.server";
import { getSettingsRow } from "../lib/admin-settings.server";
import { errorMessage, reasonText } from "../lib/admin-validate.server";
import { setInfluencer } from "../lib/influencer.service";

const PERIODS = [
  { label: "All time", value: "all" },
  { label: "Last 30 days", value: "30d" },
  { label: "Last 7 days", value: "7d" },
  { label: "This month", value: "month" },
  { label: "Last 90 days", value: "90d" },
];

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  const sp = new URL(request.url).searchParams;

  // Customer search for the "Add influencer" window.
  const find = sp.get("find");
  if (find !== null) {
    const q = find.trim().slice(0, 100);
    const candidates = q.length >= 2 ? (await searchCustomers({ query: q, influencer: false }, 8)).customers : [];
    return json({ kind: "candidates" as const, candidates });
  }

  const periodKey = sp.get("period") ?? "all";
  const period = periodKey === "all" ? null : periodRange(parsePeriodKey(periodKey, true));
  const campaign = (sp.get("campaign") ?? "").slice(0, 80);
  const settings = await getSettingsRow();
  const standardPoints = Number(settings.referral_points ?? 6000);
  const { rows, campaigns, capped } = await listInfluencers({
    campaign, from: period?.from ?? null, to: period?.to ?? null, standardPoints,
  });
  return json({
    kind: "list" as const, rows, campaigns, capped, totals: totalsOf(rows), standardPoints,
    campaign, periodKey: period ? period.key : "all", periodLabel: period ? period.label : "All time",
  });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  await authenticate.admin(request);
  const form = await request.formData();
  try {
    if (form.get("intent") === "add_influencer") {
      const memberId = String(form.get("member_id") ?? "");
      if (!UUID_RE.test(memberId)) return json({ ok: false as const, error: "Choose a customer first." }, { status: 400 });
      const res = await setInfluencer(memberId, { isInfluencer: true });
      if (!res.ok) return json({ ok: false as const, error: reasonText(res.reason, "She was not added.") }, { status: 400 });
      return json({ ok: true as const, message: "Influencer added. Set her rate and code next", memberId });
    }
    return json({ ok: false as const, error: "Unknown action." }, { status: 400 });
  } catch (e) {
    return json({ ok: false as const, error: errorMessage(e) }, { status: 500 });
  }
};

export default function Influencers() {
  const data = useLoaderData<typeof loader>();
  // The page itself only ever renders the list; "candidates" is fetched by the Add window.
  if (data.kind !== "list") return null;
  return <InfluencerList d={data} />;
}

type ListData = Extract<ReturnType<typeof useLoaderData<typeof loader>>, { kind: "list" }>;

function InfluencerList({ d }: { d: ListData }) {
  const [sp, setSp] = useSearchParams();
  const navigate = useNavigate();
  const fetcher = useFetcher<typeof action>();
  const finder = useFetcher<typeof loader>();
  useActionToast(fetcher.data);
  const [adding, setAdding] = useState(false);
  const [find, setFind] = useState("");
  const t = d.totals;

  useEffect(() => {
    const r = fetcher.data;
    if (r && r.ok === true && "memberId" in r) navigate(`/app/influencers/${r.memberId}`);
  }, [fetcher.data, navigate]);

  useEffect(() => {
    if (!adding) return;
    const q = find.trim();
    if (q.length < 2) return;
    const timer = setTimeout(() => finder.load(`/app/influencers?find=${encodeURIComponent(q)}`), 300);
    return () => clearTimeout(timer);
    // finder.load is stable for this purpose; re-running on its identity would loop
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [find, adding]);

  const setParam = (name: string, value: string, clearWhen: string) => {
    const next = new URLSearchParams(sp);
    if (value === clearWhen) next.delete(name); else next.set(name, value);
    setSp(next, { preventScrollReset: true });
  };
  const candidates = finder.data && finder.data.kind === "candidates" && find.trim().length >= 2 ? finder.data.candidates : [];
  const exportUrl = `/app/influencers/export.csv?${new URLSearchParams({ campaign: d.campaign, period: d.periodKey }).toString()}`;

  return (
    <Page
      title="Influencers"
      subtitle={`The standard referral reward is ${fmtInt(d.standardPoints)} points. Each influencer can have her own.`}
      primaryAction={{ content: "Add influencer", onAction: () => { setFind(""); setAdding(true); } }}
      secondaryActions={[{ content: "Export", disabled: d.rows.length === 0, onAction: () => downloadCsv(exportUrl, "influencers.csv") }]}
    >
      <Layout>
        <Layout.Section>
          <InlineStack gap="300" wrap>
            <Select
              label="Campaign" labelInline value={d.campaign}
              onChange={(v) => setParam("campaign", v, "")}
              options={[{ label: "All campaigns", value: "" }, ...d.campaigns.map((c) => ({ label: c, value: c })), { label: "No campaign", value: "none" }]}
            />
            <Select label="Results for" labelInline value={d.periodKey} onChange={(v) => setParam("period", v, "all")} options={PERIODS} />
          </InlineStack>
        </Layout.Section>
        <Layout.Section>
          <Text as="p" tone="subdued" variant="bodySm">
            {d.periodKey === "all"
              ? "All-time results."
              : `${d.periodLabel}: each number counts what happened in the period. Friends by the day they signed in, completed referrals by the day they completed, orders and sales by the day the order was placed, points by the day they were paid or taken back.`}{" "}
            Sales count her link and her code; an order that completed a link referral counts for that link only, whichever code was used. Cancelled orders are left out and points are net of reversals.
          </Text>
        </Layout.Section>
        <Layout.Section><ResultBanner data={fetcher.data} /></Layout.Section>
        {d.capped ? (
          <Layout.Section>
            <Banner tone="warning"><p>Only the first 1,000 influencers are listed and totalled here.</p></Banner>
          </Layout.Section>
        ) : null}
        <Layout.Section>
          <InlineGrid columns={{ xs: 2, md: 4 }} gap="400">
            <Tile label="Active influencers" value={fmtInt(t.active)} sub={`${fmtInt(t.paused)} paused`} />
            <Tile label="Friends referred" value={fmtInt(t.friends)} sub={`${fmtInt(t.completed)} with a delivered, paid order`} />
            <Tile label="Sales attributed" value={fmtPkr(t.salesPkr)} sub={`${fmtInt(t.orders)} orders by link or code · ${d.periodLabel}`} />
            <Tile label="Points paid to influencers" value={fmtInt(t.pointsPaid)} sub={t.completed > 0 ? `Average ${fmtInt(t.averagePerCompleted)} per completed referral` : "No completed referrals yet"} />
          </InlineGrid>
        </Layout.Section>
        <Layout.Section>
          <Card padding="0">
            {d.rows.length === 0 ? (
              <EmptyBlock
                heading={d.campaign ? "No influencers in this campaign" : "No influencers yet"}
                action={d.campaign ? { content: "Show all campaigns", onAction: () => setParam("campaign", "", "") } : { content: "Add influencer", onAction: () => setAdding(true) }}
              >
                <p>
                  {d.campaign
                    ? "Set an influencer's campaign on her page to group her here."
                    : "Pick an existing customer, then give her a multiplier on the referral reward and, if you like, her own discount code."}
                </p>
              </EmptyBlock>
            ) : (
              <IndexTable
                selectable={false} itemCount={d.rows.length}
                resourceName={{ singular: "influencer", plural: "influencers" }}
                headings={[
                  { title: "Influencer" }, { title: "Campaign" }, { title: "Multiplier" },
                  { title: "Points per referral", alignment: "end" }, { title: "Discount code" },
                  { title: "Friends", alignment: "end" }, { title: "Completed", alignment: "end" },
                  { title: "Orders", alignment: "end" }, { title: "Sales", alignment: "end" },
                  { title: "Points paid", alignment: "end" }, { title: "Status" },
                ]}
              >
                {d.rows.map((r, i) => (
                  <IndexTable.Row id={r.id} key={r.id} position={i} onClick={() => navigate(`/app/influencers/${r.id}`)}>
                    <IndexTable.Cell>
                      <Link url={`/app/influencers/${r.id}`} dataPrimaryLink><Text as="span" fontWeight="semibold">{r.name}</Text></Link>
                    </IndexTable.Cell>
                    <IndexTable.Cell>{r.campaign ?? "None"}</IndexTable.Cell>
                    <IndexTable.Cell>{r.multiplier ? `${r.multiplier}×` : "Standard"}</IndexTable.Cell>
                    <IndexTable.Cell><Text as="span" alignment="end">{fmtInt(r.pointsPerReferral)}</Text></IndexTable.Cell>
                    <IndexTable.Cell>{r.code ? `${r.code} (${r.codePercent}% off)` : "None"}</IndexTable.Cell>
                    <IndexTable.Cell><Text as="span" alignment="end">{fmtInt(r.friends)}</Text></IndexTable.Cell>
                    <IndexTable.Cell><Text as="span" alignment="end">{fmtInt(r.completed)}</Text></IndexTable.Cell>
                    <IndexTable.Cell><Text as="span" alignment="end">{fmtInt(r.orders)}</Text></IndexTable.Cell>
                    <IndexTable.Cell><Text as="span" alignment="end">{fmtPkr(r.salesPkr)}</Text></IndexTable.Cell>
                    <IndexTable.Cell><Text as="span" alignment="end">{fmtInt(r.pointsPaid)}</Text></IndexTable.Cell>
                    <IndexTable.Cell>{r.paused ? <Badge tone="warning">Paused</Badge> : <Badge tone="success">Active</Badge>}</IndexTable.Cell>
                  </IndexTable.Row>
                ))}
              </IndexTable>
            )}
          </Card>
        </Layout.Section>
      </Layout>

      <Modal open={adding} onClose={() => setAdding(false)} title="Add influencer"
        secondaryActions={[{ content: "Close", onAction: () => setAdding(false) }]}>
        <Modal.Section>
          <BlockStack gap="300">
            <TextField
              label="Find an existing customer" autoComplete="off" placeholder="Name, email or phone"
              value={find} onChange={setFind} autoFocus
              helpText="She must already be in the program. If she is not, ask her to sign in on the store once."
            />
            {find.trim().length >= 2 && finder.state === "idle" && candidates.length === 0 ? (
              <Text as="p" tone="subdued">No customer matches who is not already an influencer.</Text>
            ) : null}
            {candidates.map((c) => (
              <Box key={c.id} paddingBlock="100">
                <InlineStack align="space-between" blockAlign="center" gap="300">
                  <BlockStack gap="050">
                    <Text as="span" fontWeight="semibold">{c.name}</Text>
                    <Text as="span" tone="subdued" variant="bodySm">{[c.email, c.phone].filter(Boolean).join(" · ")}</Text>
                  </BlockStack>
                  <Button loading={fetcher.state !== "idle"}
                    onClick={() => fetcher.submit({ intent: "add_influencer", member_id: c.id }, { method: "post" })}>
                    Add
                  </Button>
                </InlineStack>
              </Box>
            ))}
          </BlockStack>
        </Modal.Section>
      </Modal>
    </Page>
  );
}

function Tile({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <Card>
      <BlockStack gap="100">
        <Text as="p" tone="subdued" variant="bodySm">{label}</Text>
        <Text as="p" variant="headingLg">{value}</Text>
        <Text as="p" tone="subdued" variant="bodySm">{sub}</Text>
      </BlockStack>
    </Card>
  );
}
