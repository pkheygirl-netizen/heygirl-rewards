// app/lib/referral-checks.server.ts
// Pure comparisons for the referral fraud rules (contract rule 10). Nothing
// here reads the database or Shopify, and nothing here is stored: callers
// compare in memory and keep only a reason code.
//
//   at the friend's sign-in   same email / same phone      -> blocked
//                             similar email / same name    -> held (flagged)
//   on an order that used the friend's free-shipping code
//                             same shipping phone          -> blocked
//                             same shipping address        -> held (flagged)

// ── email ──────────────────────────────────────────────────────────────────

const GMAIL_DOMAINS = new Set(["gmail.com", "googlemail.com"]);

function splitEmail(email: string | null | undefined): { local: string; domain: string } | null {
  const e = typeof email === "string" ? email.trim().toLowerCase() : "";
  const at = e.lastIndexOf("@");
  if (at <= 0 || at === e.length - 1) return null;
  let local = e.slice(0, at);
  let domain = e.slice(at + 1);
  const plus = local.indexOf("+");
  if (plus >= 0) local = local.slice(0, plus); // "+tag" is dropped for every domain
  if (GMAIL_DOMAINS.has(domain)) {
    domain = "gmail.com"; // googlemail.com is the same mailbox as gmail.com
    local = local.replace(/\./g, ""); // Gmail ignores dots in the name part
  }
  return local ? { local, domain } : null;
}

/** Lowercase, trimmed, "+tag" dropped, Gmail dots removed and googlemail.com = gmail.com. */
export function normaliseEmail(email: string | null | undefined): string | null {
  const p = splitEmail(email);
  return p ? `${p.local}@${p.domain}` : null;
}

export function sameEmail(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = normaliseEmail(a);
  return !!x && x === normaliseEmail(b);
}

/**
 * The name part of an email for the "similar email" hold: normalised as above,
 * then dots, underscores and hyphens removed (for every domain, so
 * ayesha.khan1@yahoo.com and ayeshakhan@gmail.com compare equal) and trailing
 * digits removed. Null when fewer than 6 characters are left.
 */
export function emailSimilarityKey(email: string | null | undefined): string | null {
  const p = splitEmail(email);
  if (!p) return null;
  const key = p.local.replace(/[._-]/g, "").replace(/\d+$/, "");
  return key.length >= 6 ? key : null;
}

/** Same name part (any domain), not counting the exact same address (that is sameEmail). */
export function similarEmail(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = emailSimilarityKey(a);
  return !!x && x === emailSimilarityKey(b);
}

// ── phone ──────────────────────────────────────────────────────────────────

/** Last 10 digits, so +92 300 1234567, 0092300..., and 0300-1234567 match. Null under 10 digits. */
export function phoneKey(v: string | null | undefined): string | null {
  const d = (v ?? "").replace(/\D/g, "");
  return d.length >= 10 ? d.slice(-10) : null;
}

export function samePhone(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = phoneKey(a);
  return !!x && x === phoneKey(b);
}

// ── name ───────────────────────────────────────────────────────────────────

