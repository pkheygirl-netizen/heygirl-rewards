// app/lib/smile-import-core.ts
// Smile.io customer export: parsing, validation, the file-level plan and the
// reconciliation maths. Pure functions only (no database, no Shopify), so the
// same code runs in the admin action, the worker, the tests and a dry parse.
//
// Owner rules encoded here:
//   * match by e-mail only (trimmed, lower-cased); rows without one are unmatched
//   * points are written with thousands separators ("12,500"); negative → 0
//   * duplicate e-mails: keep the row with the most points, list the others
//   * date of birth, names and the referral url are read past and never kept

export const SMILE_HEADER = [
  "Smile Customer ID", "First name", "Last name", "Email", "Membership status",
  "Points balance", "Referral url", "Vip tier name", "Date of birth",
] as const;

const COL = { id: 0, email: 3, status: 4, points: 5, vipTier: 7 } as const;

// ── CSV (RFC 4180) ────────────────────────────────────────────────────────

/**
 * Incremental CSV parser. Feed it text in chunks of any size; it returns the
 * records completed by each chunk. Handles quoted fields with commas, doubled
 * quotes and line breaks, CRLF / LF / lone CR line ends (also when split
 * across chunks) and a leading byte-order mark. Blank lines are skipped.
 */
export class CsvParser {
  private field = "";
  private record: string[] = [];
  private inQuotes = false;
  private quoteSeen = false; // previous char was a quote inside a quoted field
  private fieldQuoted = false;
  private lastWasCr = false;
  private started = false;

  push(chunk: string): string[][] {
    const out: string[][] = [];
    let i = 0;
    if (!this.started && chunk.length > 0) {
      this.started = true;
      if (chunk.charCodeAt(0) === 0xfeff) i = 1;
    }
    for (; i < chunk.length; i++) {
      const ch = chunk[i];
      if (this.inQuotes) {
        if (this.quoteSeen) {
          this.quoteSeen = false;
          if (ch === '"') {
            this.field += '"'; // "" inside quotes is one quote
            continue;
          }
          this.inQuotes = false; // the quote closed the field; fall through
        } else if (ch === '"') {
          this.quoteSeen = true;
          continue;
        } else {
          this.field += ch;
          continue;
        }
      }
      if (ch === "\n" && this.lastWasCr) {
        this.lastWasCr = false; // second half of CRLF
        continue;
      }
      this.lastWasCr = false;
      if (ch === '"' && this.field === "" && !this.fieldQuoted) {
        this.inQuotes = true;
        this.fieldQuoted = true;
      } else if (ch === ",") {
        this.endField();
      } else if (ch === "\n" || ch === "\r") {
        this.lastWasCr = ch === "\r";
        this.endRecord(out);
      } else {
        this.field += ch;
      }
    }
    return out;
  }

  /** Call once after the last chunk: returns the final record if the file had no trailing line break. */
  end(): string[][] {
    const out: string[][] = [];
    if (this.inQuotes && !this.quoteSeen) {
      throw new Error("The file ends inside a quoted field. It may be cut off; export it again.");
    }
    this.inQuotes = false;
    this.quoteSeen = false;
    this.endRecord(out);
    return out;
  }

  private endField(): void {
    this.record.push(this.field);
    this.field = "";
    this.fieldQuoted = false;
    this.quoteSeen = false;
  }

  private endRecord(out: string[][]): void {
    const blank = this.record.length === 0 && this.field === "" && !this.fieldQuoted;
    if (blank) return;
    this.endField();
    out.push(this.record);
    this.record = [];
  }
}

/** Parse a whole string (tests and small inputs). */
export function parseCsv(text: string): string[][] {
  const p = new CsvParser();
  return [...p.push(text), ...p.end()];
}

/** Parse a byte or text stream record by record without holding the file as one string. */
export async function* parseCsvStream(
  source: AsyncIterable<Uint8Array | string> | Iterable<Uint8Array | string>,
): AsyncGenerator<string[]> {
  const parser = new CsvParser();
  const decoder = new TextDecoder("utf-8");
  for await (const chunk of source as AsyncIterable<Uint8Array | string>) {
    const text = typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
    for (const rec of parser.push(text)) yield rec;
  }
  const tail = decoder.decode();
  if (tail) for (const rec of parser.push(tail)) yield rec;
  for (const rec of parser.end()) yield rec;
}

// ── Field rules ───────────────────────────────────────────────────────────

export function normaliseEmail(raw: string | null | undefined): string | null {
  const e = String(raw ?? "").trim().toLowerCase();
  return e ? e : null;
}

