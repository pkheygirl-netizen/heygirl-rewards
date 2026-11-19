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
      L("H# 12 St 5", "House No 12 Street 5", false); // round 10: no locality word or sector on either side = city-wide, never a match
      same(C("H# 12 St 5 G-9/1"), C("House No 12 Street 5 G-9/1"), true); // the same with a sector
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

  describe("review 10: all 72 reviewer pairs with the intended answer (S*/P* = one person writing her address twice; G* = two genuine friends; S31 = floor on one side only, no match by design)", () => {
    type R = { address1: string; address2: string | null; city: string };
    const A = (address1: string, city: string, address2?: string): R => ({ address1, address2: address2 ?? null, city });
    const cases: Array<[R, R, boolean, string]> = [
      // ── self-referrals written differently (expect true) ──
      [A("House 12, Street 5, G-9/1","Islamabad"), A("H# 12 St 5 G 9/1","Islamabad"), true, "S1 ISB H# / G 9/1"],
      [A("H.No. 45, Block 13-D, Gulshan-e-Iqbal","Karachi"), A("House No 45 Block 13D Gulshan e Iqbal","Karachi"), true, "S2 KHI Gulshan 13-D"],
      [A("Flat B-4, 2nd Floor, Sea View Apartments, Clifton Block 2","Karachi"), A("Flat 4-B 2nd floor Sea View Apts, Block 2 Clifton","Karachi"), true, "S3 Clifton flat floor"],
      [A("House 23, Street 7, Phase VI DHA","Lahore"), A("H 23 St 7 DHA Phase 6","Lahore"), true, "S4 LHR DHA Phase VI"],
      [A("House 112-C, Model Town","Lahore"), A("112 C Model Town","Lahore"), true, "S5 Model Town 112-C vs 112 C"],
      [A("Plot 34, Khayaban-e-Ittehad, Phase 6 DHA","Karachi"), A("34 Khayaban e Ittehad DHA Phase VI","Karachi"), true, "S6 plot label vs bare number"],
      [A("House 5, Street 10, F-7/2","Islamabad"), A("House #5, St. 10, Sector F-7/2","Islamabad, ICT"), true, "S7 F-7/2 with Sector label + ICT"],
      [A("House 789, Block R-1, Johar Town","Lahore"), A("H no 789 R1 Johar town","Lahore Punjab"), true, "S8 Johar Block R-1 vs R1"],
      [A("A-12, Block 7, Gulistan-e-Jauhar","Karachi"), A("House A-12, Block-7, Gulistan e Johar","Karachi"), true, "S9 A-12 vs House A-12"],
      [A("House 12, Street 3, I-8/3","Islamabad"), A("H-12, St 3, I 8/3","Islamabad"), true, "S10 H-12 = house (sector present)"],
      [A("House 3, Street 12, H-12","Islamabad"), A("H#3 St 12 Sector H-12","Islamabad"), true, "S11 sector H-12"],
      [A("Bahria Town Phase 4, Street 9, House 221","Rawalpindi"), A("House 221 St 9 Phase IV Bahria Town","Pindi"), true, "S12 Bahria Pindi alias"],
      [A("Flat 302, Block A, Askari 11","Lahore"), A("Askari XI, Flat no. 302, Block-A","Lahore"), true, "S13 Askari XI"],
      [A("House 17-B, Street 2, Gulberg III","Lahore"), A("17B St 2 Gulberg 3","Lahore"), true, "S14 House 17-B vs bare 17B"],
      [A("House 45, Street 6, G-9/1","Islamabad","near Masjid Bilal"), A("House 45 Street 6 G-9/1","Islamabad"), true, "S15 near masjid one side"],
      [A("House 10 Block D North Nazimabad","Karachi"), A("H. No. 10, D Block, North Nazimabad","Karachi"), true, "S16 'D Block' word order"],
      [A("House 22, Street 4, Phase 2 Bahria Town","Rawalpindi","46000 0300-1234567"), A("House 22 Street 4 Bahria Town Phase 2","Rawalpindi"), true, "S17 postcode+phone ignored"],
      [A("House ۱۲, Street ۵, G-9/1","Islamabad"), A("House 12 Street 5 G-9/1","Islamabad"), true, "S18 Urdu digits"],
      [A("Upper Portion, House 56, Street 3, F-10/4","Islamabad"), A("House 56 St 3 F-10/4","Islamabad"), true, "S19 upper portion one side"],
      [A("House 8, Lane 3, DHA Phase 8","Karachi"), A("8 Lane 3 Phase VIII DHA","Karachi"), true, "S20 house label vs bare 8"],
      [A("Apartment 5C, Block 4, Clifton","Karachi"), A("Flat 5-C, Block 4, Clifton","Karachi"), true, "S21 apartment = flat"],
      [A("House 14, Street 21, E-11/2","Islamabad"), A("House 14 Street 21 E 11/2","Islamabad"), true, "S22 E-11/2"],
      [A("House 14, Street 21, E-11","Islamabad"), A("House 14 St 21 Sector E-11","Islamabad"), true, "S23 E-11 with Sector"],
      [A("House 5, Street 2, Askari 10","Lahore Cantt"), A("House 5 St 2 Askari X","Lahore"), true, "S24 Lahore Cantt city + Askari X"],
      [A("H 12, Bahria Enclave","Islamabad"), A("House 12, Bahria Enclave","Islamabad"), true, "S25 ambiguous H 12 = house"],
      [A("House 5, DHA Phase V","Lahore"), A("House 5 DHA Phase 5","Lahore"), true, "S26 Phase V roman"],
      [A("House 7, Gulshan-e-Iqbal Block 2","Karachi"), A("House 7, Gulshan-e-Iqbal Block 2","Karachi"), true, "S27 identical"],
      [A("House 9, Street 1, Sector E, Bahria Town","Lahore"), A("H#9 Street 1 Sector E Bahria","Lahore"), true, "S28 Sector E"],
      [A("R-45, Block 15, FB Area","Karachi"), A("House R-45 Block 15 F.B. Area","Karachi"), true, "S29 R-45 FB Area"],
      [A("House 12 Street 5 G-9/1","Islamabad"), A("G-9/1 Street 5 House 12","islamabad"), true, "S30 reordered lowercase city"],
      [A("Flat 12, 3rd Floor, Block 5, Clifton","Karachi"), A("Flat 12 Block 5 Clifton","Karachi"), false, "S31 floor written one side only (design: no match)"],
      [A("House 33, Street 4, Gulberg II","Lahore"), A("House 33 Street 4 Gulberg-2","Lahore"), true, "S32 Gulberg-2"],
      [A("House 33-A, Johar Town","Lahore"), A("33A Johar Town","Lahore"), true, "S33 33-A vs 33A no label"],
      // ── genuine different friends (expect false) ──
      [A("House 12, Street 5, G-9/1","Islamabad"), A("House 14, Street 5, G-9/1","Islamabad"), false, "G1 neighbour house"],
      [A("House 12, Street 5, G-9/1","Islamabad"), A("House 12, Street 5, G-9/2","Islamabad"), false, "G2 sub-sector"],
      [A("Flat 4-B, Sea View Apartments, Clifton","Karachi"), A("Flat 5-B, Sea View Apartments, Clifton","Karachi"), false, "G3 flat"],
      [A("House 23, Street 7, DHA Phase 6","Lahore"), A("House 23, Street 7, DHA Phase 5","Lahore"), false, "G4 phase"],
      [A("House 12, Model Town","Lahore"), A("House 12, Model Town","Karachi"), false, "G5 city"],
      [A("House 10, Block D, North Nazimabad","Karachi"), A("House 10, Block D, Gulshan","Karachi"), false, "G6 locality"],
      [A("House 10, Block 13-D, Gulshan-e-Iqbal","Karachi"), A("House 10, Block 13-D, Gulistan-e-Jauhar","Karachi"), false, "G7 Gulshan vs Gulistan"],
      [A("Flat 1, 1st Floor, Building 7, Bahadurabad","Karachi"), A("Flat 1, 2nd Floor, Building 7, Bahadurabad","Karachi"), false, "G8 floor"],
      [A("House 221, Street 9, Phase 4 Bahria Town","Rawalpindi"), A("House 221, Street 9, Phase 7 Bahria Town","Rawalpindi"), false, "G9 Bahria phase"],
      [A("House 5, Street 10, F-7/2","Islamabad"), A("House 5, Street 10, F-7/3","Islamabad"), false, "G10 F-7/3"],
      [A("House 3, Street 12, Sector H-12","Islamabad"), A("H-12 Street 3","Islamabad"), false, "G11 H-12 swap"],
      [A("Flat 12, NUST Hostel, H-12","Islamabad"), A("House 12, Street 4, G-11/3","Islamabad"), false, "G12 NUST H-12"],
      [A("House 12","Lahore","Gulberg"), A("House 12, Johar Town","Lahore"), false, "G13 locality differs"],
      [A("Flat 302, Block A, Askari 11","Lahore"), A("Flat 302, Block B, Askari 11","Lahore"), false, "G14 block letter"],
      [A("House 45, Street 6, G-9/1","Islamabad"), A("House 6, Street 45, G-9/1","Islamabad"), false, "G15 swapped numbers"],
      [A("Street 5, House 12, Johar Town Block R1","Lahore"), A("House 12, Street 5, Johar Town Block R2","Lahore"), false, "G16 R1 vs R2"],
      [A("House 7, Street 1, Mohallah Islampura, near Main Bazar","Lahore"), A("House 7, Street 1, Krishan Nagar, near Main Bazar","Lahore"), false, "G17 shared 'bazar' only"],
      [A("House 12, Street 5, near Jamia Masjid, Ichhra","Lahore"), A("House 12, Street 5, near Jamia Masjid, Shadman","Lahore"), false, "G18 shared 'jamia masjid'"],
      [A("House 12, Street 5","Lahore"), A("House 12, Street 5","Lahore"), false, "G19 no locality at all (city-wide: no match since round 10)"],
      [A("House 2, Street 3, Gulberg III","Lahore"), A("House 2, Street 3, Gulberg II","Lahore"), false, "G20 Gulberg III vs II"],
      [A("House 9, Street 1, Sector C, Bahria Town","Lahore"), A("House 9, Street 1, Sector E, Bahria Town","Lahore"), false, "G21 Sector C vs E"],
      [A("House 9, Phase V, DHA","Lahore"), A("House 9, DHA Phase 6","Lahore"), false, "G22 Phase V vs 6"],
      [A("House 4, Askari X","Lahore"), A("House 4, Askari 11","Lahore"), false, "G23 Askari X vs 11"],
      [A("12","Karachi"), A("12","Karachi"), false, "G24 only digits"],
      [A("House 15, Street 2, near Chase Up, Gulshan Block 6","Karachi"), A("House 15, Street 2, near Chase Up, Gulshan Block 6","Hyderabad"), false, "G25 diff city same line"],
      [A("House 1, Street 1, Sector I-8/3","Islamabad"), A("House 1, Street 1, Sector I-8/4","Islamabad"), false, "G26 I-8/3 vs I-8/4"],
      [A("House 11, Street 2, near Hospital, Satellite Town","Rawalpindi"), A("House 11, Street 2, near Hospital, Westridge","Rawalpindi"), false, "G27 shared 'hospital'"],
      [A("C-12, Block 2, PECHS","Karachi"), A("C-12, Block 2, KDA Scheme 1","Karachi"), false, "G28 PECHS vs KDA"],
      [A("House 12, Street 5, G-9/1","Islamabad","0300 1234567"), A("House 12 Street 5 G-9/1","Islamabad"), true, "P1 phone in address2 after sector"],
      [A("House 12","Lahore","0321-1234567 Johar Town"), A("House 12 Johar Town","Lahore"), true, "P2 phone right after house no"],
      [A("Faisal Town, 123-A","Lahore"), A("123-A Faisal Town","Lahore"), true, "P3 Town label eats house no"],
      [A("University Road, 23-B, Block 13","Karachi"), A("23-B, Block 13, Gulshan, University Road","Karachi"), true, "P4 Road label eats house no"],
      [A("Flat 4-B 2nd Floor, Block 2, Clifton","Karachi"), A("Flat B-4, 2nd Floor, Block 2, Clifton","Karachi"), true, "P5 4-B followed by number"],
      [A("House 10 D Block North Nazimabad","Karachi"), A("House 10, Block D, North Nazimabad","Karachi"), true, "P6 D Block no comma"],
      [A("House 5, Phase I, DHA","Lahore"), A("House 5, Phase 1, DHA","Lahore"), true, "P7 Phase I"],
      [A("House 12, Street 5, G-9/1","Islamabad"), A("House 12, Street 5, G-9/1","Islamabad, Pakistan"), true, "P8 city with country"],
      [A("House 12, Street 5, G-9/1","Islamabad"), A("House 12, Street 5, G-9/1","Islamabad Capital Territory"), true, "P9 city 'Capital Territory'"],
      // genuine
      [A("House 12, Main Market Road","Lahore"), A("House 12, Main Market Road","Lahore"), true, "P10 identical"],
      [A("House 1, Street 2, near Park","Karachi"), A("House 1, Street 2, near Park","Karachi"), true, "P11 identical landmark only"],
    ];
    it("has every pair", () => {
      expect(cases).toHaveLength(72);
    });
    for (const [x, y, want, label] of cases) {
      it(label, () => same(x, y, want));
    }
  });

  it("round 10 details", () => {
    // phones are removed by shape, keeping the house / sector numbers next to them
    expect([...addressReadings(C("G-9/1 0300 1234567, House 12"))[0].labelled].sort()).toEqual(["house:12", "sector:g9/1"]);
    expect([...addressReadings(C("House 12 0321-1234567 Johar Town", "Lahore"))[0].labelled]).toEqual(["house:12"]);
    expect([...addressReadings(C("House 12, Johar Town 042-35761234", "Lahore"))[0].numbers]).toEqual([]);
    expect([...addressReadings(C("House 12, Johar Town 46000 0300-1234567", "Lahore"))[0].numbers]).toEqual([]);
    expect([...addressReadings(C("House 12, Johar Town +923001234567", "Lahore"))[0].numbers]).toEqual([]);
    // "4-B" = "4B" = "B-4" = "B4"
    for (const v of ["Flat 4-B, Clifton", "Flat 4B, Clifton", "Flat B-4, Clifton", "Flat B4, Clifton", "Flat 4 B, Clifton"]) {
      expect([...addressReadings(C(v, "Karachi"))[0].labelled], v).toEqual(["flat:4b"]);
    }
    // a label never takes a value across a comma; road and town take only a plain number
    expect([...addressReadings(C("Faisal Town, 123-A", "Lahore"))[0].numbers]).toEqual(["123a"]);
    expect([...addressReadings(C("University Road 23-B", "Karachi"))[0].numbers]).toEqual(["23b"]);
    // "D Block" = "Block D"; "10 D Block" = house 10, block D
    expect([...addressReadings(C("House 10 D Block, North Nazimabad", "Karachi"))[0].labelled].sort()).toEqual(["block:d", "house:10"]);
    expect([...addressReadings(C("10 D Block North Nazimabad", "Karachi"))[0].numbers]).toEqual(["10"]);
    // Roman I, V, X only after phase/block/sector/askari/gulberg/town
    expect([...addressReadings(C("House 5, Phase V, DHA", "Lahore"))[0].labelled].sort()).toEqual(["house:5", "phase:5"]);
    expect([...addressReadings(C("House 5, Askari X", "Lahore"))[0].numbers]).toEqual(["10"]);
    expect([...addressReadings(C("House 5, Gulberg I", "Lahore"))[0].numbers]).toEqual(["1"]);
    // landmark words are weak; before "road" they name the road
    const lm = addressReadings(C("House 5, near Jamia Masjid, University Road", "Karachi"))[0];
    expect([...lm.words]).toEqual(["university"]);
    expect([...lm.landmarks].sort()).toEqual(["jamia", "masjid"]);
    L("House 5, Street 2, near Main Bazar, Ichhra", "House 5, Street 2, near Main Bazar, Shadman", false);
    L("House 5, Mall Road", "House 5, Mall Road", true);
    // a stand-in only when the other side has no house/flat/plot label at all
    L("Flat 302, Block A, Askari 11", "House 11, Block A, Askari 302", false);
    // the city field
    expect(cityKey("Lahore Cantt")).toBe("lahore");
    expect(cityKey("Rawalpindi Cantonment")).toBe("rawalpindi");
    expect(cityKey("Islamabad Capital Territory")).toBe("islamabad");
    expect(cityKey("Islamabad, ICT")).toBe("islamabad");
    // initials: "F.B. Area" = "FB Area"
    expect([...addressReadings(C("House R-45, F.B. Area", "Karachi"))[0].words]).toEqual(["fb"]);
  });

  it("stays fast on hostile 100 KB input (linear regular expressions)", () => {
    const inputs = [
      "1".repeat(100_000), "a ".repeat(50_000), "1-".repeat(50_000), "1 ".repeat(50_000), "g" + "1/".repeat(50_000) + "x",
      "h no ".repeat(20_000), "a1 ".repeat(33_000), "1a ".repeat(33_000), "0300 ".repeat(20_000), "+92 ".repeat(25_000),
      "1, ".repeat(33_000), "d block ".repeat(12_500), "f.b. ".repeat(20_000), "1 a 1 a ".repeat(12_500), "1" + " -".repeat(50_000) + "x",
      "1".repeat(50_000) + "a" + "1".repeat(50_000),
    ];
    for (const s of inputs) {
      const t0 = Date.now();
      sameAddress({ address1: s, address2: s, city: "Karachi" }, { address1: s, city: "Karachi" });
      expect(Date.now() - t0, s.slice(0, 12)).toBeLessThan(1500);
    }
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
    L("House 12", "House 12", false); // round 10: a bare house number alone never matches
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
