// app/lib/referral-checks.server.ts
// Pure comparisons for the referral fraud rules (contract rule 10). Nothing
// here reads the database or Shopify, and nothing here is stored: callers
// compare in memory and keep only a reason code.
//
//   at the friend's sign-in   same email / same phone      -> blocked
//                             similar email / same name    -> held (flagged)
//   on the friend's first qualifying order (fulfilled + paid), code or no
//   code, and earlier on an order that used her free-shipping code
//                             the referrer's own phone     -> blocked
//                             a phone from her past orders
//                             or saved addresses (gift?)   -> held (flagged)
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

/*
 * Address comparison (owner decisions 19 Nov 2026, round 9). An address only
 * ever HOLDS a referral, never blocks it, so the rule leans towards "no match"
 * when the evidence is thin. Each address is read into:
 *   - labelled numbers: house, street, road, block, phase, sector, flat, plot,
 *     lane, floor, building, town -> "house:12", "street:5", "block:a",
 *     "phase:6" ("Phase VI" = 6), "flat:4b" ("Flat B-4" = "4-B" = "4B")
 *   - sector codes without a label: "G-9/1" = "G 9/1" = "G9/1" = "G-9-1",
 *     "F-7", "I-8" -> "sector:g9/1"
 *   - unlabelled numbers ("Askari 11", "Gulberg III" -> 3), compared as a set
 *   - locality words: what is left after dropping the city names, "Pakistan",
 *     provinces, filler ("near", "opposite", "behind") and generic words
 *     ("town", "colony", "road" ...)
 * Two addresses match when: same city AND the same labelled numbers (a label
 * on one side only = no match) AND the same unlabelled numbers AND
 * (at least one locality word in common, OR the same sector code, OR nothing
 * else at all on either side, e.g. "H# 12 St 5" = "House No 12 Street 5").
 * Order does not matter: "G-9/1, House 12" = "House 12, G-9/1", and
 * "Street 12, House 5" is not "House 12, Street 5".
 *
 * "H-12" (also "H 12", "H12"): Islamabad has a sector H-12, and "H" is also
 * the usual short form of "House". Read as:
 *   - a sector when the address already has a house number written another way;
 *   - house 12 when another sector code is present, or "street"/"st" follows;
 *   - otherwise BOTH readings are tried, and either may match (an address
 *     result only holds the referral for staff, so a possible match is shown).
 * "H#12", "H no 12", "H.No.12", "House No. 12" are always house 12.
 */

/** Words that label the number (or single letter / Roman numeral) after them. */
const LABELS: Record<string, string> = {
  house: "house", hno: "house", hse: "house", home: "house",
  street: "street", st: "street", str: "street", gali: "street", galli: "street",
  road: "road", rd: "road",
  block: "block", blk: "block",
  phase: "phase", ph: "phase",
  sector: "sector", sec: "sector",
  flat: "flat", apt: "flat", apartment: "flat", unit: "flat", suite: "flat", portion: "flat",
  plot: "plot",
  lane: "lane",
  floor: "floor",
  building: "building", bldg: "building", tower: "building",
  town: "town",
};
/** Labels whose letter goes after the number ("Flat B-4" = "4b"); the others keep a code's letter first. */
const DWELLING = new Set(["house", "flat", "plot", "building"]);
/** Between a label and its number: "House No. 12", "St # 5". */
const FILLER_AFTER_LABEL = new Set(["no", "number", "num", "nmbr"]);

/** City field forms read as the same city. */
const CITY_ALIASES: Record<string, string> = {
  pindi: "rawalpindi", rwp: "rawalpindi", isb: "islamabad", isl: "islamabad", khi: "karachi", lhr: "lahore", fsd: "faisalabad",
};
const PROVINCES = new Set(["pakistan", "pk", "sindh", "punjab", "kpk", "kp", "khyber", "pakhtunkhwa", "balochistan", "baluchistan", "ict", "ajk"]);
/** City names dropped from the address line (the order's own city is dropped too). */
const CITY_WORDS = new Set([
  "karachi", "lahore", "islamabad", "rawalpindi", "pindi", "faisalabad", "multan", "peshawar", "quetta", "sialkot", "gujranwala",
  "hyderabad", "abbottabad", "bahawalpur", "sargodha", "sukkur", "larkana", "sheikhupura", "gujrat", "mardan", "kasur", "sahiwal",
  "okara", "jhelum", "taxila", "wah", "mirpur", "muzaffarabad",
]);
/** Words that never tell two places apart. */
const GENERIC = new Set([
  "near", "opp", "opposite", "behind", "beside", "nearby", "adjacent", "front", "back", "side", "the", "of", "and", "in", "at", "to", "on",
  "town", "colony", "society", "scheme", "housing", "city", "cantt", "cantonment", "extension", "ext", "main", "road", "street",
  "avenue", "boulevard", "lane", "mohalla", "gali", "area", "sector", "block", "phase", "plot", "house", "flat", "floor", "building",
  "tower", "apartment", "apartments", "portion", "upper", "lower", "ground", "first", "second", "third", "no", "number", "pakistan",
]);
const ROMAN: Record<string, number> = {
  ii: 2, iii: 3, iv: 4, vi: 6, vii: 7, viii: 8, ix: 9, xi: 11, xii: 12, xiii: 13, xiv: 14, xv: 15, xvi: 16, xvii: 17, xviii: 18, xix: 19, xx: 20,
};

