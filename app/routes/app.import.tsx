// app/routes/app.import.tsx — Bring members and points over from Smile.io
// Upload the Smile customer export → dry run → explicit confirmation → import
// in the worker with live progress → reconciliation and report download.
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json, unstable_createMemoryUploadHandler, unstable_parseMultipartFormData } from "@remix-run/node";
import { useFetcher, useLoaderData, useRevalidator } from "@remix-run/react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Badge, Banner, BlockStack, Box, Button, Card, Checkbox, DataTable, DropZone, InlineGrid, InlineStack, Layout,
  List, Modal, Page, ProgressBar, Text,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import { ConfirmModal, ResultBanner, useActionToast } from "../components/admin-ui";
import { fmtDateTime, fmtInt } from "../components/karachi";
import { actorFromSession } from "../lib/admin-members.server";
import { errorMessage } from "../lib/admin-validate.server";
import {
  LIMITS, SMILE_HEADER, buildReportCsv, confirmRun, createRun, discardRun, getLatestRun, getLaunchState,
  purgeExpiredRows, purgeRunRows, resumeRun, type ImportRun,
} from "../lib/smile-import.server";


function view(run: ImportRun | null) {
  if (!run) return null;
  const working = run.status === "planning" || run.status === "running";
  return {
    id: run.id, status: run.status, phase: run.phase, fileName: run.file_name, error: run.error,
    options: { tierFromSmile: run.options?.tierFromSmile === true },
    totals: run.totals ?? {},
    progress: { done: Number(run.progress?.done ?? 0), total: Number(run.progress?.total ?? 0) },
    rowsCleared: Boolean(run.rows_purged_at),
    createdAt: run.created_at, startedAt: run.started_at, finishedAt: run.finished_at, updatedAt: run.updated_at,
    stalled: working && Date.now() - new Date(run.updated_at).getTime() > LIMITS.stallMs,
  };
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  await purgeExpiredRows(); // retention: rows of imports closed more than 30 days ago
  return json({
    run: view(await getLatestRun()), launch: await getLaunchState(), header: SMILE_HEADER.join(","),
    maxMb: LIMITS.maxFileBytes / 1024 / 1024, retentionDays: LIMITS.retentionDays,
  });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const fail = (error: string, intent: string, status = 400) => json({ ok: false as const, error, intent }, { status });
  let intent = "";
  try {
    const multipart = (request.headers.get("content-type") ?? "").includes("multipart/form-data");
    const form = multipart
      ? await unstable_parseMultipartFormData(request, unstable_createMemoryUploadHandler({ maxPartSize: LIMITS.maxFileBytes }))
      : await request.formData();
    intent = String(form.get("intent") ?? "");
    const runId = String(form.get("run_id") ?? "");

    if (intent === "upload") {
      const file = form.get("file");
      if (!file || typeof file === "string" || file.size === 0) return fail("Choose the Smile customer export (a .csv file).", intent);
      const res = await createRun({
        source: file.stream() as unknown as AsyncIterable<Uint8Array>,
        fileName: file.name,
        actor: actorFromSession(session),
      });
      if (!res.ok) return fail(res.error, intent, 409);
      return json({ ok: true as const, intent, message: `File read: ${fmtInt(res.rows)} rows. Checking Shopify customers…` });
    }
    if (intent === "confirm") {
      if (form.get("confirmed") !== "yes") return fail("Tick the box to confirm the import.", intent);
      const res = await confirmRun(runId, { tierFromSmile: form.get("tier_from_smile") === "true" });
      return res.ok ? json({ ...res, intent }) : fail(res.error, intent, 409);
    }
    if (intent === "discard" || intent === "resume" || intent === "purge") {
      const res = intent === "discard" ? await discardRun(runId) : intent === "resume" ? await resumeRun(runId) : await purgeRunRows(runId);
      return res.ok ? json({ ...res, intent }) : fail(res.error, intent, 409);
    }
    if (intent === "report") {
      const { csv, rows } = await buildReportCsv(runId);
      // Byte-order mark so Excel reads the file as UTF-8.
      return json({ ok: true as const, intent, csv: `﻿${csv}`, rows, filename: "smile-import-not-imported.csv" });
    }
    return fail("Unknown action.", intent);
  } catch (e) {
    const text = errorMessage(e);
    return fail(/maxPartSize|exceeded/i.test(text) ? "The file is too large." : text, intent, 500);
  }
};

