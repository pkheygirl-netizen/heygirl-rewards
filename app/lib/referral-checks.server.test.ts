import { describe, expect, it } from "vitest";
import {
  addressKey,
  emailSimilarityKey,
  houseNumber,
  MIN_MEANINGFUL_WORDS,
  normaliseEmail,
  numberTokens,
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

describe("address", () => {
  it("house/flat number: the first number in address1 with a letter straight after it", () => {
    expect(houseNumber("House 12, Street 5")).toBe("12");
    expect(houseNumber("H# 12 St 5")).toBe("12");
    expect(houseNumber("Flat 4-B, Block 7")).toBe("4b");
    expect(houseNumber("12A Gulberg")).toBe("12a");
    expect(houseNumber("Plot 4-Block C")).toBe("4"); // "B" starts a word: not a flat letter
    expect(houseNumber("Main Boulevard")).toBeNull();
  });

  it("strict match: same city AND same house number AND (same address1 OR 80% word overlap)", () => {
    const a = { address1: "House 12, Street 5, DHA Phase 6", city: "Karachi" };
    expect(sameAddress(a, { address1: "house 12 street 5 dha phase 6", city: " karachi " })).toBe(true);
    expect(sameAddress(a, { address1: "H# 12 St 5 DHA Phase 6", city: "Karachi" })).toBe(true); // abbreviations written the same way
    // extra words do not make a match when the shorter address has fewer than 3 meaningful words ("dha" only)
    expect(sameAddress(a, { address1: "House 12, Street 5, DHA Phase 6, near park", city: "Karachi" })).toBe(false);
    expect(sameAddress(a, { address1: "House 12, Street 5, DHA Phase 6", city: "Lahore" })).toBe(false); // other city
    expect(sameAddress(a, { address1: "House 14, Street 5, DHA Phase 6", city: "Karachi" })).toBe(false); // other house
    expect(sameAddress(a, { address1: "House 12, Gulshan Block 13", city: "Karachi" })).toBe(false); // same number, other place
    expect(sameAddress(a, { address1: null, city: "Karachi" })).toBe(false);
    expect(addressKey({ address1: "Main Boulevard", city: "Lahore" })).toBeNull(); // no house number: never matches
  });

  it("number tokens: every number with the letter or sector code written onto it", () => {
    expect([...numberTokens("House 12, Street 5, G-9/1")]).toEqual(["12", "5", "g9/1"]);
    expect([...numberTokens("House 12 Street 5 G9/1")]).toEqual(["12", "5", "g9/1"]);
    expect([...numberTokens("Flat 4-B, Block 7")]).toEqual(["4b", "7"]);
    expect([...numberTokens("Apartment 4B Askari 11")]).toEqual(["4b", "11"]);
    expect([...numberTokens("H# 12 St 5")]).toEqual(["12", "5"]); // "H" before a space is the house abbreviation, not a code
    expect([...numberTokens("House 12 DHA Phase 6")]).toEqual(["12", "6"]);
    expect([...numberTokens("Plot 4-Block C")]).toEqual(["4"]);
    expect(houseNumber("House 12 G-9/1")).toBe("12"); // the sector letter is not a flat letter
  });

  describe("reviewer probe pairs (same city): a different place is NOT the same address", () => {
    const no = (a: string, b: string, city = "Lahore") => expect(sameAddress({ address1: a, city }, { address1: b, city }), `${a} ~ ${b}`).toBe(false);
    it("a bare house number does not match a longer address with more numbers", () => {
      no("House 12", "House 12, Street 40, Model Town");
      no("12", "12 Main Boulevard Gulberg");
    });
    it("a different street, block or phase number is a different place", () => {
      no("House 12, Street 5, G-9/1", "House 12, Street 7, G-9/1", "Islamabad");
      no("Flat 3, Block 7, Gulshan-e-Iqbal", "Flat 3, Block 9, Gulshan-e-Iqbal", "Karachi");
      no("House 12 DHA Phase 5", "House 12 DHA Phase 6");
      no("House 12, Street 5, G-9/1", "House 12, Street 5, G-9/2", "Islamabad"); // other sub-sector
      no("House 12, Street 5, F-7", "House 12, Street 5, G-7", "Islamabad"); // other sector letter
      no("House 12, Street 5, Model Town", "House 12, Model Town"); // street number missing on one side
    });
    it("fewer than 3 meaningful words: only an identical address matches", () => {
      expect(MIN_MEANINGFUL_WORDS).toBe(3);
      no("House 12, Street 5", "House 12, Street 5, Johar Town");
      no("House 12 Block B", "House 12 Block C");
    });
  });

  describe("the same address written two ways still matches", () => {
    const yes = (a: string, b: string, city = "Lahore") => expect(sameAddress({ address1: a, city }, { address1: b, city }), `${a} ~ ${b}`).toBe(true);
    it("identical, and abbreviations", () => {
      yes("House 12", "House 12");
      yes("House 12, Street 40, Model Town", "house 12 street 40 model town");
      yes("H no 12 St 5", "House 12 Street 5");
      yes("H# 12 St 5", "House No 12 Street 5");
      yes("Flat 3, Block 7, Gulshan-e-Iqbal", "Flat 3 Blk 7 Gulshan e Iqbal", "Karachi");
      yes("House 12, Street 5, G-9/1", "H 12 St 5 G9/1", "Islamabad");
      yes("House 12 DHA Phase 6", "House 12 DHA Ph 6");
      yes("Apartment 4B Askari 11", "Flat 4-B, Askari 11");
    });
    it("extra words with the same numbers, when the shorter address has 3 meaningful words", () => {
      yes("Flat 4-B, Askari 11, Sarwar Road Cantt", "Flat 4B Askari 11 Sarwar Road Cantt near CSD");
      yes("House 12, Street 5, Gulshan-e-Ravi Main Boulevard", "House 12 Street 5 Gulshan e Ravi Main Boulevard opposite Ravi Park");
    });
  });

  it("address2 is read with address1 as one line", () => {
    const city = "Islamabad";
    // the street on line 2 on one side, on line 1 on the other: same place
    expect(sameAddress({ address1: "House 12", address2: "Street 5, G-9/1", city }, { address1: "House 12, Street 5, G-9/1", city })).toBe(true);
    // both have line 2 with a different street: different places
    expect(sameAddress({ address1: "House 12", address2: "Street 5, G-9/1", city }, { address1: "House 12", address2: "Street 7, G-9/1", city })).toBe(false);
    // a flat number only on one side's line 2: a different flat
    expect(sameAddress({ address1: "House 12, Street 5, G-9/1", address2: "Flat 3", city }, { address1: "House 12, Street 5, G-9/1", city })).toBe(false);
    expect(sameAddress({ address1: "House 12, Street 5, G-9/1", address2: null, city }, { address1: "House 12, Street 5, G-9/1", address2: "  ", city })).toBe(true);
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
    expect(orderVerdict({ phone: "0300 1234567", address: { address1: "Flat 2, Gulberg", city: "Lahore" } }, { phones: [null, "+92 300 1234567"], addresses: [] }))
      .toBe("same_phone");
  });

  it("same address, different phone: same_address", () => {
    expect(orderVerdict({ phone: "03119999999", address: { address1: "H 12 St 5 DHA Phase 6", city: "karachi" } }, { phones: ["03001234567"], addresses: [home] }))
      .toBe("same_address");
  });

  it("phone wins over address when both match", () => {
    expect(orderVerdict({ phone: "03001234567", address: home }, { phones: ["03001234567"], addresses: [home] })).toBe("same_phone");
  });

  it("nothing in common: clear", () => {
    expect(orderVerdict({ phone: "03119999999", address: { address1: "House 3, Model Town", city: "Lahore" } }, { phones: ["03001234567"], addresses: [home] }))
      .toBe("clear");
  });

  it("nothing comparable (no shipping details on the order, or none for the referrer): not_checked", () => {
    expect(orderVerdict(null, { phones: ["03001234567"], addresses: [home] })).toBe("not_checked");
    expect(orderVerdict({ phone: null, address: { address1: null, city: null } }, { phones: ["03001234567"], addresses: [home] })).toBe("not_checked");
    expect(orderVerdict({ phone: "03001234567", address: home }, { phones: [null], addresses: [null] })).toBe("not_checked");
  });

  it("only one side comparable: that side decides", () => {
    // order has a phone but no usable address; referrer has a phone: compared on phone only
    expect(orderVerdict({ phone: "03119999999", address: null }, { phones: ["03001234567"], addresses: [home] })).toBe("clear");
  });
});
