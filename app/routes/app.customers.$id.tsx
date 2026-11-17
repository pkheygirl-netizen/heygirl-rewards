// app/routes/app.customers.$id.tsx — Customer profile (full page)
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useFetcher, useLoaderData, useSearchParams } from "@remix-run/react";
import { useEffect, useState } from "react";
import {
  Badge, Banner, BlockStack, Box, Button, ButtonGroup, Card, ChoiceList, Divider, FormLayout, IndexTable,
  InlineGrid, InlineStack, Layout, Link, Modal, Page, ProgressBar, Select, Text, TextField,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import {
  ConfirmModal, CopyButton, Pager, ResultBanner, TierBadge, fieldError, newIdempotencyKey, useActionToast,
} from "../components/admin-ui";
import { MONTH_NAMES, fmtDate, fmtDateTime, fmtInt, fmtPkr, fmtSigned, tierLabel } from "../components/karachi";
import { getActivity, parseActivityFilter } from "../lib/admin-data.server";
import {
  actorFromSession, addStaffNote, adjustBalance, codeBelongsTo, deleteStaffNote,
  getCustomerProfile, listRewardCodes, listStaffNotes, parseAdjustment, parseBirthday,
  referralLink, setBlocked, shopifyCustomerUrl, tierProgress,
} from "../lib/admin-members.server";
import { ADJUST_LIMITS, NOTE_MAX, previewBalance } from "../components/admin-constants";
import { getSettingsRow } from "../lib/admin-settings.server";
import { errorMessage, invalid, reasonText } from "../lib/admin-validate.server";
import { UUID_RE } from "../lib/admin-db.server";
import { setBirthday, setOptOut } from "../lib/points.service";
import { cancelRewardCode } from "../lib/redemption.service";
import { setInfluencer } from "../lib/influencer.service";

const ACTIVITY_PAGE = 20;

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const id = params.id ?? "";
  const profile = await getCustomerProfile(id);
  if (!profile) throw new Response("Customer not found", { status: 404 });

  const sp = new URL(request.url).searchParams;
  const filter = parseActivityFilter(sp.get("activity"));
  const pageRaw = Number(sp.get("apage") ?? "0");
  const activityPage = Number.isInteger(pageRaw) && pageRaw > 0 ? pageRaw : 0;

  const [codes, notes, activity, settings] = await Promise.all([
    listRewardCodes(id),
    listStaffNotes(id),
    getActivity({ filter, memberId: id, page: activityPage, pageSize: ACTIVITY_PAGE }),
    getSettingsRow(),
  ]);
  const thresholds = {
    gold: Number(settings.tier_gold_threshold_pkr ?? 50000),
    diamond: Number(settings.tier_diamond_threshold_pkr ?? 100000),
  };
  return json({
    profile, codes, notes, activity, filter, activityPage,
    progress: tierProgress(profile.lifetimeSpendPkr, profile.tier, thresholds),
    expiryDays: Number(settings.silver_expiry_days ?? 365),
    referralUrl: referralLink(profile.referralSlug, session.shop),
    shopifyUrl: shopifyCustomerUrl(session.shop, profile.shopifyNumericId),
  });
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const id = params.id ?? "";
  if (!UUID_RE.test(id)) return json({ ok: false as const, error: "Customer not found.", intent: "" }, { status: 404 });
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  const actor = actorFromSession(session);
  const fail = (error: string, status = 400) => json({ ok: false as const, error, intent }, { status });
  const done = (message: string) => json({ ok: true as const, message, intent });

  try {
    switch (intent) {
      case "adjust": {
        const parsed = parseAdjustment(form);
        if (!parsed.ok) return json({ ...invalid(parsed.errors), intent }, { status: 400 });
        const res = await adjustBalance(id, parsed.value);
        if (!res.applied) return done("This adjustment was already applied. The balance was not changed again");
        return done(`Balance adjusted. New balance ${fmtInt(res.newBalance)} points`);
      }
      case "cancel_code": {
        const codeId = String(form.get("code_id") ?? "");
        if (!(await codeBelongsTo(codeId, id))) return fail("That code does not belong to this customer.", 404);
        const res = await cancelRewardCode({ codeId, shop: session.shop, actor });
        if (!res.ok) return fail(reasonText(res.reason, "The code was not cancelled."), 409);
        return done(`Code cancelled and ${fmtInt(res.pointsReturned)} points returned`);
      }
      case "birthday": {
        const parsed = parseBirthday(form);
        if (!parsed.ok) return json({ ...invalid(parsed.errors), intent }, { status: 400 });
        const res = await setBirthday(id, parsed.month, parsed.day, { byAdmin: true });
        if (!res.ok) return fail(reasonText(res.reason, "The birthday was not saved."));
        return done("Birthday saved");
      }
      case "block":
      case "unblock":
        await setBlocked(id, intent === "block");
        return done(intent === "block" ? "Customer blocked" : "Customer unblocked");
      case "opt_out":
      case "opt_in":
        await setOptOut(id, intent === "opt_out");
        return done(intent === "opt_out" ? "Customer opted out of the program" : "Customer is taking part again");
      case "influencer_on":
      case "influencer_off": {
        const res = await setInfluencer(id, { isInfluencer: intent === "influencer_on" });
        if (!res.ok) return fail(reasonText(res.reason, "The change was not saved."));
        return done(intent === "influencer_on" ? "Marked as an influencer" : "No longer an influencer");
      }
      case "influencer_pause":
      case "influencer_resume": {
        const res = await setInfluencer(id, { isInfluencer: true, paused: intent === "influencer_pause" });
        if (!res.ok) return fail(reasonText(res.reason, "The change was not saved."));
        return done(intent === "influencer_pause" ? "Influencer rate paused" : "Influencer rate resumed");
      }
      case "add_note":
        await addStaffNote(id, String(form.get("note") ?? ""), actor);
        return done("Note saved");
      case "delete_note": {
        const noteId = String(form.get("note_id") ?? "");
        if (!UUID_RE.test(noteId)) return fail("That note could not be found.", 404);
        await deleteStaffNote(id, noteId);
        return done("Note deleted");
      }
      default:
        return fail("Unknown action.");
    }
  } catch (e) {
    return fail(errorMessage(e), 500);
  }
};

