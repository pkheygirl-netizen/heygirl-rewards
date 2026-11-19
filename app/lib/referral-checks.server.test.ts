import { describe, expect, it } from "vitest";
import {
  addressReadings,
  cityKey,
  emailSimilarityKey,
  normaliseEmail,
  orderVerdict,
  phoneKey,
  sameAddress,
  sameEmail,
  sameFullName,
  samePhone,
  signInVerdict,
  similarEmail,
} from "./referral-checks.server";

describe("email", () => {
  it("normalises: lowercase, trim, +tag dropped for every domain, Gmail dots removed, googlemail.com = gmail.com", () => {
    expect(normaliseEmail("  Ayesha.Khan+promo@GMAIL.com ")).toBe("ayeshakhan@gmail.com");
    expect(normaliseEmail("a.y.e.s.h.a@googlemail.com")).toBe("ayesha@gmail.com");
    expect(normaliseEmail("ayesha.khan+x@yahoo.com")).toBe("ayesha.khan@yahoo.com"); // dots kept outside Gmail
    expect(normaliseEmail("+tag@x.com")).toBeNull();
    expect(normaliseEmail("nope")).toBeNull();
    expect(normaliseEmail(null)).toBeNull();
  });

  it("same email after normalising", () => {
    expect(sameEmail("Ayesha.Khan@gmail.com", "ayeshakhan+2@googlemail.com")).toBe(true);
    expect(sameEmail("ayesha.khan@yahoo.com", "ayeshakhan@yahoo.com")).toBe(false); // Yahoo dots count
    expect(sameEmail(null, null)).toBe(false);
  });

  it("similar email: name part without separators and trailing digits, 6+ characters, any domain", () => {
    expect(similarEmail("ayesha.khan1@yahoo.com", "ayeshakhan@gmail.com")).toBe(true); // the owner's example
    expect(similarEmail("ayesha_khan92@hotmail.com", "ayesha-khan@outlook.com")).toBe(true);
    expect(emailSimilarityKey("sara12@x.com")).toBeNull(); // "sara": fewer than 6 characters
    expect(similarEmail("sara1@x.com", "sara2@y.com")).toBe(false);
    expect(similarEmail("ayeshakhan@x.com", "ayeshakhanum@y.com")).toBe(false); // different name part
    expect(similarEmail("12345678@x.com", "12345678@y.com")).toBe(false); // digits only leaves nothing
  });
});

describe("phone", () => {
  it("compares the last 10 digits (+92, 0092 and 0 prefixes match)", () => {
    expect(phoneKey("+92 300 1234567")).toBe("3001234567");
    expect(samePhone("+923001234567", "0300-1234567")).toBe(true);
    expect(samePhone("00923001234567", "3001234567")).toBe(true);
    expect(samePhone("0300123456", "0300123457")).toBe(false);
    expect(samePhone("12345", "12345")).toBe(false); // too short to mean anything
  });
});

describe("full name", () => {
  it("first AND last must both be present on both people; case, spaces and punctuation ignored", () => {
    expect(sameFullName({ first_name: " Ayesha ", last_name: "Al-Khan" }, { first_name: "ayesha", last_name: "al khan" })).toBe(true);
    expect(sameFullName({ first_name: "Ayesha", last_name: null }, { first_name: "Ayesha", last_name: null })).toBe(false);
    expect(sameFullName({ first_name: "Ayesha", last_name: "Khan" }, { first_name: "Ayesha", last_name: "" })).toBe(false);
    expect(sameFullName({ first_name: "Ayesha", last_name: "Khan" }, { first_name: "Aisha", last_name: "Khan" })).toBe(false);
  });
});

