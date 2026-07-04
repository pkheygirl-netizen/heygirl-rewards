-- supabase/migrations/008_redemption_balance_guard.sql
-- W2 (2026-07-03 review): award_points clamped a would-be-negative balance to zero
-- and still returned awarded=true. For redemptions that meant a concurrent second
-- redeem could issue a full discount code while deducting fewer (or zero) points.
-- Redemptions must be rejected outright when the balance is insufficient; the
-- clamp remains intentional for refund_deduction/expiry clawbacks.

CREATE OR REPLACE FUNCTION award_points(
  p_member_id uuid,
  p_action_type text,
  p_reference_id text,
  p_points integer,
  p_expires_at timestamptz DEFAULT NULL,
  p_shopify_order_id text DEFAULT NULL,
  p_reason_note text DEFAULT NULL,
  p_purchase_amount_pkr numeric DEFAULT NULL
) RETURNS TABLE(awarded boolean, new_balance integer, new_lifetime_spend_pkr numeric)
LANGUAGE plpgsql AS $$
DECLARE
  v_current integer;
  v_delta   integer := p_points;
  v_new     integer;
  v_lifetime numeric;
  v_remaining integer;
  v_take    integer;
  tranche_row record;
BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtextextended(p_action_type || ':' || coalesce(p_reference_id, ''), 0)
  );

  SELECT points_balance, COALESCE(lifetime_spend_pkr, 0)
    INTO v_current, v_lifetime
    FROM members
   WHERE id = p_member_id
     FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'member % not found', p_member_id;
  END IF;

  -- Redemptions: reject insufficient balance instead of clamping (W2 fix).
  IF p_action_type = 'redemption' AND v_current + v_delta < 0 THEN
    RETURN QUERY SELECT false, v_current, v_lifetime;
    RETURN;
  END IF;

  IF v_current + v_delta < 0 THEN
    v_delta := -v_current;
  END IF;
  v_new := v_current + v_delta;

  BEGIN
    INSERT INTO points_ledger
      (member_id, action_type, reference_id, points, balance_after,
       expires_at, points_remaining, shopify_order_id, reason_note)
    VALUES
      (p_member_id, p_action_type, p_reference_id, v_delta, v_new,
       p_expires_at,
       CASE WHEN p_action_type = 'purchase' AND v_delta > 0 THEN v_delta ELSE NULL END,
       p_shopify_order_id, p_reason_note);
  EXCEPTION WHEN unique_violation THEN
    RETURN QUERY SELECT false, v_current, v_lifetime;
    RETURN;
  END;

  UPDATE members
     SET points_balance = v_new, updated_at = now()
   WHERE id = p_member_id;

  -- Atomically add to lifetime_spend on purchases
  IF p_action_type = 'purchase' AND p_purchase_amount_pkr IS NOT NULL THEN
    v_lifetime := v_lifetime + p_purchase_amount_pkr;
    UPDATE members SET lifetime_spend_pkr = v_lifetime WHERE id = p_member_id;
  END IF;

  -- Mark order as points_awarded
  IF p_shopify_order_id IS NOT NULL AND p_action_type = 'purchase' THEN
    UPDATE order_webhook_state
       SET points_awarded = true, updated_at = now()
     WHERE shopify_order_id = p_shopify_order_id;
  END IF;

  -- Atomic FIFO decrement for refund deductions
  IF p_action_type = 'refund_deduction' THEN
    v_remaining := -v_delta;
    FOR tranche_row IN
      SELECT id, points_remaining
        FROM points_ledger
       WHERE member_id = p_member_id
         AND action_type = 'purchase'
         AND expired = false
         AND points_remaining > 0
       ORDER BY earned_at ASC
         FOR UPDATE
    LOOP
      EXIT WHEN v_remaining <= 0;
      v_take := LEAST(tranche_row.points_remaining, v_remaining);
      UPDATE points_ledger
         SET points_remaining = points_remaining - v_take
       WHERE id = tranche_row.id;
      v_remaining := v_remaining - v_take;
    END LOOP;
  END IF;

  -- Mark source tranche as expired (atomic with the balance deduction)
  IF p_action_type = 'expiry' THEN
    UPDATE points_ledger
       SET points_remaining = 0, expired = true
     WHERE id = p_reference_id::uuid;
  END IF;

  RETURN QUERY SELECT true, v_new, v_lifetime;
END;
$$;