const JOINED: Record<string, string> = {
  order: "Joined by placing an order",
  signin: "Joined by signing in",
  import: "Brought over from Smile",
  admin: "Added by staff",
};

const FILTERS = [
  { label: "Everything", value: "all" },
  { label: "Earned", value: "earned" },
  { label: "Redeemed", value: "redeemed" },
  { label: "Referrals", value: "referrals" },
  { label: "Adjustments", value: "adjustments" },
];

type Confirm =
  | { kind: "cancel_code"; codeId: string; code: string; points: number }
  | { kind: "block" } | { kind: "opt_out" } | { kind: "influencer_off" }
  | { kind: "delete_note"; noteId: string };

export default function CustomerProfilePage() {
  const d = useLoaderData<typeof loader>();
  const p = d.profile;
  const [sp, setSp] = useSearchParams();
  const fetcher = useFetcher<typeof action>();
  useActionToast(fetcher.data);
  const busy = fetcher.state !== "idle";
  const result = fetcher.data;

  const [adjustOpen, setAdjustOpen] = useState(false);
  const [direction, setDirection] = useState<"add" | "remove">("add");
  const [points, setPoints] = useState("");
  const [reason, setReason] = useState("");
  const [customerNote, setCustomerNote] = useState("");
  const [idemKey, setIdemKey] = useState("");
  const [birthdayOpen, setBirthdayOpen] = useState(false);
  const [bMonth, setBMonth] = useState(String(p.birthdayMonth ?? 1));
  const [bDay, setBDay] = useState(String(p.birthdayDay ?? 1));
  const [note, setNote] = useState("");
  const [confirm, setConfirm] = useState<Confirm | null>(null);

  // Close forms and clear them once the server says the change was applied.
  useEffect(() => {
    if (!result || result.ok !== true) return;
    if (result.intent === "adjust") {
      setAdjustOpen(false); setPoints(""); setReason(""); setCustomerNote("");
    }
    if (result.intent === "birthday") setBirthdayOpen(false);
    if (result.intent === "add_note") setNote("");
  }, [result]);

  const openAdjust = () => {
    // One key per opening of the form: pressing Save twice sends the same key,
    // and the server applies it once.
    setIdemKey(newIdempotencyKey());
    setAdjustOpen(true);
  };
  const post = (fields: Record<string, string>) => fetcher.submit(fields, { method: "post" });
  const pointsNum = /^\d+$/.test(points.trim()) ? Number(points.trim()) : 0;
  const newBalance = previewBalance(p.pointsBalance, direction, pointsNum);
  const floorHit = direction === "remove" && pointsNum > p.pointsBalance;
  const adjustErr = result && result.ok === false && result.intent === "adjust" ? result : null;

  const setActivityParam = (changes: Record<string, string | null>) => {
    const next = new URLSearchParams(sp);
    for (const [k, v] of Object.entries(changes)) { if (v === null) next.delete(k); else next.set(k, v); }
    setSp(next, { preventScrollReset: true });
  };

  const contact = [p.email, p.phone, `Member since ${fmtDate(p.enrolledAt)}`, p.consentSource ? JOINED[p.consentSource] : null]
    .filter(Boolean).join(" · ");

  return (
    <Page
      title={p.name}
      backAction={{ content: "Customers", url: "/app/customers" }}
      titleMetadata={
        <InlineStack gap="200">
          <TierBadge tier={p.tier} />
          {p.isBlocked ? <Badge tone="critical">Blocked</Badge> : p.optedOut ? <Badge tone="warning">Opted out</Badge> : <Badge tone="success">Active</Badge>}
          {p.influencer.isInfluencer ? <Badge tone="info">{p.influencer.paused ? "Influencer, paused" : "Influencer"}</Badge> : null}
        </InlineStack>
      }
      subtitle={contact}
      secondaryActions={d.shopifyUrl ? [{ content: "Open in Shopify", url: d.shopifyUrl, target: "_top" }] : []}
      actionGroups={[{
        title: "More actions",
        actions: [
          p.isBlocked
            ? { content: "Unblock customer", onAction: () => post({ intent: "unblock" }) }
            : { content: "Block customer", destructive: true, onAction: () => setConfirm({ kind: "block" }) },
          p.optedOut
            ? { content: "Opt back in", onAction: () => post({ intent: "opt_in" }) }
            : { content: "Opt out of the program", destructive: true, onAction: () => setConfirm({ kind: "opt_out" }) },
          p.influencer.isInfluencer
            ? { content: "Remove influencer status", destructive: true, onAction: () => setConfirm({ kind: "influencer_off" }) }
            : { content: "Make an influencer", onAction: () => post({ intent: "influencer_on" }) },
        ],
      }]}
    >
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            {result && !(result.ok === false && result.intent === "adjust" && adjustOpen) ? <ResultBanner data={result} /> : null}
            {p.isBlocked ? (
              <Banner tone="critical" title="This customer is blocked">
                <p>She cannot earn, redeem, or receive birthday and referral rewards until she is unblocked.</p>
              </Banner>
            ) : null}
            {p.optedOut ? (
              <Banner tone="warning" title="This customer has opted out">
                <p>She does not earn or redeem, and placing an order will not enrol her again.</p>
              </Banner>
            ) : null}
            {p.referralsBlocked ? (
              <Banner tone="warning" title="Referrals are blocked for this customer">
                <p>A friend she referred used her own email or phone number, so her link no longer earns.</p>
              </Banner>
            ) : null}

            <Card>
              <BlockStack gap="300">
                <InlineStack align="space-between" blockAlign="center">
                  <Text as="h2" variant="headingMd">Points</Text>
                  <Button onClick={openAdjust}>Adjust balance</Button>
                </InlineStack>
                <InlineGrid columns={2} gap="400">
                  <BlockStack gap="050">
                    <Text as="p" variant="heading2xl">{fmtInt(p.pointsBalance)}</Text>
                    <Text as="p" tone="subdued">Available</Text>
                  </BlockStack>
                  <BlockStack gap="050">
                    <Text as="p" variant="heading2xl" tone="subdued">{fmtInt(p.pendingPoints)}</Text>
                    <Text as="p" tone="subdued">Pending, released when her orders are delivered and paid</Text>
                  </BlockStack>
                </InlineGrid>
                <Text as="p" tone="subdued">
                  {p.tier === "silver"
                    ? p.nextExpiry
                      ? `Silver points expire ${d.expiryDays} days after they are earned. Next: ${fmtInt(p.nextExpiry.points)} points on ${fmtDate(p.nextExpiry.at)}.`
                      : `Silver points expire ${d.expiryDays} days after they are earned. Nothing is due to expire.`
                    : `${tierLabel(p.tier)} members' points do not expire.`}
                </Text>
              </BlockStack>
            </Card>

            <Card padding="0">
              <Box padding="400">
                <InlineStack align="space-between" blockAlign="center" gap="300" wrap>
                  <Text as="h2" variant="headingMd">Activity</Text>
                  <Box minWidth="180px">
                    <Select label="Show" labelInline options={FILTERS} value={d.filter}
                      onChange={(v) => setActivityParam({ activity: v === "all" ? null : v, apage: null })} />
                  </Box>
                </InlineStack>
              </Box>
              {d.activity.items.length === 0 ? (
                <Box padding="400">
                  <Text as="p" tone="subdued">
                    {d.filter === "all"
                      ? "Nothing yet. Her points, reward codes and tier changes will appear here. Use Adjust balance to add points by hand."
                      : "Nothing matches this filter. Choose Everything to see all of her activity."}
                  </Text>
                </Box>
              ) : (
                <IndexTable
                  selectable={false} itemCount={d.activity.items.length}
                  resourceName={{ singular: "entry", plural: "entries" }}
                  headings={[{ title: "When" }, { title: "What happened" }, { title: "Points", alignment: "end" }]}
                >
                  {d.activity.items.map((a, i) => (
                    <IndexTable.Row id={a.id} key={a.id} position={i}>
                      <IndexTable.Cell>{fmtDateTime(a.at)}</IndexTable.Cell>
                      <IndexTable.Cell>
                        <BlockStack gap="050">
                          <Text as="span">{a.title}</Text>
                          {a.detail ? <Text as="span" tone="subdued" variant="bodySm">{a.detail}</Text> : null}
                        </BlockStack>
                      </IndexTable.Cell>
                      <IndexTable.Cell>
                        <Text as="span" alignment="end" tone={a.pointsLabel ? "subdued" : a.points < 0 ? "critical" : "success"}>
                          {a.pointsLabel ?? fmtSigned(a.points)}
                        </Text>
                      </IndexTable.Cell>
                    </IndexTable.Row>
                  ))}
                </IndexTable>
              )}
              <Box padding="300">
                <Pager page={d.activityPage} pageSize={ACTIVITY_PAGE} param="apage" hasMore={d.activity.hasMore} />
              </Box>
            </Card>

            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">Reward codes</Text>
                {d.codes.length === 0 ? (
                  <Text as="p" tone="subdued">No codes yet. A code appears here when she redeems points or receives a birthday, tier or referral reward.</Text>
                ) : (
                  d.codes.map((c, i) => (
                    <BlockStack gap="300" key={c.id}>
                      {i > 0 ? <Divider /> : null}
                      <InlineStack align="space-between" blockAlign="center" gap="300" wrap>
                        <BlockStack gap="050">
                          <InlineStack gap="200" blockAlign="center">
                            <Text as="span" fontWeight="semibold">{c.code}</Text>
                            <Badge tone={c.status === "active" ? "success" : c.status === "cancelled" ? "critical" : undefined}>
                              {c.status === "active" ? "Unused" : c.status === "used" ? "Used" : c.status === "cancelled" ? "Cancelled" : c.status === "expired" ? "Expired" : c.status}
                            </Badge>
                            {c.kind !== "reward" ? <Badge>{c.kindLabel}</Badge> : null}
                          </InlineStack>
                          <Text as="span" tone="subdued" variant="bodySm">
                            {[
                              c.discountPkr > 0 ? `${fmtPkr(c.discountPkr)} off` : "Free shipping",
                              c.pointsSpent > 0 ? `${fmtInt(c.pointsSpent)} points` : null,
                              c.status === "used" && c.usedAt ? `used ${fmtDate(c.usedAt)}` : c.expiresAt ? `expires ${fmtDate(c.expiresAt)}` : null,
                            ].filter(Boolean).join(" · ")}
                          </Text>
                        </BlockStack>
                        {c.canCancel ? (
                          <Button tone="critical" variant="plain"
                            onClick={() => setConfirm({ kind: "cancel_code", codeId: c.id, code: c.code, points: c.pointsSpent })}>
                            Cancel and return points
                          </Button>
                        ) : null}
                      </InlineStack>
                    </BlockStack>
                  ))
                )}
              </BlockStack>
            </Card>
          </BlockStack>
        </Layout.Section>

        <Layout.Section variant="oneThird">
          <BlockStack gap="400">
            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">Tier</Text>
                <InlineStack align="space-between">
                  <Text as="span" tone="subdued">Lifetime spend</Text>
                  <Text as="span" fontWeight="semibold">{fmtPkr(p.lifetimeSpendPkr)}</Text>
                </InlineStack>
                <ProgressBar progress={d.progress.percent} size="small" />
                <Text as="p" tone="subdued">
                  {d.progress.nextTier
                    ? `${fmtPkr(d.progress.remainingPkr)} more to reach ${tierLabel(d.progress.nextTier)} (${fmtPkr(d.progress.nextThresholdPkr ?? 0)})`
                    : "Top tier reached. Tiers are never taken away."}
                </Text>
                <Link url="/app/program?tab=tiers">Change tier thresholds</Link>
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">Details</Text>
                <InlineStack align="space-between" blockAlign="center">
                  <BlockStack gap="050">
                    <Text as="span" tone="subdued">Birthday</Text>
                    <Text as="span">{p.birthdayMonth && p.birthdayDay ? `${p.birthdayDay} ${MONTH_NAMES[p.birthdayMonth - 1]}` : "Not set"}</Text>
                  </BlockStack>
                  <Button variant="plain" onClick={() => setBirthdayOpen(true)}>{p.birthdayMonth ? "Edit" : "Set"}</Button>
                </InlineStack>
                <Divider />
                <BlockStack gap="100">
                  <Text as="span" tone="subdued">Referral link</Text>
                  <Text as="span" breakWord>{d.referralUrl}</Text>
                  <InlineStack><CopyButton text={d.referralUrl} /></InlineStack>
                </BlockStack>
                <Divider />
                <BlockStack gap="050">
                  <Text as="span" tone="subdued">Friends referred</Text>
                  <Text as="span">
                    {fmtInt(p.referrals.completed)} completed, {fmtInt(p.referrals.pending)} pending
                    {p.referrals.held > 0 ? `, ${fmtInt(p.referrals.held)} held for review` : ""}
                  </Text>
                  {p.referrals.held > 0 ? <Link url="/app/referrals?status=flagged">Review held referrals</Link> : null}
                </BlockStack>
                <Divider />
                <BlockStack gap="100">
                  <Text as="span" tone="subdued">Influencer</Text>
                  {p.influencer.isInfluencer ? (
                    <>
                      <Text as="span">
                        {p.influencer.multiplier ? `${p.influencer.multiplier}× the standard referral reward` : "Standard referral reward"}
                        {p.influencer.campaign ? ` · ${p.influencer.campaign}` : ""}
                        {p.influencer.code ? ` · code ${p.influencer.code} (${p.influencer.codePercent}% off)` : ""}
                      </Text>
                      <InlineStack gap="200">
                        <Button url={`/app/influencers/${p.id}`}>Rate, code and results</Button>
                        <Button variant="plain" loading={busy}
                          onClick={() => post({ intent: p.influencer.paused ? "influencer_resume" : "influencer_pause" })}>
                          {p.influencer.paused ? "Resume" : "Pause"}
                        </Button>
                      </InlineStack>
                    </>
                  ) : (
                    <>
                      <Text as="span">Not an influencer</Text>
                      <InlineStack><Button onClick={() => post({ intent: "influencer_on" })} loading={busy}>Make an influencer</Button></InlineStack>
                    </>
                  )}
                </BlockStack>
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">Staff notes</Text>
                <TextField
                  label="Add a note, only your team sees it" multiline={3} autoComplete="off"
                  value={note} onChange={setNote} maxLength={NOTE_MAX} showCharacterCount
                />
                <InlineStack>
                  <Button disabled={!note.trim()} loading={busy} onClick={() => post({ intent: "add_note", note })}>Save note</Button>
                </InlineStack>
                {d.notes.length === 0 ? (
                  <Text as="p" tone="subdued">No notes yet.</Text>
                ) : (
                  d.notes.map((n) => (
                    <BlockStack gap="050" key={n.id}>
                      <Divider />
                      <Text as="p" breakWord>{n.note}</Text>
                      <InlineStack align="space-between">
                        <Text as="span" tone="subdued" variant="bodySm">{n.author ?? "Store staff"} · {fmtDateTime(n.createdAt)}</Text>
                        <Button variant="plain" tone="critical" onClick={() => setConfirm({ kind: "delete_note", noteId: n.id })}>Delete</Button>
                      </InlineStack>
                    </BlockStack>
                  ))
                )}
              </BlockStack>
            </Card>
          </BlockStack>
        </Layout.Section>
      </Layout>

      <Modal
        open={adjustOpen}
        onClose={() => setAdjustOpen(false)}
        title="Adjust balance"
        primaryAction={{
          content: "Save adjustment", loading: busy, disabled: pointsNum <= 0 || !reason.trim(),
          onAction: () => post({ intent: "adjust", direction, points: points.trim(), reason, customer_note: customerNote, idempotency_key: idemKey }),
        }}
        secondaryActions={[{ content: "Cancel", onAction: () => setAdjustOpen(false) }]}
      >
        <Modal.Section>
          <BlockStack gap="300">
            {adjustErr ? <Banner tone="critical"><p>{adjustErr.error}</p></Banner> : null}
            <FormLayout>
              <ChoiceList
                title="Add or remove"
                choices={[{ label: "Add points", value: "add" }, { label: "Remove points", value: "remove" }]}
                selected={[direction]} onChange={(v) => setDirection(v[0] === "remove" ? "remove" : "add")}
              />
              <TextField
                label="Points" type="number" inputMode="numeric" min={1} max={ADJUST_LIMITS.maxPoints} autoComplete="off"
                value={points} onChange={setPoints} error={fieldError(adjustErr, "points")}
              />
              <TextField
                label="Reason, for your records only" autoComplete="off" maxLength={ADJUST_LIMITS.reason}
                value={reason} onChange={setReason} error={fieldError(adjustErr, "reason")}
                helpText="Never shown to the customer."
              />
              <TextField
                label="Note the customer sees, optional" autoComplete="off" maxLength={ADJUST_LIMITS.customerNote} showCharacterCount
                value={customerNote} onChange={setCustomerNote} error={fieldError(adjustErr, "customer_note")}
                helpText="Shown beside this entry in her points history."
              />
            </FormLayout>
            <Text as="p">
              New balance will be <Text as="span" fontWeight="bold">{fmtInt(newBalance)}</Text>
            </Text>
            {floorHit ? (
              <Text as="p" tone="caution">
                She has {fmtInt(p.pointsBalance)} points. A balance cannot go below zero, so this removes all of them.
              </Text>
            ) : null}
          </BlockStack>
        </Modal.Section>
      </Modal>

      <Modal
        open={birthdayOpen}
        onClose={() => setBirthdayOpen(false)}
        title="Birthday"
        primaryAction={{ content: "Save birthday", loading: busy, onAction: () => post({ intent: "birthday", birthday_month: bMonth, birthday_day: bDay }) }}
        secondaryActions={[{ content: "Cancel", onAction: () => setBirthdayOpen(false) }]}
      >
        <Modal.Section>
          <BlockStack gap="300">
            {result && result.ok === false && result.intent === "birthday" ? <Banner tone="critical"><p>{result.error}</p></Banner> : null}
            <FormLayout>
              <FormLayout.Group>
                <Select label="Month" value={bMonth} onChange={setBMonth}
                  options={MONTH_NAMES.map((m, i) => ({ label: m, value: String(i + 1) }))} />
                <Select label="Day" value={bDay} onChange={setBDay}
                  options={Array.from({ length: 31 }, (_, i) => ({ label: String(i + 1), value: String(i + 1) }))} />
              </FormLayout.Group>
            </FormLayout>
            <Text as="p" tone="subdued">
              Customers can set their birthday once themselves. A birthday first set during its own month earns the reward from next year.
            </Text>
          </BlockStack>
        </Modal.Section>
      </Modal>

      <ConfirmModal
        open={confirm !== null}
        loading={busy}
        title={
          confirm?.kind === "cancel_code" ? "Cancel this code and return the points?"
            : confirm?.kind === "block" ? "Block this customer?"
            : confirm?.kind === "opt_out" ? "Opt this customer out?"
            : confirm?.kind === "influencer_off" ? "Remove influencer status?"
            : "Delete this note?"
        }
        confirmLabel={
          confirm?.kind === "cancel_code" ? "Cancel code and return points"
            : confirm?.kind === "block" ? "Block customer"
            : confirm?.kind === "opt_out" ? "Opt out"
            : confirm?.kind === "influencer_off" ? "Remove status"
            : "Delete note"
        }
        onClose={() => setConfirm(null)}
        onConfirm={() => {
          if (!confirm) return;
          if (confirm.kind === "cancel_code") post({ intent: "cancel_code", code_id: confirm.codeId });
          else if (confirm.kind === "delete_note") post({ intent: "delete_note", note_id: confirm.noteId });
          else post({ intent: confirm.kind });
          setConfirm(null);
        }}
      >
        <Text as="p">
          {confirm?.kind === "cancel_code"
            ? `${confirm.code} is switched off in Shopify first, then ${fmtInt(confirm.points)} points go back to her balance. The code cannot be used afterwards.`
            : confirm?.kind === "block"
              ? "She will stop earning and redeeming, and will not receive birthday or referral rewards. Her balance is kept."
              : confirm?.kind === "opt_out"
                ? "She will stop earning and redeeming, and new orders will not enrol her again. Her balance is kept."
                : confirm?.kind === "influencer_off"
                  ? "Her referrals go back to the standard reward. Remove her discount code on the influencer page first if she has one."
                  : "The note is removed for everyone on your team."}
        </Text>
      </ConfirmModal>
    </Page>
  );
}