// Deliberately loose: one @, something either side, a dot in the domain, no spaces.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export function looksLikeEmail(email: string): boolean {
  return email.length <= 254 && EMAIL_RE.test(email);
}

/**
 * "12,500" → 12500, "-300" → -300, "1,250.00" → 1250, "" → 0.
 * Returns null when the text is not a whole number (the row is then invalid).
 */
export function parsePoints(raw: string | null | undefined): number | null {
  const t = String(raw ?? "").trim().replace(/[,\s ]/g, "");
  if (t === "") return 0;
  const m = /^([+-]?)(\d+)(?:\.0+)?$/.exec(t);
  if (!m) return null;
  const n = Number(m[2]) * (m[1] === "-" ? -1 : 1);
  return Number.isSafeInteger(n) && Math.abs(n) <= 2_000_000_000 ? n : null;
}

/** Owner option "set tier from Smile VIP tier name": names containing gold / diamond. */
export function mapVipTier(name: string | null | undefined): "gold" | "diamond" | null {
  const n = String(name ?? "").toLowerCase();
  if (n.includes("diamond")) return "diamond";
  if (n.includes("gold")) return "gold";
  return null;
}

export function importReference(smileCustomerId: string): string {
  return `smile:${smileCustomerId}`;
}

export function validateHeader(record: string[] | undefined): { ok: true } | { ok: false; error: string } {
  if (!record) return { ok: false, error: "The file is empty." };
  const got = record.map((c) => c.trim());
  const same = got.length === SMILE_HEADER.length && SMILE_HEADER.every((h, i) => got[i] === h);
  if (same) return { ok: true };
  return {
    ok: false,
    error:
      "This is not the Smile customer export. The first line must be exactly: " + SMILE_HEADER.join(","),
  };
}

// ── File-level plan ───────────────────────────────────────────────────────

export type RowState =
  | "pending" // has a usable e-mail; waiting for the Shopify lookup
  | "matched" // Shopify customer found; waiting to be imported
  | "imported"
  | "unmatched" // not imported: see reason
  | "duplicate" // not imported: another row for the same customer has more points
  | "invalid" // not imported: the row could not be read
  | "skipped" // not imported: this customer already has Smile points
  | "error"; // the import of this row failed

export type RowReason =
  | "no_email" | "invalid_email" | "no_shopify_customer" | "shopify_lookup_error"
  | "duplicate_email" | "same_shopify_customer"
  | "wrong_column_count" | "no_smile_id" | "points_not_a_number" | "duplicate_smile_id"
  | "already_imported" | "member_not_created" | "award_failed";

/** What is kept for one file row. No names, no date of birth, no referral url. */
export type PlannedRow = {
  row_number: number; // 1 = first data row (the line after the header)
  smile_customer_id: string;
  email: string | null;
  smile_status: string | null;
  vip_tier_name: string | null;
  file_points: number; // as written in the file (may be negative)
  points: number; // what would be imported (never negative)
  state: RowState;
  reason: RowReason | null;
};

/**
 * Turns records (header already removed) into planned rows and settles
 * everything that can be settled from the file alone: unreadable rows, rows
 * without an e-mail and duplicate e-mails.
 */
export class FilePlanner {
  readonly rows: PlannedRow[] = [];
  private byEmail = new Map<string, PlannedRow>();
  private ids = new Set<string>();
  blankPoints = 0;

  add(record: string[]): void {
    const row_number = this.rows.length + 1;
    const base: PlannedRow = {
      row_number, smile_customer_id: "", email: null, smile_status: null, vip_tier_name: null,
      file_points: 0, points: 0, state: "invalid", reason: null,
    };
    if (record.length !== SMILE_HEADER.length) {
      this.rows.push({ ...base, smile_customer_id: (record[COL.id] ?? "").trim().slice(0, 64), reason: "wrong_column_count" });
      return;
    }
    const id = record[COL.id].trim();
    const email = normaliseEmail(record[COL.email]);
    const filePoints = parsePoints(record[COL.points]);
    const row: PlannedRow = {
      ...base,
      smile_customer_id: id.slice(0, 64),
      email,
      smile_status: record[COL.status].trim().toLowerCase().slice(0, 40) || null,
      vip_tier_name: record[COL.vipTier].trim().slice(0, 80) || null,
    };
    this.rows.push(row);
    if (!id) { row.reason = "no_smile_id"; return; }
    if (filePoints === null) { row.reason = "points_not_a_number"; return; }
    if (this.ids.has(id)) { row.reason = "duplicate_smile_id"; return; }
    this.ids.add(id);
    if (record[COL.points].trim() === "") this.blankPoints++;
    row.file_points = filePoints;
    row.points = Math.max(0, filePoints);
    if (!email) { row.state = "unmatched"; row.reason = "no_email"; return; }
    if (!looksLikeEmail(email)) { row.state = "unmatched"; row.reason = "invalid_email"; return; }

    const other = this.byEmail.get(email);
    if (!other) {
      row.state = "pending";
      this.byEmail.set(email, row);
      return;
    }
    // Same e-mail twice: summing would be wrong. The row with more points wins
    // (the earlier row on a tie); the other is listed as a duplicate.
    if (row.points > other.points) {
      other.state = "duplicate";
      other.reason = "duplicate_email";
      row.state = "pending";
      this.byEmail.set(email, row);
    } else {
      row.state = "duplicate";
      row.reason = "duplicate_email";
    }
  }
}