describe("address (owner rules 19 Nov 2026, round 9: an address only ever holds)", () => {
  type A = { address1: string | null; address2?: string | null; city: string };
  const C = (address1: string, city = "Islamabad", address2: string | null = null): A => ({ address1, address2, city });
  const same = (a: A, b: A, want: boolean) => {
    expect(sameAddress(a, b), `${JSON.stringify(a)} ~ ${JSON.stringify(b)}`).toBe(want);
    expect(sameAddress(b, a), "symmetric").toBe(want);
  };
  const L = (a: string, b: string, want: boolean, city = "Lahore") => same(C(a, city), C(b, city), want);

  it("reads labelled numbers, sector codes, unlabelled numbers and locality words", () => {
    const r = addressReadings(C("House No. 12, Street 5, G-9/1, Islamabad, Pakistan 44000"));
    expect(r).toHaveLength(1);
    expect([...r[0].labelled].sort()).toEqual(["house:12", "sector:g9/1", "street:5"]);
    expect([...r[0].numbers]).toEqual([]); // postcode dropped
    expect([...r[0].words]).toEqual([]); // city and country dropped
    const k = addressReadings(C("Flat B-4, Askari 11, Gulberg III near CSD", "Lahore"))[0];
    expect([...k.labelled]).toEqual(["flat:4b"]);
    expect([...k.numbers].sort()).toEqual(["11", "3"]);
    expect([...k.words].sort()).toEqual(["askari", "csd", "gulberg"]); // "near" is filler
    expect(addressReadings(C("Main Boulevard", "Lahore"))).toEqual([]); // nothing that identifies a home: never matches
    expect(addressReadings(C("Street 5, Model Town", "Lahore"))).toEqual([]);
    expect(addressReadings(C("House 12", ""))).toEqual([]); // no city
    expect(addressReadings({ address1: null, city: "Karachi" })).toEqual([]);
    expect(cityKey(" Karachi. ")).toBe("karachi");
    expect(cityKey("Karachi, Sindh")).toBe("karachi");
    expect(cityKey("Pindi")).toBe("rawalpindi");
  });

  it("owner examples", () => {
    same(C("House 12, Street 5, G-9/1, Islamabad"), C("H no 12 St 5 G9/1"), true);
    L("House 12", "House 12, Street 40, Model Town", false); // missing street on one side: not enough evidence
    same(C("G-9/1, House 12"), C("House 12, G-9/1"), true); // order does not matter
    L("Street 12, House 5, Model Town", "House 12, Street 5, Model Town", false); // numbers keep their label
    L("House 12, Gulberg II", "House 12, Gulberg III", false);
    L("House 12, Block A, Johar Town", "House 12, Block B, Johar Town", false);
    same(C("Flat B-4, Block 7, Clifton", "Karachi"), C("Flat 4-B Block 7 Clifton", "Karachi"), true);
    same(C("Flat 4B Block 7 Clifton", "Karachi"), C("Flat 4-B Block 7 Clifton", "Karachi"), true);
    same(C("House ۱۲ Street ۵ F-7/2"), C("House 12 Street 5 F-7/2"), true); // Urdu digits
    same(C("House ١٢ Street 5 F-7/2"), C("House 12 Street 5 F-7/2"), true); // Arabic-Indic digits
    same(C("House 12 Street 5 G 9/1"), C("House 12 Street 5 G-9/1"), true);
    same(C("House 12 Street 5 G9/1"), C("House 12 Street 5 G-9-1"), true);
    same(C("H-12, St 5, G-9/1"), C("House 12, Street 5, G-9/1"), true);
    same(C("H 12, Street 5, Bahria Enclave"), C("House 12, Street 5, Bahria Enclave"), true);
    same(C("House 12, Street 5, Johar Town +92 300 1234567", "Lahore"), C("House 12, Street 5, Johar Town", "Lahore"), true); // phone in the line
    same(C("House 12, Street 5, Johar Town", "Lahore", "54000"), C("House 12, Street 5, Johar Town, Lahore", "Lahore"), true); // postcode, city
  });

  it("\"H-12\": a sector when a house number is written elsewhere; house 12 when another sector code is present or a street follows; else both readings", () => {
    // house written elsewhere -> H-12 is the sector
    expect([...addressReadings(C("House 5, Street 3, H-12"))[0].labelled].sort()).toEqual(["house:5", "sector:h12", "street:3"]);
    // another sector code present -> house 12
    expect([...addressReadings(C("H-12, G-9/1"))[0].labelled].sort()).toEqual(["house:12", "sector:g9/1"]);
    // a street follows -> house 12
    expect([...addressReadings(C("H 12 Street 4 Bahria Enclave"))[0].labelled].sort()).toEqual(["house:12", "street:4"]);
    // nothing else to go on -> both readings are tried
    const both = addressReadings(C("H-12, Bahria Enclave"));
    expect(both.map((r) => [...r.labelled])).toEqual([["house:12"], ["sector:h12"]]);
    same(C("H-12, Bahria Enclave"), C("House 12, Bahria Enclave"), true); // the house reading matches
    same(C("H-12 Markaz, Bahria Enclave"), C("House 5, H-12, Bahria Enclave"), false); // her house 5 is a different home
    same(C("House 5, Street 3, H-12"), C("House 12, Street 3, H 5"), false);
    same(C("H-12 house 5 street 3"), C("House 5 street 3 H-12"), true);
    same(C("House 12, Street 5, H-12"), C("House 12, Street 5, I-8"), false); // other sector
    // "H#12", "H no 12", "H.No.12" are always the house
    for (const v of ["H#12, Street 5, Bahria Enclave", "H no 12, Street 5, Bahria Enclave", "H.No.12, Street 5, Bahria Enclave"]) {
      expect(addressReadings(C(v)).map((r) => [...r.labelled].sort())).toEqual([["house:12", "street:5"]]);
    }
  });

  describe("every pair from reviews 8 and 9, with the intended answer", () => {
    it("review 8", () => {
      L("House 12", "House 12, Street 40, Model Town", false);
      L("House 12, Street 5, G-9/1", "House 12, Street 7, G-9/1", false, "Islamabad");
      L("Flat 3, Block 7, Gulshan-e-Iqbal", "Flat 3, Block 9, Gulshan-e-Iqbal", false, "Karachi");
      L("House 12 DHA Phase 5", "House 12 DHA Phase 6", false);
      L("12", "12 Main Boulevard Gulberg", false);
      L("Street 5, House 12, F-7", "House 12, Street 5, F-7", true, "Islamabad");
      L("H# 12 St 5", "House No 12 Street 5", true);
      L("Apartment 4B Askari 11", "Flat 4-B, Askari 11", true);
      L("House 12 Block B", "House 12 Block C", false);
    });
    it("review 9 (addr.ts)", () => {
      same(C("House 12, Street 5, G-9/1"), C("House 12 Street 5 G 9/1"), true);
      same(C("H# 12, St 5, G-9/1"), C("House No. 12, Street 5, G-9/1"), true);
      same(C("House 12 Street 5 G-9/1"), C("House 12 Street 5 G9/1"), true);
      same(C("House 12 Street 5 G-9/1"), C("House 12 Street 5 G-9/2"), false);
      same(C("House 5, Street 3, H-12"), C("House 12, Street 3, H 5"), false);
      same(C("Flat 3 Block 7 Gulshan-e-Iqbal", "Karachi"), C("Flat 3, Block 7, Gulshan e Iqbal", "Karachi"), true);
      same(C("Flat 3 Block 7 Gulshan", "Karachi"), C("Flat 3 Block 7 Gulshan", "Karachi"), true);
      same(C("House 12, Street 5, DHA Phase 6", "Karachi"), C("House 12, Street 5, DHA Phase 5", "Karachi"), false);
      same(C("House 12, Street 5, DHA Phase 6", "Lahore"), C("H 12 St 5 DHA Ph 6", "Lahore"), true);
      same(C("House 12, Street 5, DHA Phase VI", "Lahore"), C("House 12, Street 5, DHA Phase 6", "Lahore"), true);
      same(C("House 12", "Lahore", "Street 5 DHA Phase 6"), C("House 12 Street 5 DHA Phase 6", "Lahore"), true);
      same(C("House 12 Street 5 Model Town near Jamia Masjid", "Lahore"), C("House 12 Street 5 Model Town", "Lahore"), true);
      same(C("House 12A Street 5 Model Town", "Lahore"), C("House 12-A Street 5 Model Town", "Lahore"), true);
      same(C("House 12 A Street 5 Model Town", "Lahore"), C("House 12A Street 5 Model Town", "Lahore"), true);
      same(C("House 12 Street 5 Johar Town", "Lahore"), C("House 12 Street 5 Johar Town Lahore", "Lahore"), true);
      same(C("House 12 Street 5 Johar Town", "Lahore"), C("House 14 Street 5 Johar Town", "Lahore"), false);
      same(C("House 12 Street 5 Satellite Town", "Rawalpindi"), C("House 12 Street 5 Satellite Town", "Pindi"), true);
      same(C("House 12 Street 5 Johar Town 03001234567", "Lahore"), C("House 12 Street 5 Johar Town", "Lahore"), true);
      same(C("House 12 Street 5 Johar Town", "Lahore", "54000"), C("House 12 Street 5 Johar Town", "Lahore"), true);
      same(C("Plot 12-C, Khayaban-e-Ittehad, DHA Phase 6", "Karachi"), C("Plot No 12 C Khayaban e Ittehad DHA Phase 6", "Karachi"), true);
      same(C("Flat 4-B, Block 7, Clifton", "Karachi"), C("Flat 4B Block 7 Clifton", "Karachi"), true);
      same(C("Flat B-4, Block 7, Clifton", "Karachi"), C("Flat 4-B Block 7 Clifton", "Karachi"), true);
      same(C("House 12 St# 5 Bahria Town", "Rawalpindi"), C("House 12 Street 5 Bahria Town", "Rawalpindi"), true);
      // a floor on one side only: another portion of the house, not the same home (labelled number missing on one side)
      same(C("House 12, 1st Floor, Street 5, F-7/2"), C("House 12, Street 5, F-7/2"), false);
      same(C("House ١٢ Street 5 F-7/2"), C("House 12 Street 5 F-7/2"), true);
      same(C("G-9/1, House 12, Street 5"), C("House 12, Street 5, G-9/1"), true);
      same(C("H-12 house 5 street 3"), C("House 5 street 3 H-12"), true);
    });
    it("review 9 (addr2.ts)", () => {
      L("Street 12, House 5, Allama Iqbal Town", "House 12, Street 5, Allama Iqbal Town", false);
      L("House 12 Street 5 Gulberg III Main Boulevard", "House 12 Street 5 Gulberg II Main Boulevard", false);
      L("House 12, Block A, Model Town Extension", "House 12, Block B, Model Town Extension", false);
      same(C("House 12, Sector C, Bahria Town Phase 8", "Rawalpindi"), C("House 12, Sector D, Bahria Town Phase 8", "Rawalpindi"), false);
      L("House 12, Block A, Johar Town", "House 12, Block B, Johar Town", false);
      L("House 12 Street 5 Askari 11", "House 12 Street 5 Askari 10", false);
      same(C("House 12, Lane 4, Khayaban-e-Seher, DHA Phase 6", "Karachi"), C("House 12 Lane 4 Khayaban e Sehar DHA Phase 6", "Karachi"), true);
      same(C("House 12, Street 5, H-12"), C("House 12, Street 5, I-8"), false);
      same(C("Flat 3, Building B, Gulshan Block 7", "Karachi"), C("Flat 3, Building C, Gulshan Block 7", "Karachi"), false);
      same(C("House 12 St 5 Gulshan", "Karachi."), C("House 12 St 5 Gulshan", "karachi"), true);
      same(C("House 12 St 5 Gulshan", "Karachi Sindh"), C("House 12 St 5 Gulshan", "Karachi"), true);
    });
    it("review 9 (addr3.ts)", () => {
      same(C("H-12, St 5, G-9/1"), C("House 12, Street 5, G-9/1"), true);
      same(C("H.No.12, St 5, G-9/1"), C("House 12, Street 5, G-9/1"), true);
      same(C("H#12 St#5 G-9/1"), C("House 12, Street 5, G-9/1"), true);
      same(C("House 12, Street 5, G-9-1"), C("House 12, Street 5, G-9/1"), true);
      same(C("House 12, Street 5, G-9/1, Islamabad"), C("House 12, Street 5, G-9/1"), true);
    });
  });

  it("earlier rules that still hold", () => {
    const a = C("House 12, Street 5, DHA Phase 6", "Karachi");
    same(a, C("house 12 street 5 dha phase 6", " karachi "), true);
    same(a, C("H# 12 St 5 DHA Phase 6", "Karachi"), true);
    same(a, C("House 12, Street 5, DHA Phase 6, near park", "Karachi"), true); // relaxed (owner): numbers agree and "dha" agrees
    same(a, C("House 12, Street 5, DHA Phase 6", "Lahore"), false); // other city
    same(a, C("House 14, Street 5, DHA Phase 6", "Karachi"), false);
    same(a, C("House 12, Gulshan Block 13", "Karachi"), false);
    L("House 12, Street 5", "House 12, Street 5, Johar Town", false); // no locality word in common
    L("House 12, Street 5, Model Town", "House 12, Street 5, Johar Town", false); // "town" alone tells nothing
    L("House 12, Street 5, Model Town", "House 12, Model Town", false);
    L("House 12", "House 12", true);
    same(C("House 12, Street 5, F-7"), C("House 12, Street 5, G-7"), false);
    L("Flat 4-B, Askari 11, Sarwar Road Cantt", "Flat 4B Askari 11 Sarwar Road Cantt near CSD", true);
  });

  it("address2 is read with address1 as one line", () => {
    const city = "Islamabad";
    same({ address1: "House 12", address2: "Street 5, G-9/1", city }, { address1: "House 12, Street 5, G-9/1", city }, true);
    same({ address1: "House 12", address2: "Street 5, G-9/1", city }, { address1: "House 12", address2: "Street 7, G-9/1", city }, false);
    same({ address1: "House 12, Street 5, G-9/1", address2: "Flat 3", city }, { address1: "House 12, Street 5, G-9/1", city }, false);
    same({ address1: "House 12, Street 5, G-9/1", address2: null, city }, { address1: "House 12, Street 5, G-9/1", address2: "  ", city }, true);
  });
});

