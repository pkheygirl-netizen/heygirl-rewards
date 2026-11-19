// app/lib/admin-review-claims.server.ts
// Approve / Reject for review claims (rule 14: points only on staff approval).
// Shared by Home ("Needs your attention") and the customer profile.
import { UUID_RE } from "./admin-db.server";
import { approveReviewClaim, rejectReviewClaim } from "./review-claims.service";

export type ClaimActionResult =
  | { ok: true; message: string }
  | { ok: false; error: string; status: number };

const REFUSED: Record<string, string> = {
  not_found: "That claim could not be found.",
  already_resolved: "This claim was already approved or rejected. Nothing was changed.",
  disabled: "Reviews are switched off on the Program page, so no points were added. The claim is still waiting.",
  blocked: "This customer is blocked or opted out, so no points were added. You can reject the claim instead.",
  order_gone: "Her order was cancelled or refunded in full, so no points were added. You can reject the claim instead.",
};

const fmt = (n: number) => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");

/**
 * `intent` is "approve_claim" or "reject_claim"; anything else returns null so
 * the route can handle its own intents. `allowed`, when given, limits the
 * action to these claim ids (the customer profile passes her own claims).
 */
export async function handleReviewClaimIntent(
  intent: string, claimIdRaw: unknown, actor: string, allowed?: string[],
): Promise<ClaimActionResult | null> {
  if (intent !== "approve_claim" && intent !== "reject_claim") return null;
  const claimId = String(claimIdRaw ?? "");
  if (!UUID_RE.test(claimId)) return { ok: false, error: REFUSED.not_found, status: 400 };
  if (allowed && !allowed.includes(claimId)) return { ok: false, error: REFUSED.not_found, status: 404 };

  if (intent === "reject_claim") {
    const res = await rejectReviewClaim(claimId, actor);
    if (!res.ok) return { ok: false, error: REFUSED.already_resolved, status: 409 };
    return { ok: true, message: "Review claim rejected. No points were added" };
  }
  const res = await approveReviewClaim(claimId, actor);
  if (!res.ok) return { ok: false, error: REFUSED[res.reason] ?? REFUSED.not_found, status: res.reason === "not_found" ? 404 : 409 };
  return {
    ok: true,
    message: res.alreadyPaid
      ? "Review approved. Its points had already been added"
      : `Review approved. ${fmt(res.points)} points added`,
  };
}
