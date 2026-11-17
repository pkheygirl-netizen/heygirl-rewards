// app/lib/smile-import.server.ts
// Smile.io import: upload → dry run (plan) → confirmed run (execute).
//
//   createRun    admin action: parse the CSV, settle what the file alone can
//                settle, store compact rows, queue the "plan" job
//   planRun      worker: find each e-mail's Shopify customer, see which members
//                already exist, write the dry-run totals (status "planned")
//   confirmRun   admin action: owner confirms; queue the "execute" job
//   executeRun   worker: create members and add points in batches; every step
//                is idempotent and driven by import_rows.state, so a restart or
//                a retry continues where it stopped
//
// Parsing and the maths live in smile-import-core.ts (no database needed).
import type { SupabaseClient } from "@supabase/supabase-js";
import { db } from "../db.server";
import { generateSlug } from "./points.service";
import { getAdminForShop } from "./worker-admin.server";
import type { AdminGraphqlClient } from "./shopify-graphql.server";
import { enqueueImportJob } from "./smile-import-queue.server";
import { fetchAllPages, toCsv } from "./csv.server";
import {
  FilePlanner, REPORT_COLUMNS, computeTotals, importReference, mapVipTier, parseCsvStream, toReportLine,
  validateHeader, type ImportTotals, type PlannedRow, type RowReason, type RowState, type TotalsRow,
} from "./smile-import-core";

export * from "./smile-import-core";

// import_runs and import_rows (migration 012) are not in database.types.ts,
// which belongs to stream A, so these two tables go through an untyped view of
// the same client and results are cast to the row types below.
const idb = (): SupabaseClient => db as unknown as SupabaseClient;

export type RunStatus = "planning" | "planned" | "running" | "completed" | "failed" | "cancelled";
export const OPEN_STATUSES: RunStatus[] = ["planning", "planned", "running", "failed"];

export type ImportOptions = { tierFromSmile: boolean };

export type ImportRun = {
  id: string;
  status: RunStatus;
  phase: "plan" | "execute";
  file_name: string | null;
  options: Partial<ImportOptions>;
  totals: Partial<ImportTotals>;
  progress: { done?: number; total?: number };
  error: string | null;
  created_by: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  updated_at: string;
};

export type ImportRow = PlannedRow & {
  run_id: string;
  shopify_customer_id: string | null;
  shopify_first_name: string | null;
  shopify_last_name: string | null;
  shopify_phone: string | null;
  member_id: string | null;
  member_existed: boolean | null;
  points_awarded: number | null;
};

export const LIMITS = {
  maxFileBytes: 20 * 1024 * 1024,
  maxRows: 200_000,
  insertChunk: 500,
  lookupPage: 500, // rows read per planning pass
  lookupBatch: 50, // e-mails per Shopify request
  executeBatch: 100,
  awardConcurrency: 5,
  idChunk: 100, // values per .in() filter (keeps the request URL short)
  maxLookupErrors: 50,
};

/** Replaceable in tests so pacing does not slow them down. */
export const pacing = {
  sleep: (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms)),
};

const TIER_RANK: Record<string, number> = { silver: 0, gold: 1, diamond: 2 };
const nowIso = () => new Date().toISOString();
const chunk = <T>(list: T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
};
const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

// ── Runs ──────────────────────────────────────────────────────────────────

export async function getRun(runId: string): Promise<ImportRun | null> {
  const { data, error } = await idb().from("import_runs").select("*").eq("id", runId).maybeSingle();
  if (error) throw new Error(`could not read the import run: ${error.message}`);
  return (data as ImportRun | null) ?? null;
}

/** The newest run, whatever its status (what the Import page shows). */
export async function getLatestRun(): Promise<ImportRun | null> {
  const { data, error } = await idb()
    .from("import_runs").select("*").order("created_at", { ascending: false }).limit(1);
  if (error) throw new Error(`could not read import runs: ${error.message}`);
  return ((data as ImportRun[] | null) ?? [])[0] ?? null;
}