describe("signInVerdict", () => {
  const referrer = { email: "ayeshakhan@gmail.com", phone: "+923001234567", first_name: "Ayesha", last_name: "Khan" };

  it("same email or same phone: blocked", () => {
    expect(signInVerdict({ email: "Ayesha.Khan+1@googlemail.com" }, referrer)).toMatchObject({ status: "blocked", flags: ["same_email"] });
    expect(signInVerdict({ email: "other@x.com", phone: "03001234567" }, referrer)).toMatchObject({ status: "blocked", flags: ["same_phone"] });
  });

  it("blocked beats held", () => {
    const v = signInVerdict({ email: "ayeshakhan@gmail.com", first_name: "Ayesha", last_name: "Khan" }, referrer);
    expect(v).toEqual({ status: "blocked", flags: ["same_email"], blockReason: "The friend's email is the referrer's email" });
  });

  it("similar email or same full name: held, with every reason", () => {
    const v = signInVerdict({ email: "ayesha.khan1@yahoo.com", first_name: "AYESHA", last_name: "khan" }, referrer);
    expect(v.status).toBe("flagged");
    expect(v.flags).toEqual(["similar_email", "same_name"]);
    expect(v.blockReason).toBe("The friend's email looks like the referrer's; The friend has the same first and last name as the referrer");
  });

  it("nothing in common: pending", () => {
    expect(signInVerdict({ email: "friend@x.com", phone: "03111111111", first_name: "Hina", last_name: "Ali" }, referrer))
      .toEqual({ status: "pending", flags: [], blockReason: null });
  });
});

