import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData, useSearchParams, useFetcher, Form } from "@remix-run/react";
import { useState } from "react";
import {
  Page,
  Card,
  IndexTable,
  TextField,
  Select,
  Badge,
  Modal,
  BlockStack,
  InlineStack,
  Text,
  Button,
  Banner,
  Box,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import {
  searchMembers,
  getMemberDetail,
  adjustPoints,
  setBlocked,
  setInfluencer,
  type Tier,
} from "../lib/admin-members.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  const url = new URL(request.url);
  const query = url.searchParams.get("q") ?? "";
  const tier = (url.searchParams.get("tier") as Tier | "") || undefined;
  const detailId = url.searchParams.get("detail");

  const { members, total } = await searchMembers({ query, tier });
  const detail = detailId ? await getMemberDetail(detailId) : null;
  return json({ members, total, query, tier: tier ?? "", detail });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  await authenticate.admin(request);
  const form = await request.formData();
  const intent = form.get("intent");
  const memberId = String(form.get("memberId"));

  try {
    if (intent === "adjust") {
      await adjustPoints({
        memberId,
        points: Number(form.get("points")),
        reason: String(form.get("reason") ?? ""),
      });
    } else if (intent === "block") {
      await setBlocked(memberId, form.get("blocked") === "true");
    } else if (intent === "influencer") {
      const isInfluencer = form.get("isInfluencer") === "true";
      const rateRaw = form.get("rate");
      await setInfluencer({
        memberId,
        isInfluencer,
        rate: rateRaw ? Number(rateRaw) : null,
      });
    }
    return json({ ok: true });
  } catch (e) {
    return json({ ok: false, error: (e as Error).message }, { status: 400 });
  }
};

function tierBadge(tier: string) {
  const tone = tier === "diamond" ? "info" : tier === "gold" ? "warning" : undefined;
  return <Badge tone={tone as any}>{tier}</Badge>;
}