export async function getOpenRun(): Promise<ImportRun | null> {
  const { data, error } = await idb()
    .from("import_runs").select("*").in("status", OPEN_STATUSES).order("created_at", { ascending: false }).limit(1);
  if (error) throw new Error(`could not read import runs: ${error.message}`);
  return ((data as ImportRun[] | null) ?? [])[0] ?? null;
}

async function patchRun(runId: string, patch: Partial<ImportRun>, onlyIfStatus?: RunStatus[]): Promise<boolean> {
  let q = idb().from("import_runs").update({ ...patch, updated_at: nowIso() }).eq("id", runId);
  if (onlyIfStatus) q = q.in("status", onlyIfStatus);
  const { data, error } = await q.select("id");
  if (error) throw new Error(`could not update the import run: ${error.message}`);
  return ((data as unknown[] | null) ?? []).length > 0;
}

async function allRows<T>(runId: string, columns: string, states?: RowState[]): Promise<T[]> {
  const { rows } = await fetchAllPages<T>((from, to) => {
    let q = idb().from("import_rows").select(columns).eq("run_id", runId);
    if (states) q = q.in("state", states);
    return q.order("row_number", { ascending: true }).range(from, to) as unknown as PromiseLike<{
      data: T[] | null; error: { message: string } | null;
    }>;
  }, { pageSize: 1000, maxRows: LIMITS.maxRows + 1000 });
  return rows;
}

async function saveRows(rows: ImportRow[]): Promise<void> {
  for (const part of chunk(rows, LIMITS.insertChunk)) {
    const { error } = await idb().from("import_rows").upsert(part, { onConflict: "run_id,row_number" });
    if (error) throw new Error(`could not save import rows: ${error.message}`);
  }
}

/** Recount everything from the rows and store it on the run. */
export async function refreshTotals(runId: string): Promise<ImportTotals> {
  const rows = await allRows<TotalsRow>(
    runId, "state, reason, file_points, points, smile_status, member_existed, points_awarded, vip_tier_name",
  );
  const totals = computeTotals(rows);
  await patchRun(runId, { totals });
  return totals;
}

// ── Upload ────────────────────────────────────────────────────────────────

export type CreateRunResult = { ok: true; runId: string; rows: number } | { ok: false; error: string };

/**
 * Read the uploaded CSV as a stream, keep only the columns the import needs
 * and queue the dry run. Refuses when another run is open.
 */
export async function createRun(input: {
  source: AsyncIterable<Uint8Array | string> | Iterable<Uint8Array | string>;
  fileName?: string | null;
  actor?: string | null;
}): Promise<CreateRunResult> {
  const open = await getOpenRun();
  if (open) return { ok: false, error: "An import is already open. Finish or discard it before uploading another file." };

  const planner = new FilePlanner();
  let first = true;
  try {
    for await (const record of parseCsvStream(input.source)) {
      if (first) {
        first = false;
        const head = validateHeader(record);
        if (!head.ok) return head;
        continue;
      }
      if (planner.rows.length >= LIMITS.maxRows) {
        return { ok: false, error: `The file has more than ${LIMITS.maxRows.toLocaleString("en")} rows.` };
      }
      planner.add(record);
    }
  } catch (e) {
    return { ok: false, error: msg(e) };
  }
  if (first) return { ok: false, error: "The file is empty." };
  if (planner.rows.length === 0) return { ok: false, error: "The file has a header but no customers." };

  const { data: created, error } = await idb()
    .from("import_runs")
    .insert({
      source: "smile", status: "planning", phase: "plan",
      file_name: (input.fileName ?? "").replace(/[^\w .()-]/g, "_").slice(0, 120) || null,
      created_by: input.actor ?? null,
      progress: { done: 0, total: planner.rows.filter((r) => r.state === "pending").length },
    })
    .select("id")
    .single();
  if (error || !created) {
    // The partial unique index refuses a second open run even in a race.
    if (error?.code === "23505") return { ok: false, error: "An import is already open. Finish or discard it first." };
    return { ok: false, error: `Could not start the import: ${error?.message ?? "no row returned"}` };
  }
  const runId = String((created as { id: string }).id);

  try {
    await saveRows(planner.rows.map((r) => ({
      ...r, run_id: runId, shopify_customer_id: null, shopify_first_name: null, shopify_last_name: null,
      shopify_phone: null, member_id: null, member_existed: null, points_awarded: null,
    })));
    await refreshTotals(runId);
    await enqueueImportJob("plan", runId);
  } catch (e) {
    // Nothing has been imported yet: remove the half-stored upload completely.
    await idb().from("import_runs").delete().eq("id", runId);
    return { ok: false, error: `Could not store the file: ${msg(e)}` };
  }
  return { ok: true, runId, rows: planner.rows.length };
}

