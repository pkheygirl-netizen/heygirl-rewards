// app/routes/app.referrals.tsx — Referral review queue
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useFetcher, useLoaderData, useSearchParams } from "@remix-run/react";
import { useState } from "react";
import {
  Badge, BlockStack, Box, Button, Card, IndexTable, InlineGrid, InlineStack, Layout, Link, Modal, Page, Tabs,
  Text, TextField,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import { ConfirmModal, EmptyBlock, Pager, ResultBanner, useActionToast } from "../components/admin-ui";
import { REFERRAL_STATUS_LABELS, REJECT_NOTE_MAX } from "../components/admin-constants";
import { fmtDate, fmtInt } from "../components/karachi";
import { actorFromSession } from "../lib/admin-members.server";
import {
  approve, blockReferrer, dismissReferralAlert, listReferrals, parseOrderCheckFilter, parseReferralStatus, referralSummary, reject,
} from "../lib/admin-referrals.server";
import { UUID_RE } from "../lib/admin-db.server";
import { errorMessage } from "../lib/admin-validate.server";

const PAGE_SIZE = 25;
const TABS = ["flagged", "pending", "completed", "rejected", "blocked", "all"] as const;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  const sp = new URL(request.url).searchParams;
  // The queue opens on what needs a decision.
  // ?referral=<id>: one referral, opened from a Home alert.
  const one = sp.get("referral");
  const referralId = one && UUID_RE.test(one) ? one : null;
  // ?check=not_checked: orders not compared with the referrer (from Home).
  const orderCheck = referralId ? null : parseOrderCheckFilter(sp.get("check"));
  const raw = sp.get("status");
  const status = referralId || orderCheck || raw === "all" ? null : parseReferralStatus(raw) ?? "flagged";
  const pageRaw = Number(sp.get("page") ?? "0");
  const page = Number.isInteger(pageRaw) && pageRaw > 0 ? pageRaw : 0;
  const [list, summary] = await Promise.all([
    listReferrals({ status, page, pageSize: PAGE_SIZE, referralId, orderCheck }),
    referralSummary(),
  ]);
  return json({ ...list, summary, status: status ?? "all", page, referralId, orderCheck });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  const id = String(form.get("referral_id") ?? "");
  const actor = actorFromSession(session);
  try {
    if (intent === "approve") {
      const res = await approve(id, actor, session.shop);
      return json(res, { status: res.ok ? 200 : 409 });
    }
    if (intent === "reject") {
      const res = await reject(id, actor, String(form.get("note") ?? ""));
      return json(res, { status: res.ok ? 200 : 409 });
    }
    if (intent === "block_referrer") {
      const res = await blockReferrer(id, actor);
      return json(res, { status: res.ok ? 200 : 409 });
    }
    if (intent === "dismiss_referral_alert") {
      const res = await dismissReferralAlert(id);
      return json(res, { status: res.ok ? 200 : 409 });
    }
    return json({ ok: false as const, error: "Unknown action." }, { status: 400 });
  } catch (e) {
    return json({ ok: false as const, error: errorMessage(e) }, { status: 500 });
  }
};

function tone(status: string): "success" | "attention" | "critical" | "info" | undefined {
  return status === "completed" ? "success" : status === "flagged" ? "attention"
    : status === "rejected" || status === "blocked" ? "critical" : "info";
}

