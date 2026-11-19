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

export type AddressLike = { address1?: string | null; city?: string | null };

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

function words(v: string): string[] {
  return v
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
}

/**
 * First number in address1 with a single letter straight after it:
 * "House 12" -> "12", "H# 12" -> "12", "Flat 4-B" -> "4b", "12A Street 3" -> "12a".
 * A letter that starts a word ("4-Block") is not taken.
 */
export function houseNumber(address1: string | null | undefined): string | null {
  const m = (address1 ?? "").toLowerCase().match(/(\d+)(?:\s*[-/]?\s*([a-z])(?![a-z]))?/);
  return m ? `${m[1]}${m[2] ?? ""}` : null;
}

export type AddressKey = { city: string; house: string; line: string; tokens: Set<string> };

/** What is compared of an address. Null when the city, address1 or the house number is missing. */
export function addressKey(a: AddressLike | null | undefined): AddressKey | null {
  if (!a) return null;
  const city = words(a.city ?? "").join("");
  const house = houseNumber(a.address1);
  const tokens = words(a.address1 ?? "").map((t) => TOKEN_CANON[t] ?? t).filter(Boolean);
  if (!city || !house || tokens.length === 0) return null;
  return { city, house, line: tokens.join(" "), tokens: new Set(tokens) };
}

/**
 * Strict match: same city AND same house/flat number AND (address1 identical
 * after normalising OR at least 80% of the shorter address1's words appear in
 * the other).
 */
export function sameAddress(a: AddressLike | null | undefined, b: AddressLike | null | undefined): boolean {
  const x = addressKey(a);
  const y = addressKey(b);
  if (!x || !y) return false;
  if (x.city !== y.city || x.house !== y.house) return false;
  if (x.line === y.line) return true;
  const [small, big] = x.tokens.size <= y.tokens.size ? [x.tokens, y.tokens] : [y.tokens, x.tokens];
  let shared = 0;
  for (const t of small) if (big.has(t)) shared++;
  return shared / small.size >= 0.8;
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
