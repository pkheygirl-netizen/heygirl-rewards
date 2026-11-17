// Time and number formatting shared by the admin server code and the browser.
// The store runs on Asia/Karachi, which is UTC+5 all year (no daylight saving),
// so period boundaries are plain offset arithmetic and never depend on the
// server's or the staff member's own time zone.

export const KARACHI_OFFSET_MS = 5 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export type PeriodKey = "7d" | "30d" | "90d" | "month";
export const PERIOD_OPTIONS: Array<{ value: PeriodKey; label: string }> = [
  { value: "30d", label: "Last 30 days" },
  { value: "7d", label: "Last 7 days" },
  { value: "month", label: "This month" },
];

export type Period = {
  key: PeriodKey;
  label: string;
  /** inclusive, ISO UTC */
  from: string;
  /** exclusive, ISO UTC (start of tomorrow in Karachi) */
  to: string;
  prevFrom: string;
  prevTo: string;
};

/** Start of the Karachi calendar day containing `d`, as a UTC instant. */
export function startOfKarachiDay(d: Date): Date {
  const shifted = d.getTime() + KARACHI_OFFSET_MS;
  return new Date(Math.floor(shifted / DAY_MS) * DAY_MS - KARACHI_OFFSET_MS);
}

export function parsePeriodKey(v: string | null | undefined, allow90 = false): PeriodKey {
  if (v === "7d" || v === "month") return v;
  if (v === "90d" && allow90) return v;
  return "30d";
}

/**
 * A reporting period that ends at the end of today (Karachi) and the period of
 * the same length immediately before it. "This month" is compared with the same
 * number of days at the start of the previous month.
 */
export function periodRange(key: PeriodKey, now: Date = new Date()): Period {
  const tomorrow = new Date(startOfKarachiDay(now).getTime() + DAY_MS);
  if (key === "month") {
    const k = new Date(now.getTime() + KARACHI_OFFSET_MS);
    const y = k.getUTCFullYear();
    const m = k.getUTCMonth();
    const from = new Date(Date.UTC(y, m, 1) - KARACHI_OFFSET_MS);
    const prevFrom = new Date(Date.UTC(y, m - 1, 1) - KARACHI_OFFSET_MS);
    const span = tomorrow.getTime() - from.getTime();
    const prevTo = new Date(Math.min(prevFrom.getTime() + span, from.getTime()));
    return {
      key, label: "This month",
      from: from.toISOString(), to: tomorrow.toISOString(),
      prevFrom: prevFrom.toISOString(), prevTo: prevTo.toISOString(),
    };
  }
  const days = key === "7d" ? 7 : key === "90d" ? 90 : 30;
  const from = new Date(tomorrow.getTime() - days * DAY_MS);
  const prevFrom = new Date(from.getTime() - days * DAY_MS);
  return {
    key, label: `Last ${days} days`,
    from: from.toISOString(), to: tomorrow.toISOString(),
    prevFrom: prevFrom.toISOString(), prevTo: from.toISOString(),
  };
}

/**
 * "2026-11-16T00:00" typed as Karachi wall-clock time → UTC ISO string.
 * Returns null when the text is not a real date and time (handbook R6: the old
 * form sent this text with no zone, so midnight PKT was stored as 05:00 PKT).
 */
export function karachiLocalToUtcIso(local: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec((local ?? "").trim());
  if (!m) return null;
  const [y, mo, d, h, mi, s] = [m[1], m[2], m[3], m[4], m[5], m[6] ?? "0"].map(Number);
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 59) return null;
  const utc = Date.UTC(y, mo - 1, d, h, mi, s);
  const check = new Date(utc);
  // rejects 31 February and the like
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) return null;
  return new Date(utc - KARACHI_OFFSET_MS).toISOString();
}

