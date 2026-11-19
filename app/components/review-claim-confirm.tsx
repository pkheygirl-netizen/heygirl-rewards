// app/components/review-claim-confirm.tsx
// The confirmation shown before a review claim is approved or rejected
// (Home and the customer profile). Points are added only on approval (rule 14).
import { Text } from "@shopify/polaris";
import { ConfirmModal } from "./admin-ui";

export type ClaimDecision = { kind: "approve" | "reject"; id: string; name: string; points: number };

const fmt = (n: number) => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");

export function ReviewClaimConfirm(props: {
  decision: ClaimDecision | null; loading: boolean;
  onClose: () => void; onConfirm: (d: ClaimDecision) => void;
}) {
  const d = props.decision;
  return (
    <ConfirmModal
      open={d !== null}
      title={d?.kind === "approve" ? "Approve this review?" : "Reject this review claim?"}
      confirmLabel={d?.kind === "approve" ? `Approve and add ${fmt(d?.points ?? 0)} points` : "Reject claim"}
      destructive={d?.kind !== "approve"}
      loading={props.loading}
      onClose={props.onClose}
      onConfirm={() => { if (d) props.onConfirm(d); }}
    >
      <Text as="p">
        {d?.kind === "approve"
          ? `${d.name} gets ${fmt(d.points)} points now. Check first that she posted a public review of her order and tagged @heygirl.pk.`
          : `${d?.name ?? "She"} will not receive the review points for this claim. This cannot be undone from here.`}
      </Text>
    </ConfirmModal>
  );
}