describe("orderVerdict", () => {
  const home = { address1: "House 12, Street 5, DHA Phase 6", city: "Karachi", phone: "+923001234567" };

  it("same shipping phone (any referrer phone, any format): same_phone", () => {
    expect(orderVerdict({ phone: "0300 1234567", address: { address1: "Flat 2, Gulberg", city: "Lahore" } }, { ownPhones: [null, "+92 300 1234567"], addresses: [] }))
      .toBe("same_phone");
  });

  it("same address, different phone: same_address", () => {
    expect(orderVerdict({ phone: "03119999999", address: { address1: "H 12 St 5 DHA Phase 6", city: "karachi" } }, { ownPhones: ["03001234567"], addresses: [home] }))
      .toBe("same_address");
  });

  it("phone wins over address when both match", () => {
    expect(orderVerdict({ phone: "03001234567", address: home }, { ownPhones: ["03001234567"], addresses: [home] })).toBe("same_phone");
  });

  it("nothing in common: clear", () => {
    expect(orderVerdict({ phone: "03119999999", address: { address1: "House 3, Model Town", city: "Lahore" } }, { ownPhones: ["03001234567"], addresses: [home] }))
      .toBe("clear");
  });

  it("gift orders (owner, 19 Nov 2026): a phone only on her saved addresses or recent orders holds; her own account phone blocks", () => {
    const order = { phone: "0333 7654321", address: { address1: "Flat 2, Gulberg", city: "Lahore" } };
    expect(orderVerdict(order, { ownPhones: ["03001234567"], otherPhones: ["+92 333 7654321"], addresses: [] })).toBe("same_order_phone");
    expect(orderVerdict(order, { ownPhones: ["03337654321"], otherPhones: ["03337654321"], addresses: [] })).toBe("same_phone"); // own phone wins
    expect(orderVerdict(order, { ownPhones: [], otherPhones: ["03001111111"], addresses: [] })).toBe("clear");
    // a gift phone beats an address match (both only hold; one reason is enough)
    expect(orderVerdict({ phone: "03337654321", address: home }, { ownPhones: [], otherPhones: ["03337654321"], addresses: [home] })).toBe("same_order_phone");
  });

  it("nothing comparable (no shipping details on the order, or none for the referrer): not_checked", () => {
    expect(orderVerdict(null, { ownPhones: ["03001234567"], addresses: [home] })).toBe("not_checked");
    expect(orderVerdict({ phone: null, address: { address1: null, city: null } }, { ownPhones: ["03001234567"], addresses: [home] })).toBe("not_checked");
    expect(orderVerdict({ phone: "03001234567", address: home }, { ownPhones: [null], addresses: [null] })).toBe("not_checked");
  });

  it("only one side comparable: that side decides", () => {
    // order has a phone but no usable address; referrer has a phone: compared on phone only
    expect(orderVerdict({ phone: "03119999999", address: null }, { ownPhones: ["03001234567"], addresses: [home] })).toBe("clear");
  });
});