/** A Karachi calendar date "2026-11-16" → UTC ISO of its start, or of its end (start of next day). */
export function karachiDateToUtcIso(date: string, edge: "start" | "end" = "start"): string | null {
  const iso = karachiLocalToUtcIso(`${(date ?? "").trim()}T00:00`);
  if (!iso) return null;
  return edge === "start" ? iso : new Date(new Date(iso).getTime() + DAY_MS).toISOString();
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** UTC ISO → "YYYY-MM-DDTHH:mm" in Karachi time, for datetime-local inputs. */
export function utcIsoToKarachiLocal(iso: string | null | undefined): string {
  if (!iso) return "";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "";
  const k = new Date(t + KARACHI_OFFSET_MS);
  return `${k.getUTCFullYear()}-${pad(k.getUTCMonth() + 1)}-${pad(k.getUTCDate())}T${pad(k.getUTCHours())}:${pad(k.getUTCMinutes())}`;
}

/** UTC ISO → "YYYY-MM-DD" Karachi date. With edge "end" the instant is treated as exclusive. */
export function utcIsoToKarachiDate(iso: string | null | undefined, edge: "start" | "end" = "start"): string {
  if (!iso) return "";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "";
  return utcIsoToKarachiLocal(new Date(edge === "end" ? t - 1 : t).toISOString()).slice(0, 10);
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/** "16 Nov 2026" in Karachi time. Hand-rolled so server and browser render identical text. */
export function fmtDate(iso: string | null | undefined): string {
  const local = utcIsoToKarachiLocal(iso);
  if (!local) return "";
  const [y, m, d] = local.slice(0, 10).split("-").map(Number);
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

/** "16 Nov 2026, 9:05 pm" in Karachi time. */
export function fmtDateTime(iso: string | null | undefined): string {
  const local = utcIsoToKarachiLocal(iso);
  if (!local) return "";
  const h = Number(local.slice(11, 13));
  const mi = local.slice(14, 16);
  return `${fmtDate(iso)}, ${h % 12 === 0 ? 12 : h % 12}:${mi} ${h < 12 ? "am" : "pm"}`;
}

/** "3 hours", "2 days": how long ago (or until) relative to `now`. */
export function fmtAge(iso: string | null | undefined, now: Date = new Date()): string {
  if (!iso) return "";
  const mins = Math.round(Math.abs(now.getTime() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return "less than a minute";
  if (mins < 60) return `${mins} minute${mins === 1 ? "" : "s"}`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours} hour${hours === 1 ? "" : "s"}`;
  const days = Math.round(hours / 24);
  return `${days} days`;
}

export function fmtInt(n: number | null | undefined): string {
  const v = Math.round(Number(n ?? 0));
  const s = String(Math.abs(v)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return v < 0 ? `-${s}` : s;
}

/** Money is whole rupees in the admin. */
export function fmtPkr(n: number | null | undefined): string {
  return `Rs.${fmtInt(n)}`;
}

export function fmtSigned(n: number): string {
  return n > 0 ? `+${fmtInt(n)}` : fmtInt(n);
}

export function fmtPercent(ratio: number, digits = 0): string {
  if (!Number.isFinite(ratio)) return "0%";
  return `${(ratio * 100).toFixed(digits)}%`;
}

/**
 * Change against the previous period as text. No previous value means there is
 * nothing to compare with, which is said plainly instead of showing "+∞%".
 */
export function fmtChange(current: number, previous: number): { text: string; tone: "up" | "down" | "flat" } {
  if (!previous) return { text: current ? "no earlier data to compare" : "no change", tone: "flat" };
  const pct = Math.round(((current - previous) / previous) * 100);
  if (pct === 0) return { text: "same as previous period", tone: "flat" };
  return pct > 0
    ? { text: `up ${pct}% on previous period`, tone: "up" }
    : { text: `down ${Math.abs(pct)}% on previous period`, tone: "down" };
}

export function tierLabel(tier: string | null | undefined): string {
  return tier === "gold" ? "Gold" : tier === "diamond" ? "Diamond" : "Silver";
}
