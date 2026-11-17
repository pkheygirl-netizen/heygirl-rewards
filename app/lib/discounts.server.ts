// app/lib/discounts.server.ts
// Every Shopify discount operation the app performs lives here. The old
// priceRuleCreate / priceRuleDiscountCodeCreate mutations no longer exist in
// the Admin GraphQL schema; these are the current replacements. Each call
// checks `userErrors` and reports failure instead of pretending it worked.
//
// Shapes confirmed against the Admin GraphQL schema (16 Nov 2026):
//   discountCodeBasicCreate(basicCodeDiscount: DiscountCodeBasicInput!)
//   discountCodeFreeShippingCreate(freeShippingCodeDiscount: DiscountCodeFreeShippingInput!)
//   discountCodeDeactivate(id: ID!) / discountCodeDelete(id: ID!)
//   codeDiscountNodeByCode(code: String!)
//   customer restriction: `context: { customers: { add: [ID!] } }` (one-of input)
import crypto from "node:crypto";
import { db } from "../db.server";
import { shopifyGraphqlWithRetry, type AdminGraphqlClient } from "./shopify-graphql.server";

export type DiscountUserError = { field?: string[] | null; message: string; code?: string | null };

export type DiscountResult =
  | { ok: true; discountId: string }
  | { ok: false; reason: "user_errors" | "request_failed" | "code_taken"; userErrors: DiscountUserError[] };

// Reward codes never combine with any other discount (rule 16).
const COMBINES_WITH_NOTHING = { orderDiscounts: false, productDiscounts: false, shippingDiscounts: false };

export const CREATE_BASIC_CODE = `#graphql
  mutation HgDiscountCodeBasicCreate($basicCodeDiscount: DiscountCodeBasicInput!) {
    discountCodeBasicCreate(basicCodeDiscount: $basicCodeDiscount) {
      codeDiscountNode { id }
      userErrors { field message code }
    }
  }`;

export const CREATE_FREE_SHIPPING_CODE = `#graphql
  mutation HgDiscountCodeFreeShippingCreate($freeShippingCodeDiscount: DiscountCodeFreeShippingInput!) {
    discountCodeFreeShippingCreate(freeShippingCodeDiscount: $freeShippingCodeDiscount) {
      codeDiscountNode { id }
      userErrors { field message code }
    }
  }`;

export const DEACTIVATE_CODE = `#graphql
  mutation HgDiscountCodeDeactivate($id: ID!) {
    discountCodeDeactivate(id: $id) {
      codeDiscountNode {
        id
        codeDiscount {
          ... on DiscountCodeBasic { asyncUsageCount }
          ... on DiscountCodeFreeShipping { asyncUsageCount }
        }
      }
      userErrors { field message code }
    }
  }`;

export const DELETE_CODE = `#graphql
  mutation HgDiscountCodeDelete($id: ID!) {
    discountCodeDelete(id: $id) {
      deletedCodeDiscountId
      userErrors { field message code }
    }
  }`;

export const FIND_CODE = `#graphql
  query HgCodeDiscountNodeByCode($code: String!) {
    codeDiscountNodeByCode(code: $code) { id }
  }`;

type CreatePayload = { codeDiscountNode: { id: string } | null; userErrors: DiscountUserError[] };

export function customerGid(shopifyCustomerId: string): string {
  const id = String(shopifyCustomerId);
  return id.startsWith("gid://") ? id : `gid://shopify/Customer/${id}`;
}

function failed(payload: CreatePayload | null | undefined, where: string): DiscountResult {
  const userErrors = payload?.userErrors ?? [];
  const taken = userErrors.some((e) => e.code === "TAKEN" || e.code === "DUPLICATE");
  console.error(`[discounts] ${where} rejected:`, userErrors.map((e) => `${e.code ?? "?"}: ${e.message}`).join("; ") || "no node returned");
  return { ok: false, reason: taken ? "code_taken" : "user_errors", userErrors };
}

function requestFailed(err: unknown, where: string): DiscountResult {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`[discounts] ${where} request failed:`, message);
  return { ok: false, reason: "request_failed", userErrors: [{ message }] };
}