export function planFile(records: string[][]): { ok: true; rows: PlannedRow[]; blankPoints: number } | { ok: false; error: string } {
  const head = validateHeader(records[0]);
  if (!head.ok) return head;
  const planner = new FilePlanner();
  for (let i = 1; i < records.length; i++) planner.add(records[i]);
  return { ok: true, rows: planner.rows, blankPoints: planner.blankPoints };
}

// ── Totals and reconciliation ─────────────────────────────────────────────

/** The columns the totals are computed from. */
export type TotalsRow = Pick<PlannedRow, "state" | "reason" | "file_points" | "points" | "smile_status"> & {
  member_existed?: boolean | null;
  points_awarded?: number | null;
  vip_tier_name?: string | null;
};

export type Difference = { key: string; label: string; rows: number; points: number };

export type ImportTotals = {
  rows: number;
  /** Sum of the points column over every readable row, negatives included. */
  filePoints: number;
  byStatus: Record<string, { rows: number; points: number }>;
  vipTiers: { gold: number; diamond: number };
  waitingForLookup: number;
  matched: number; // found in Shopify (waiting, imported, skipped or failed)
  unmatched: number;
  duplicates: number;
  invalid: number;
  membersToCreate: number;
  membersToUpdate: number;
  pointsToImport: number; // matched rows not yet finished
  zeroPointMembers: number; // matched rows with nothing to add
  imported: number;
  importedPoints: number;
  skipped: number;
  errors: number;
  /** filePoints − importedPoints, split into named causes. */
  differences: Difference[];
  /** What the named causes do not explain. Must be 0. */
  unexplained: number;
};

const DIFF_LABELS: Record<string, string> = {
  negative: "Negative balances brought in as 0",
  no_email: "No email in the file",
  invalid_email: "Email is not a valid address",
  no_shopify_customer: "No Shopify customer with this email",
  shopify_lookup_error: "Shopify could not be asked about this email",
  duplicate_email: "Duplicate email (the row with more points was used)",
  same_shopify_customer: "Second row for the same Shopify customer",
  already_imported: "Customer already has imported Smile points",
  error: "Import of the row failed",
  waiting: "Not imported yet",
  short: "Fewer points added than planned",
};

/**
 * Totals for the summary and the reconciliation. Identity checked here:
 *   filePoints = importedPoints + sum(differences.points) + unexplained
 * A negative balance is a negative difference: the file counts it below zero,
 * the import brings it in as zero.
 */