// ── Shopify lookup ────────────────────────────────────────────────────────

export type ShopifyCustomer = {
  id: string; // numeric id, as stored in members.shopify_customer_id
  email: string | null;
  firstName: string | null;
  lastName: string | null;
  phone: string | null;
};

/**
 * One request that asks for many customers by e-mail, each through
 * customerByIdentifier (an exact lookup, not the tokenised customer search).
 * Values travel as variables, never inside the query text.
 */
export function buildLookupQuery(count: number): string {
  const vars = Array.from({ length: count }, (_, i) => `$e${i}: String!`).join(", ");
  const fields = Array.from(
    { length: count },
    (_, i) => `c${i}: customerByIdentifier(identifier: { emailAddress: $e${i} }) { ...HgImportCustomer }`,
  ).join("\n    ");
  return `#graphql
  query HgImportCustomersByEmail(${vars}) {
    ${fields}
  }
  fragment HgImportCustomer on Customer {
    id
    firstName
    lastName
    defaultEmailAddress { emailAddress }
    defaultPhoneNumber { phoneNumber }
  }`;
}

type LookupNode = {
  id: string;
  firstName: string | null;
  lastName: string | null;
  defaultEmailAddress: { emailAddress: string | null } | null;
  defaultPhoneNumber: { phoneNumber: string | null } | null;
} | null;

type LookupJson = {
  data?: Record<string, LookupNode> | null;
  errors?: Array<{ message?: string; extensions?: { code?: string } }>;
  extensions?: { cost?: { requestedQueryCost?: number; throttleStatus?: { maximumAvailable?: number; currentlyAvailable?: number; restoreRate?: number } } };
};

class LookupError extends Error {}

/** Share of the rate-limit bucket left for the live store (orders, reward codes). */
const BUCKET_RESERVE = 0.4;

async function lookupOnce(admin: AdminGraphqlClient, emails: string[]): Promise<Array<ShopifyCustomer | null>> {
  const variables: Record<string, unknown> = {};
  emails.forEach((e, i) => (variables[`e${i}`] = e));
  const query = buildLookupQuery(emails.length);
  for (let attempt = 0; attempt < 8; attempt++) {
    const res = await admin.graphql(query, { variables });
    const json = (await res.json()) as LookupJson;
    const throttle = json.extensions?.cost?.throttleStatus;
    if (json.errors?.some((e) => e.extensions?.code === "THROTTLED")) {
      const wanted = json.extensions?.cost?.requestedQueryCost ?? emails.length * 3;
      await pacing.sleep(Math.max(1000, Math.ceil((wanted / (throttle?.restoreRate ?? 50)) * 1000)));
      continue;
    }
    if (json.errors && json.errors.length > 0) {
      throw new LookupError(json.errors.map((e) => e.message ?? "unknown").join("; ").slice(0, 300));
    }
    if (!json.data) throw new LookupError("Shopify returned no data");

    // Pace ourselves: wait while the bucket is below the reserve.
    if (throttle?.maximumAvailable && throttle.currentlyAvailable != null && throttle.restoreRate) {
      const floor = throttle.maximumAvailable * BUCKET_RESERVE;
      if (throttle.currentlyAvailable < floor) {
        await pacing.sleep(Math.ceil(((floor - throttle.currentlyAvailable) / throttle.restoreRate) * 1000));
      }
    }
    const data = json.data;
    return emails.map((_, i) => {
      const node = data[`c${i}`];
      if (!node?.id) return null;
      return {
        id: String(node.id).split("/").pop() ?? "",
        email: node.defaultEmailAddress?.emailAddress?.trim().toLowerCase() ?? null,
        firstName: node.firstName,
        lastName: node.lastName,
        phone: node.defaultPhoneNumber?.phoneNumber ?? null,
      };
    });
  }
  throw new Error("Shopify kept throttling the customer lookup; the run will be retried");
}