/** Rs. amount off the order, one use, locked to one customer. */
export async function createCustomerAmountOffCode(
  admin: AdminGraphqlClient,
  input: { code: string; title: string; amountPkr: number; shopifyCustomerId: string; startsAt?: Date; endsAt: Date },
): Promise<DiscountResult> {
  if (!Number.isFinite(input.amountPkr) || input.amountPkr <= 0) {
    return { ok: false, reason: "user_errors", userErrors: [{ message: "amount must be greater than zero" }] };
  }
  try {
    const data = await shopifyGraphqlWithRetry<{ discountCodeBasicCreate: CreatePayload | null }>(admin, CREATE_BASIC_CODE, {
      basicCodeDiscount: {
        title: input.title,
        code: input.code,
        startsAt: (input.startsAt ?? new Date()).toISOString(),
        endsAt: input.endsAt.toISOString(),
        usageLimit: 1,
        appliesOncePerCustomer: true,
        combinesWith: COMBINES_WITH_NOTHING,
        context: { customers: { add: [customerGid(input.shopifyCustomerId)] } },
        customerGets: {
          items: { all: true },
          value: { discountAmount: { amount: input.amountPkr.toFixed(2), appliesOnEachItem: false } },
        },
      },
    });
    const payload = data.discountCodeBasicCreate;
    if (!payload || payload.userErrors.length > 0 || !payload.codeDiscountNode) return failed(payload, "discountCodeBasicCreate");
    return { ok: true, discountId: payload.codeDiscountNode.id };
  } catch (err) {
    return requestFailed(err, "discountCodeBasicCreate");
  }
}

/** Free shipping, one use, locked to one customer. */
export async function createCustomerFreeShippingCode(
  admin: AdminGraphqlClient,
  input: { code: string; title: string; shopifyCustomerId: string; startsAt?: Date; endsAt: Date },
): Promise<DiscountResult> {
  try {
    const data = await shopifyGraphqlWithRetry<{ discountCodeFreeShippingCreate: CreatePayload | null }>(
      admin,
      CREATE_FREE_SHIPPING_CODE,
      {
        freeShippingCodeDiscount: {
          title: input.title,
          code: input.code,
          startsAt: (input.startsAt ?? new Date()).toISOString(),
          endsAt: input.endsAt.toISOString(),
          usageLimit: 1,
          appliesOncePerCustomer: true,
          combinesWith: { orderDiscounts: false, productDiscounts: false },
          context: { customers: { add: [customerGid(input.shopifyCustomerId)] } },
          destination: { all: true },
        },
      },
    );
    const payload = data.discountCodeFreeShippingCreate;
    if (!payload || payload.userErrors.length > 0 || !payload.codeDiscountNode) {
      return failed(payload, "discountCodeFreeShippingCreate");
    }
    return { ok: true, discountId: payload.codeDiscountNode.id };
  } catch (err) {
    return requestFailed(err, "discountCodeFreeShippingCreate");
  }
}

/** Public percentage code for an influencer: anyone may use it, no end date, combines with nothing. */
export async function createPublicPercentageCode(
  admin: AdminGraphqlClient,
  input: { code: string; title: string; percentOff: number; startsAt?: Date },
): Promise<DiscountResult> {
  if (!Number.isFinite(input.percentOff) || input.percentOff <= 0 || input.percentOff > 100) {
    return { ok: false, reason: "user_errors", userErrors: [{ message: "percent must be between 1 and 100" }] };
  }
  try {
    const data = await shopifyGraphqlWithRetry<{ discountCodeBasicCreate: CreatePayload | null }>(admin, CREATE_BASIC_CODE, {
      basicCodeDiscount: {
        title: input.title,
        code: input.code,
        startsAt: (input.startsAt ?? new Date()).toISOString(),
        appliesOncePerCustomer: false,
        combinesWith: COMBINES_WITH_NOTHING,
        context: { all: "ALL" },
        customerGets: {
          items: { all: true },
          // Shopify takes the percentage as a fraction: 10% is 0.1.
          value: { percentage: Math.round(input.percentOff) / 100 },
        },
      },
    });
    const payload = data.discountCodeBasicCreate;
    if (!payload || payload.userErrors.length > 0 || !payload.codeDiscountNode) return failed(payload, "discountCodeBasicCreate");
    return { ok: true, discountId: payload.codeDiscountNode.id };
  } catch (err) {
    return requestFailed(err, "discountCodeBasicCreate");
  }
}

/**
 * Stop a code being used. Returns how many times Shopify says it has already
 * been used, so a caller about to return points can refuse when it was spent.
 */
export async function deactivateDiscount(
  admin: AdminGraphqlClient,
  discountId: string,
): Promise<{ ok: true; usageCount: number } | { ok: false; reason: "user_errors" | "request_failed"; userErrors: DiscountUserError[] }> {
  try {
    const data = await shopifyGraphqlWithRetry<{
      discountCodeDeactivate: {
        codeDiscountNode: { id: string; codeDiscount: { asyncUsageCount?: number } | null } | null;
        userErrors: DiscountUserError[];
      } | null;
    }>(admin, DEACTIVATE_CODE, { id: discountId });
    const payload = data.discountCodeDeactivate;
    if (!payload || payload.userErrors.length > 0 || !payload.codeDiscountNode) {
      const userErrors = payload?.userErrors ?? [];
      console.error("[discounts] discountCodeDeactivate rejected:", userErrors.map((e) => e.message).join("; ") || "no node returned");
      return { ok: false, reason: "user_errors", userErrors };
    }
    return { ok: true, usageCount: Number(payload.codeDiscountNode.codeDiscount?.asyncUsageCount ?? 0) };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[discounts] discountCodeDeactivate request failed:", message);
    return { ok: false, reason: "request_failed", userErrors: [{ message }] };
  }
}

