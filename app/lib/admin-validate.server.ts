// app/lib/admin-validate.server.ts
// Server-side validation for every admin form (handbook R3: a cleared field used
// to be saved as 0). Each reader records a message under the field's name and
// returns a safe placeholder, so an action can read every field first and then
// refuse the whole save if anything was wrong.
import { karachiDateToUtcIso, karachiLocalToUtcIso } from "../components/karachi";

export type FieldErrors = Record<string, string>;

type Source = { get(name: string): unknown };

export class FormReader {
  readonly errors: FieldErrors = {};
  constructor(private readonly form: Source) {}

  get ok(): boolean {
    return Object.keys(this.errors).length === 0;
  }

  fail(name: string, message: string): void {
    if (!this.errors[name]) this.errors[name] = message;
  }

  raw(name: string): string {
    const v = this.form.get(name);
    return typeof v === "string" ? v.trim() : "";
  }

  /** Whole number within [min, max]. Blank, decimals and text are rejected. */
  int(name: string, label: string, min: number, max: number): number {
    const raw = this.raw(name);
    if (raw === "") return this.bad(name, `${label} is required.`, min);
    if (!/^-?\d+$/.test(raw)) return this.bad(name, `${label} must be a whole number.`, min);
    const n = Number(raw);
    if (!Number.isSafeInteger(n) || n < min || n > max) {
      return this.bad(name, `${label} must be between ${fmt(min)} and ${fmt(max)}.`, min);
    }
    return n;
  }

  /** Decimal within [min, max] with at most `decimals` places. */
  decimal(name: string, label: string, min: number, max: number, decimals = 2): number {
    const raw = this.raw(name);
    if (raw === "") return this.bad(name, `${label} is required.`, min);
    if (!new RegExp(`^\\d+(\\.\\d{1,${decimals}})?$`).test(raw)) {
      return this.bad(name, `${label} must be a number with at most ${decimals} decimal place${decimals === 1 ? "" : "s"}.`, min);
    }
    const n = Number(raw);
    if (!Number.isFinite(n) || n < min || n > max) {
      return this.bad(name, `${label} must be between ${fmt(min)} and ${fmt(max)}.`, min);
    }
    return n;
  }

  /** Text, trimmed. `required` rejects blank; longer than `max` is rejected, never cut. */
  text(name: string, label: string, opts: { max: number; required?: boolean }): string {
    const raw = this.raw(name);
    if (raw === "" && opts.required) {
      this.fail(name, `${label} is required.`);
      return "";
    }
    if (raw.length > opts.max) {
      this.fail(name, `${label} must be ${fmt(opts.max)} characters or fewer.`);
      return "";
    }
    return raw;
  }

  bool(name: string): boolean {
    const v = this.raw(name);
    return v === "true" || v === "on" || v === "1";
  }

  oneOf<T extends string>(name: string, label: string, allowed: readonly T[]): T {
    const raw = this.raw(name);
    if ((allowed as readonly string[]).includes(raw)) return raw as T;
    this.fail(name, `${label} is not a valid choice.`);
    return allowed[0];
  }

  /** http(s) link. Blank is allowed unless `required`. */
  url(name: string, label: string, opts: { required?: boolean } = {}): string {
    const raw = this.raw(name);
    if (raw === "") {
      if (opts.required) this.fail(name, `${label} is required.`);
      return "";
    }
    if (raw.length > 300 || !/^https?:\/\/[^\s"'<>]+\.[^\s"'<>]+$/i.test(raw)) {
      this.fail(name, `${label} must be a full link starting with https://`);
      return "";
    }
    return raw;
  }

  /** Karachi wall-clock "YYYY-MM-DDTHH:mm" → UTC ISO. */
  karachiDateTime(name: string, label: string): string {
    const raw = this.raw(name);
    if (raw === "") {
      this.fail(name, `${label} is required.`);
      return "";
    }
    const iso = karachiLocalToUtcIso(raw);
    if (!iso) this.fail(name, `${label} is not a valid date and time.`);
    return iso ?? "";
  }

  /** Optional Karachi calendar date → UTC ISO of its start (or end). Blank → null. */
  karachiDate(name: string, label: string, edge: "start" | "end"): string | null {
    const raw = this.raw(name);
    if (raw === "") return null;
    const iso = karachiDateToUtcIso(raw, edge);
    if (!iso) this.fail(name, `${label} is not a valid date.`);
    return iso;
  }

  private bad(name: string, message: string, placeholder: number): number {
    this.fail(name, message);
    return placeholder;
  }
}

function fmt(n: number): string {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** First message, for a banner above a form. */
export function firstError(errors: FieldErrors): string {
  const k = Object.keys(errors)[0];
  return k ? errors[k] : "";
}

export type ActionResult =
  | { ok: true; message: string; warning?: string }
  | { ok: false; error: string; errors?: FieldErrors };

export function invalid(errors: FieldErrors): { ok: false; error: string; errors: FieldErrors } {
  return { ok: false, error: firstError(errors) || "Please check the form.", errors };
}

/** Turn anything thrown into text that is safe to show staff (never a stack). */
export function errorMessage(e: unknown): string {
  const m = e instanceof Error ? e.message : typeof e === "string" ? e : "";
  return m ? m.slice(0, 300) : "Something went wrong. Please try again.";
}

const REASONS: Record<string, string> = {
  not_found: "That record no longer exists. Reload the page.",
  member_not_found: "That customer no longer exists.",
  not_a_reward_code: "Only reward codes bought with points can be cancelled.",
  not_active: "That code has already been used, cancelled or has expired.",
  shopify_unavailable: "Shopify could not be reached. Nothing was changed. Try again in a minute.",
  shopify_error: "Shopify refused the change. Nothing was changed.",
  db_error: "The change could not be saved. Try again.",
  invalid_multiplier: "The multiplier is outside the allowed range.",
  invalid_date: "One of the dates is not valid.",
  end_before_start: "The end date must be after the start date.",
  invalid_code: "A code is 3 to 32 letters or numbers (dashes and underscores allowed), with no spaces.",
  invalid_percent: "The discount must be between 1% and 90%.",
  not_an_influencer: "Mark her as an influencer first.",
  code_exists: "She already has a code. Remove it before creating another.",
  code_taken: "That code is already in use. Choose a different one.",
  no_code: "She has no discount code to remove.",
  already_set: "The birthday is already set.",
  not_flagged: "That referral is no longer held for review.",
  already_reviewed: "That referral has already been reviewed.",
};

/** A service's machine reason → a sentence for staff. Unknown reasons are shown as they are. */
export function reasonText(reason: string | undefined | null, fallback = "The change could not be made."): string {
  if (!reason) return fallback;
  return REASONS[reason] ?? `${fallback} (${reason.replace(/_/g, " ")})`;
}