export default function Referrals() {
  const d = useLoaderData<typeof loader>();
  const [sp, setSp] = useSearchParams();
  const fetcher = useFetcher<typeof action>();
  useActionToast(fetcher.data);
  const busy = fetcher.state !== "idle";
  const [approving, setApproving] = useState<{ id: string; referrer: string; friend: string } | null>(null);
  const [rejecting, setRejecting] = useState<{ id: string; referrer: string; friend: string } | null>(null);
  const [blocking, setBlocking] = useState<{ id: string; referrer: string } | null>(null);
  const [note, setNote] = useState("");
  const selected = Math.max(0, TABS.indexOf(d.status as (typeof TABS)[number]));
  const s = d.summary;

  const setStatus = (status: string) => {
    const next = new URLSearchParams(sp);
    next.set("status", status);
    next.delete("page");
    next.delete("referral");
    next.delete("check");
    setSp(next, { preventScrollReset: true });
  };

  return (
    <Page title="Referrals" subtitle="Approve or reject referrals that were held for review">
      <Layout>
        <Layout.Section>
          <InlineGrid columns={{ xs: 2, md: 4 }} gap="400">
            <Summary label="Held for review" value={s.flagged} />
            <Summary label="Waiting for first order" value={s.pending} />
            <Summary label="Completed" value={s.completed} />
            <Summary label="Points paid to referrers" value={s.pointsPaid} />
          </InlineGrid>
        </Layout.Section>
        <Layout.Section><ResultBanner data={fetcher.data} /></Layout.Section>
        {d.referralId ? (
          <Layout.Section>
            <InlineStack align="space-between" blockAlign="center">
              <Text as="p" tone="subdued">Showing the referral from the Home alert.</Text>
              <Button variant="plain" onClick={() => setStatus("all")}>Show all referrals</Button>
            </InlineStack>
          </Layout.Section>
        ) : null}
        {d.orderCheck === "not_checked" ? (
          <Layout.Section>
            <InlineStack align="space-between" blockAlign="center">
              <Text as="p" tone="subdued">Showing referrals whose order was not checked against the referrer's phone and address. Dismiss each one once you have looked at it.</Text>
              <Button variant="plain" onClick={() => setStatus("all")}>Show all referrals</Button>
            </InlineStack>
          </Layout.Section>
        ) : null}
        <Layout.Section>
          <Card padding="0">
            <Tabs
              tabs={TABS.map((t) => ({
                id: t,
                content: t === "all" ? "All" : t === "flagged" ? `Held for review (${fmtInt(s.flagged)})` : REFERRAL_STATUS_LABELS[t],
              }))}
              selected={selected}
              onSelect={(i) => setStatus(TABS[i])}
            />
            {d.rows.length === 0 ? (
              d.status === "flagged" ? (
                <EmptyBlock heading="Nothing is held for review" action={{ content: "See all referrals", onAction: () => setStatus("all") }}>
                  <p>A referral is held when the friend's email looks like the referrer's, she has the same full name, or her order delivers to the referrer's address. Held referrals appear here for you to approve or reject.</p>
                </EmptyBlock>
              ) : (
                <EmptyBlock heading="No referrals here yet" action={{ content: "Check the referral reward", url: "/app/program" }}>
                  <p>Referrals appear when a friend opens a customer's link and signs in. Each customer's link is on her profile.</p>
                </EmptyBlock>
              )
            ) : (
              <IndexTable
                selectable={false} itemCount={d.rows.length}
                resourceName={{ singular: "referral", plural: "referrals" }}
                headings={[
                  { title: "Referrer" }, { title: "Friend" }, { title: "Status" }, { title: "Reason" },
                  { title: "Date" }, { title: "Points", alignment: "end" }, { title: "Action" },
                ]}
              >
                {d.rows.map((r, i) => (
                  <IndexTable.Row id={r.id} key={r.id} position={i}>
                    <IndexTable.Cell>
                      <InlineStack gap="100" blockAlign="center">
                        <Link url={`/app/customers/${r.referrerId}`}>{r.referrerName}</Link>
                        {r.referrerIsInfluencer ? <Badge tone="info">Influencer</Badge> : null}
                      </InlineStack>
                    </IndexTable.Cell>
                    <IndexTable.Cell>{r.friend}</IndexTable.Cell>
                    <IndexTable.Cell><Badge tone={tone(r.status)}>{r.statusLabel}</Badge></IndexTable.Cell>
                    <IndexTable.Cell>
                      <Box maxWidth="320px">
                        <BlockStack gap="050">
                          <Text as="span" breakWord>{r.reason || r.reviewedNote || ""}</Text>
                          {r.orderCheckNote ? <Text as="span" tone="subdued" variant="bodySm" breakWord>{r.orderCheckNote}</Text> : null}
                          {r.referrerReferralsBlocked ? <Text as="span" tone="subdued" variant="bodySm">Referrer's referrals are blocked</Text> : null}
                        </BlockStack>
                      </Box>
                    </IndexTable.Cell>
                    <IndexTable.Cell>{fmtDate(r.createdAt)}</IndexTable.Cell>
                    <IndexTable.Cell>
                      <Text as="span" alignment="end">{r.rewardPoints !== null && r.status === "completed" ? fmtInt(r.rewardPoints) : ""}</Text>
                    </IndexTable.Cell>
                    <IndexTable.Cell>
                      <InlineStack gap="200" wrap={false}>
                        {r.status === "flagged" ? (
                          <>
                            <Button size="slim" onClick={() => setApproving({ id: r.id, referrer: r.referrerName, friend: r.friend })}>Approve</Button>
                            <Button size="slim" tone="critical" onClick={() => { setNote(""); setRejecting({ id: r.id, referrer: r.referrerName, friend: r.friend }); }}>Reject</Button>
                          </>
                        ) : null}
                        {(r.status === "flagged" || r.status === "blocked" || r.alertOpen) && !r.referrerReferralsBlocked ? (
                          <Button size="slim" tone="critical" variant="plain" onClick={() => setBlocking({ id: r.id, referrer: r.referrerName })}>Block this referrer</Button>
                        ) : null}
                        {r.alertOpen ? (
                          <Button size="slim" variant="plain" onClick={() => fetcher.submit({ intent: "dismiss_referral_alert", referral_id: r.id }, { method: "post" })}>Dismiss alert</Button>
                        ) : null}
                      </InlineStack>
                    </IndexTable.Cell>
                  </IndexTable.Row>
                ))}
              </IndexTable>
            )}
            <Box padding="300"><Pager page={d.page} pageSize={PAGE_SIZE} total={d.total} /></Box>
          </Card>
        </Layout.Section>
      </Layout>

      <ConfirmModal
        open={blocking !== null}
        title="Block this referrer?"
        confirmLabel="Block referrer"
        loading={busy}
        onClose={() => setBlocking(null)}
        onConfirm={() => {
          if (!blocking) return;
          fetcher.submit({ intent: "block_referrer", referral_id: blocking.id }, { method: "post" });
          setBlocking(null);
        }}
      >
        <Text as="p">
          {blocking?.referrer}'s referral link will stop earning, and no referral of hers that is still waiting will be paid. You can allow her referrals again from her profile.
        </Text>
      </ConfirmModal>

      <ConfirmModal
        open={approving !== null}
        title="Approve this referral?"
        confirmLabel="Approve"
        destructive={false}
        loading={busy}
        onClose={() => setApproving(null)}
        onConfirm={() => {
          if (!approving) return;
          fetcher.submit({ intent: "approve", referral_id: approving.id }, { method: "post" });
          setApproving(null);
        }}
      >
        <Text as="p">
          {approving?.referrer} is paid when {approving?.friend}'s first order is delivered and paid. If that has already happened, the points are paid now.
        </Text>
      </ConfirmModal>

      <Modal
        open={rejecting !== null}
        onClose={() => setRejecting(null)}
        title="Reject this referral?"
        primaryAction={{
          content: "Reject referral", destructive: true, loading: busy,
          onAction: () => {
            if (!rejecting) return;
            fetcher.submit({ intent: "reject", referral_id: rejecting.id, note }, { method: "post" });
            setRejecting(null);
          },
        }}
        secondaryActions={[{ content: "Cancel", onAction: () => setRejecting(null) }]}
      >
        <Modal.Section>
          <BlockStack gap="300">
            <Text as="p">
              {rejecting?.referrer} will not be paid for referring {rejecting?.friend}. This cannot be undone from here.
            </Text>
            <TextField
              label="Note for your records, optional" autoComplete="off" value={note} onChange={setNote}
              maxLength={REJECT_NOTE_MAX} showCharacterCount
            />
          </BlockStack>
        </Modal.Section>
      </Modal>
    </Page>
  );
}

function Summary({ label, value }: { label: string; value: number }) {
  return (
    <Card>
      <BlockStack gap="100">
        <Text as="p" tone="subdued" variant="bodySm">{label}</Text>
        <Text as="p" variant="headingLg">{fmtInt(value)}</Text>
      </BlockStack>
    </Card>
  );
}