/** Remove a code for good (the code text becomes free to use again). */
export async function deleteDiscount(
  admin: AdminGraphqlClient,
  discountId: string,
): Promise<{ ok: true } | { ok: false; reason: "user_errors" | "request_failed"; userErrors: DiscountUserError[] }> {
  try {
    const data = await shopifyGraphqlWithRetry<{
      discountCodeDelete: { deletedCodeDiscountId: string | null; userErrors: DiscountUserError[] } | null;
    }>(admin, DELETE_CODE, { id: discountId });
    const payload = data.discountCodeDelete;
    if (!payload || payload.userErrors.length > 0 || !payload.deletedCodeDiscountId) {
      const userErrors = payload?.userErrors ?? [];
      console.error("[discounts] discountCodeDelete rejected:", userErrors.map((e) => e.message).join("; ") || "nothing deleted");
      return { ok: false, reason: "user_errors", userErrors };
    }
    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[discounts] discountCodeDelete request failed:", message);
    return { ok: false, reason: "request_failed", userErrors: [{ message }] };
  }
}

/** Discount node id for a code, or null when Shopify has no such code. */
export async function findDiscountIdByCode(admin: AdminGraphqlClient, code: string): Promise<string | null> {
  const data = await shopifyGraphqlWithRetry<{ codeDiscountNodeByCode: { id: string } | null }>(admin, FIND_CODE, { code });
  return data.codeDiscountNodeByCode?.id ?? null;
}

// ── Automatic codes (birthday, referral friend, tier rewards) ─────────────

const FREE_SHIPPING_KINDS = new Set(["referral_friend", "tier_gold"]);
const KIND_TITLES: Record<string, string> = {
  birthday: "HeyGirl Rewards: birthday gift",
  referral_friend: "HeyGirl Rewards: friend welcome, free shipping",
  tier_gold: "HeyGirl Rewards: Gold tier, free shipping",
  tier_diamond: "HeyGirl Rewards: Diamond tier reward",
  reward: "HeyGirl Rewards",
};

export type PendingCodeRow = {
  id: string;
  code: string;
  kind: string;
  expires_at: string;
  discount_amount_pkr: number;
};

/**
 * Finish a loyalty_codes row that was left `pending` (the job that created it
 * ran out of retries, or the process died between the two steps). Creates the
 * discount with the row's own code, or adopts it if Shopify already has it,
 * then marks the row active. Used by the pending-code sweep.
 */
export async function finishPendingCode(
  admin: AdminGraphqlClient,
  row: PendingCodeRow,
  shopifyCustomerId: string,
): Promise<{ ok: boolean; freeShipping: boolean; reason?: string }> {
  const freeShipping = FREE_SHIPPING_KINDS.has(row.kind);
  const endsAt = new Date(row.expires_at);
  if (!(endsAt.getTime() > Date.now())) {
    await db.from("loyalty_codes").update({ status: "expired" }).eq("id", row.id).eq("status", "pending");
    return { ok: false, freeShipping, reason: "expired" };
  }
  const amount = Number(row.discount_amount_pkr ?? 0);
  const title = freeShipping ? KIND_TITLES[row.kind] : `${KIND_TITLES[row.kind] ?? KIND_TITLES.reward}, Rs. ${amount} off`;
  let created: DiscountResult = freeShipping
    ? await createCustomerFreeShippingCode(admin, { code: row.code, title, shopifyCustomerId, endsAt })
    : await createCustomerAmountOffCode(admin, { code: row.code, title, amountPkr: amount, shopifyCustomerId, endsAt });
  if (!created.ok && created.reason === "code_taken") {
    try {
      const existingId = await findDiscountIdByCode(admin, row.code);
      if (existingId) created = { ok: true, discountId: existingId };
    } catch (err) {
      console.error("[finishPendingCode] lookup failed:", err instanceof Error ? err.message : err);
    }
  }
  if (!created.ok) return { ok: false, freeShipping, reason: "shopify_error" };
  const { error } = await db
    .from("loyalty_codes")
    .update({ status: "active", shopify_discount_id: created.discountId })
    .eq("id", row.id)
    .eq("status", "pending");
  if (error) return { ok: false, freeShipping, reason: "db_error" };
  return { ok: true, freeShipping };
}

export type AutoCodeKind = "birthday" | "referral_friend" | "tier_gold" | "tier_diamond";

const AUTO_PREFIX: Record<AutoCodeKind, string> = {
  birthday: "BDAY",
  referral_friend: "WELCOME",
  tier_gold: "GOLD",
  tier_diamond: "DIAMOND",
};