export function computeTotals(rows: Iterable<TotalsRow>): ImportTotals {
  const t: ImportTotals = {
    rows: 0, filePoints: 0, byStatus: {}, vipTiers: { gold: 0, diamond: 0 }, waitingForLookup: 0, matched: 0,
    unmatched: 0, duplicates: 0, invalid: 0, membersToCreate: 0, membersToUpdate: 0, pointsToImport: 0,
    zeroPointMembers: 0, imported: 0, importedPoints: 0, skipped: 0, errors: 0, differences: [], unexplained: 0,
  };
  const diff = new Map<string, { rows: number; points: number }>();
  const note = (key: string, points: number) => {
    const d = diff.get(key) ?? { rows: 0, points: 0 };
    d.rows++;
    d.points += points;
    diff.set(key, d);
  };

  for (const r of rows) {
    t.rows++;
    if (r.state === "invalid") {
      t.invalid++; // no readable number: counted, not part of filePoints
      continue;
    }
    t.filePoints += r.file_points;
    const status = r.smile_status || "(blank)";
    const s = (t.byStatus[status] ??= { rows: 0, points: 0 });
    s.rows++;
    s.points += r.file_points;
    const vip = mapVipTier(r.vip_tier_name);
    if (vip) t.vipTiers[vip]++;
    if (r.file_points < 0) note("negative", r.file_points);

    switch (r.state) {
      case "pending":
        t.waitingForLookup++;
        note("waiting", r.points);
        break;
      case "matched":
        t.matched++;
        t.pointsToImport += r.points;
        if (r.points === 0) t.zeroPointMembers++;
        if (r.member_existed) t.membersToUpdate++;
        else t.membersToCreate++;
        note("waiting", r.points);
        break;
      case "imported": {
        const awarded = Number(r.points_awarded ?? 0);
        t.matched++;
        t.imported++;
        t.importedPoints += awarded;
        if (r.points === 0) t.zeroPointMembers++;
        if (r.member_existed) t.membersToUpdate++;
        else t.membersToCreate++;
        if (awarded !== r.points) note("short", r.points - awarded);
        break;
      }
      case "skipped":
        t.matched++;
        t.skipped++;
        note(r.reason ?? "already_imported", r.points);
        break;
      case "error":
        t.matched++;
        t.errors++;
        note("error", r.points);
        break;
      case "unmatched":
        t.unmatched++;
        note(r.reason ?? "no_shopify_customer", r.points);
        break;
      case "duplicate":
        t.duplicates++;
        note(r.reason ?? "duplicate_email", r.points);
        break;
    }
  }

  for (const [key, d] of diff) {
    // Rows that carry no points explain nothing; keep the list short.
    if (d.points === 0 && key !== "waiting") continue;
    if (d.points === 0 && d.rows === 0) continue;
    t.differences.push({ key, label: DIFF_LABELS[key] ?? key, rows: d.rows, points: d.points });
  }
  t.differences = t.differences.filter((d) => d.points !== 0);
  t.differences.sort((a, b) => Math.abs(b.points) - Math.abs(a.points));
  t.unexplained = t.filePoints - t.importedPoints - t.differences.reduce((sum, d) => sum + d.points, 0);
  return t;
}

// ── Report ────────────────────────────────────────────────────────────────

const REASON_TEXT: Record<string, string> = {
  no_email: "No email in the Smile file, so it cannot be matched to a Shopify customer",
  invalid_email: "The email is not a valid address",
  no_shopify_customer: "No Shopify customer has this email",
  shopify_lookup_error: "Shopify returned an error for this email; try the import again",
  duplicate_email: "Same email as another row that has at least as many points; that row was used",
  same_shopify_customer: "Another row matched the same Shopify customer and has at least as many points",
  wrong_column_count: "The row does not have 9 columns",
  no_smile_id: "The Smile Customer ID is blank",
  points_not_a_number: "The points balance is not a whole number",
  duplicate_smile_id: "The Smile Customer ID appears earlier in the file",
  already_imported: "This customer already has imported Smile points; nothing was added",
  member_not_created: "The member could not be created",
  award_failed: "The points could not be added",
};

const OUTCOME_TEXT: Record<RowState, string> = {
  pending: "Waiting for the Shopify lookup",
  matched: "Matched, not imported yet",
  imported: "Imported",
  unmatched: "Unmatched",
  duplicate: "Duplicate",
  invalid: "Unreadable row",
  skipped: "Skipped",
  error: "Failed",
};

export function reasonText(reason: string | null | undefined): string {
  return reason ? (REASON_TEXT[reason] ?? reason) : "";
}

export function outcomeText(state: RowState): string {
  return OUTCOME_TEXT[state] ?? state;
}

export type ReportLine = {
  rowNumber: number;
  smileCustomerId: string;
  email: string;
  smileStatus: string;
  filePoints: number;
  outcome: string;
  reason: string;
};

export const REPORT_COLUMNS = [
  { key: "rowNumber", header: "Row in file" },
  { key: "smileCustomerId", header: "Smile Customer ID" },
  { key: "email", header: "Email" },
  { key: "smileStatus", header: "Smile status" },
  { key: "filePoints", header: "Points in file" },
  { key: "outcome", header: "Outcome" },
  { key: "reason", header: "Why" },
] as const;

export function toReportLine(
  r: Pick<PlannedRow, "row_number" | "smile_customer_id" | "email" | "smile_status" | "file_points" | "state" | "reason">,
): ReportLine {
  return {
    rowNumber: r.row_number + 1, // line in the file, counting the header as line 1
    smileCustomerId: r.smile_customer_id,
    email: r.email ?? "",
    smileStatus: r.smile_status ?? "",
    filePoints: r.file_points,
    outcome: outcomeText(r.state),
    reason: reasonText(r.reason),
  };
}