type Run = NonNullable<ReturnType<typeof useLoaderData<typeof loader>>["run"]>;
type Totals = Run["totals"];
const n = (v: number | undefined | null) => fmtInt(Number(v ?? 0));

const STATUS: Record<string, { label: string; tone?: "info" | "success" | "attention" | "critical" }> = {
  planning: { label: "Dry run in progress", tone: "info" },
  planned: { label: "Dry run ready", tone: "attention" },
  running: { label: "Importing", tone: "info" },
  completed: { label: "Finished", tone: "success" },
  failed: { label: "Stopped with an error", tone: "critical" },
  cancelled: { label: "Closed" },
};

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <Box padding="300" borderWidth="025" borderColor="border" borderRadius="200">
      <BlockStack gap="100">
        <Text as="p" variant="bodySm" tone="subdued">{label}</Text>
        <Text as="p" variant="headingLg">{value}</Text>
        {sub ? <Text as="p" variant="bodySm" tone="subdued">{sub}</Text> : null}
      </BlockStack>
    </Box>
  );
}

function Summary({ t, done }: { t: Totals; done: boolean }) {
  const statuses = Object.entries(t.byStatus ?? {});
  return (
    <BlockStack gap="400">
      <InlineGrid columns={{ xs: 2, md: 4 }} gap="300">
        <Stat label="Rows in the file" value={n(t.rows)} sub={`${n(t.filePoints)} points in total`} />
        <Stat label="Matched to a Shopify customer" value={n(t.matched)} sub="by email" />
        <Stat label="Unmatched" value={n(t.unmatched)} sub="not imported" />
        <Stat label="Duplicates" value={n(t.duplicates)} sub={t.invalid ? `${n(t.invalid)} unreadable rows` : "not imported"} />
        <Stat
          label={done ? "Points imported" : "Points to import"}
          value={n(done ? t.importedPoints : t.pointsToImport)}
          sub={`${n(t.zeroPointMembers)} members come in with 0 points`}
        />
        <Stat label={done ? "Members created" : "Members to create"} value={n(t.membersToCreate)} />
        <Stat label={done ? "Existing members updated" : "Existing members to update"} value={n(t.membersToUpdate)} sub="points added once, nothing else changed" />
        <Stat label="Skipped" value={n(t.skipped)} sub="already imported before, opted out or blocked" />
        <Stat label="Already have the welcome bonus" value={n(t.welcomeAlready)} sub="matched members; they keep it" />
      </InlineGrid>
      {Number(t.pointsUnreadable ?? 0) > 0 ? (
        <Banner tone="warning">
          <p>{n(t.pointsUnreadable)} rows have a points balance that is not a number. They are not imported and cannot be counted in the file total; they are listed in the download.</p>
        </Banner>
      ) : null}
      {statuses.length > 0 ? (
        <Text as="p" tone="subdued">
          Smile status in the file: {statuses.map(([k, v]) => `${k} ${n(v.rows)} rows (${n(v.points)} points)`).join(" · ")}.
          All statuses are imported the same way.
        </Text>
      ) : null}
    </BlockStack>
  );
}

function Reconciliation({ t }: { t: Totals }) {
  const diffs = t.differences ?? [];
  const rows: Array<[string, string, string]> = [
    ["Points in the file", n(t.rows), n(t.filePoints)],
    ["Points imported", n(t.imported), n(t.importedPoints)],
    ...diffs.map((d): [string, string, string] => [`Difference: ${d.label}`, n(d.rows), n(d.points)]),
    ["Not explained (must be 0)", "", n(t.unexplained)],
  ];
  return (
    <BlockStack gap="300">
      <Text as="h3" variant="headingSm">Reconciliation</Text>
      <DataTable columnContentTypes={["text", "numeric", "numeric"]} headings={["", "Rows", "Points"]} rows={rows} />
      <Text as="p" tone="subdued">
        File total = imported + every difference. A negative difference means the file counted a balance below zero and it was brought in as 0.
      </Text>
      {Number(t.unexplained ?? 0) !== 0 ? (
        <Banner tone="critical"><p>The totals do not add up. Do not switch Smile off; send this page to your developer.</p></Banner>
      ) : null}
    </BlockStack>
  );
}

