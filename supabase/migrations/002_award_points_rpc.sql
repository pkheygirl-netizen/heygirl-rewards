CREATE OR REPLACE FUNCTION award_points(
  p_member_id uuid,
  p_action_type text,
  p_reference_id text,
  p_points integer,
  p_expires_at timestamptz DEFAULT NULL,
  p_shopify_order_id text DEFAULT NULL,
  p_reason_note text DEFAULT NULL
) RETURNS TABLE(awarded boolean, new_balance integer)
LANGUAGE plpgsql AS $$
DECLARE
  v_current integer;
  v_delta integer := p_points;
  v_new integer;
BEGIN
  -- Serialize concurrent jobs for the same action+reference
  PERFORM pg_advisory_xact_lock(hashtextextended(p_action_type || ':' || coalesce(p_reference_id,''), 0));

  SELECT points_balance INTO v_current FROM members WHERE id = p_member_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'member % not found', p_member_id;
  END IF;

  -- Clamp negative deltas so balance never goes below zero
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
    RETURN QUERY SELECT false, v_current;  -- duplicate: idempotent no-op
    RETURN;
  END;

  UPDATE members SET points_balance = v_new, updated_at = now() WHERE id = p_member_id;

  IF p_shopify_order_id IS NOT NULL AND p_action_type = 'purchase' THEN
    UPDATE order_webhook_state SET points_awarded = true, updated_at = now()
      WHERE shopify_order_id = p_shopify_order_id;
  END IF;

  RETURN QUERY SELECT true, v_new;
END;
$$;