export type LookupOutcome = ShopifyCustomer | "not_found" | "error";
export type LookupStats = { found: number; errors: number; lastError: string | null };

/**
 * Look up many e-mails. A request that fails as a whole is split in halves
 * until the one bad address is isolated; that address is reported as "error"
 * and the rest still resolve. If nothing has ever worked (wrong scope, no
 * access to customer data) the first isolated failure is thrown instead, so a
 * broken connection does not turn every row into "unmatched".
 */
export async function lookupCustomersByEmail(
  admin: AdminGraphqlClient,
  emails: string[],
  stats: LookupStats = { found: 0, errors: 0, lastError: null },
): Promise<Map<string, LookupOutcome>> {
  const out = new Map<string, LookupOutcome>();
  const run = async (list: string[]): Promise<void> => {
    try {
      const res = await lookupOnce(admin, list);
      list.forEach((email, i) => {
        const c = res[i];
        // Only an exact e-mail match counts (owner rule: e-mail only).
        if (c && c.id && c.email === email) {
          out.set(email, c);
          stats.found++;
        } else {
          out.set(email, "not_found");
        }
      });
    } catch (e) {
      if (!(e instanceof LookupError)) throw e;
      if (list.length > 1) {
        const mid = Math.ceil(list.length / 2);
        await run(list.slice(0, mid));
        await run(list.slice(mid));
        return;
      }
      stats.errors++;
      stats.lastError = e.message;
      if (stats.found === 0 || stats.errors > LIMITS.maxLookupErrors) {
        throw new Error(`Shopify customer lookup is failing: ${e.message}`);
      }
      out.set(list[0], "error");
    }
  };
  for (const part of chunk(emails, LIMITS.lookupBatch)) await run(part);
  return out;
}

// ── Members and ledger helpers ────────────────────────────────────────────

type MemberLite = { id: string; shopify_customer_id: string; tier: string };

async function membersByCustomerId(ids: string[]): Promise<Map<string, MemberLite>> {
  const out = new Map<string, MemberLite>();
  for (const part of chunk([...new Set(ids)], LIMITS.idChunk)) {
    const { data, error } = await db.from("members").select("id, shopify_customer_id, tier").in("shopify_customer_id", part);
    if (error) throw new Error(`member lookup failed: ${error.message}`);
    for (const m of data ?? []) out.set(m.shopify_customer_id, m);
  }
  return out;
}

/** member id → the import ledger row that member already has (one is enough). */
async function importLedgerByMember(memberIds: string[]): Promise<Map<string, { reference_id: string | null; points: number }>> {
  const out = new Map<string, { reference_id: string | null; points: number }>();
  for (const part of chunk([...new Set(memberIds)], LIMITS.idChunk)) {
    const { data, error } = await db
      .from("points_ledger").select("member_id, reference_id, points").eq("action_type", "import").in("member_id", part);
    if (error) throw new Error(`ledger lookup failed: ${error.message}`);
    for (const l of data ?? []) if (!out.has(l.member_id)) out.set(l.member_id, { reference_id: l.reference_id, points: l.points });
  }
  return out;
}

// ── Dry run (worker) ──────────────────────────────────────────────────────

