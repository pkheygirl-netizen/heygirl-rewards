import { expect, test } from "vitest";
import { hashAddress } from "./referrals.service";

test("hashAddress: deterministic, lowercased + trimmed", () => {
  const h1 = hashAddress("  123 Main St, Karachi  ");
  const h2 = hashAddress("123 main st, karachi");
  expect(h1).toBe(h2);
  expect(h1).toMatch(/^[a-f0-9]{64}$/);
});

test("hashAddress: different addresses produce different hashes", () => {
  expect(hashAddress("123 Main St")).not.toBe(hashAddress("456 Other Rd"));
});
