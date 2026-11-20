-- 017_referral_payment.sql
-- Review 12, item 2: paying, un-claiming and reversing a referral under one
-- row lock each, so a referrer can never keep points for a cancelled order.
--
-- Before this, the app paid a referral in several separate calls (claim the
-- row, add the points, set points_awarded) and looked for paid referrals by
-- status = 'completed'. Two races were reproduced where the referrer kept the
-- points after the friend's order was cancelled (a cron run finishing a claim
-- while the worker processed the cancellation; a payment stalled for more than
-- 10 minutes, released by the cron run and then awarded). Now:
--
--   pay_referral            locks the referral, then the qualifying order,
--                           then the referrer; checks the referral is
--                           pending (or, for an older half-done payment,
--                           still claimed for this order), the order row
--                           exists (else 'order_not_found'), the rule
--                           is on, the referrer may be paid and the order is
--                           not cancelled or refunded in full; then adds the
--                           points (award_points, idempotent on member /
--                           referral_earned / referral id) and marks the
--                           referral completed with points_awarded = true,
--                           all in one transaction.
--   release_referral_claim  puts an older half-done payment back to pending,
--                           only when no referral_earned ledger row exists for
--                           it (checked under the same lock).
--   reverse_referral        takes the points back by referral id, whatever the
--                           referral's status, when a referral_earned row
--                           exists (for the order named, if one is named) and
--                           no referral_reversal row does yet. Idempotent.
--
-- Lock order (no cycles): referral -> order row -> member. 010's functions
-- lock order row -> member and never a referral.
--
-- Review 13:
--   * pay_referral refuses with outcome 'order_not_found' when the order row
--     is missing or the order id (asked for, or on the claim) is null: a
--     referral is never paid on an order the database does not know.
--   * pay_referral from a claim whose release back to pending hits another
--     open referral for the same friend returns 'conflict' (it used to return
--     the refusal reason, which the app read as "released").
--   * every function here runs with SET search_path = public, pg_catalog
--     (still SECURITY INVOKER: they run with the caller's rights).
--   * referrals.completion_email_queued_at (nullable): set by the app when the
--     "referral completed" email is queued, so the 10-minute sweep can queue
--     one lost to a crash or a Redis error. When this file adds the column it
--     marks referrals already completed and paid as queued (their email went
--     out through the old code), so nobody gets a second email.
--   * hg_schema_version() returns 17 when everything in this file is in
--     place (the three functions and the column), else 16; the worker checks
--     it at start and every 10 minutes and raises the alert
--     alert:schema_017 while it is missing.
--
-- Must be applied BEFORE the app version that calls these functions is
-- deployed (together with 016). Safe to apply twice: functions are replaced,
-- the column is added only if missing, and the one-time backfill runs only in
-- the call that adds the column.

-- Set by the app when the "referral completed" email is queued (review 13).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_attribute
     WHERE attrelid = 'public.referrals'::regclass
       AND attname = 'completion_email_queued_at'
       AND NOT attisdropped
  ) THEN
    ALTER TABLE public.referrals ADD COLUMN IF NOT EXISTS completion_email_queued_at timestamptz;
    -- Referrals paid before this column existed had their email queued by the
    -- code of the day: mark them, so the sweep does not send a second one.
    UPDATE public.referrals
       SET completion_email_queued_at = COALESCE(completed_at, now())
     WHERE status = 'completed' AND points_awarded;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.pay_referral(
  p_referral_id      uuid,
  p_points           integer,
  p_shopify_order_id text,
  p_expires_at       timestamptz DEFAULT NULL,
  p_reason_note      text DEFAULT NULL,
  p_customer_note    text DEFAULT NULL,
  p_from_claim       boolean DEFAULT false
) RETURNS TABLE(outcome text, newly_awarded boolean, paid_points integer, member_balance integer)
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_ref       public.referrals%ROWTYPE;
  v_order     public.order_webhook_state%ROWTYPE;
  v_order_hit boolean := false;
  v_member    public.members%ROWTYPE;
  v_earned    integer;
  v_earned_order text;
  v_refuse    text;
  v_rules     jsonb;
  v_basis     numeric;
  v_since     numeric;
  v_awarded   boolean;
  v_balance   integer;