/**
 * The code text for an automatic reward is derived from its issue key, so a
 * retry asks Shopify for the same code again instead of minting a second one.
 * It is keyed with the app secret so it cannot be guessed from a member id.
 */
export function deterministicCode(kind: AutoCodeKind, issueKey: string): string {
  const secret = process.env.SHOPIFY_API_SECRET ?? "";
  const digest = crypto.createHmac("sha256", secret).update(issueKey).digest("hex").slice(0, 10).toUpperCase();
  return `${AUTO_PREFIX[kind]}-${digest}`;
}

export type IssueResult =
  | { issued: true; codeId: string; code: string; discountPkr: number; expiresAt: string; freeShipping: boolean }
  | { issued: false; reason: "already_issued" | "shopify_error" | "db_error"; codeId?: string; code?: string };

/**
 * Two-step issue for automatic codes (finding L11):
 *   1. write the loyalty_codes row as `pending` under a unique issue_key
 *   2. create the discount in Shopify
 *   3. flip the row to `active`
 * A crash between 1 and 3 leaves a pending row; the retry picks it up, and if
 * Shopify already has the code it is adopted rather than created twice. A
 * second call after success returns `already_issued`.
 */
export async function issueAutomaticCode(input: {
  admin: AdminGraphqlClient;
  memberId: string;
  shopifyCustomerId: string;
  kind: AutoCodeKind;
  issueKey: string;
  title: string;
  discountPkr: number; // 0 with freeShipping
  freeShipping: boolean;
  expiryDays: number;
}): Promise<IssueResult> {
  const code = deterministicCode(input.kind, input.issueKey);
  const expiresAt = new Date(Date.now() + Math.max(1, input.expiryDays) * 86_400_000).toISOString();

  let row: { id: string; code: string; status: string; expires_at: string; discount_amount_pkr: number } | null = null;

  const { data: inserted, error: insertErr } = await db
    .from("loyalty_codes")
    .insert({
      member_id: input.memberId,
      code,
      kind: input.kind,
      issue_key: input.issueKey,
      discount_amount: input.discountPkr,
      discount_amount_pkr: input.discountPkr,
      points_spent: 0,
      status: "pending",
      expires_at: expiresAt,
    })
    .select("id, code, status, expires_at, discount_amount_pkr")
    .single();

  if (insertErr || !inserted) {
    if (insertErr?.code !== "23505") {
      console.error("[issueAutomaticCode] insert failed:", insertErr?.message);
      return { issued: false, reason: "db_error" };
    }
    const { data: existing, error: readErr } = await db
      .from("loyalty_codes")
      .select("id, code, status, expires_at, discount_amount_pkr")
      .eq("issue_key", input.issueKey)
      .maybeSingle();
    if (readErr || !existing) {
      console.error("[issueAutomaticCode] could not read the existing row:", readErr?.message);
      return { issued: false, reason: "db_error" };
    }
    if (existing.status !== "pending") {
      return { issued: false, reason: "already_issued", codeId: existing.id, code: existing.code };
    }
    row = existing; // an earlier attempt stopped half way: finish it
  } else {
    row = inserted;
  }

  const endsAt = new Date(row.expires_at);
  let created: DiscountResult = input.freeShipping
    ? await createCustomerFreeShippingCode(input.admin, {
        code: row.code,
        title: input.title,
        shopifyCustomerId: input.shopifyCustomerId,
        endsAt,
      })
    : await createCustomerAmountOffCode(input.admin, {
        code: row.code,
        title: input.title,
        amountPkr: input.discountPkr,
        shopifyCustomerId: input.shopifyCustomerId,
        endsAt,
      });

  if (!created.ok && created.reason === "code_taken") {
    // The earlier attempt did reach Shopify. Adopt that discount.
    try {
      const existingId = await findDiscountIdByCode(input.admin, row.code);
      if (existingId) created = { ok: true, discountId: existingId };
    } catch (err) {
      console.error("[issueAutomaticCode] lookup of the existing code failed:", err instanceof Error ? err.message : err);
    }
  }
  if (!created.ok) return { issued: false, reason: "shopify_error", codeId: row.id, code: row.code };

  const { error: updErr } = await db
    .from("loyalty_codes")
    .update({ status: "active", shopify_discount_id: created.discountId })
    .eq("id", row.id)
    .eq("status", "pending");
  if (updErr) {
    console.error("[issueAutomaticCode] could not mark the code active:", updErr.message);
    return { issued: false, reason: "db_error", codeId: row.id, code: row.code };
  }

  return {
    issued: true,
    codeId: row.id,
    code: row.code,
    discountPkr: Number(row.discount_amount_pkr ?? input.discountPkr),
    expiresAt: row.expires_at,
    freeShipping: input.freeShipping,
  };
}
