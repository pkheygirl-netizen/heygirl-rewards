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
 * Address comparison (owner decisions 19 Nov 2026, rounds 9, 10 and 11). An
 * address only ever HOLDS a referral, never blocks it, so the rule leans
 * towards "no match" when the evidence is thin. Each address (address1 and
 * address2 read as one line, address2 after a comma) is read into:
 *   - labelled numbers: house (also "villa"), street, road, block, phase,
 *     sector (also Bahria Town Karachi's "precinct"), flat, plot, lane, floor,
 *     building, town -> "house:12", "street:5", "block:a", "phase:6" ("Phase
 *     VI" = "Phase 6"), "flat:4b" ("Flat B-4" = "4-B" = "4B" = "B4"). A label
 *     takes the number right after it, never across a comma ("Faisal Town,
 *     123-A": 123-A is not the town's number); road and town take a plain
 *     number of at most 4 digits only. "D Block" = "Block D", "10 D Block" =
 *     house 10, block D. After phase, block, sector, askari, gulberg and town a
 *     single I, V or X is a Roman numeral ("Phase V" = 5, "Askari X" = 10);
 *     ii..xx are read as numbers anywhere. A label word with one letter wrong,
 *     missing, extra or swapped ("Stret 12", "Hous 5") is read as the label
 *     when a number follows it.
 *   - sector codes: "G-9/1" = "G 9/1" = "G9/1" = "G-9-1" (any city), and in
 *     Islamabad also "F-7", "I-8" -> "sector:g9/1", "sector:f7" (only for the
 *     real sector letters D, E, F, G, H, I; "A-12", "B-4" there are homes).
 *   - numbers and codes without a label ("Askari 11", "Gulberg III" -> 3,
 *     "33A", Karachi's "A-12" -> "12a"), compared as a set. "ext"/"extension"
 *     is kept as a mark in this set: "Phase 2 Extension" is not "Phase 2".
 *   - locality words: what is left after dropping the city names, "Pakistan",
 *     provinces, filler ("near", "opposite", "behind") and generic words
 *     ("town", "colony", "road" ...). Weak words (north, south, east, west,
 *     new, old, gulshan, khayaban, shahrah) and landmark words (masjid, bazar,
 *     market, hospital, school, park ...) do not tell two places apart on
 *     their own: "North Nazimabad" is not "North Karachi", "Gulshan-e-Iqbal"
 *     is not "Gulshan-e-Hadeed". A landmark word before "road"/"street"
 *     ("University Road", "Mall Road") or "town"/"colony" ("University Town")
 *     names the road or town and counts fully, as "university~road" or
 *     "university~town" (so "University Town" is not "University Road").
 *     Words split on one side and joined on the other ("Gul Bahar" =
 *     "Gulbahar") and words of 6+ letters with one letter wrong ("Nazimabd")
 *     are the same word. "F.B. Area" = "Federal B Area" = "FB Area".
 *   - road and town names: the word before road/street/avenue/boulevard/lane
 *     (without a number) or after khayaban/shahrah ("Bank Road", "Khayaban-e-
 *     Ittehad"), and the word before town/colony ("Johar Town"). When both
 *     addresses name a road (or a town) and none is the same, they are not the
 *     same place, whatever else they share.
 * Phone numbers (Pakistani mobile and landline shapes, with their own digit
 * boundaries, so "House 12 0321-1234567" keeps 12, and any 7-9 digit run, a
 * landline written without its area code) are removed first, then 5-digit
 * postcodes unless a label is right before them ("House 10234" is kept). The
 * city field drops provinces, "Cantt", "Cantonment", "Capital Territory",
 * "ICT"; Pindi = Rawalpindi; a one-letter typo of a known city is that city
 * ("Karchi" = Karachi); Islamabad and Rawalpindi count as one city.
 * Two addresses match when they are in the same city AND EITHER
 *   (a) the cleaned lines are identical and carry at least 2 labelled numbers
 *       (owner decision 19 Nov 2026: "House 12, Street 5" written the same way
 *       twice in the same city holds; a lone "House 12" never matches), OR
 *   (b) the same labelled numbers (a label on one side only = no match, e.g. a
 *       floor or street written once) AND the same unlabelled numbers AND no
 *       road or town name conflict AND (a locality word in common, OR the same
 *       letter-number sector code, OR no locality word on either side but a
 *       weak word in common).
 * Order does not matter: "G-9/1, House 12" = "House 12, G-9/1", and
 * "Street 12, House 5" is not "House 12, Street 5".
 * Stand-ins (only for a side with no label of that kind): a house, flat or
 * plot number written bare ("Plot 34" = "34", "House A-12" = "A-12"); a block
 * or sector letter code written bare ("Block R-1" = "R1"); and the Lahore /
 * Pindi house+block form, a bare number+letter for the pair house N + block
 * (or sector) L ("120-Y DHA" = "House 120, Block Y"; "56-C Bahria" = "House
 * 56, Sector C"). Each bare value stands in once.
 *
 * "H-12" (also "H 12", "H12"): Islamabad has a sector H-12, and "H" is also
 * the usual short form of "House". Read as:
 *   - a sector when the address already has a house number written another way
 *     (outside Islamabad: a bare code "12h");
 *   - house 12 when another sector code is present, or "street"/"st" follows;
 *   - otherwise BOTH readings are tried, and either may match (an address
 *     result only holds the referral for staff, so a possible match is shown).
 * "H#12", "H no 12", "H.No.12", "House No. 12" are always house 12.
 *
 * Every regular expression here is linear (bounded repeats, look-arounds of
 * fixed shape), and the one-letter-typo comparisons are capped: a 100 KB line
 * is read in milliseconds.
 */

/** Words that label the number (or single letter / Roman numeral) after them. */
const LABELS: Record<string, string> = {
  house: "house", hno: "house", hse: "house", home: "house", villa: "house",
  street: "street", st: "street", str: "street", gali: "street", galli: "street",
  road: "road", rd: "road",
  block: "block", blk: "block",
  phase: "phase", ph: "phase",
  sector: "sector", sec: "sector", precinct: "sector",
  flat: "flat", apt: "flat", apts: "flat", apartment: "flat", unit: "flat", suite: "flat", portion: "flat",
  plot: "plot",
  lane: "lane",
  floor: "floor",
  building: "building", bldg: "building", tower: "building",
  town: "town",
};
/** Label words a one-letter typo may stand for ("Stret 12", "Hous 5"): 5+ letters only. */
const TYPO_LABELS = ["house", "street", "block", "phase", "sector", "precinct", "floor", "building", "tower", "apartment", "villa"];
/** Labels whose letter goes after the number ("Flat B-4" = "4b"); the others keep a code's letter first. */
const DWELLING = new Set(["house", "flat", "plot", "building"]);
/** Labelled values a bare number or code on the other side may stand for. */
const STAND_IN_HOME = new Set(["house", "flat", "plot"]);
const STAND_IN_CODE = new Set(["block", "sector"]);
/** Home labels that, with a block/sector letter, a bare "120-Y" may stand for (Lahore, Pindi). */
const STAND_IN_PAIR_HOME = new Set(["house", "plot"]);
/** Labels that take only a plain number: a road or town name is often followed by the house number. */
const NUMBER_ONLY = new Set(["road", "town"]);
/** Labels that may follow their letter: "D Block" = "Block D". */
const BACK_LABELS = new Set(["block", "sector"]);
/** Words after which a single i, v or x is a Roman numeral. */
const ROMAN_AFTER = new Set(["phase", "ph", "block", "blk", "sector", "sec", "askari", "gulberg", "town"]);
const ROMAN_SINGLE: Record<string, number> = { i: 1, v: 5, x: 10 };
/** Between a label and its number: "House No. 12", "St # 5". */
const FILLER_AFTER_LABEL = new Set(["no", "number", "num", "nmbr"]);
/** Words naming a road: the word before one names the road ("Bank Road", "University Road"). */
const ROAD_WORDS = new Set(["road", "rd", "street", "st", "avenue", "boulevard", "lane"]);
/** Words naming a town: the word before one names the town ("Johar Town", "Peoples Colony"). */
const TOWN_WORDS = new Set(["town", "colony"]);
/** Words before a road's name: "Khayaban-e-Ittehad", "Shahrah-e-Faisal". */
const ROAD_PREFIXES = new Set(["khayaban", "khayabane", "shahrah", "shahra", "shahrae"]);
/** "Extension" changes the place: "DHA Phase 2 Extension" is not "DHA Phase 2". */
const EXTENSION = new Set(["ext", "extension", "extn"]);
const EXT_MARK = "ext";

/** City field forms read as the same city. */
const CITY_ALIASES: Record<string, string> = {
  pindi: "rawalpindi", rwp: "rawalpindi", isb: "islamabad", isl: "islamabad", khi: "karachi", lhr: "lahore", fsd: "faisalabad",
};
const PROVINCES = new Set(["pakistan", "pk", "sindh", "punjab", "kpk", "kp", "khyber", "pakhtunkhwa", "balochistan", "baluchistan", "ict", "ajk"]);
/** Dropped from the city field: "Lahore Cantt" = "Lahore", "Islamabad Capital Territory" = "Islamabad". */
const CITY_EXTRA = new Set(["cantt", "cant", "cantonment", "capital", "territory", "ict"]);
/** City names dropped from the address line (the order's own city is dropped too). */
const CITY_WORDS = new Set([
  "karachi", "lahore", "islamabad", "rawalpindi", "pindi", "faisalabad", "multan", "peshawar", "quetta", "sialkot", "gujranwala",
  "hyderabad", "abbottabad", "bahawalpur", "sargodha", "sukkur", "larkana", "sheikhupura", "gujrat", "mardan", "kasur", "sahiwal",
  "okara", "jhelum", "taxila", "wah", "mirpur", "muzaffarabad",
]);
/** Cities compared as one (the twin cities share Bahria Town, DHA and many roads). */
const CITY_GROUP: Record<string, string> = { islamabad: "islamabad+rawalpindi", rawalpindi: "islamabad+rawalpindi" };
/** Words that never tell two places apart. */
const GENERIC = new Set([
  "near", "opp", "opposite", "behind", "beside", "nearby", "adjacent", "front", "back", "side", "the", "of", "and", "in", "at", "to", "on",
  "town", "colony", "society", "scheme", "housing", "city", "cantt", "cantonment", "main", "road", "street",
  "avenue", "boulevard", "lane", "mohalla", "mohallah", "muhalla", "muhallah", "gali", "area", "sector", "block", "phase", "plot",
  "house", "flat", "floor", "building", "tower", "apartment", "apartments", "apts", "portion", "upper", "lower", "ground", "first",
  "second", "third", "no", "number", "pakistan", "contact", "cell", "mobile", "phone", "tel", "whatsapp",
]);
/** Prefixes many different places share: weak (see readingsMatch). */
const WEAK = new Set(["north", "south", "east", "west", "new", "old", "gulshan", "khayaban", "khayabane", "shahrah", "shahra", "shahrae"]);
/**
 * Landmarks shared by many neighbourhoods ("near Jamia Masjid", "near Main
 * Bazar"): never a locality word on their own (see readingsMatch).
 */
const LANDMARKS = new Set([
  "masjid", "mosque", "jamia", "jamiya", "madrasa", "madrassa", "church", "bazar", "bazaar", "market", "hospital", "clinic",
  "school", "college", "university", "chowk", "stop", "plaza", "mall", "park", "station", "bank", "pump", "petrol", "store", "shop",
]);
/** Islamabad's sector letters: "F-7", "I-8" there are sectors; "A-12", "B-4" are homes. */
const ISLAMABAD_SECTOR_LETTERS = new Set(["d", "e", "f", "g", "h", "i"]);
const ROMAN: Record<string, number> = {
  ii: 2, iii: 3, iv: 4, vi: 6, vii: 7, viii: 8, ix: 9, xi: 11, xii: 12, xiii: 13, xiv: 14, xv: 15, xvi: 16, xvii: 17, xviii: 18, xix: 19, xx: 20,
};

/**
 * At most one letter wrong, missing, extra, or two neighbours swapped
 * (Damerau distance <= 1). Linear in the word length.
 */
function withinOneEdit(a: string, b: string): boolean {
  if (a === b) return true;
  const la = a.length, lb = b.length;
  if (Math.abs(la - lb) > 1) return false;
  let i = 0;
  while (i < la && i < lb && a[i] === b[i]) i++;
  if (la === lb) {
    if (a.slice(i + 1) === b.slice(i + 1)) return true; // one substitution
    return i + 1 < la && a[i] === b[i + 1] && a[i + 1] === b[i] && a.slice(i + 2) === b.slice(i + 2); // swap
  }
  return la > lb ? a.slice(i + 1) === b.slice(i) : a.slice(i) === b.slice(i + 1); // one deletion / insertion
}

/** Arabic-Indic (٠-٩) and Urdu/Persian (۰-۹) digits as 0-9. */
function asciiDigits(v: string): string {
  return v.replace(/[٠-٩۰-۹]/g, (d) => String((d.charCodeAt(0) & 0xf) % 10));
}

// Pakistani phone shapes, each with its own digit boundaries so a house or
// sector number next to it is kept ("G-9/1 0300 1234567", "House 12 0321-1234567").
// Mobile: optional +92 / 0092 / 92 / 0, then 3xx and 7 digits (spaces or dashes allowed).
const MOBILE = /(?<![\d/-])(?:(?:\+|00)?92[\s-]?|0)?3\d{2}[\s-]?\d{3}[\s-]?\d{4}(?!\d)/g;
// Landline: +92 / 0092 / 0, a 2-4 digit area code, a 6-8 digit number (9 or 10 national digits).
const LANDLINE = /(?<![\d/-])(?:(?:\+|00)92[\s-]?0?|0)[1-9]\d{1,3}[\s-]?\d{6,8}(?!\d)/g;
// Any other long digit run (10-13 digits, no separators).
const LONG_RUN = /(?<![\d/-])\d{10,13}(?![\d/-])/g;
// A landline without its area code ("Johar Town 5761234"): 7-9 digits, no separators.
const LOCAL_LINE = /(?<![\d/-])\d{7,9}(?![\d/-])/g;
const POSTCODE = /(?<![\d/-])\d{5}(?![\d/-])/g;
// A label right before a 5-digit number ("House 10234", "House No. 10234"): a house number, not a
// postcode. Not road/town, which take at most 4 digits ("Johar Town 54000" is a postcode).
const LABEL_BEFORE = new RegExp(
  String.raw`(?:^|[^\p{L}\p{N}])(?:${Object.keys(LABELS).filter((k) => !NUMBER_ONLY.has(LABELS[k])).join("|")})\s*(?:(?:no|number|num)\b\.?)?\s*[#:.-]?\s*$`,
  "u",
);

/** Lowercase text with phone numbers, postcodes and punctuation removed; "-" and "/" kept for codes, "," kept as a separator. */
function cleanLine(v: string): string {
  let s = asciiDigits(v.normalize("NFKC")).toLowerCase();
  s = s.replace(MOBILE, " ");
  s = s.replace(LANDLINE, (m) => {
    const national = m.replace(/\D/g, "").replace(/^(?:0092|92)?0?/, "");
    return national.length === 9 || national.length === 10 ? " " : m;
  });
  s = s.replace(LONG_RUN, " ");
  s = s.replace(LOCAL_LINE, " ");
  // "H#12", "H # 12", "H no 12", "H.No.12", "h. no. 12": always the house number.
  s = s.replace(/(?<![\p{L}\p{N}])h\s*(?:#|\.?\s*no\b\.?)/gu, " house ");
  // 5-digit postcodes, unless a label is right before ("House 10234" is a house number).
  s = s.replace(POSTCODE, (m, offset: number, whole: string) =>
    LABEL_BEFORE.test(whole.slice(Math.max(0, offset - 24), offset)) ? m : " ");
  // Initials: "F.B. Area" = "FB Area", "P.E.C.H.S." = "PECHS".
  s = s.replace(/(?<![\p{L}\p{N}])(?:[a-z]\.[ \t]?){2,}/gu, (m) => m.replace(/[.\s]/g, "") + (/\s$/.test(m) ? " " : ""));
  // "Federal B Area" = "F B Area" = "FB Area".
  s = s.replace(/(?<![\p{L}\p{N}])federal[\s-]{0,3}b(?![\p{L}\p{N}])/gu, "fb");
  s = s.replace(/(?<![\p{L}\p{N}])f[\s-]{1,3}b(?=[\s-]{1,3}area(?![\p{L}\p{N}]))/gu, "fb");
  // Izafat "-e-": "Gulshan-e-Iqbal" = "Gulshan e Iqbal" (a lone "e" is never a locality word).
  s = s.replace(/(?<=\p{L})-e-(?=\p{L})/gu, " ");
  s = s.replace(/[,;|\n\r]+/g, " , ");
  return s.replace(/[^\p{L}\p{N}/\-\s,]+/gu, " ");
}

type Tok =
  | { t: "code"; l: string; n: string } // letter(s) + number with a sub-number: g9/1
  | { t: "ln"; l: string; n: string } // single letter + number: h12, b4, f7
  | { t: "nl"; n: string; l: string } // number + single letter: 12a, 4b
  | { t: "num"; n: string; ord?: boolean }
  | { t: "word"; w: string }
  | { t: "sep" }; // a comma (or the address1 / address2 boundary)

const LEX = new RegExp(
  [
    String.raw`(?<![\p{L}\p{N}])(?<cl>(?!(?:st|ph|rd|no|h)\b)[a-z]{1,2})[ -]?(?<cn>\d+(?:\s*[/-]\s*\d+)+)(?![\p{L}\p{N}])`,
    String.raw`(?<![\p{L}\p{N}])(?<ord>\d+)(?:st|nd|rd|th)(?![\p{L}\p{N}])`,
    String.raw`(?<![\p{L}\p{N}])(?<ll>[a-z])[ -]?(?<ln>\d+)(?![\p{L}\p{N}/])`,
    // not a letter that starts a code: "Street 5 G 9/1", "Street 3 H-12"
    // (but "4-B 2nd Floor" is flat 4-B: the number after it is an ordinal)
    String.raw`(?<![\p{L}\p{N}])(?<nn>\d+)[ -]?(?<nl>[a-z])(?![\p{L}\p{N}])(?!\s*-?\s*\d+(?:\s*[/-]\s*\d+)*(?!\p{L}))`,
    String.raw`(?<num>\d+(?:/\d+)*)`,
    String.raw`(?<w>\p{L}+)`,
    String.raw`(?<sep>,)`,
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
    else if (g.sep) out.push({ t: "sep" });
  }
  return out;
}

const isWord = (t: Tok | undefined): t is { t: "word"; w: string } => t?.t === "word";

/** A token that can be a label's value: a number, a code, or a single letter. */
function isValue(t: Tok | undefined): boolean {
  if (!t) return false;
  if (t.t === "num") return !t.ord;
  if (t.t === "nl" || t.t === "ln" || t.t === "code") return true;
  return t.t === "word" && t.w.length === 1;
}

/** Roman I/V/X after phase, block, askari ...; "D Block" -> "Block D"; "10 D Block" -> "10 Block D". */
function arrange(toks: Tok[]): Tok[] {
  const out: Tok[] = [];
  for (let i = 0; i < toks.length; i++) {
    let tok = toks[i];
    const prev = out[out.length - 1];
    if (isWord(tok) && ROMAN_SINGLE[tok.w] && isWord(prev) && ROMAN_AFTER.has(prev.w)) tok = { t: "num", n: String(ROMAN_SINGLE[tok.w]) };
    if (isWord(tok) && BACK_LABELS.has(LABELS[tok.w] ?? "")) {
      let j = i + 1;
      while (isWord(toks[j]) && FILLER_AFTER_LABEL.has((toks[j] as { w: string }).w)) j++;
      const next = toks[j];
      const nextValue = isValue(next) || (isWord(next) && !!ROMAN_SINGLE[next.w]);
      if (!nextValue && isWord(prev) && prev.w.length === 1) {
        out.pop();
        out.push(tok, prev);
        continue;
      }
      if (!nextValue && prev?.t === "nl") {
        out.pop();
        out.push({ t: "num", n: prev.n }, tok, { t: "word", w: prev.l });
        continue;
      }
    }
    out.push(tok);
  }
  return out;
}

/** One reading of an address (an ambiguous "H-12" gives two). */
export type AddressReading = {
  city: string;
  /** "house:12", "street:5", "sector:g9/1", ... */
  labelled: Set<string>;
  /** Numbers and letter codes without a label ("Askari 11" -> "11", "33-A" -> "33a", Karachi "A-12" -> "12a"), and "ext". */
  numbers: Set<string>;
  /** Locality words (city, filler, generic, weak and landmark words removed; "university~road" for a landmark naming a road). */
  words: Set<string>;
  /** Weak words ("north", "gulshan", "khayaban" ...): count only when neither side has a locality word. */
  weak: Set<string>;
  /** Landmark words ("masjid", "bazar", "hospital" ...): never a match on their own. */
  landmarks: Set<string>;
  /** Neighbouring locality words joined ("gul bahar" -> "gulbahar"), matched against the other side's words. */
  joined: Set<string>;
  /** Road names ("bank" of "Bank Road", "ittehad" of "Khayaban-e-Ittehad"). */
  roads: Set<string>;
  /** Town names ("johar" of "Johar Town", "peoples" of "Peoples Colony"). */
  towns: Set<string>;
  /** Letter-number sector codes ("g9/1", Islamabad "f7"): the same one counts as the same locality. */
  sectors: Set<string>;
  /** The cleaned line (phones, postcodes, city names and punctuation removed), for the identical-line rule. */
  line: string;
};

/** address1 and address2 as one line (address2 is often the flat, street or area), a comma between them. */
function fullLine(a: AddressLike): string {
  return [a.address1, a.address2].map((v) => (typeof v === "string" ? v.trim() : "")).filter(Boolean).join(", ");
}

function cityWords(city: string | null | undefined): string[] {
  return lex(cleanLine(city ?? "")).flatMap((t) => (t.t === "word" ? [t.w] : []));
}

/**
 * The city as compared: lowercase words without province/country/"Cantt"/
 * "Capital Territory", aliases applied, and a one-letter typo of a known city
 * read as that city ("Karchi" = "karachi", "Lahor" = "lahore").
 */
export function cityKey(city: string | null | undefined): string {
  const key = cityWords(city)
    .map((w) => CITY_ALIASES[w] ?? w)
    .filter((w) => !PROVINCES.has(w) && !CITY_EXTRA.has(w))
    .join("");
  if (key.length < 5 || key.length > 40 || CITY_WORDS.has(key)) return key;
  const near = [...CITY_WORDS].filter((c) => c.length >= 5 && c[0] === key[0] && withinOneEdit(key, c));
  return near.length === 1 ? CITY_ALIASES[near[0]] ?? near[0] : key;
}

/** Same city: equal keys, the twin cities, or one letter apart (5+ letters, same first letter). */
function sameCity(a: string, b: string): boolean {
  if (a === b) return true;
  if (CITY_GROUP[a] && CITY_GROUP[a] === CITY_GROUP[b]) return true;
  return a.length >= 5 && b.length >= 5 && a.length <= 40 && b.length <= 40 && a[0] === b[0] && withinOneEdit(a, b);
}

/** A dwelling's value number first ("4b"), any other label's letter first ("r1"). */
function labelValue(label: string, v: Tok | undefined): string | null {
  if (!v) return null;
  if (NUMBER_ONLY.has(label)) return v.t === "num" && !v.ord && /^\d{1,4}$/.test(v.n) ? v.n : null;
  if (v.t === "num" && !v.ord) return v.n.replace(/-/g, "/");
  if (v.t === "nl" || v.t === "ln") return DWELLING.has(label) ? `${v.n}${v.l}` : `${v.l}${v.n}`;
  if (v.t === "code") return `${v.l}${v.n}`;
  if (v.t === "word" && v.w.length === 1) return v.w; // "Block A", "Sector E"
  return null;
}

/** The token after any "no"/"number" following index i. */
function valueIndex(toks: Tok[], i: number): number {
  let j = i + 1;
  while (isWord(toks[j]) && FILLER_AFTER_LABEL.has((toks[j] as { w: string }).w)) j++;
  return j;
}

/** A word one letter away from a label word, followed by a number: "Stret 12" -> street. */
function typoLabel(w: string, toks: Tok[], i: number): string | undefined {
  if (w.length < 4 || w.length > 12) return undefined;
  if (GENERIC.has(w) || LANDMARKS.has(w) || WEAK.has(w) || CITY_WORDS.has(w) || PROVINCES.has(w) || EXTENSION.has(w)) return undefined;
  const next = toks[valueIndex(toks, i)];
  if (!next || !(next.t === "num" ? !next.ord : next.t === "nl" || next.t === "ln" || next.t === "code")) return undefined;
  const hit = TYPO_LABELS.find((k) => k[0] === w[0] && withinOneEdit(w, k));
  return hit ? LABELS[hit] : undefined;
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
  const islamabad = city === "islamabad";
  const ownCity = new Set(cityWords(a.city));
  const toks = arrange(lex(cleanLine(fullLine(a))));
  if (toks.length === 0) return [];

  const labelled = new Set<string>();
  const numbers = new Set<string>();
  const words = new Set<string>();
  const weak = new Set<string>();
  const landmarks = new Set<string>();
  const joined = new Set<string>();
  const roads = new Set<string>();
  const towns = new Set<string>();
  const sectors = new Set<string>();
  const lineParts: string[] = [];
  const hCodes: Array<{ n: string; streetNext: boolean }> = [];
  let home = false;
  let prevLocality: string | null = null; // the locality word right before, for "gul bahar" -> "gulbahar"
  const addLabel = (label: string, value: string) => {
    labelled.add(`${label}:${value}`);
    if (label === "sector" && /^[a-z]+\d/.test(value)) sectors.add(value);
    if (DWELLING.has(label)) home = true;
  };
  const nextNonSep = (i: number) => {
    let j = i + 1;
    while (toks[j]?.t === "sep") j++;
    return toks[j];
  };
  const placeWord = (w: string) => !(w.length < 2 || GENERIC.has(w) || CITY_WORDS.has(w) || ownCity.has(w) || PROVINCES.has(w)
    || FILLER_AFTER_LABEL.has(w) || LABELS[w]);
  /** The word at i names a road: a road word without a number follows, or a road prefix comes before. */
  const namesRoad = (i: number) => {
    const next = toks[i + 1];
    const prev = toks[i - 1];
    if (isWord(prev) && ROAD_PREFIXES.has(prev.w)) return true;
    if (!isWord(next) || !ROAD_WORDS.has(next.w)) return false;
    const label = LABELS[next.w];
    return !label || labelValue(label, toks[valueIndex(toks, i + 1)]) === null;
  };
  const namesTown = (i: number) => {
    const next = toks[i + 1];
    return isWord(next) && TOWN_WORDS.has(next.w);
  };

  for (const tok of toks) {
    if (tok.t === "sep" || (tok.t === "word" && (CITY_WORDS.has(tok.w) || ownCity.has(tok.w) || PROVINCES.has(tok.w)))) continue;
    lineParts.push(tok.t === "word" ? tok.w : tok.t === "num" ? `${tok.n}${tok.ord ? "th" : ""}` : tok.t === "nl" ? `${tok.n}${tok.l}` : `${tok.l}${tok.n}`);
  }

  for (let i = 0; i < toks.length; i++) {
    const tok = toks[i];
    const wasLocality = prevLocality;
    prevLocality = null;
    if (tok.t === "sep") continue;
    if (tok.t === "word") {
      const label = LABELS[tok.w] ?? typoLabel(tok.w, toks, i);
      if (label) {
        // the value: the next token after any "no"/"number", never across a comma
        const j = valueIndex(toks, i);
        const value = labelValue(label, toks[j]);
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
      if (EXTENSION.has(tok.w)) {
        numbers.add(EXT_MARK); // "Phase 2 Extension" is not "Phase 2"
        continue;
      }
      if (!placeWord(tok.w)) continue;
      const road = namesRoad(i);
      const town = namesTown(i);
      if (LANDMARKS.has(tok.w)) {
        // "University Road", "Mall Road", "University Town": the landmark word names the road or town
        if (road) { words.add(`${tok.w}~road`); roads.add(tok.w); }
        else if (town) { words.add(`${tok.w}~town`); towns.add(tok.w); }
        else landmarks.add(tok.w);
        continue;
      }
      if (road) roads.add(tok.w);
      if (town) towns.add(tok.w);
      if (WEAK.has(tok.w)) weak.add(tok.w);
      else words.add(tok.w);
      if (wasLocality) joined.add(`${wasLocality}${tok.w}`);
      prevLocality = tok.w;
      continue;
    }
    if (tok.t === "code") addLabel("sector", `${tok.l}${tok.n}`);
    else if (tok.t === "ln" && tok.l === "h") {
      const next = nextNonSep(i);
      hCodes.push({ n: tok.n, streetNext: isWord(next) && LABELS[next.w] === "street" });
    } else if (tok.t === "ln") {
      // Islamabad: "F-7", "I-8" are sectors (letters D-I only). Elsewhere, and
      // for other letters there, a letter code is a home or block code
      // (Karachi "A-12", "R-45"; Lahore "R1"; Islamabad "B-4"), "12a".
      if (islamabad && ISLAMABAD_SECTOR_LETTERS.has(tok.l)) addLabel("sector", `${tok.l}${tok.n}`);
      else numbers.add(`${tok.n}${tok.l}`);
      home = true;
    } else if (tok.t === "nl") {
      numbers.add(`${tok.n}${tok.l}`);
      home = true;
    } else if (tok.t === "num") {
      // an ordinal straight before "floor" is taken by the floor label above
      const next = toks[i + 1];
      if (!(tok.ord && isWord(next) && LABELS[next.w] === "floor")) {
        numbers.add(tok.n.replace(/-/g, "/"));
        home = true;
      }
    }
  }

  const copy = (r: AddressReading): AddressReading => ({
    ...r, labelled: new Set(r.labelled), numbers: new Set(r.numbers), sectors: new Set(r.sectors),
  });
  const hasHouse = [...labelled].some((l) => l.startsWith("house:"));
  const line = lineParts.join(" ");
  let readings: AddressReading[] = [copy({ city, labelled, numbers, words, weak, landmarks, joined, roads, towns, sectors, line })];
  for (const h of hCodes) {
    // outside Islamabad there is no sector H-12: the other reading is a bare home code "12h"
    const asSector = (r: AddressReading) => {
      if (islamabad) { r.labelled.add(`sector:h${h.n}`); r.sectors.add(`h${h.n}`); } else r.numbers.add(`${h.n}h`);
    };
    const asHouse = (r: AddressReading) => { r.labelled.add(`house:${h.n}`); };
    if (hasHouse) readings.forEach(asSector);
    else if (sectors.size > 0 || h.streetNext) readings.forEach(asHouse);
    else {
      readings = readings.flatMap((r) => {
        const s = copy(r);
        const hs = copy(r);
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
const labelOf = (e: string) => e.slice(0, e.indexOf(":"));
const valueOf = (e: string) => e.slice(e.indexOf(":") + 1);
/** "a12" and "12a" read the same; anything else unchanged. */
const codeKey = (v: string) => {
  const m = /^([a-z])(\d+)$/.exec(v);
  return m ? `${m[2]}${m[1]}` : v;
};
const LETTER_CODE = /^(?:[a-z]\d+|\d+[a-z])$/;

/**
 * Labelled numbers on one side that the other side wrote bare (only when that
 * other side has no label of that kind): the pair house (or plot) N + block
 * (or sector) letter L written as one bare "N-L" ("House 120, Block Y" =
 * "120-Y", Lahore and Pindi); a house, flat or plot number ("Plot 34" = "34",
 * "House 17-B" = "17B", "House A-12" = "A-12"); a block or sector letter code
 * ("Block R-1" = "R1"). Each bare value stands in once. Returns the sets left
 * to compare.
 */
function withStandIns(x: AddressReading, y: AddressReading) {
  const xl = new Set(x.labelled), yl = new Set(y.labelled), xn = new Set(x.numbers), yn = new Set(y.numbers);
  const fillPair = (from: Set<string>, otherOriginal: Set<string>, otherBare: Set<string>) => {
    const otherLabels = new Set([...otherOriginal].map(labelOf));
    if ([...otherLabels].some((l) => STAND_IN_HOME.has(l) || STAND_IN_CODE.has(l))) return;
    const homes = [...from].filter((e) => STAND_IN_PAIR_HOME.has(labelOf(e)) && /^\d+$/.test(valueOf(e)));
    const letters = [...from].filter((e) => STAND_IN_CODE.has(labelOf(e)) && /^[a-z]$/.test(valueOf(e)));
    if (homes.length !== 1 || letters.length !== 1) return;
    const key = `${valueOf(homes[0])}${valueOf(letters[0])}`;
    if (otherBare.has(key)) {
      from.delete(homes[0]);
      from.delete(letters[0]);
      otherBare.delete(key);
    }
  };
  const fill = (from: Set<string>, otherOriginal: Set<string>, otherBare: Set<string>) => {
    const otherLabels = new Set([...otherOriginal].map(labelOf));
    const otherHasHome = [...otherLabels].some((l) => STAND_IN_HOME.has(l));
    for (const e of [...from]) {
      if (otherOriginal.has(e)) continue;
      const label = labelOf(e);
      const value = valueOf(e);
      const allowed = STAND_IN_HOME.has(label)
        ? !otherHasHome
        : STAND_IN_CODE.has(label) && !otherLabels.has(label) && LETTER_CODE.test(value);
      const key = codeKey(value);
      if (allowed && otherBare.has(key)) {
        from.delete(e);
        otherBare.delete(key);
      }
    }
  };
  fillPair(xl, y.labelled, yn);
  fillPair(yl, x.labelled, xn);
  fill(xl, y.labelled, yn);
  fill(yl, x.labelled, xn);
  return { xl, yl, xn, yn };
}

/** Fuzzy word comparison is skipped for very long lines (hostile input): exact and joined forms still count. */
const FUZZY_MAX_WORDS = 40;
/** Same word: equal, or 6+ letters with one letter wrong and the same first letter ("nazimabd" = "nazimabad"). */
function nearWord(a: string, b: string): boolean {
  if (a === b) return true;
  if (a.includes("~") || b.includes("~")) return false;
  const short = Math.min(a.length, b.length), long = Math.max(a.length, b.length);
  return short >= 5 && long >= 6 && long <= 30 && a[0] === b[0] && withinOneEdit(a, b);
}
function sharesNear(a: Set<string>, b: Set<string>): boolean {
  if (shares(a, b)) return true;
  if (a.size > FUZZY_MAX_WORDS || b.size > FUZZY_MAX_WORDS) return false;
  return [...a].some((v) => [...b].some((w) => nearWord(v, w)));
}
/** A locality word in common: the same word, the joined form of two words on the other side, or one letter apart. */
function sharesPlace(x: AddressReading, y: AddressReading): boolean {
  return sharesNear(x.words, y.words) || shares(x.words, y.joined) || shares(y.words, x.joined);
}
/** Both sides name a road (or a town) and none is the same: different places. */
function conflict(a: Set<string>, b: Set<string>): boolean {
  return a.size > 0 && b.size > 0 && !sharesNear(a, b);
}

function readingsMatch(x: AddressReading, y: AddressReading): boolean {
  if (!sameCity(x.city, y.city)) return false;
  // Owner decision 19 Nov 2026 (round 11): the same cleaned line with two or
  // more labelled numbers ("House 12, Street 5" twice) holds, even with no
  // locality word. A lone number ("House 12") still never matches.
  if (x.line === y.line && x.labelled.size >= 2) return true;
  const { xl, yl, xn, yn } = withStandIns(x, y);
  if (!sameSet(xl, yl) || !sameSet(xn, yn)) return false;
  if (conflict(x.roads, y.roads) || conflict(x.towns, y.towns)) return false;
  if (sharesPlace(x, y)) return true;
  if (shares(x.sectors, y.sectors)) return true;
  // Only weak words ("Gulshan") and nothing else on either side: the weak word
  // must be shared. Landmarks alone never match ("near Jamia Masjid" twice
  // matches only through the identical-line rule above).
  return x.words.size === 0 && y.words.size === 0 && shares(x.weak, y.weak);
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