/** Arabic-Indic (٠-٩) and Urdu/Persian (۰-۹) digits as 0-9. */
function asciiDigits(v: string): string {
  return v.replace(/[٠-٩۰-۹]/g, (d) => String((d.charCodeAt(0) & 0xf) % 10));
}

/** Lowercase text with phone numbers, postcodes and punctuation removed; "-" and "/" kept for codes. */
function cleanLine(v: string): string {
  let s = asciiDigits(v.normalize("NFKC")).toLowerCase();
  // Phone-like digit runs (10-13 digits, spaces/dashes allowed: +92 300 1234567, 0300-1234567).
  s = s.replace(/\+?\d[\d\s-]{8,18}\d/g, (m) => {
    const n = m.replace(/\D/g, "").length;
    return n >= 10 && n <= 13 ? " " : m;
  });
  s = s.replace(/(?<!\d)\d{5}(?![\d/-])/g, " "); // 5-digit postcode
  // "H#12", "H # 12", "H no 12", "H.No.12", "h. no. 12": always the house number.
  s = s.replace(/(?<![\p{L}\p{N}])h\s*(?:#|\.?\s*no\b\.?)/gu, " house ");
  return s.replace(/[^\p{L}\p{N}/\-\s]+/gu, " ");
}

type Tok =
  | { t: "code"; l: string; n: string } // letter(s) + number with a sub-number: g9/1
  | { t: "ln"; l: string; n: string } // single letter + number: h12, b4, f7
  | { t: "nl"; n: string; l: string } // number + single letter: 12a, 4b
  | { t: "num"; n: string; ord?: boolean }
  | { t: "word"; w: string };

const LEX = new RegExp(
  [
    String.raw`(?<![\p{L}\p{N}])(?<cl>(?!(?:st|ph|rd|no|h)\b)[a-z]{1,2})[ -]?(?<cn>\d+(?:\s*[/-]\s*\d+)+)(?![\p{L}\p{N}])`,
    String.raw`(?<![\p{L}\p{N}])(?<ord>\d+)(?:st|nd|rd|th)(?![\p{L}\p{N}])`,
    String.raw`(?<![\p{L}\p{N}])(?<ll>[a-z])[ -]?(?<ln>\d+)(?![\p{L}\p{N}/])`,
    // not a letter that starts a code: "Street 5 G 9/1", "Street 3 H-12"
    String.raw`(?<![\p{L}\p{N}])(?<nn>\d+)[ -]?(?<nl>[a-z])(?![\p{L}\p{N}])(?!\s*-?\s*\d)`,
    String.raw`(?<num>\d+(?:/\d+)*)`,
    String.raw`(?<w>\p{L}+)`,
  ].join("|"),
  "gu",
);

function lex(line: string): Tok[] {
  const out: Tok[] = [];
  for (const m of line.matchAll(LEX)) {
    const g = m.groups ?? {};
    if (g.cl) out.push({ t: "code", l: g.cl, n: g.cn.replace(/\s+/g, "").replace(/-/g, "/") });
    else if (g.ord) out.push({ t: "num", n: g.ord, ord: true });
    else if (g.ll) out.push({ t: "ln", l: g.ll, n: g.ln });
    else if (g.nn) out.push({ t: "nl", n: g.nn, l: g.nl });
    else if (g.num) out.push({ t: "num", n: g.num });
    else if (g.w) out.push(ROMAN[g.w] ? { t: "num", n: String(ROMAN[g.w]) } : { t: "word", w: g.w });
  }
  return out;
}

/** One reading of an address (an ambiguous "H-12" gives two). */
export type AddressReading = {
  city: string;
  /** "house:12", "street:5", "sector:g9/1", ... */
  labelled: Set<string>;
  /** Numbers without a label ("Askari 11" -> "11"). */
  numbers: Set<string>;
  /** Locality words (city, filler and generic words removed). */
  words: Set<string>;
  sectors: Set<string>;
};

/** address1 and address2 as one line (address2 is often the flat, street or area). */
function fullLine(a: AddressLike): string {
  return [a.address1, a.address2].map((v) => (typeof v === "string" ? v.trim() : "")).filter(Boolean).join(" ");
}

/** The city as compared: lowercase words without province/country, aliases applied. */
export function cityKey(city: string | null | undefined): string {
  return lex(cleanLine(city ?? ""))
    .flatMap((t) => (t.t === "word" ? [CITY_ALIASES[t.w] ?? t.w] : []))
    .filter((w) => !PROVINCES.has(w))
    .join("");
}

/**
 * The readings of an address, or [] when it cannot be compared: no city, or
 * nothing that identifies a home (no house, flat or plot number, no
 * unlabelled number, no letter-number code such as "A-12").
 */
export function addressReadings(a: AddressLike | null | undefined): AddressReading[] {
  if (!a) return [];
  const city = cityKey(a.city);
  if (!city) return [];
  const ownCity = new Set(lex(cleanLine(a.city ?? "")).flatMap((t) => (t.t === "word" ? [t.w] : [])));
  const toks = lex(cleanLine(fullLine(a)));
  if (toks.length === 0) return [];

  const labelled = new Set<string>();
  const numbers = new Set<string>();
  const words = new Set<string>();
  const sectors = new Set<string>();
  const hCodes: Array<{ n: string; streetNext: boolean }> = [];
  let home = false;
  const addLabel = (label: string, value: string) => {
    labelled.add(`${label}:${value}`);
    if (label === "sector") sectors.add(value);
    if (DWELLING.has(label)) home = true;
  };

  for (let i = 0; i < toks.length; i++) {
    const tok = toks[i];
    if (tok.t === "word") {
      const label = LABELS[tok.w];
      if (label) {
        // the value: the next token after any "no"/"number"
        let j = i + 1;
        while (j < toks.length && toks[j].t === "word" && FILLER_AFTER_LABEL.has((toks[j] as { w: string }).w)) j++;
        const v = toks[j];
        let value: string | null = null;
        if (v?.t === "num" && !v.ord) value = v.n.replace(/-/g, "/");
        else if (v?.t === "nl") value = DWELLING.has(label) ? `${v.n}${v.l}` : `${v.l}${v.n}`;
        else if (v?.t === "ln") value = DWELLING.has(label) ? `${v.n}${v.l}` : `${v.l}${v.n}`;
        else if (v?.t === "code") value = `${v.l}${v.n}`;
        else if (v?.t === "word" && v.w.length === 1 && v.w !== "e") value = v.w; // "Block A", "Sector C"
        if (value !== null) {
          addLabel(label, value);
          i = j;
          continue;
        }
        if (label === "floor") {
          // "1st Floor": the number is before the label
          const p = toks[i - 1];
          if (p?.t === "num" && p.ord) {
            numbers.delete(p.n);
            addLabel("floor", p.n);
          }
        }
        continue; // a label word with no value is generic
      }
      if (tok.w.length > 1 && !GENERIC.has(tok.w) && !CITY_WORDS.has(tok.w) && !ownCity.has(tok.w) && !PROVINCES.has(tok.w)
        && !FILLER_AFTER_LABEL.has(tok.w)) words.add(tok.w);
      continue;
    }
    if (tok.t === "code") addLabel("sector", `${tok.l}${tok.n}`);
    else if (tok.t === "ln" && tok.l === "h") {
      const next = toks[i + 1];
      hCodes.push({ n: tok.n, streetNext: next?.t === "word" && LABELS[next.w] === "street" });
    } else if (tok.t === "ln") {
      addLabel("sector", `${tok.l}${tok.n}`); // "F-7", "I-8"; also Karachi's "A-12" (read as a code, not a house)
      home = true;
    } else if (tok.t === "nl") {
      numbers.add(`${tok.n}${tok.l}`);
      home = true;
    } else if (tok.t === "num") {
      // an ordinal straight before "floor" is taken by the floor label above
      if (!(tok.ord && toks[i + 1]?.t === "word" && LABELS[(toks[i + 1] as { w: string }).w] === "floor")) {
        numbers.add(tok.n.replace(/-/g, "/"));
        home = true;
      }
    }
  }

  const base = (): AddressReading => ({ city, labelled: new Set(labelled), numbers: new Set(numbers), words, sectors: new Set(sectors) });
  const hasHouse = [...labelled].some((l) => l.startsWith("house:"));
  let readings: AddressReading[] = [base()];
  for (const h of hCodes) {
    const asSector = (r: AddressReading) => { r.labelled.add(`sector:h${h.n}`); r.sectors.add(`h${h.n}`); };
    const asHouse = (r: AddressReading) => { r.labelled.add(`house:${h.n}`); };
    if (hasHouse) readings.forEach(asSector);
    else if (sectors.size > 0 || h.streetNext) readings.forEach(asHouse);
    else {
      readings = readings.flatMap((r) => {
        const s = { ...r, labelled: new Set(r.labelled), sectors: new Set(r.sectors) };
        const hs = { ...r, labelled: new Set(r.labelled), sectors: new Set(r.sectors) };
        asSector(s);
        asHouse(hs);
        return [hs, s];
      });
    }
    home = true;
  }
  if (!home) return [];
  return readings;
}

const sameSet = (a: Set<string>, b: Set<string>) => a.size === b.size && [...a].every((v) => b.has(v));
const shares = (a: Set<string>, b: Set<string>) => [...a].some((v) => b.has(v));

function readingsMatch(x: AddressReading, y: AddressReading): boolean {
  if (x.city !== y.city) return false;
  if (!sameSet(x.labelled, y.labelled) || !sameSet(x.numbers, y.numbers)) return false;
  if (shares(x.words, y.words)) return true;
  if (shares(x.sectors, y.sectors)) return true;
  return x.words.size === 0 && y.words.size === 0; // nothing else written on either side
}

/** Same place (see the rules above). Never stored or logged: a yes/no only. */
export function sameAddress(a: AddressLike | null | undefined, b: AddressLike | null | undefined): boolean {
  const xs = addressReadings(a);
  const ys = addressReadings(b);
  return xs.some((x) => ys.some((y) => readingsMatch(x, y)));
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
  same_order_phone_on_order: "The friend's order goes to a phone number the referrer used on one of her earlier orders or saved addresses (could be a gift)",
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

/**
 * "same_order_phone" (owner decision 19 Nov 2026, gift orders): the order's
 * phone is not one of the referrer's own account phones but was found on one
 * of her recent orders or saved addresses, so the friend's order may be a
 * gift the referrer once sent her: held for staff, not blocked. Stored as
 * order_check "same_phone" with status flagged and flag
 * same_order_phone_on_order (016's check constraint allows only the four
 * stored values).
 */
export type OrderCheckResult = "clear" | "not_checked" | "same_phone" | "same_order_phone" | "same_address";

/**
 * Decision on the friend's order: its shipping phone and address against the
 * referrer's. `ownPhones` = her account phones (members.phone, Shopify
 * defaultPhoneNumber): a match blocks. `otherPhones` = phones on her saved
 * addresses and recent orders: a match only holds. "not_checked" when nothing
 * could be compared (no shipping details on the order, or none for the referrer).
 */
export function orderVerdict(
  order: { phone?: string | null; address?: AddressLike | null } | null,
  referrer: {
    ownPhones: Array<string | null | undefined>;
    otherPhones?: Array<string | null | undefined>;
    addresses: Array<AddressLike | null | undefined>;
  },
): OrderCheckResult {
  const orderPhone = phoneKey(order?.phone);
  const keys = (list: Array<string | null | undefined>) => list.map(phoneKey).filter((p): p is string => !!p);
  const own = keys(referrer.ownPhones);
  const other = keys(referrer.otherPhones ?? []);
  const comparable = addressReadings(order?.address).length > 0;
  const addresses = referrer.addresses.filter((a) => addressReadings(a).length > 0);
  const phoneComparable = !!orderPhone && own.length + other.length > 0;
  const addressComparable = comparable && addresses.length > 0;
  if (!phoneComparable && !addressComparable) return "not_checked";
  if (phoneComparable && own.includes(orderPhone)) return "same_phone";
  if (phoneComparable && other.includes(orderPhone)) return "same_order_phone";
  if (addressComparable && addresses.some((a) => sameAddress(order?.address, a))) return "same_address";
  return "clear";
}