BEGIN
  SELECT * INTO v_ref FROM public.referrals r WHERE r.id = p_referral_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'not_found'::text, false, 0, NULL::integer;
    RETURN;
  END IF;

  IF p_shopify_order_id IS NOT NULL THEN
    SELECT * INTO v_order FROM public.order_webhook_state o
     WHERE o.shopify_order_id = p_shopify_order_id
       FOR SHARE;
    v_order_hit := FOUND;
  END IF;

  SELECT * INTO v_member FROM public.members m WHERE m.id = v_ref.referrer_member_id FOR UPDATE;

  -- Already paid once and taken back: it can never be paid again.
  IF EXISTS (
    SELECT 1 FROM public.points_ledger pl
     WHERE pl.member_id = v_ref.referrer_member_id
       AND pl.action_type = 'referral_reversal'
       AND pl.reference_id = p_referral_id::text
  ) THEN
    UPDATE public.referrals
       SET status = 'rejected', points_awarded = false,
           reviewed_at = COALESCE(reviewed_at, now()),
           reviewed_note = COALESCE(reviewed_note, 'reversed earlier: paid and taken back')
     WHERE id = p_referral_id AND status <> 'rejected';
    RETURN QUERY SELECT 'already_reversed'::text, false, 0, v_member.points_balance;
    RETURN;
  END IF;

  SELECT pl.points, pl.shopify_order_id INTO v_earned, v_earned_order
    FROM public.points_ledger pl
   WHERE pl.member_id = v_ref.referrer_member_id
     AND pl.action_type = 'referral_earned'
     AND pl.reference_id = p_referral_id::text;

  IF v_earned IS NOT NULL THEN
    -- The points are already in the ledger (an older half-done payment, or a
    -- row left pending by the race this migration fixes): record that.
    IF v_ref.status = 'completed' AND v_ref.points_awarded THEN
      RETURN QUERY SELECT 'already_paid'::text, false, v_earned, v_member.points_balance;
      RETURN;
    END IF;
    IF v_ref.status IN ('pending', 'completed') THEN
      UPDATE public.referrals
         SET status = 'completed', points_awarded = true, reward_points = v_earned,
             shopify_order_id = COALESCE(v_earned_order, shopify_order_id, p_shopify_order_id),
             completed_at = COALESCE(completed_at, now())
       WHERE id = p_referral_id;
      RETURN QUERY SELECT 'recorded'::text, false, v_earned, v_member.points_balance;
      RETURN;
    END IF;
    RETURN QUERY SELECT 'not_pending'::text, false, 0, v_member.points_balance;
    RETURN;
  END IF;

  IF p_from_claim THEN
    -- Only an older half-done payment: completed, points_awarded false,
    -- reward_points set (rows completed without payment by the pre-v3 admin
    -- button have no reward_points and are never touched).
    IF NOT (v_ref.status = 'completed' AND NOT v_ref.points_awarded AND v_ref.reward_points IS NOT NULL) THEN
      RETURN QUERY SELECT 'not_claimed'::text, false, 0, v_member.points_balance;
      RETURN;
    END IF;
    -- Review 13: a claim with no order id, or a call naming none, is never
    -- paid (NULL = NULL is not "the same order").
    IF v_ref.shopify_order_id IS NULL OR p_shopify_order_id IS NULL THEN
      RETURN QUERY SELECT 'order_not_found'::text, false, 0, v_member.points_balance;
      RETURN;
    END IF;
    IF v_ref.shopify_order_id <> p_shopify_order_id THEN
      RETURN QUERY SELECT 'other_order'::text, false, 0, v_member.points_balance;
      RETURN;
    END IF;
  ELSIF v_ref.status <> 'pending' THEN
    -- Rejected, blocked, held, or paid by another call in the meantime.
    RETURN QUERY SELECT 'not_pending'::text, false, 0, v_member.points_balance;
    RETURN;
  END IF;

  -- Review 13: the qualifying order must be a row this database knows; with
  -- no row there is nothing to test for a cancellation or a full refund, so
  -- nothing is paid (and nothing is changed: the caller tries again later).
  IF p_shopify_order_id IS NULL OR NOT v_order_hit THEN
    RETURN QUERY SELECT 'order_not_found'::text, false, 0, v_member.points_balance;
    RETURN;
  END IF;

  SELECT s.earn_rules INTO v_rules FROM public.app_settings s WHERE s.id = 1;
  IF v_rules IS NOT NULL AND (v_rules -> 'referral' -> 'enabled') = 'false'::jsonb THEN
    v_refuse := 'disabled';
  ELSIF v_member.id IS NULL THEN
    v_refuse := 'referrer_not_found';
  ELSIF v_member.is_blocked OR v_member.opted_out OR v_member.referrals_blocked THEN
    v_refuse := 'referrer_not_eligible';
  ELSIF p_points IS NULL OR p_points <= 0 THEN
    v_refuse := 'zero_points';
  ELSIF v_order.cancelled_at IS NOT NULL THEN
    v_refuse := 'order_cancelled';
  ELSE
    -- Refunded in full: the same test as the app's fullyRefunded().
    v_basis := COALESCE(v_order.earning_basis_pkr, 0);
    v_since := GREATEST(0, COALESCE(v_order.refunded_basis_pkr, 0) - COALESCE(v_order.refund_basis_at_award_pkr, 0));
    IF v_basis <= 0
       OR (v_order.points_awarded_amount > 0 AND v_order.points_reversed_amount >= v_order.points_awarded_amount)
       OR v_basis - v_since < 0.01 THEN
      v_refuse := 'order_refunded';
    END IF;
  END IF;

  IF v_refuse IS NOT NULL THEN
    IF p_from_claim THEN
      -- Nothing was added: back to pending, so the normal rules decide again
      -- (a later order of hers may be her first qualifying order now).
      BEGIN
        UPDATE public.referrals
           SET status = 'pending', completed_at = NULL, shopify_order_id = NULL, reward_points = NULL
         WHERE id = p_referral_id;
      EXCEPTION WHEN unique_violation THEN
        -- Another open referral for this friend: the claim stays as it is,
        -- for staff. Said as 'conflict' so the app counts it as a failure.
        v_refuse := 'conflict';
      END;
    END IF;
    RETURN QUERY SELECT v_refuse, false, 0, v_member.points_balance;
    RETURN;
  END IF;

  SELECT a.awarded, a.new_balance INTO v_awarded, v_balance
    FROM public.award_points(
      v_ref.referrer_member_id, 'referral_earned', p_referral_id::text, p_points,
      p_expires_at, p_shopify_order_id, p_reason_note, NULL, p_customer_note
    ) a;

  UPDATE public.referrals
     SET status = 'completed', points_awarded = true, completed_at = now(),
         shopify_order_id = p_shopify_order_id, reward_points = p_points
   WHERE id = p_referral_id;

  RETURN QUERY SELECT 'paid'::text, COALESCE(v_awarded, false), p_points, v_balance;