export default function ImportPage() {
  const { run, launch, header, maxMb, retentionDays } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const reportFetcher = useFetcher<typeof action>();
  const revalidator = useRevalidator();
  useActionToast(fetcher.data);
  const busy = fetcher.state !== "idle";
  const [file, setFile] = useState<File | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [tierFromSmile, setTierFromSmile] = useState(false);
  const [closing, setClosing] = useState<"discard" | "purge" | null>(null);

  const working = run?.status === "planning" || run?.status === "running";
  // Live progress: reload the numbers every 3 seconds while the worker is busy.
  useEffect(() => {
    if (!working) return;
    const timer = setInterval(() => { if (revalidator.state === "idle") revalidator.revalidate(); }, 3000);
    return () => clearInterval(timer);
  }, [working, revalidator]);

  useEffect(() => {
    if (fetcher.data?.ok === true) { setFile(null); setConfirmOpen(false); setConfirmed(false); setClosing(null); }
  }, [fetcher.data]);

  // Report download: the action returns the CSV text; save it from the browser.
  const savedReport = useRef<unknown>(null);
  useEffect(() => {
    const d = reportFetcher.data;
    if (!d || d === savedReport.current || d.ok !== true || !("csv" in d)) return;
    savedReport.current = d;
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([d.csv], { type: "text/csv;charset=utf-8" }));
    a.download = d.filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(a.href);
  }, [reportFetcher.data]);

  const upload = useCallback(() => {
    if (!file) return;
    const body = new FormData();
    body.set("intent", "upload");
    body.set("file", file);
    fetcher.submit(body, { method: "post", encType: "multipart/form-data" });
  }, [file, fetcher]);
  const send = (intent: string, extra: Record<string, string> = {}) =>
    run && fetcher.submit({ intent, run_id: run.id, ...extra }, { method: "post" });

  const open = run && ["planning", "planned", "running", "failed"].includes(run.status);
  const t: Totals = run?.totals ?? {};
  const notImported = Number(t.unmatched ?? 0) + Number(t.duplicates ?? 0) + Number(t.invalid ?? 0) + Number(t.skipped ?? 0) + Number(t.errors ?? 0);
  const pct = run && run.progress.total > 0 ? Math.min(100, Math.round((run.progress.done / run.progress.total) * 100)) : 0;
  const reportButton = run && !run.rowsCleared ? (
    <Button
      loading={reportFetcher.state !== "idle"} disabled={notImported === 0}
      onClick={() => reportFetcher.submit({ intent: "report", run_id: run.id }, { method: "post" })}
    >
      Download rows not imported ({n(notImported)})
    </Button>
  ) : null;

  return (
    <Page title="Import from Smile" subtitle="Bring your Smile.io members and their points balances into HeyGirl Rewards.">
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            <ResultBanner data={fetcher.data} />
            {reportFetcher.data?.ok === false ? <ResultBanner data={reportFetcher.data} /> : null}

            <Banner
              tone={launch.welcomeBonusesGiven > 0 || launch.signedInMembers > 0 ? "warning" : "info"}
              title="Run the import before you switch the storefront launcher on"
            >
              <BlockStack gap="100">
                <p>
                  The welcome bonus is given at a customer's first sign-in, and only to customers who have no imported Smile balance.
                  Import first, then enable the Rewards launcher (the app embed in your theme). A customer who signs in before the import
                  gets the welcome bonus and keeps it, and still receives her Smile points on top.
                </p>
                {launch.welcomeBonusesGiven > 0 || launch.signedInMembers > 0 ? (
                  <p>
                    <Text as="span" fontWeight="semibold">
                      Customers are already signing in: {fmtInt(launch.welcomeBonusesGiven)} welcome bonuses have been given and {fmtInt(launch.signedInMembers)} members joined by signing in.
                    </Text>{" "}
                    The launcher appears to be on. Those customers keep their welcome bonus; the dry run shows how many of them are in the file.
                  </p>
                ) : (
                  <p>No welcome bonus has been given and nobody has joined by signing in yet, so the order is still right.</p>
                )}
                <p>
                  The app cannot see the theme's app-embed switch itself; check it under Online Store → Themes → Customize → App embeds.
                </p>
              </BlockStack>
            </Banner>

            {run ? (
              <Card>
                <BlockStack gap="400">
                  <InlineStack align="space-between" blockAlign="center">
                    <BlockStack gap="050">
                      <Text as="h2" variant="headingMd">{run.fileName ?? "Smile export"}</Text>
                      <Text as="p" tone="subdued" variant="bodySm">
                        Uploaded {fmtDateTime(run.createdAt)}
                        {run.finishedAt ? ` · closed ${fmtDateTime(run.finishedAt)}` : ""} (Pakistan time)
                      </Text>
                    </BlockStack>
                    <Badge tone={STATUS[run.status]?.tone}>{STATUS[run.status]?.label ?? run.status}</Badge>
                  </InlineStack>

                  {working ? (
                    <BlockStack gap="200">
                      <ProgressBar progress={pct} size="small" />
                      <Text as="p" tone="subdued">
                        {run.status === "planning"
                          ? `Looking up Shopify customers by email: ${n(run.progress.done)} of ${n(run.progress.total)}. Nothing is changed during the dry run.`
                          : `Importing: ${n(run.progress.done)} of ${n(run.progress.total)} customers. You can leave this page; the import continues.`}
                      </Text>
                      {run.stalled ? (
                        <Banner tone="warning" title="No progress for a few minutes">
                          <p>The worker may be stopped or restarting. Progress is saved; press Resume to continue from where it stopped.</p>
                        </Banner>
                      ) : null}
                    </BlockStack>
                  ) : null}

                  {run.status === "failed" ? (
                    <Banner tone="critical" title="The import stopped">
                      <p>{run.error ?? "Unknown error."} Nothing is lost and nothing is added twice: press Resume to continue.</p>
                    </Banner>
                  ) : null}
                  {run.status !== "failed" && run.error ? <Banner tone="warning"><p>{run.error}</p></Banner> : null}

                  {run.status !== "planning" ? <Summary t={t} done={run.phase === "execute"} /> : null}

                  {run.status === "planned" ? (
                    <Banner tone="info" title="This was a dry run. Nothing has been imported yet.">
                      <List>
                        <List.Item>Customers are matched by email only. Rows with no email, or with an email no Shopify customer has, are not imported; download them below.</List.Item>
                        <List.Item>Balances come in as they are (below zero becomes 0) and expire one year from today for Silver members.</List.Item>
                        <List.Item>No welcome bonus is given by the import. Date of birth is not imported.</List.Item>
                        <List.Item>Members who opted out or are blocked receive no points; they are listed in the download.</List.Item>
                        <List.Item>{n(t.welcomeAlready)} matched members already have the welcome bonus and keep it.</List.Item>
                        <List.Item>Running the import again never adds a customer's Smile points twice.</List.Item>
                      </List>
                    </Banner>
                  ) : null}

                  {run.phase === "execute" && run.status !== "planned" ? <Reconciliation t={t} /> : null}

                  <InlineStack gap="200">
                    {run.status === "planned" ? (
                      <Button variant="primary" onClick={() => setConfirmOpen(true)} disabled={Number(t.matched ?? 0) === 0}>Review and import</Button>
                    ) : null}
                    {run.status === "failed" || run.stalled ? <Button variant="primary" loading={busy} onClick={() => send("resume")}>Resume</Button> : null}
                    {run.status === "completed" && Number(t.errors ?? 0) > 0 ? <Button loading={busy} onClick={() => send("resume")}>Retry failed rows</Button> : null}
                    {run.status !== "planning" ? reportButton : null}
                    {open ? (
                      <Button tone="critical" variant="plain" onClick={() => setClosing("discard")}>
                        {run.status === "planned" || run.status === "planning" ? "Discard this dry run" : "Stop and close this import"}
                      </Button>
                    ) : null}
                    {!open && !run.rowsCleared ? (
                      <Button variant="plain" onClick={() => setClosing("purge")}>Delete stored rows</Button>
                    ) : null}
                  </InlineStack>
                  <Text as="p" tone="subdued" variant="bodySm">
                    {run.rowsCleared
                      ? "The stored rows of this import have been deleted; only the totals are kept."
                      : `Personal data: only the email of each row is stored, for the report. The Shopify name and phone held during the dry run are removed when the import closes. A discarded dry run is deleted at once; all other stored rows are deleted automatically ${retentionDays} days after the import closes, or now with "Delete stored rows".`}
                  </Text>
                </BlockStack>
              </Card>
            ) : null}

            {!open ? (
              <Card>
                <BlockStack gap="300">
                  <Text as="h2" variant="headingMd">{run ? "Upload another export" : "Upload the Smile customer export"}</Text>
                  <Text as="p" tone="subdued">
                    In Smile: Customers → Export. Upload the .csv exactly as downloaded (up to {maxMb} MB). The first step is a dry run that changes nothing.
                  </Text>
                  <DropZone accept=".csv,text/csv" type="file" allowMultiple={false} onDrop={(_all, accepted) => setFile(accepted[0] ?? null)}>
                    {file ? (
                      <Box padding="400"><Text as="p">{file.name} ({fmtInt(Math.ceil(file.size / 1024))} KB)</Text></Box>
                    ) : (
                      <DropZone.FileUpload actionTitle="Choose file" actionHint="or drop the .csv here" />
                    )}
                  </DropZone>
                  <InlineStack>
                    <Button variant="primary" disabled={!file} loading={busy} onClick={upload}>Upload and start dry run</Button>
                  </InlineStack>
                  <Text as="p" tone="subdued" variant="bodySm">Expected first line: {header}</Text>
                </BlockStack>
              </Card>
            ) : null}
          </BlockStack>
        </Layout.Section>
      </Layout>

      <Modal
        open={confirmOpen && run?.status === "planned"}
        onClose={() => setConfirmOpen(false)}
        title="Import these members and points?"
        primaryAction={{
          content: "Start import", disabled: !confirmed, loading: busy,
          onAction: () => send("confirm", { confirmed: "yes", tier_from_smile: String(tierFromSmile) }),
        }}
        secondaryActions={[{ content: "Cancel", onAction: () => setConfirmOpen(false) }]}
      >
        <Modal.Section>
          <BlockStack gap="300">
            <Text as="p">
              {n(t.pointsToImport)} points will be added to {n(t.matched)} customers: {n(t.membersToCreate)} new members and {n(t.membersToUpdate)} existing members.
              {" "}{n(Number(t.unmatched ?? 0) + Number(t.duplicates ?? 0) + Number(t.invalid ?? 0) + Number(t.skipped ?? 0))} rows will not be imported.
            </Text>
            <Text as="p" tone="subdued">Points added by the import are not removed by closing it. Take a database backup before you start.</Text>
            <Checkbox
              label="Set tier from the Smile VIP tier name"
              helpText={`Off: everyone starts at Silver and moves up by spend. On: a VIP tier name containing "gold" or "diamond" sets that tier (never lowers one), without sending tier reward codes. This file has ${n(t.vipTiers?.gold)} Gold and ${n(t.vipTiers?.diamond)} Diamond names.`}
              checked={tierFromSmile} onChange={setTierFromSmile}
            />
            <Checkbox label="I have checked the dry-run numbers and want to import now" checked={confirmed} onChange={setConfirmed} />
          </BlockStack>
        </Modal.Section>
      </Modal>

      <ConfirmModal
        open={closing !== null}
        loading={busy}
        title={closing === "purge" ? "Delete the stored rows?" : "Close this import?"}
        confirmLabel={closing === "purge" ? "Delete rows" : "Close import"}
        onClose={() => setClosing(null)}
        onConfirm={() => closing && send(closing)}
      >
        <Text as="p">
          {closing === "purge"
            ? "The emails kept for the report are deleted. The totals stay, but the report can no longer be downloaded. Members and points are not touched."
            : "The uploaded rows stop being processed. Members and points that were already imported stay. You can upload the file again later; nobody gets Smile points twice."}
        </Text>
      </ConfirmModal>
    </Page>
  );
}