export async function planRun(runId: string, deps: { admin?: AdminGraphqlClient } = {}): Promise<{ status: RunStatus | "missing" }> {
  const run = await getRun(runId);
  if (!run) return { status: "missing" };
  if (run.status !== "planning") return { status: run.status };
  const admin = deps.admin ?? (await getAdminForShop());
  const stats: LookupStats = { found: 0, errors: 0, lastError: null };
  const total = Number(run.progress?.total ?? 0);
  let done = 0;

  for (;;) {
    const current = await getRun(runId);
    if (!current || current.status !== "planning") return { status: current?.status ?? "missing" }; // discarded meanwhile
    const { data, error } = await idb()
      .from("import_rows").select("*").eq("run_id", runId).eq("state", "pending")
      .order("row_number", { ascending: true }).limit(LIMITS.lookupPage);
    if (error) throw new Error(`could not read import rows: ${error.message}`);
    const rows = (data as ImportRow[] | null) ?? [];
    if (rows.length === 0) break;

    const found = await lookupCustomersByEmail(admin, rows.map((r) => r.email ?? ""), stats);
    const customerIds = [...found.values()].flatMap((c) => (typeof c === "object" ? [c.id] : []));
    const members = await membersByCustomerId(customerIds);
    const already = await importLedgerByMember([...members.values()].map((m) => m.id));

    for (const row of rows) {
      const c = found.get(row.email ?? "");
      if (!c || c === "not_found") { row.state = "unmatched"; row.reason = "no_shopify_customer"; continue; }
      if (c === "error") { row.state = "unmatched"; row.reason = "shopify_lookup_error"; continue; }
      const member = members.get(c.id);
      row.shopify_customer_id = c.id;
      row.shopify_first_name = c.firstName;
      row.shopify_last_name = c.lastName;
      row.shopify_phone = c.phone;
      row.member_id = member?.id ?? null;
      row.member_existed = Boolean(member);
      if (member && already.has(member.id)) {
        // One Smile balance per customer, whatever file it came from.
        row.state = "skipped";
        row.reason = "already_imported";
        clearContact(row);
      } else {
        row.state = "matched";
      }
    }
    await saveRows(rows);
    done += rows.length;
    await patchRun(runId, { progress: { done, total: Math.max(total, done) } }, ["planning"]);
  }

  await settleSameCustomer(runId);
  await refreshTotals(runId);
  const moved = await patchRun(runId, { status: "planned", error: stats.lastError ? `Some lookups failed: ${stats.lastError}` : null }, ["planning"]);
  return { status: moved ? "planned" : ((await getRun(runId))?.status ?? "missing") };
}

function clearContact(row: ImportRow): void {
  row.shopify_first_name = null;
  row.shopify_last_name = null;
  row.shopify_phone = null;
}

/** Two rows that reached the same Shopify customer: the one with more points stays. */
async function settleSameCustomer(runId: string): Promise<void> {
  const rows = await allRows<ImportRow>(runId, "*", ["matched"]);
  const best = new Map<string, ImportRow>();
  const losers: ImportRow[] = [];
  for (const row of rows) {
    const key = row.shopify_customer_id ?? "";
    const other = best.get(key);
    if (!other) { best.set(key, row); continue; }
    const loser = row.points > other.points ? other : row;
    if (loser === other) best.set(key, row);
    loser.state = "duplicate";
    loser.reason = "same_shopify_customer";
    clearContact(loser);
    losers.push(loser);
  }
  if (losers.length > 0) await saveRows(losers);
}

// ── Confirm, discard, resume ──────────────────────────────────────────────

export type ActionOutcome = { ok: true; message: string } | { ok: false; error: string };

/** The owner confirmed the dry run: start the real import. */
export async function confirmRun(runId: string, options: ImportOptions): Promise<ActionOutcome> {
  const moved = await patchRun(
    runId,
    { status: "running", phase: "execute", options, started_at: nowIso(), error: null, progress: { done: 0 } },
    ["planned"],
  );
  if (!moved) return { ok: false, error: "This dry run is no longer waiting for confirmation. Reload the page." };
  try {
    await enqueueImportJob("execute", runId);
  } catch (e) {
    await patchRun(runId, { status: "failed", error: `Could not queue the import: ${msg(e)}` }, ["running"]);
    return { ok: false, error: "The import could not be queued. Check that Redis is running, then press Resume." };
  }
  return { ok: true, message: "Import started" };
}

