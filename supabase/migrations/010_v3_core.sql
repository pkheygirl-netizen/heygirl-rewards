-- supabase/migrations/010_v3_core.sql
-- HeyGirl Rewards v3 core (docs/v3-contract.md section 2).
-- Idempotent: safe to run more than once. Take a database backup before the
-- first run: the points function is replaced and existing ledger rows are
-- backfilled.

-- ───────────────────────────── members ─────────────────────────────
ALTER TABLE public.members ALTER COLUMN email DROP NOT NULL;

ALTER TABLE public.members
  ADD COLUMN IF NOT EXISTS phone                      text,
  ADD COLUMN IF NOT EXISTS consent_source             text,
  ADD COLUMN IF NOT EXISTS opted_out                  boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS birthday_set_at            timestamptz,
  ADD COLUMN IF NOT EXISTS last_seen_ip               text,
  ADD COLUMN IF NOT EXISTS referrals_blocked          boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS influencer_multiplier      numeric(4,2),
  ADD COLUMN IF NOT EXISTS influencer_campaign        text,
  ADD COLUMN IF NOT EXISTS influencer_paused          boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS influencer_rate_starts_at  timestamptz,
  ADD COLUMN IF NOT EXISTS influencer_rate_ends_at    timestamptz,
  ADD COLUMN IF NOT EXISTS influencer_code            text,
  ADD COLUMN IF NOT EXISTS influencer_code_percent    integer,
  ADD COLUMN IF NOT EXISTS influencer_code_discount_id text,
  ADD COLUMN IF NOT EXISTS imported_from_smile        boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS first_order_awarded_at     timestamptz;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'members_consent_source_check'
                    AND conrelid = 'public.members'::regclass) THEN
    ALTER TABLE public.members
      ADD CONSTRAINT members_consent_source_check
      CHECK (consent_source IN ('order','signin','import','admin'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'members_influencer_code_key'
                    AND conrelid = 'public.members'::regclass) THEN
    ALTER TABLE public.members
      ADD CONSTRAINT members_influencer_code_key UNIQUE (influencer_code);
  END IF;
END $$;

-- A birthday that already exists counts as "set once" (rule 13).
UPDATE public.members
   SET birthday_set_at = created_at
 WHERE birthday_month IS NOT NULL AND birthday_set_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_members_phone ON public.members (phone);
CREATE INDEX IF NOT EXISTS idx_members_birthday_month ON public.members (birthday_month);

-- ─────────────────────────── points_ledger ───────────────────────────
ALTER TABLE public.points_ledger
  ADD COLUMN IF NOT EXISTS customer_note text;

-- Replace the action_type CHECK (whatever it is called) with the v3 list.
DO $$
DECLARE c record;
BEGIN
  FOR c IN
    SELECT conname FROM pg_constraint
     WHERE conrelid = 'public.points_ledger'::regclass
       AND contype = 'c'
       AND pg_get_constraintdef(oid) ILIKE '%action_type%'
  LOOP
    EXECUTE format('ALTER TABLE public.points_ledger DROP CONSTRAINT %I', c.conname);
  END LOOP;
  ALTER TABLE public.points_ledger
    ADD CONSTRAINT points_ledger_action_type_check CHECK (action_type IN (
      'signup','purchase','social_youtube','social_facebook','social_instagram',
      'review','referral_earned','referral_bonus','redemption','expiry',
      'adjustment','birthday','campaign_bonus','refund_deduction',
      'order_cancelled','referral_reversal','redemption_return','tier_reward',
      'influencer_sale','import'
    ));
END $$;

-- Every positive, unexpired row becomes a FIFO tranche.
UPDATE public.points_ledger
   SET points_remaining = points
 WHERE points_remaining IS NULL AND points > 0 AND expired = false;

-- Earlier versions only decremented purchase tranches on refunds, so the
-- tranche total can exceed the member's balance. Consume the excess oldest
-- first so that sum(points_remaining) = points_balance from here on.
-- Re-running this is a no-op once the two agree.
DO $$
DECLARE
  m record;
  t record;
  v_excess integer;
  v_take integer;
BEGIN
  FOR m IN
    SELECT mb.id, mb.points_balance, COALESCE(SUM(pl.points_remaining), 0)::integer AS remaining
      FROM public.members mb
      JOIN public.points_ledger pl
        ON pl.member_id = mb.id AND pl.points > 0 AND pl.expired = false
     GROUP BY mb.id, mb.points_balance
    HAVING COALESCE(SUM(pl.points_remaining), 0) > mb.points_balance
  LOOP
    v_excess := m.remaining - m.points_balance;
    FOR t IN
      SELECT id, points_remaining FROM public.points_ledger
       WHERE member_id = m.id AND points > 0 AND expired = false AND points_remaining > 0
       ORDER BY earned_at ASC, id ASC
    LOOP
      EXIT WHEN v_excess <= 0;
      v_take := LEAST(t.points_remaining, v_excess);
      UPDATE public.points_ledger SET points_remaining = points_remaining - v_take WHERE id = t.id;
      v_excess := v_excess - v_take;
    END LOOP;
  END LOOP;
END $$;

-- Silver members: every positive row expires silver_expiry_days after it was
-- earned (rule 8). Rows that would already be overdue get 30 days' grace so
-- nobody loses points without the 30-day warning email.
UPDATE public.points_ledger pl
   SET expires_at = GREATEST(
         pl.earned_at + make_interval(days => COALESCE(
           (SELECT silver_expiry_days FROM public.app_settings WHERE id = 1), 365)),
         now() + interval '30 days')
  FROM public.members mb
 WHERE mb.id = pl.member_id
   AND mb.tier = 'silver'
   AND pl.points > 0
   AND pl.expired = false
   AND pl.expires_at IS NULL
   AND COALESCE(pl.points_remaining, 0) > 0;

DROP INDEX IF EXISTS public.points_ledger_fifo_idx;
CREATE INDEX IF NOT EXISTS points_ledger_fifo_v3_idx
  ON public.points_ledger (member_id, earned_at, id)
  WHERE points > 0 AND expired = false;

CREATE INDEX IF NOT EXISTS points_ledger_order_idx
  ON public.points_ledger (shopify_order_id)
  WHERE shopify_order_id IS NOT NULL;

-- ───────────────────────── order_webhook_state ─────────────────────────
ALTER TABLE public.order_webhook_state
  ADD COLUMN IF NOT EXISTS order_name             text,
  ADD COLUMN IF NOT EXISTS placed_at              timestamptz,
  ADD COLUMN IF NOT EXISTS cancelled_at           timestamptz,
  ADD COLUMN IF NOT EXISTS earning_basis_pkr      numeric(12,2),
  ADD COLUMN IF NOT EXISTS gift_card_amount_pkr   numeric(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS refunded_basis_pkr     numeric(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS multiplier_used        numeric(4,2),
  ADD COLUMN IF NOT EXISTS campaign_id            uuid,
  ADD COLUMN IF NOT EXISTS pending_points         integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS points_awarded_amount  integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS points_reversed_amount integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS discount_codes         text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS influencer_member_id   uuid REFERENCES public.members(id),
  ADD COLUMN IF NOT EXISTS is_first_order         boolean;

CREATE INDEX IF NOT EXISTS idx_order_webhook_state_customer
  ON public.order_webhook_state (shopify_customer_id);

-- Orders awarded before v3 only have the yes/no flag. Rebuild the amounts
-- from the ledger so refunds and cancellations of those orders can be capped.
UPDATE public.order_webhook_state o
   SET points_awarded_amount = s.earned,
       points_reversed_amount = LEAST(s.earned, s.reversed),
       earning_basis_pkr = COALESCE(o.earning_basis_pkr, o.order_total_pkr)
  FROM (
    SELECT shopify_order_id,
           COALESCE(SUM(points) FILTER (WHERE action_type = 'purchase' AND points > 0), 0)::integer AS earned,
           COALESCE(-SUM(points) FILTER (WHERE action_type IN ('refund_deduction','order_cancelled')), 0)::integer AS reversed
      FROM public.points_ledger
     WHERE shopify_order_id IS NOT NULL
     GROUP BY shopify_order_id
  ) s
 WHERE s.shopify_order_id = o.shopify_order_id
   AND o.points_awarded = true
   AND o.points_awarded_amount = 0
   AND s.earned > 0;

-- ──────────────────────────── loyalty_codes ────────────────────────────
ALTER TABLE public.loyalty_codes
  ADD COLUMN IF NOT EXISTS kind                text NOT NULL DEFAULT 'reward',
  ADD COLUMN IF NOT EXISTS shopify_discount_id text,
  ADD COLUMN IF NOT EXISTS issue_key           text,
  ADD COLUMN IF NOT EXISTS cancelled_at        timestamptz;

DO $$
DECLARE c record;
BEGIN
  -- Backfill kind from the code prefix, once (before the CHECK exists).
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'loyalty_codes_kind_check'
                    AND conrelid = 'public.loyalty_codes'::regclass) THEN
    UPDATE public.loyalty_codes SET kind = 'birthday'
     WHERE code LIKE 'BDAY-%' AND kind = 'reward';
    UPDATE public.loyalty_codes SET kind = 'referral_friend'
     WHERE code LIKE 'FREESHIP-%' AND kind = 'reward';
    ALTER TABLE public.loyalty_codes
      ADD CONSTRAINT loyalty_codes_kind_check
      CHECK (kind IN ('reward','birthday','referral_friend','tier_gold','tier_diamond'));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'loyalty_codes_issue_key_key'
                    AND conrelid = 'public.loyalty_codes'::regclass) THEN
    ALTER TABLE public.loyalty_codes
      ADD CONSTRAINT loyalty_codes_issue_key_key UNIQUE (issue_key);
  END IF;

  -- Status CHECK: drop every existing variant, add the v3 list.
  FOR c IN
    SELECT conname FROM pg_constraint
     WHERE conrelid = 'public.loyalty_codes'::regclass
       AND contype = 'c'
       AND pg_get_constraintdef(oid) ILIKE '%status%'
  LOOP
    EXECUTE format('ALTER TABLE public.loyalty_codes DROP CONSTRAINT %I', c.conname);
  END LOOP;
  ALTER TABLE public.loyalty_codes
    ADD CONSTRAINT loyalty_codes_status_check
    CHECK (status IN ('pending','active','used','expired','cancelled'));
END $$;

-- The old price-rule id is the closest thing to a discount id for old rows.
UPDATE public.loyalty_codes
   SET shopify_discount_id = shopify_price_rule_id
 WHERE shopify_discount_id IS NULL AND shopify_price_rule_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS loyalty_codes_order_idx
  ON public.loyalty_codes (shopify_order_id)
  WHERE shopify_order_id IS NOT NULL;

-- ────────────────────────────── referrals ──────────────────────────────
ALTER TABLE public.referrals
  ADD COLUMN IF NOT EXISTS reward_points  integer,
  ADD COLUMN IF NOT EXISTS friend_code_id uuid,
  ADD COLUMN IF NOT EXISTS reviewed_at    timestamptz,
  ADD COLUMN IF NOT EXISTS reviewed_note  text;

-- Phone-only friends have no email (rule 5).
ALTER TABLE public.referrals ALTER COLUMN referred_email DROP NOT NULL;

DO $$
DECLARE c record;
BEGIN
  FOR c IN
    SELECT conname FROM pg_constraint
     WHERE conrelid = 'public.referrals'::regclass
       AND contype = 'c'
       AND pg_get_constraintdef(oid) ILIKE '%status%'
  LOOP
    EXECUTE format('ALTER TABLE public.referrals DROP CONSTRAINT %I', c.conname);
  END LOOP;
  ALTER TABLE public.referrals
    ADD CONSTRAINT referrals_status_check
    CHECK (status IN ('pending','completed','flagged','blocked','rejected'));
END $$;

-- De-duplicate open referrals: keep the oldest per referred customer.
UPDATE public.referrals r
   SET status = 'rejected',
       reviewed_at = now(),
       reviewed_note = 'duplicate open referral closed by migration 010'
  FROM (
    SELECT id,
           row_number() OVER (PARTITION BY referred_shopify_customer_id
                              ORDER BY created_at ASC, id ASC) AS rn
      FROM public.referrals
     WHERE status IN ('pending','flagged')
       AND referred_shopify_customer_id IS NOT NULL
  ) d
 WHERE d.id = r.id AND d.rn > 1;

CREATE UNIQUE INDEX IF NOT EXISTS referrals_one_open_per_referred_uniq
  ON public.referrals (referred_shopify_customer_id)
  WHERE status IN ('pending','flagged');

CREATE INDEX IF NOT EXISTS referrals_order_idx
  ON public.referrals (shopify_order_id)
  WHERE shopify_order_id IS NOT NULL;

-- ────────────────────────────── new tables ──────────────────────────────
CREATE TABLE IF NOT EXISTS public.review_claims (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  member_id        uuid NOT NULL REFERENCES public.members(id),
  shopify_order_id text,
  status           text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','awarded','rejected')),
  points           integer NOT NULL,
  claimed_at       timestamptz NOT NULL DEFAULT now(),
  release_at       timestamptz NOT NULL,
  resolved_at      timestamptz
);
CREATE INDEX IF NOT EXISTS review_claims_member_idx ON public.review_claims (member_id, status);
CREATE INDEX IF NOT EXISTS review_claims_release_idx ON public.review_claims (release_at) WHERE status = 'pending';
-- One live claim per delivered+paid order (rule 14).
CREATE UNIQUE INDEX IF NOT EXISTS review_claims_one_per_order_uniq
  ON public.review_claims (shopify_order_id)
  WHERE status <> 'rejected' AND shopify_order_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.tier_history (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  member_id        uuid NOT NULL REFERENCES public.members(id),
  from_tier        text,
  to_tier          text,
  shopify_order_id text,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS tier_history_member_idx ON public.tier_history (member_id, created_at);

CREATE TABLE IF NOT EXISTS public.staff_notes (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  member_id  uuid NOT NULL REFERENCES public.members(id),
  note       text NOT NULL,
  author     text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS staff_notes_member_idx ON public.staff_notes (member_id, created_at);

CREATE TABLE IF NOT EXISTS public.system_heartbeat (
  key    text PRIMARY KEY,
  at     timestamptz NOT NULL,
  detail jsonb NOT NULL DEFAULT '{}'
);

-- The app only talks to the database with the service key, which bypasses
-- row level security. Turning it on keeps the new tables closed to the
-- public (anon) API key.
ALTER TABLE public.review_claims    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tier_history     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.staff_notes      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.system_heartbeat ENABLE ROW LEVEL SECURITY;

-- ───────────────────────────── app_settings ─────────────────────────────
ALTER TABLE public.app_settings
  ADD COLUMN IF NOT EXISTS earn_rules jsonb NOT NULL DEFAULT
    '{"purchase":{"enabled":true},"signup":{"enabled":true},"referral":{"enabled":true},"instagram":{"enabled":true},"facebook":{"enabled":true},"youtube":{"enabled":true},"review":{"enabled":true},"birthday":{"enabled":true}}'::jsonb,
  ADD COLUMN IF NOT EXISTS referral_friend_free_shipping  boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS tier_reward_gold_free_shipping boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS tier_reward_diamond_pkr        integer NOT NULL DEFAULT 500,
  ADD COLUMN IF NOT EXISTS review_release_hours           integer NOT NULL DEFAULT 72,
  ADD COLUMN IF NOT EXISTS social_url_instagram           text,
  ADD COLUMN IF NOT EXISTS social_url_facebook            text,
  ADD COLUMN IF NOT EXISTS social_url_youtube             text,
  ADD COLUMN IF NOT EXISTS reward_code_expiry_days        integer NOT NULL DEFAULT 30;

INSERT INTO public.app_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- ────────────────────────────── functions ──────────────────────────────
-- Older signatures must go: PostgREST cannot choose between overloads that
-- differ only by defaulted arguments.
DROP FUNCTION IF EXISTS public.award_points(uuid, text, text, integer, timestamptz, text, text);
DROP FUNCTION IF EXISTS public.award_points(uuid, text, text, integer, timestamptz, text, text, numeric);

-- award_points: the only writer of points_ledger and members.points_balance.
--   * idempotent on (member, action_type, reference_id)
--   * positive rows become FIFO tranches (points_remaining = points); a Silver
--     member's positive row gets an expiry even when the caller passes none
--   * negative rows consume the oldest unexpired tranches first
--   * 'redemption' is refused when the balance is too low; every other
--     deduction is floored at zero
--   * 'expiry' (reference = the tranche's ledger id) removes exactly what is
--     left in that tranche
CREATE OR REPLACE FUNCTION public.award_points(
  p_member_id           uuid,
  p_action_type         text,
  p_reference_id        text,
  p_points              integer,
  p_expires_at          timestamptz DEFAULT NULL,
  p_shopify_order_id    text DEFAULT NULL,
  p_reason_note         text DEFAULT NULL,
  p_purchase_amount_pkr numeric DEFAULT NULL,
  p_customer_note       text DEFAULT NULL
) RETURNS TABLE(awarded boolean, new_balance integer, new_lifetime_spend_pkr numeric)
LANGUAGE plpgsql AS $$
DECLARE
  v_current   integer;
  v_lifetime  numeric;
  v_tier      text;
  v_delta     integer := p_points;
  v_new       integer;
  v_expires   timestamptz := p_expires_at;
  v_left      integer;
  v_take      integer;
  v_tranche   record;
  v_src_id    uuid;
  v_src_left  integer;
  v_days      integer;
BEGIN
  SELECT m.points_balance, COALESCE(m.lifetime_spend_pkr, 0), m.tier
    INTO v_current, v_lifetime, v_tier
    FROM public.members m
   WHERE m.id = p_member_id
     FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'member % not found', p_member_id;
  END IF;

  IF p_points IS NULL THEN
    RAISE EXCEPTION 'p_points must not be null';
  END IF;

  -- Idempotent replay. Safe under the member row lock: every writer takes it.
  IF EXISTS (
    SELECT 1 FROM public.points_ledger pl
     WHERE pl.member_id = p_member_id
       AND pl.action_type = p_action_type
       AND pl.reference_id IS NOT DISTINCT FROM p_reference_id
  ) THEN
    RETURN QUERY SELECT false, v_current, v_lifetime;
    RETURN;
  END IF;

  IF p_action_type = 'expiry' THEN
    -- The reference is the ledger id of the tranche that is expiring.
    BEGIN
      v_src_id := p_reference_id::uuid;
    EXCEPTION WHEN others THEN
      RAISE EXCEPTION 'expiry needs a ledger row id as reference, got %', p_reference_id;
    END;
    SELECT COALESCE(pl.points_remaining, 0) INTO v_src_left
      FROM public.points_ledger pl
     WHERE pl.id = v_src_id
       AND pl.member_id = p_member_id
       AND pl.points > 0
       AND pl.expired = false
       FOR UPDATE;
    IF NOT FOUND THEN
      RETURN QUERY SELECT false, v_current, v_lifetime;
      RETURN;
    END IF;
    v_delta := -LEAST(v_src_left, v_current);
  ELSIF p_action_type = 'redemption' AND v_current + v_delta < 0 THEN
    -- Never issue a code for points the member does not have.
    RETURN QUERY SELECT false, v_current, v_lifetime;
    RETURN;
  ELSIF v_current + v_delta < 0 THEN
    v_delta := -v_current;  -- floor at zero
  END IF;

  v_new := v_current + v_delta;

  IF v_delta > 0 AND v_expires IS NULL AND v_tier = 'silver' THEN
    SELECT s.silver_expiry_days INTO v_days FROM public.app_settings s WHERE s.id = 1;
    v_expires := now() + make_interval(days => COALESCE(v_days, 365));
  END IF;

  BEGIN
    INSERT INTO public.points_ledger
      (member_id, action_type, reference_id, points, balance_after,
       expires_at, points_remaining, shopify_order_id, reason_note, customer_note)
    VALUES
      (p_member_id, p_action_type, p_reference_id, v_delta, v_new,
       CASE WHEN v_delta > 0 THEN v_expires ELSE NULL END,
       CASE WHEN v_delta > 0 THEN v_delta ELSE NULL END,
       p_shopify_order_id, p_reason_note, p_customer_note);
  EXCEPTION WHEN unique_violation THEN
    RETURN QUERY SELECT false, v_current, v_lifetime;
    RETURN;
  END;

  IF p_action_type = 'expiry' THEN
    UPDATE public.points_ledger
       SET points_remaining = 0, expired = true
     WHERE id = v_src_id;
  ELSIF v_delta < 0 THEN
    v_left := -v_delta;
    FOR v_tranche IN
      SELECT pl.id, pl.points_remaining
        FROM public.points_ledger pl
       WHERE pl.member_id = p_member_id
         AND pl.points > 0
         AND pl.expired = false
         AND pl.points_remaining > 0
       ORDER BY pl.earned_at ASC, pl.id ASC
         FOR UPDATE
    LOOP
      EXIT WHEN v_left <= 0;
      v_take := LEAST(v_tranche.points_remaining, v_left);
      UPDATE public.points_ledger
         SET points_remaining = points_remaining - v_take
       WHERE id = v_tranche.id;
      v_left := v_left - v_take;
    END LOOP;
  END IF;

  IF p_action_type = 'purchase' AND p_purchase_amount_pkr IS NOT NULL THEN
    v_lifetime := v_lifetime + p_purchase_amount_pkr;
  END IF;

  UPDATE public.members
     SET points_balance = v_new,
         lifetime_spend_pkr = v_lifetime,
         updated_at = now()
   WHERE id = p_member_id;

  RETURN QUERY SELECT true, v_new, v_lifetime;
END;
$$;

-- award_order_points: award one order exactly once, and never after it was
-- cancelled. Lock order: order row first, then the member (inside award_points).
CREATE OR REPLACE FUNCTION public.award_order_points(
  p_shopify_order_id text,
  p_member_id        uuid,
  p_points           integer,
  p_basis_pkr        numeric,
  p_multiplier       numeric,
  p_expires_at       timestamptz
) RETURNS TABLE(awarded boolean, new_balance integer, new_lifetime_spend_pkr numeric)
LANGUAGE plpgsql AS $$
DECLARE
  v_order    public.order_webhook_state%ROWTYPE;
  v_balance  integer;
  v_lifetime numeric;
  v_points   integer := GREATEST(COALESCE(p_points, 0), 0);
  v_basis    numeric := GREATEST(COALESCE(p_basis_pkr, 0), 0);
  v_awarded  boolean;
  v_existing integer;
BEGIN
  SELECT * INTO v_order
    FROM public.order_webhook_state o
   WHERE o.shopify_order_id = p_shopify_order_id
     FOR UPDATE;

  SELECT m.points_balance, COALESCE(m.lifetime_spend_pkr, 0)
    INTO v_balance, v_lifetime
    FROM public.members m
   WHERE m.id = p_member_id
     FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'member % not found', p_member_id;
  END IF;

  IF v_order.id IS NULL
     OR v_order.cancelled_at IS NOT NULL
     OR v_order.points_awarded THEN
    RETURN QUERY SELECT false, v_balance, v_lifetime;
    RETURN;
  END IF;

  IF v_points > 0 THEN
    SELECT a.awarded, a.new_balance, a.new_lifetime_spend_pkr
      INTO v_awarded, v_balance, v_lifetime
      FROM public.award_points(
             p_member_id, 'purchase', p_shopify_order_id, v_points,
             p_expires_at, p_shopify_order_id, NULL, v_basis, NULL) a;

    IF NOT v_awarded THEN
      -- A purchase row for this order already exists (awarded before v3).
      -- Adopt it so the order cannot be awarded twice and can be reversed.
      SELECT COALESCE(SUM(pl.points), 0)::integer INTO v_existing
        FROM public.points_ledger pl
       WHERE pl.member_id = p_member_id
         AND pl.action_type = 'purchase'
         AND pl.reference_id = p_shopify_order_id;
      UPDATE public.order_webhook_state
         SET points_awarded = true,
             points_awarded_amount = GREATEST(v_existing, 0),
             pending_points = 0,
             earning_basis_pkr = COALESCE(earning_basis_pkr, v_basis),
             updated_at = now()
       WHERE id = v_order.id;
      RETURN QUERY SELECT false, v_balance, v_lifetime;
      RETURN;
    END IF;
  ELSE
    -- Nothing to earn (for example paid entirely by gift card, or the purchase
    -- rule was off), but the spend still counts towards the tier.
    v_lifetime := v_lifetime + v_basis;
    UPDATE public.members
       SET lifetime_spend_pkr = v_lifetime, updated_at = now()
     WHERE id = p_member_id;
  END IF;

  UPDATE public.order_webhook_state
     SET points_awarded = true,
         points_awarded_amount = v_points,
         multiplier_used = COALESCE(p_multiplier, multiplier_used),
         earning_basis_pkr = v_basis,
         pending_points = 0,
         updated_at = now()
   WHERE id = v_order.id;

  UPDATE public.members
     SET first_order_awarded_at = now()
   WHERE id = p_member_id AND first_order_awarded_at IS NULL;

  RETURN QUERY SELECT true, v_balance, v_lifetime;
END;
$$;

-- reverse_order_points: refund or cancellation (rule 6).
--   refund: reverse awarded x refunded basis / earning basis (cumulative, so
--           several part refunds never add up to more than a full refund)
--   cancel: mark the order cancelled (blocks any later award) and reverse
--           whatever is still un-reversed
-- Never more than was awarded for the order; the order row lock serialises a
-- refund and a cancellation that arrive together. `reversed` is what actually
-- left the balance (the balance is floored at zero).
CREATE OR REPLACE FUNCTION public.reverse_order_points(
  p_shopify_order_id   text,
  p_kind               text,
  p_reference_id       text,
  p_refunded_basis_pkr numeric DEFAULT NULL
) RETURNS TABLE(reversed integer, new_balance integer)
LANGUAGE plpgsql AS $$
DECLARE
  v_order        public.order_webhook_state%ROWTYPE;
  v_member_id    uuid;
  v_balance      integer;
  v_lifetime     numeric;
  v_action       text;
  v_left         integer;
  v_amount       integer := 0;
  v_basis        numeric;
  v_refund       numeric := GREATEST(COALESCE(p_refunded_basis_pkr, 0), 0);
  v_refund_total numeric;
  v_spend_cut    numeric := 0;
  v_target       integer;
  v_actual       integer := 0;
  v_note         text;
BEGIN
  IF p_kind NOT IN ('refund', 'cancel') THEN
    RAISE EXCEPTION 'reverse_order_points: unknown kind %', p_kind;
  END IF;
  v_action := CASE WHEN p_kind = 'refund' THEN 'refund_deduction' ELSE 'order_cancelled' END;

  SELECT * INTO v_order
    FROM public.order_webhook_state o
   WHERE o.shopify_order_id = p_shopify_order_id
     FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 0, NULL::integer;
    RETURN;
  END IF;

  SELECT m.id, m.points_balance, COALESCE(m.lifetime_spend_pkr, 0)
    INTO v_member_id, v_balance, v_lifetime
    FROM public.members m
   WHERE m.shopify_customer_id = v_order.shopify_customer_id
     FOR UPDATE;

  IF p_kind = 'cancel' THEN
    UPDATE public.order_webhook_state
       SET cancelled_at = COALESCE(cancelled_at, now()),
           pending_points = 0,
           updated_at = now()
     WHERE id = v_order.id;
  END IF;

  IF v_member_id IS NULL
     OR NOT v_order.points_awarded THEN
    RETURN QUERY SELECT 0, v_balance;
    RETURN;
  END IF;

  -- Replay of the same refund / cancellation: nothing more to do.
  IF EXISTS (
    SELECT 1 FROM public.points_ledger pl
     WHERE pl.member_id = v_member_id
       AND pl.action_type = v_action
       AND pl.reference_id IS NOT DISTINCT FROM p_reference_id
  ) THEN
    RETURN QUERY SELECT 0, v_balance;
    RETURN;
  END IF;

  v_basis := COALESCE(v_order.earning_basis_pkr, v_order.order_total_pkr, 0);
  v_left  := GREATEST(v_order.points_awarded_amount - v_order.points_reversed_amount, 0);

  IF p_kind = 'refund' THEN
    IF v_refund <= 0 OR v_basis <= 0 THEN
      RETURN QUERY SELECT 0, v_balance;
      RETURN;
    END IF;
    v_refund_total := LEAST(v_order.refunded_basis_pkr + v_refund, v_basis);
    v_spend_cut    := v_refund_total - LEAST(v_order.refunded_basis_pkr, v_basis);
    v_target       := ROUND(v_order.points_awarded_amount * v_refund_total / v_basis)::integer;
    v_amount       := LEAST(GREATEST(v_target - v_order.points_reversed_amount, 0), v_left);
    v_note         := 'Order refunded';
  ELSE
    v_refund_total := GREATEST(v_basis, v_order.refunded_basis_pkr);
    v_spend_cut    := GREATEST(v_basis - v_order.refunded_basis_pkr, 0);
    v_amount       := v_left;
    v_note         := 'Order cancelled';
  END IF;

  IF v_amount <= 0 AND v_spend_cut <= 0 THEN
    RETURN QUERY SELECT 0, v_balance;
    RETURN;
  END IF;

  IF v_order.order_name IS NOT NULL THEN
    v_note := v_note || ' (' || v_order.order_name || ')';
  END IF;

  -- Always written (even for 0 points) so a replay is recognised above.
  PERFORM public.award_points(
    v_member_id, v_action, p_reference_id, -v_amount,
    NULL, p_shopify_order_id, p_kind, NULL, v_note);

  SELECT -pl.points, pl.balance_after INTO v_actual, v_balance
    FROM public.points_ledger pl
   WHERE pl.member_id = v_member_id
     AND pl.action_type = v_action
     AND pl.reference_id IS NOT DISTINCT FROM p_reference_id;

  UPDATE public.order_webhook_state
     SET points_reversed_amount = points_reversed_amount + v_amount,
         refunded_basis_pkr = v_refund_total,
         updated_at = now()
   WHERE id = v_order.id;

  UPDATE public.members
     SET lifetime_spend_pkr = GREATEST(COALESCE(lifetime_spend_pkr, 0) - v_spend_cut, 0),
         updated_at = now()
   WHERE id = v_member_id;

  RETURN QUERY SELECT COALESCE(v_actual, 0), v_balance;
END;
$$;

-- Only the service key may run the points functions (Supabase roles; skipped
-- on a plain Postgres where those roles do not exist).
DO $$
DECLARE
  fn text;
BEGIN
  FOREACH fn IN ARRAY ARRAY[
    'public.award_points(uuid, text, text, integer, timestamptz, text, text, numeric, text)',
    'public.award_order_points(text, uuid, integer, numeric, numeric, timestamptz)',
    'public.reverse_order_points(text, text, text, numeric)'
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

-- Ask PostgREST to pick up the new columns and function signatures.
NOTIFY pgrst, 'reload schema';
