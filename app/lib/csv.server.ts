// app/lib/csv.server.ts
// CSV building for admin exports.
//
// Formula injection (handbook R2): a spreadsheet runs a cell as a formula when
// it starts with = + - @ (or a tab / carriage return before one). A customer
// can type such a name. Text cells that start that way are prefixed with an
// apostrophe so they open as plain text. Number cells are left alone, so
// negative points stay numbers that can be summed.

const FORMULA_START = /^[=+\-@\t\r]/;
/** "+92 300 1234567": a plus, a digit, then only digits, spaces and dashes. Cannot be a formula with a function or cell reference. */
const PLAIN_PHONE = /^\+\d[\d\s-]*$/;

export function neutraliseFormula(text: string): string {
  if (PLAIN_PHONE.test(text)) return text;
  return FORMULA_START.test(text) ? `'${text}` : text;
}

function cell(value: unknown): string {
  let s: string;
  if (value === null || value === undefined) s = "";
  else if (typeof value === "number") s = Number.isFinite(value) ? String(value) : "";
  else if (typeof value === "boolean") s = value ? "yes" : "no";
  else s = neutraliseFormula(String(value));
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function toCsv<T>(
  rows: T[],
  columns: ReadonlyArray<{ key: keyof T; header: string }>,
): string {
  const header = columns.map((c) => cell(c.header)).join(",");
  const body = rows
    .map((row) => columns.map((c) => cell(row[c.key])).join(","))
    .join("\n");
  return body ? `${header}\n${body}` : header;
}

export function csvResponse(filename: string, csv: string): Response {
  const safe = filename.replace(/[^A-Za-z0-9._-]/g, "_");
  // The byte-order mark makes Excel read the file as UTF-8 (names in Urdu).
  return new Response(`﻿${csv}`, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${safe}"`,
      "Cache-Control": "no-store",
    },
  });
}

/**
 * Read every row of a query in pages. Supabase caps rows per request, so a
 * single select silently returns a partial export (handbook R1).
 */
export async function fetchAllPages<T>(
  page: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
  opts: { pageSize?: number; maxRows?: number } = {},
): Promise<{ rows: T[]; truncated: boolean }> {
  const pageSize = opts.pageSize ?? 1000;
  const maxRows = opts.maxRows ?? 200000;
  const rows: T[] = [];
  let from = 0;
  while (from < maxRows) {
    const to = Math.min(from + pageSize, maxRows) - 1;
    const { data, error } = await page(from, to);
    if (error) throw new Error(`export failed: ${error.message}`);
    const batch = data ?? [];
    // Only an EMPTY page means the end. A short page does not: the server may
    // cap rows per request below the page size asked for, and stopping there
    // would silently cut the export. The next page starts after the rows that
    // actually came back.
    if (batch.length === 0) return { rows, truncated: false };
    rows.push(...batch);
    from += batch.length;
  }
  // The cap was reached without seeing an empty page: there may be more rows.
  return { rows, truncated: true };
}