/** Discard a dry run, or stop a run. Points already added stay (they are in the ledger). */
export async function discardRun(runId: string): Promise<ActionOutcome> {
  const moved = await patchRun(runId, { status: "cancelled", finished_at: nowIso() }, OPEN_STATUSES);
  if (!moved) return { ok: false, error: "This import is already finished." };
  return { ok: true, message: "Import closed" };
}

/** Continue a failed or stalled run, or retry the rows that failed in a finished one. */
export async function resumeRun(runId: string): Promise<ActionOutcome> {
  const run = await getRun(runId);
  if (!run) return { ok: false, error: "Import not found." };
  if (run.status === "planned" || run.status === "cancelled") return { ok: false, error: "There is nothing to resume." };
  if (run.status === "completed") {
    const other = await getOpenRun();
    if (other) return { ok: false, error: "Another import is open." };
  }
  if (run.phase === "execute") {
    // Give the rows that failed another chance.
    const { error } = await idb()
      .from("import_rows").update({ state: "matched", reason: null }).eq("run_id", runId).eq("state", "error");
    if (error) return { ok: false, error: `Could not reset the failed rows: ${error.message}` };
  }
  const status: RunStatus = run.phase === "execute" ? "running" : "planning";
  try {
    const moved = await patchRun(runId, { status, error: null, finished_at: null }, [run.status]);
    if (!moved) return { ok: false, error: "The import changed meanwhile. Reload the page." };
    await enqueueImportJob(run.phase, runId);
  } catch (e) {
    return { ok: false, error: `Could not resume: ${msg(e)}` };
  }
  return { ok: true, message: "Import resumed" };
}

/** Called by the worker when a job has used all its attempts. */
export async function markRunFailed(runId: string, error: string): Promise<void> {
  await patchRun(runId, { status: "failed", error: error.slice(0, 500) }, ["planning", "running"]);
}

/** Delete the stored rows (and their e-mails) of a finished run. Totals stay. */
export async function purgeRunRows(runId: string): Promise<ActionOutcome> {
  const run = await getRun(runId);
  if (!run) return { ok: false, error: "Import not found." };
  if (run.status !== "completed" && run.status !== "cancelled") {
    return { ok: false, error: "Only a finished or closed import can be cleared." };
  }
  const { error } = await idb().from("import_rows").delete().eq("run_id", runId);
  if (error) return { ok: false, error: `Could not clear the rows: ${error.message}` };
  await patchRun(runId, { progress: { ...run.progress, rowsCleared: true } as ImportRun["progress"] });
  return { ok: true, message: "Stored rows deleted" };
}

// ── Real run (worker) ─────────────────────────────────────────────────────

async function pool<T>(items: T[], size: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) await fn(items[next++]);
  });
  await Promise.all(workers);
}

function memberInsert(row: ImportRow, tier: string, slug: string) {
  const now = nowIso();
  return {
    shopify_customer_id: String(row.shopify_customer_id),
    email: row.email,
    phone: row.shopify_phone?.trim() || null,
    first_name: row.shopify_first_name?.trim() || null,
    last_name: row.shopify_last_name?.trim() || null,
    tier,
    points_balance: 0,
    lifetime_spend_pkr: 0,
    referral_slug: slug,
    consent_given: true,
    consent_given_at: now,
    consent_source: "import",
    imported_from_smile: true,
  };
}