END;
$$;

CREATE OR REPLACE FUNCTION public.release_referral_claim(p_referral_id uuid)
RETURNS text
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_ref public.referrals%ROWTYPE;
BEGIN
  SELECT * INTO v_ref FROM public.referrals r WHERE r.id = p_referral_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN 'not_found';
  END IF;
  IF NOT (v_ref.status = 'completed' AND NOT v_ref.points_awarded AND v_ref.reward_points IS NOT NULL) THEN
    RETURN 'not_claimed';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.points_ledger pl
     WHERE pl.member_id = v_ref.referrer_member_id
       AND pl.action_type = 'referral_earned'
       AND pl.reference_id = p_referral_id::text
  ) THEN
    RETURN 'paid'; -- the points were added: never back to pending
  END IF;
  BEGIN
    UPDATE public.referrals
       SET status = 'pending', completed_at = NULL, shopify_order_id = NULL, reward_points = NULL
     WHERE id = p_referral_id;
  EXCEPTION WHEN unique_violation THEN
    RETURN 'conflict'; -- another open referral for this friend
  END;
  RETURN 'released';
END;
$$;

CREATE OR REPLACE FUNCTION public.reverse_referral(
  p_referral_id      uuid,
  p_reason           text,
  p_shopify_order_id text DEFAULT NULL,
  p_customer_note    text DEFAULT NULL
) RETURNS TABLE(outcome text, reversed_points integer, member_balance integer)
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_ref     public.referrals%ROWTYPE;
  v_before  integer;
  v_earned  integer;
  v_order   text;
  v_balance integer;
  v_reason  text := COALESCE(NULLIF(btrim(p_reason), ''), 'cancelled');