export default function Members() {
  const { members, total, query, tier, detail } = useLoaderData<typeof loader>();
  const [params, setParams] = useSearchParams();
  const fetcher = useFetcher<{ ok: boolean; error?: string }>();
  const [reason, setReason] = useState("");
  const [points, setPoints] = useState("");

  const openDetail = (id: string) => {
    const next = new URLSearchParams(params);
    next.set("detail", id);
    setParams(next);
  };
  const closeDetail = () => {
    const next = new URLSearchParams(params);
    next.delete("detail");
    setParams(next);
  };

  return (
    <Page title="Members" subtitle={`${total} members`}>
      <Card>
        <Box padding="400">
          <Form method="get">
            <InlineStack gap="300" align="start">
              <TextField
                label="Search"
                labelHidden
                name="q"
                value={query}
                onChange={(v) => {
                  const next = new URLSearchParams(params);
                  if (v) next.set("q", v); else next.delete("q");
                  setParams(next);
                }}
                placeholder="Name or email"
                autoComplete="off"
              />
              <Select
                label="Tier"
                labelHidden
                name="tier"
                value={tier}
                options={[
                  { label: "All tiers", value: "" },
                  { label: "Silver", value: "silver" },
                  { label: "Gold", value: "gold" },
                  { label: "Diamond", value: "diamond" },
                ]}
                onChange={(v) => {
                  const next = new URLSearchParams(params);
                  if (v) next.set("tier", v); else next.delete("tier");
                  setParams(next);
                }}
              />
            </InlineStack>
          </Form>
        </Box>
        <IndexTable
          resourceName={{ singular: "member", plural: "members" }}
          itemCount={members.length}
          selectable={false}
          headings={[
            { title: "Name" },
            { title: "Email" },
            { title: "Tier" },
            { title: "Points" },
            { title: "Lifetime spend" },
            { title: "Status" },
          ]}
        >
          {members.map((m, i) => (
            <IndexTable.Row
              id={m.id}
              key={m.id}
              position={i}
              onClick={() => openDetail(m.id)}
            >
              <IndexTable.Cell>
                {[m.first_name, m.last_name].filter(Boolean).join(" ") || "—"}
              </IndexTable.Cell>
              <IndexTable.Cell>{m.email}</IndexTable.Cell>
              <IndexTable.Cell>{tierBadge(m.tier)}</IndexTable.Cell>
              <IndexTable.Cell>{m.points_balance.toLocaleString()}</IndexTable.Cell>
              <IndexTable.Cell>Rs.{Number(m.lifetime_spend_pkr).toLocaleString()}</IndexTable.Cell>
              <IndexTable.Cell>
                {m.is_blocked ? <Badge tone="critical">Blocked</Badge> : <Badge tone="success">Active</Badge>}
                {m.is_influencer ? <Badge tone="info">Influencer</Badge> : null}
              </IndexTable.Cell>
            </IndexTable.Row>
          ))}
        </IndexTable>
      </Card>

      {detail?.member ? (
        <Modal
          open
          onClose={closeDetail}
          title={`${[detail.member.first_name, detail.member.last_name].filter(Boolean).join(" ") || detail.member.email}`}
          size="large"
        >
          <Modal.Section>
            <BlockStack gap="400">
              {fetcher.data && !fetcher.data.ok ? (
                <Banner tone="critical">{fetcher.data.error}</Banner>
              ) : null}

              <InlineStack gap="400">
                <Text as="span">Tier: {tierBadge(detail.member.tier)}</Text>
                <Text as="span">Balance: {detail.member.points_balance.toLocaleString()} pts</Text>
                <Text as="span">Lifetime: Rs.{Number(detail.member.lifetime_spend_pkr).toLocaleString()}</Text>
                <Text as="span">Slug: {detail.member.referral_slug}</Text>
              </InlineStack>

              <Card>
                <Box padding="300">
                  <BlockStack gap="200">
                    <Text as="h3" variant="headingSm">Manual point adjustment</Text>
                    <fetcher.Form method="post">
                      <input type="hidden" name="intent" value="adjust" />
                      <input type="hidden" name="memberId" value={detail.member.id} />
                      <InlineStack gap="200" align="start">
                        <TextField
                          label="Points (+/-)"
                          name="points"
                          type="number"
                          value={points}
                          onChange={setPoints}
                          autoComplete="off"
                        />
                        <TextField
                          label="Reason (required)"
                          name="reason"
                          value={reason}
                          onChange={setReason}
                          autoComplete="off"
                        />
                      </InlineStack>
                      <Box paddingBlockStart="200">
                        <Button submit disabled={!reason.trim() || !points}>Apply adjustment</Button>
                      </Box>
                    </fetcher.Form>
                  </BlockStack>
                </Box>
              </Card>

              <InlineStack gap="200">
                <fetcher.Form method="post">
                  <input type="hidden" name="intent" value="block" />
                  <input type="hidden" name="memberId" value={detail.member.id} />
                  <input type="hidden" name="blocked" value={String(!detail.member.is_blocked)} />
                  <Button submit tone={detail.member.is_blocked ? undefined : "critical"}>
                    {detail.member.is_blocked ? "Unblock" : "Block"}
                  </Button>
                </fetcher.Form>
                <fetcher.Form method="post">
                  <input type="hidden" name="intent" value="influencer" />
                  <input type="hidden" name="memberId" value={detail.member.id} />
                  <input type="hidden" name="isInfluencer" value={String(!detail.member.is_influencer)} />
                  <Button submit>
                    {detail.member.is_influencer ? "Remove influencer tag" : "Tag as influencer"}
                  </Button>
                </fetcher.Form>
              </InlineStack>

              {detail.member.is_influencer ? (
                <fetcher.Form method="post">
                  <input type="hidden" name="intent" value="influencer" />
                  <input type="hidden" name="memberId" value={detail.member.id} />
                  <input type="hidden" name="isInfluencer" value="true" />
                  <InlineStack gap="200" align="start">
                    <TextField
                      label="Custom referral rate (pts)"
                      name="rate"
                      type="number"
                      autoComplete="off"
                      value={String(detail.member.influencer_referral_rate ?? "")}
                      onChange={() => {}}
                    />
                    <Button submit>Save rate</Button>
                  </InlineStack>
                </fetcher.Form>
              ) : null}

              <Card>
                <Box padding="300">
                  <BlockStack gap="200">
                    <Text as="h3" variant="headingSm">Recent activity</Text>
                    {detail.ledger.length === 0 ? (
                      <Text as="p" tone="subdued">No point activity yet.</Text>
                    ) : (
                      detail.ledger.map((l) => (
                        <Text as="p" key={l.id}>
                          {l.earned_at.slice(0, 10)} · {l.action_type} ·{" "}
                          {l.points > 0 ? "+" : ""}{l.points} → {l.balance_after}
                          {l.reason_note ? ` · ${l.reason_note}` : ""}
                        </Text>
                      ))
                    )}
                  </BlockStack>
                </Box>
              </Card>
            </BlockStack>
          </Modal.Section>
        </Modal>
      ) : null}
    </Page>
  );
}