/** Create the members a batch needs. Returns customer id → member for every one created or found. */
async function createMembers(rows: ImportRow[], tierFor: (row: ImportRow) => string): Promise<Map<string, MemberLite>> {
  const out = new Map<string, MemberLite>();
  if (rows.length === 0) return out;
  const used = new Set<string>();
  const slugFor = (row: ImportRow): string => {
    for (;;) {
      const s = generateSlug(row.shopify_first_name, row.shopify_last_name);
      if (!used.has(s)) { used.add(s); return s; }
    }
  };

  // Fast path: the whole batch in one insert.
  const bulk = await db
    .from("members").insert(rows.map((r) => memberInsert(r, tierFor(r), slugFor(r)))).select("id, shopify_customer_id, tier");
  if (!bulk.error && bulk.data) {
    for (const m of bulk.data) out.set(m.shopify_customer_id, m);
    return out;
  }

  // Something clashed (a referral slug already taken, or a webhook created one
  // of the members a moment ago). Insert one by one.
  for (const row of rows) {
    const customerId = String(row.shopify_customer_id);
    for (let attempt = 0; attempt < 6 && !out.has(customerId); attempt++) {
      const { data, error } = await db
        .from("members").insert(memberInsert(row, tierFor(row), slugFor(row))).select("id, shopify_customer_id, tier").single();
      if (!error && data) { out.set(customerId, data); break; }
      const text = error?.message ?? "";
      if (error?.code === "23505" && text.includes("referral_slug")) continue; // new suffix
      if (error?.code === "23505") {
        const existing = (await membersByCustomerId([customerId])).get(customerId);
        if (existing) out.set(customerId, existing);
        break;
      }
      console.error("[smile-import] member insert failed:", text); // no customer details in the log
      break;
    }
  }
  return out;
}

/** Option "tier from Smile": raise (never lower) the tier. No tier reward codes are issued. */
async function raiseTier(member: MemberLite, target: string, isNew: boolean): Promise<void> {
  if (!isNew) {
    if ((TIER_RANK[target] ?? 0) <= (TIER_RANK[member.tier] ?? 0)) return;
    const { data, error } = await db
      .from("members").update({ tier: target }).eq("id", member.id).eq("tier", member.tier).select("id");
    if (error) throw new Error(`tier update failed: ${error.message}`);
    if (!data || data.length === 0) return;
    // Gold and Diamond points do not expire: stop the clock on what she holds.
    await db.from("points_ledger").update({ expires_at: null }).eq("member_id", member.id).eq("expired", false).not("expires_at", "is", null);
  }
  const { error: histErr } = await db
    .from("tier_history").insert({ member_id: member.id, from_tier: isNew ? "silver" : member.tier, to_tier: target, shopify_order_id: null });
  if (histErr) console.error("[smile-import] tier_history insert failed:", histErr.message);
  member.tier = target;
}

async function award(row: ImportRow, memberId: string, runId: string): Promise<number> {
  let lastError = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    const { data, error } = await db.rpc("award_points", {
      p_member_id: memberId,
      p_action_type: "import",
      p_reference_id: importReference(row.smile_customer_id),
      p_points: row.points,
      // No p_expires_at: the database gives a Silver member's row its expiry
      // (silver_expiry_days from now, i.e. one year from import).
      p_reason_note: `Smile import ${runId}`,
      p_customer_note: "Points brought over from your previous rewards balance",
    });
    if (!error) {
      const res = data?.[0];
      if (res?.awarded) return row.points;
      return -1; // a row with this reference exists already; the caller reads it
    }
    lastError = error.message;
    await pacing.sleep(500 * (attempt + 1));
  }
  throw new Error(lastError || "award_points failed");
}