BEGIN
  SELECT * INTO v_ref FROM public.referrals r WHERE r.id = p_referral_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'not_found'::text, 0, NULL::integer;
    RETURN;
  END IF;

  SELECT m.points_balance INTO v_before FROM public.members m WHERE m.id = v_ref.referrer_member_id FOR UPDATE;

  SELECT pl.points, pl.shopify_order_id INTO v_earned, v_order
    FROM public.points_ledger pl
   WHERE pl.member_id = v_ref.referrer_member_id
     AND pl.action_type = 'referral_earned'
     AND pl.reference_id = p_referral_id::text;
  IF v_earned IS NULL THEN
    RETURN QUERY SELECT 'not_paid'::text, 0, v_before;
    RETURN;
  END IF;
  -- Asked about one order, paid for another: not this order's reversal.
  IF p_shopify_order_id IS NOT NULL AND v_order IS NOT NULL AND v_order <> p_shopify_order_id THEN
    RETURN QUERY SELECT 'other_order'::text, 0, v_before;
    RETURN;
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.points_ledger pl
     WHERE pl.member_id = v_ref.referrer_member_id
       AND pl.action_type = 'referral_reversal'
       AND pl.reference_id = p_referral_id::text
  ) THEN
    UPDATE public.referrals
       SET status = 'rejected', points_awarded = false,
           reviewed_at = COALESCE(reviewed_at, now()),
           reviewed_note = COALESCE(reviewed_note, 'reversed automatically: qualifying order ' || v_reason)
     WHERE id = p_referral_id AND status <> 'rejected';
    RETURN QUERY SELECT 'already_reversed'::text, 0, v_before;
    RETURN;
  END IF;

  v_order := COALESCE(p_shopify_order_id, v_order, v_ref.shopify_order_id);
  SELECT a.new_balance INTO v_balance
    FROM public.award_points(
      v_ref.referrer_member_id, 'referral_reversal', p_referral_id::text, -GREATEST(v_earned, 0),
      NULL, v_order, format('qualifying order %s %s', COALESCE(v_order, '?'), v_reason), NULL,
      COALESCE(p_customer_note, 'Referral reversed: your friend''s order was ' || v_reason)
    ) a;

  UPDATE public.referrals
     SET status = 'rejected', points_awarded = false, reviewed_at = now(),
         reviewed_note = 'reversed automatically: qualifying order ' || v_reason
   WHERE id = p_referral_id;

  RETURN QUERY SELECT 'reversed'::text, GREATEST(0, COALESCE(v_before, 0) - COALESCE(v_balance, 0)), v_balance;
END;
$$;

-- 17 when everything this file makes is in place, else 16 (review 13). The
-- worker reads it at start and every 10 minutes (app/lib/schema-check.server.ts).
CREATE OR REPLACE FUNCTION public.hg_schema_version()
RETURNS integer
LANGUAGE sql
STABLE
SET search_path = public, pg_catalog
AS $$
  SELECT CASE
    WHEN to_regprocedure('public.pay_referral(uuid, integer, text, timestamptz, text, text, boolean)') IS NOT NULL
     AND to_regprocedure('public.release_referral_claim(uuid)') IS NOT NULL
     AND to_regprocedure('public.reverse_referral(uuid, text, text, text)') IS NOT NULL
     AND EXISTS (
       SELECT 1 FROM pg_attribute
        WHERE attrelid = to_regclass('public.referrals')
          AND attname = 'completion_email_queued_at'
          AND NOT attisdropped
     )
    THEN 17 ELSE 16
  END
$$;

-- Only the service key may run them (Supabase roles; skipped on a plain
-- Postgres where those roles do not exist).
DO $$
DECLARE
  fn text;
BEGIN
  FOREACH fn IN ARRAY ARRAY[
    'public.pay_referral(uuid, integer, text, timestamptz, text, text, boolean)',
    'public.release_referral_claim(uuid)',
    'public.reverse_referral(uuid, text, text, text)',
    'public.hg_schema_version()'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', fn);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM anon', fn);
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM authenticated', fn);
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', fn);
    END IF;
  END LOOP;
END $$;

NOTIFY pgrst, 'reload schema';