/** Lowercase with every space and punctuation mark removed ("Al-Khan " = "al khan" = "alkhan"). */
function nameKey(v: string | null | undefined): string {
  return (v ?? "").normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

/** Same first AND last name; both names must be present on both people. */
export function sameFullName(
  a: { first_name?: string | null; last_name?: string | null },
  b: { first_name?: string | null; last_name?: string | null },
): boolean {
  const af = nameKey(a.first_name), al = nameKey(a.last_name);
  const bf = nameKey(b.first_name), bl = nameKey(b.last_name);
  if (!af || !al || !bf || !bl) return false;
  return af === bf && al === bl;
}

// ── address ────────────────────────────────────────────────────────────────

export type AddressLike = { address1?: string | null; address2?: string | null; city?: string | null };

/** Common abbreviations written the same way, and filler words dropped, before tokens are compared. */
const TOKEN_CANON: Record<string, string> = {
  h: "house", hno: "house", hse: "house",
  st: "street", str: "street",
  rd: "road",
  blk: "block",
  ph: "phase",
  apt: "flat", apartment: "flat",
  sec: "sector",
  no: "", number: "",
};

/**
 * Words that only say what kind of number follows ("House 12", "Phase 6") or
 * join words together. They do not tell two places apart, so they do not count
 * towards the 3 meaningful words the similarity rule needs.
 */
const STRUCTURE_WORDS = new Set([
  "house", "flat", "street", "road", "block", "phase", "sector", "plot", "lane", "floor", "unit", "suite", "gali",
  "near", "opp", "opposite", "behind", "the", "of", "and",
]);

/** Line text as compared: lowercase, "#" and other marks as spaces; "-" and "/" kept for the number codes. */
function lineText(v: string): string {
  return v.normalize("NFKC").toLowerCase();
}

/** A single letter written straight after a number ("12A", "4-B"), not one that starts a word or a code ("4-Block", "12 G-9/1"). */
const SUFFIX = String.raw`(?:\s*[-/]?\s*([a-z])(?![a-z]|\s*[-/]?\s*\d))?`;
const JOIN_SUFFIX = new RegExp(String.raw`(\d+)${SUFFIX}`, "g");
const JOIN_CODE = /(?<![\p{L}\p{N}])([a-z])-(?=\d)/gu;

/**
 * Words of an address line. A flat letter is joined to its number first
 * ("4-B" = "4 B" = "4B" -> "4b") and a sector letter to its code ("G-9/1" =
 * "G9/1"), so the same address written two ways gives the same words.
 */
function words(v: string): string[] {
  return lineText(v)
    .replace(JOIN_SUFFIX, (_m, n: string, l?: string) => `${n}${l ?? ""}`)
    .replace(JOIN_CODE, "$1")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
}

/**
 * First number in address1 with a single letter straight after it:
 * "House 12" -> "12", "H# 12" -> "12", "Flat 4-B" -> "4b", "12A Street 3" -> "12a".
 * A letter that starts a word ("4-Block") or a sector code ("12 G-9/1") is not taken.
 */
export function houseNumber(address1: string | null | undefined): string | null {
  const m = lineText(address1 ?? "").match(new RegExp(String.raw`(\d+)${SUFFIX}`));
  return m ? `${m[1]}${m[2] ?? ""}` : null;
}

/**
 * Every number in the address, each with what is written straight onto it:
 * "House 12, Street 5, G-9/1" -> {12, 5, g9/1}; "Flat 4-B, Block 7" -> {4b, 7};
 * "DHA Phase 6" -> {6}. A single letter joined to the number by a hyphen or
 * nothing ("G-9/1", "F7") is a sector code and kept with it; a letter word
 * before a space ("H 12", "H# 12") is not ("H" is the house abbreviation).
 */
export function numberTokens(line: string | null | undefined): Set<string> {
  const re = new RegExp(String.raw`(?:(?<![\p{L}\p{N}])([a-z])-?)?(?<!\d)(\d+(?:[-/]\d+)*)${SUFFIX}`, "gu");
  const out = new Set<string>();
  for (const m of lineText(line ?? "").matchAll(re)) out.add(`${m[1] ?? ""}${m[2].replace(/-/g, "/")}${m[3] ?? ""}`);
  return out;
}

export type AddressKey = {
  city: string;
  house: string;
  line: string;
  tokens: Set<string>;
  numbers: Set<string>;
  /** Words that are neither numbers nor structure words ("house", "street", ...). */
  meaningful: number;
};

/** address1 and address2 as one line (address2 is often the flat, street or area). */
function fullLine(a: AddressLike): string {
  return [a.address1, a.address2].map((v) => (typeof v === "string" ? v.trim() : "")).filter(Boolean).join(" ");
}

/** What is compared of an address. Null when the city, address1 or the house number is missing. */
export function addressKey(a: AddressLike | null | undefined): AddressKey | null {
  if (!a) return null;
  const city = words(a.city ?? "").join("");
  const house = houseNumber(a.address1);
  const line = fullLine(a);
  const tokens = words(line).map((t) => TOKEN_CANON[t] ?? t).filter(Boolean);
  if (!city || !house || tokens.length === 0) return null;
  const meaningful = tokens.filter((t) => !/\d/.test(t) && t.length > 1 && !STRUCTURE_WORDS.has(t)).length;
  return { city, house, line: tokens.join(" "), tokens: new Set(tokens), numbers: numberTokens(line), meaningful };
}

/** Minimum meaningful words in the shorter address before "mostly the same words" can count as a match. */
export const MIN_MEANINGFUL_WORDS = 3;

const sameSet = (a: Set<string>, b: Set<string>) => a.size === b.size && [...a].every((v) => b.has(v));

/**
 * Strict match (address1 and address2 read as one line):
 *   same city AND same house/flat number AND the same numbers everywhere else
 *   (street, block, phase, sector, flat, "G-9/1" codes: one number different
 *   or missing on one side = a different place) AND
 *   (the line is identical after normalising, abbreviations included, OR the
 *   shorter address has at least 3 meaningful words besides the numbers and
 *   at least 80% of its words appear in the other).
 * "House 12" alone therefore matches only "House 12" in the same city.
 */
export function sameAddress(a: AddressLike | null | undefined, b: AddressLike | null | undefined): boolean {
  const x = addressKey(a);
  const y = addressKey(b);
  if (!x || !y) return false;
  if (x.city !== y.city || x.house !== y.house) return false;
  if (!sameSet(x.numbers, y.numbers)) return false;
  if (x.line === y.line) return true;
  const [small, big] = x.tokens.size <= y.tokens.size ? [x, y] : [y, x];
  if (small.meaningful < MIN_MEANINGFUL_WORDS) return false;
  let shared = 0;
  for (const t of small.tokens) if (big.tokens.has(t)) shared++;
  return shared / small.tokens.size >= 0.8;
}

// ── verdicts ───────────────────────────────────────────────────────────────

export type Person = {
  email?: string | null;
  phone?: string | null;
  first_name?: string | null;
  last_name?: string | null;
};

/** Reason codes stored in referrals.fraud_flags (the admin shows them in plain words). */
export const SIGNIN_FLAGS = {
  same_email: "The friend's email is the referrer's email",
  same_phone: "The friend's phone number is the referrer's",
  similar_email: "The friend's email looks like the referrer's",
  same_name: "The friend has the same first and last name as the referrer",
} as const;

/** Tag added in Shopify to an order that matched the referrer (owner decision, 19 Nov 2026). */
export const REFERRAL_ORDER_TAG = "Rewards: check referral";

export const ORDER_FLAGS = {
  same_phone_on_order: "The friend's order uses the referrer's phone number",
  same_address_on_order: "The friend's order delivers to the referrer's address",
} as const;

/**
 * Decision at the friend's first sign-in. Blocked beats held: a blocked
 * referral carries only the blocking reasons.
 */
export function signInVerdict(
  friend: Person,
  referrer: Person,
): { status: "pending" | "flagged" | "blocked"; flags: string[]; blockReason: string | null } {
  const block: Array<keyof typeof SIGNIN_FLAGS> = [];
  if (sameEmail(friend.email, referrer.email)) block.push("same_email");
  if (samePhone(friend.phone, referrer.phone)) block.push("same_phone");
  if (block.length) return { status: "blocked", flags: block, blockReason: block.map((f) => SIGNIN_FLAGS[f]).join("; ") };

  const hold: Array<keyof typeof SIGNIN_FLAGS> = [];
  if (similarEmail(friend.email, referrer.email)) hold.push("similar_email");
  if (sameFullName(friend, referrer)) hold.push("same_name");
  if (hold.length) return { status: "flagged", flags: hold, blockReason: hold.map((f) => SIGNIN_FLAGS[f]).join("; ") };

  return { status: "pending", flags: [], blockReason: null };
}

/** Reason code for an order check Shopify never answered, even on the background job's last try (the referral is held). */
export const ORDER_CHECK_FAILED_FLAG = "order_check_failed";
export const ORDER_CHECK_FAILED_REASON = "Her order could not be checked against the referrer's phone and address: Shopify did not answer, even after an hour of retries";

export type OrderCheckResult = "clear" | "not_checked" | "same_phone" | "same_address";

/**
 * Decision on the friend's order: its shipping phone and address against the
 * referrer's phones and addresses. "not_checked" when nothing could be
 * compared (no shipping details on the order, or none for the referrer).
 */
export function orderVerdict(
  order: { phone?: string | null; address?: AddressLike | null } | null,
  referrer: { phones: Array<string | null | undefined>; addresses: Array<AddressLike | null | undefined> },
): OrderCheckResult {
  const orderPhone = phoneKey(order?.phone);
  const orderAddress = addressKey(order?.address);
  const phones = referrer.phones.map(phoneKey).filter((p): p is string => !!p);
  const addresses = referrer.addresses.filter((a) => addressKey(a) !== null);
  const phoneComparable = !!orderPhone && phones.length > 0;
  const addressComparable = !!orderAddress && addresses.length > 0;
  if (!phoneComparable && !addressComparable) return "not_checked";
  if (phoneComparable && phones.includes(orderPhone)) return "same_phone";
  if (addressComparable && addresses.some((a) => sameAddress(order?.address, a))) return "same_address";
  return "clear";
}