async function executeBatch(runId: string, rows: ImportRow[], options: ImportOptions): Promise<void> {
  const tierFor = (row: ImportRow): string => (options.tierFromSmile ? (mapVipTier(row.vip_tier_name) ?? "silver") : "silver");
  const customerIds = rows.map((r) => String(r.shopify_customer_id));
  const existing = await membersByCustomerId(customerIds);
  const toCreate = rows.filter((r) => !existing.has(String(r.shopify_customer_id)));
  const created = await createMembers(toCreate, tierFor);
  const createdIds = new Set(toCreate.filter((r) => created.has(String(r.shopify_customer_id))).map((r) => String(r.shopify_customer_id)));
  const members = new Map([...existing, ...created]);

  // Members that were already in the app keep every field; only the marker is set.
  const marked = [...existing.values()].map((m) => m.id);
  for (const part of chunk(marked, LIMITS.idChunk)) {
    const { error } = await db.from("members").update({ imported_from_smile: true }).in("id", part);
    if (error) throw new Error(`member update failed: ${error.message}`);
  }

  const already = await importLedgerByMember([...members.values()].map((m) => m.id));

  await pool(rows, LIMITS.awardConcurrency, async (row) => {
    const customerId = String(row.shopify_customer_id);
    const member = members.get(customerId);
    clearContact(row);
    if (!member) { row.state = "error"; row.reason = "member_not_created"; return; }
    row.member_id = member.id;
    // Keep what the dry run saw; a row first seen here is new when this batch created the member.
    if (row.member_existed == null) row.member_existed = !createdIds.has(customerId);

    try {
      const reference = importReference(row.smile_customer_id);
      const prior = already.get(member.id);
      if (prior && prior.reference_id !== reference) {
        row.state = "skipped"; row.reason = "already_imported"; row.points_awarded = 0;
        return;
      }
      const target = tierFor(row);
      if (target !== "silver" && !prior) await raiseTier(member, target, createdIds.has(customerId));
      if (prior) {
        // This run added the points earlier and stopped before recording it.
        row.points_awarded = prior.points;
      } else if (row.points > 0) {
        const got = await award(row, member.id, runId);
        if (got >= 0) row.points_awarded = got;
        else {
          const again = (await importLedgerByMember([member.id])).get(member.id);
          row.points_awarded = again?.points ?? 0;
        }
      } else {
        row.points_awarded = 0; // member with 0 points: no ledger row
      }
      row.state = "imported";
      row.reason = null;
    } catch (e) {
      console.error("[smile-import] row failed:", row.row_number, msg(e));
      row.state = "error";
      row.reason = "award_failed" satisfies RowReason;
    }
  });

  await saveRows(rows);
}

export async function executeRun(runId: string): Promise<{ status: RunStatus | "missing" }> {
  const first = await getRun(runId);
  if (!first) return { status: "missing" };
  if (first.status !== "running") return { status: first.status };
  const options: ImportOptions = { tierFromSmile: first.options?.tierFromSmile === true };
  const total = Number(first.totals?.matched ?? 0);

  for (;;) {
    const run = await getRun(runId);
    if (!run || run.status !== "running") return { status: run?.status ?? "missing" }; // stopped meanwhile
    const { data, error } = await idb()
      .from("import_rows").select("*").eq("run_id", runId).eq("state", "matched")
      .order("row_number", { ascending: true }).limit(LIMITS.executeBatch);
    if (error) throw new Error(`could not read import rows: ${error.message}`);
    const rows = (data as ImportRow[] | null) ?? [];
    if (rows.length === 0) break;
    await executeBatch(runId, rows, options);

    const { count } = await idb()
      .from("import_rows").select("row_number", { count: "exact", head: true }).eq("run_id", runId).eq("state", "matched");
    const left = Number(count ?? 0);
    await patchRun(runId, { progress: { done: Math.max(0, total - left), total } }, ["running"]);
  }

  const totals = await refreshTotals(runId);
  const moved = await patchRun(
    runId,
    {
      status: "completed", finished_at: nowIso(),
      error: totals.errors > 0 ? `${totals.errors} row(s) failed. Press "Retry failed rows".` : null,
    },
    ["running"],
  );
  return { status: moved ? "completed" : ((await getRun(runId))?.status ?? "missing") };
}

// ── Report ────────────────────────────────────────────────────────────────

/** Every row that was not imported, as CSV text (formula-injection safe through toCsv). */
export async function buildReportCsv(runId: string): Promise<{ csv: string; rows: number }> {
  const rows = await allRows<ImportRow>(
    runId, "row_number, smile_customer_id, email, smile_status, file_points, state, reason",
    ["unmatched", "duplicate", "invalid", "skipped", "error", "pending", "matched"],
  );
  return { csv: toCsv(rows.map(toReportLine), REPORT_COLUMNS), rows: rows.length };
}
