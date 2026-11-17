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
  ADD COLUMN IF NOT EXISTS is_first_order         boolean,
  -- Reconciliation on totals (refunds and order updates can arrive in any order):
  --   gross_basis_pkr           highest basis the order ever had
  --   refunded_basis_pkr        total basis refunded / removed so far (only grows)
  --   refund_events_basis_pkr   the part of that reported by refunds/create
  --   refund_ids                refunds already counted (replay protection)
  --   refund_basis_at_award_pkr refunded_basis_pkr at the moment of the award
  --   spend_reversed_pkr        lifetime spend already taken back
  --   source_updated_at         Shopify updated_at of the newest order payload applied
  --   points_rate               purchase rate in force (0 when the member cannot earn)
  ADD COLUMN IF NOT EXISTS gross_basis_pkr           numeric(12,2),
  ADD COLUMN IF NOT EXISTS refund_events_basis_pkr   numeric(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS refund_ids                text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS refund_basis_at_award_pkr numeric(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS spend_reversed_pkr        numeric(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS source_updated_at         timestamptz,
  ADD COLUMN IF NOT EXISTS points_rate               numeric(8,4),
  ADD COLUMN IF NOT EXISTS taxes_included            boolean NOT NULL DEFAULT false;

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

-- ...and the matching refunded share, so a new refund of such an order is
-- measured against what was already reversed.
UPDATE public.order_webhook_state o
   SET refunded_basis_pkr = ROUND(COALESCE(o.earning_basis_pkr, 0) * o.points_reversed_amount / o.points_awarded_amount, 2),
       spend_reversed_pkr = ROUND(COALESCE(o.earning_basis_pkr, 0) * o.points_reversed_amount / o.points_awarded_amount, 2)
 WHERE o.points_awarded = true
   AND o.points_awarded_amount > 0
   AND o.points_reversed_amount > 0
   AND o.refunded_basis_pkr = 0
   AND o.gross_basis_pkr IS NULL;

-- That earlier refund must also count as a refund EVENT. reverse_order_points
-- adds each new refund to refund_events_basis_pkr and takes the larger of that
-- and refunded_basis_pkr as the order's refunded total; with the events total
-- left at 0, a new refund of such an order that is no bigger than the old one
-- reversed nothing, and a bigger one reversed only the difference.
-- Only rows v3 has never touched (gross_basis_pkr is set by every v3 write,
-- refund_ids by every v3 refund), so running this again changes nothing.
UPDATE public.order_webhook_state o
   SET refund_events_basis_pkr = o.refunded_basis_pkr
 WHERE o.points_awarded = true
   AND o.points_awarded_amount > 0
   AND o.points_reversed_amount > 0
   AND o.refunded_basis_pkr > 0
   AND o.refund_events_basis_pkr = 0
   AND o.gross_basis_pkr IS NULL
   AND o.refund_ids = '{}';

-- ─────────────────────────── bonus_campaigns ───────────────────────────
-- Rule 2: a campaign switched off AFTER an order was placed still counts for
-- that order. The admin only flips is_active, so the moment is recorded here.
ALTER TABLE public.bonus_campaigns
  ADD COLUMN IF NOT EXISTS deactivated_at timestamptz;

CREATE OR REPLACE FUNCTION public.bonus_campaigns_track_deactivation()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NOT NEW.is_active AND NEW.deactivated_at IS NULL THEN NEW.deactivated_at := now(); END IF;
  ELSIF OLD.is_active AND NOT NEW.is_active THEN
    NEW.deactivated_at := now();
  ELSIF NEW.is_active AND NOT OLD.is_active THEN
    NEW.deactivated_at := NULL;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_bonus_campaigns_deactivation ON public.bonus_campaigns;
CREATE TRIGGER trg_bonus_campaigns_deactivation
  BEFORE INSERT OR UPDATE ON public.bonus_campaigns
  FOR EACH ROW EXECUTE FUNCTION public.bonus_campaigns_track_deactivation();

-- Campaigns already off: when is unknown, so they count for no earlier order.
UPDATE public.bonus_campaigns SET deactivated_at = created_at
 WHERE is_active = false AND deactivated_at IS NULL;

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
--     left in that tranche; Silver members only; a fully spent tranche is
--     closed without a ledger row
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
    -- Only Silver points expire (rule 8), whatever the caller asks.
    IF v_tier <> 'silver' THEN
      RETURN QUERY SELECT false, v_current, v_lifetime;
      RETURN;
    END IF;
    -- A tranche that was spent in full just closes: no 0-point ledger row.
    IF v_src_left <= 0 OR v_current <= 0 THEN
      UPDATE public.points_ledger SET points_remaining = 0, expired = true WHERE id = v_src_id;
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

-- ── Order points: reconciliation on totals ─────────────────────────────────
-- Shopify delivers refunds/create, orders/updated and orders/cancelled in no
-- guaranteed order, and a failed job is retried later with an old payload. So
-- nothing here works on "this event's amount" alone. Each order row keeps
--   gross_basis_pkr     the highest basis the order ever had
--   refunded_basis_pkr  the total refunded / removed so far (only ever grows)
-- and the points to reverse are always worked out from those totals:
--   before the award  the award is made on gross - refunded
--   after the award   reversed points = awarded x (refunded since award) / awarded basis
-- Whichever event arrives first, the row ends in the same state.
-- Lock order everywhere: order row first, then the member row.

-- reconcile_order_points: bring the points reversed for an awarded order in
-- line with the row's totals. A cancelled order is reversed in full.
CREATE OR REPLACE FUNCTION public.reconcile_order_points(
  p_shopify_order_id text,
  p_reference_id     text,
  p_note             text DEFAULT 'Order refunded'
) RETURNS TABLE(reversed integer, new_balance integer)
LANGUAGE plpgsql AS $$
DECLARE
  v_order     public.order_webhook_state%ROWTYPE;
  v_member_id uuid;
  v_balance   integer;
  v_basis     numeric;
  v_post      numeric;
  v_target    integer;
  v_amount    integer;
  v_cut       numeric;
  v_action    text;
  v_ref       text;
  v_actual    integer := 0;
  v_note      text := p_note;
  v_cancelled boolean;
BEGIN
  SELECT * INTO v_order
    FROM public.order_webhook_state o
   WHERE o.shopify_order_id = p_shopify_order_id
     FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 0, NULL::integer;
    RETURN;
  END IF;

  SELECT m.id, m.points_balance INTO v_member_id, v_balance
    FROM public.members m
   WHERE m.shopify_customer_id = v_order.shopify_customer_id
     FOR UPDATE;

  IF v_member_id IS NULL OR NOT v_order.points_awarded THEN
    RETURN QUERY SELECT 0, v_balance;
    RETURN;
  END IF;

  v_cancelled := v_order.cancelled_at IS NOT NULL;
  v_basis := GREATEST(COALESCE(v_order.earning_basis_pkr, v_order.order_total_pkr, 0), 0);
  IF v_cancelled THEN
    v_post   := v_basis;
    v_target := v_order.points_awarded_amount;
  ELSE
    v_post := LEAST(GREATEST(v_order.refunded_basis_pkr - v_order.refund_basis_at_award_pkr, 0), v_basis);
    v_target := CASE WHEN v_basis > 0
                     THEN ROUND(v_order.points_awarded_amount * v_post / v_basis)::integer
                     ELSE 0 END;
  END IF;

  v_amount := LEAST(GREATEST(v_target - v_order.points_reversed_amount, 0),
                    GREATEST(v_order.points_awarded_amount - v_order.points_reversed_amount, 0));
  v_cut := GREATEST(v_post - v_order.spend_reversed_pkr, 0);

  IF v_amount <= 0 AND v_cut <= 0 THEN
    RETURN QUERY SELECT 0, v_balance;
    RETURN;
  END IF;

  IF v_amount > 0 THEN
    v_action := CASE WHEN v_cancelled THEN 'order_cancelled' ELSE 'refund_deduction' END;
    v_ref := p_reference_id;
    -- The totals decide the amount; the reference only has to be unique.
    IF EXISTS (SELECT 1 FROM public.points_ledger pl
                WHERE pl.member_id = v_member_id AND pl.action_type = v_action
                  AND pl.reference_id IS NOT DISTINCT FROM v_ref) THEN
      v_ref := COALESCE(v_ref, p_shopify_order_id) || ':' || v_order.points_reversed_amount::text;
    END IF;
    IF v_order.order_name IS NOT NULL THEN
      v_note := v_note || ' (' || v_order.order_name || ')';
    END IF;
    PERFORM public.award_points(
      v_member_id, v_action, v_ref, -v_amount,
      NULL, p_shopify_order_id, CASE WHEN v_cancelled THEN 'cancel' ELSE 'refund' END, NULL, v_note);
    SELECT -pl.points, pl.balance_after INTO v_actual, v_balance
      FROM public.points_ledger pl
     WHERE pl.member_id = v_member_id AND pl.action_type = v_action
       AND pl.reference_id IS NOT DISTINCT FROM v_ref;
  END IF;

  UPDATE public.order_webhook_state
     SET points_reversed_amount = points_reversed_amount + v_amount,
         spend_reversed_pkr = v_post,
         updated_at = now()
   WHERE id = v_order.id;

  IF v_cut > 0 THEN
    UPDATE public.members
       SET lifetime_spend_pkr = GREATEST(COALESCE(lifetime_spend_pkr, 0) - v_cut, 0),
           updated_at = now()
     WHERE id = v_member_id;
  END IF;

  RETURN QUERY SELECT COALESCE(v_actual, 0), v_balance;
END;
$$;

-- award_order_points: award one order exactly once, never after it was
-- cancelled, and always net of whatever has been refunded so far. When the
-- row carries its own figures (every order seen by v3 does) those are used,
-- because the caller's p_points / p_basis may come from an older read.
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
  v_points   integer;
  v_basis    numeric;
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

  IF v_order.gross_basis_pkr IS NOT NULL THEN
    v_points := GREATEST(COALESCE(v_order.pending_points, 0), 0);
    v_basis  := GREATEST(COALESCE(v_order.earning_basis_pkr, 0), 0);
  ELSE
    v_points := GREATEST(COALESCE(p_points, 0), 0);
    v_basis  := GREATEST(COALESCE(p_basis_pkr, 0), 0);
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
             refund_basis_at_award_pkr = refunded_basis_pkr,
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
         multiplier_used = COALESCE(multiplier_used, p_multiplier),
         earning_basis_pkr = v_basis,
         gross_basis_pkr = COALESCE(gross_basis_pkr, v_basis + refunded_basis_pkr),
         refund_basis_at_award_pkr = refunded_basis_pkr,
         spend_reversed_pkr = 0,
         pending_points = 0,
         updated_at = now()
   WHERE id = v_order.id;

  UPDATE public.members
     SET first_order_awarded_at = now()
   WHERE id = p_member_id AND first_order_awarded_at IS NULL;

  RETURN QUERY SELECT true, v_balance, v_lifetime;
END;
$$;

-- reverse_order_points: a refund event or a cancellation (rule 6).
--   refund: the refund is counted once (by its id) into the order's refunded
--           total, whether or not the order has been awarded yet. Before the
--           award that lowers the pending points; after it, points are reversed.
--   cancel: the order is marked cancelled (no later award) and whatever is
--           still un-reversed is taken back.
-- `reversed` is what actually left the balance (the balance is floored at zero).
CREATE OR REPLACE FUNCTION public.reverse_order_points(
  p_shopify_order_id   text,
  p_kind               text,
  p_reference_id       text,
  p_refunded_basis_pkr numeric DEFAULT NULL
) RETURNS TABLE(reversed integer, new_balance integer)
LANGUAGE plpgsql AS $$
DECLARE
  v_order    public.order_webhook_state%ROWTYPE;
  v_refund   numeric := GREATEST(COALESCE(p_refunded_basis_pkr, 0), 0);
  v_gross    numeric;
  v_events   numeric;
  v_total    numeric;
  v_earning  numeric;
  v_pending  integer;
BEGIN
  IF p_kind NOT IN ('refund', 'cancel') THEN
    RAISE EXCEPTION 'reverse_order_points: unknown kind %', p_kind;
  END IF;

  SELECT * INTO v_order
    FROM public.order_webhook_state o
   WHERE o.shopify_order_id = p_shopify_order_id
     FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 0, NULL::integer;
    RETURN;
  END IF;

  IF p_kind = 'cancel' THEN
    UPDATE public.order_webhook_state
       SET cancelled_at = COALESCE(cancelled_at, now()),
           pending_points = 0,
           updated_at = now()
     WHERE id = v_order.id;
    RETURN QUERY SELECT r.reversed, r.new_balance
      FROM public.reconcile_order_points(p_shopify_order_id, p_reference_id, 'Order cancelled') r;
    RETURN;
  END IF;

  -- refund
  IF v_refund > 0 AND NOT (COALESCE(p_reference_id, '') = ANY (v_order.refund_ids)) THEN
    v_gross := COALESCE(
      v_order.gross_basis_pkr,
      CASE WHEN v_order.points_awarded
           THEN COALESCE(v_order.earning_basis_pkr, v_order.order_total_pkr, 0) + v_order.refund_basis_at_award_pkr
           ELSE COALESCE(v_order.earning_basis_pkr, v_order.order_total_pkr, 0) + v_order.refunded_basis_pkr END);
    v_events := v_order.refund_events_basis_pkr + v_refund;
    v_total  := LEAST(v_gross, GREATEST(v_order.refunded_basis_pkr, v_events));

    IF v_order.points_awarded OR v_order.cancelled_at IS NOT NULL THEN
      v_earning := v_order.earning_basis_pkr;
      v_pending := v_order.pending_points;
    ELSE
      v_earning := GREATEST(v_gross - v_total, 0);
      v_pending := CASE
        WHEN v_order.points_rate IS NOT NULL
          THEN FLOOR(v_earning * v_order.points_rate * COALESCE(v_order.multiplier_used, 1) + 0.000001)::integer
        WHEN COALESCE(v_order.earning_basis_pkr, 0) > 0
          THEN FLOOR(v_order.pending_points * v_earning / v_order.earning_basis_pkr)::integer
        ELSE 0 END;
    END IF;

    UPDATE public.order_webhook_state
       SET gross_basis_pkr = v_gross,
           refund_events_basis_pkr = v_events,
           refund_ids = array_append(refund_ids, COALESCE(p_reference_id, '')),
           refunded_basis_pkr = v_total,
           earning_basis_pkr = v_earning,
           pending_points = GREATEST(COALESCE(v_pending, 0), 0),
           updated_at = now()
     WHERE id = v_order.id;
  END IF;

  RETURN QUERY SELECT r.reversed, r.new_balance
    FROM public.reconcile_order_points(p_shopify_order_id, p_reference_id, 'Order refunded') r;
END;
$$;

-- sync_order_snapshot: apply one order payload (orders/create, /updated,
-- /fulfilled). p_gross_basis_pkr is the basis from the order's original
-- figures, p_current_basis_pkr from its current figures (after edits and
-- refunds). A payload older than the newest one already applied is ignored,
-- so a retried job can never undo newer state. For an awarded order the
-- difference is reversed at once.
CREATE OR REPLACE FUNCTION public.sync_order_snapshot(
  p_shopify_order_id  text,
  p_source_updated_at timestamptz,
  p_gross_basis_pkr   numeric,
  p_current_basis_pkr numeric,
  p_points_rate       numeric,
  p_can_earn          boolean
) RETURNS TABLE(applied boolean, reversed integer, pending_points integer)
LANGUAGE plpgsql AS $$
DECLARE
  v_order    public.order_webhook_state%ROWTYPE;
  v_current  numeric := GREATEST(COALESCE(p_current_basis_pkr, 0), 0);
  v_gross    numeric;
  v_total    numeric;
  v_earning  numeric;
  v_rate     numeric := CASE WHEN COALESCE(p_can_earn, false) THEN GREATEST(COALESCE(p_points_rate, 0), 0) ELSE 0 END;
  v_pending  integer;
  v_reversed integer := 0;
BEGIN
  SELECT * INTO v_order
    FROM public.order_webhook_state o
   WHERE o.shopify_order_id = p_shopify_order_id
     FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT false, 0, 0;
    RETURN;
  END IF;

  IF p_source_updated_at IS NOT NULL
     AND v_order.source_updated_at IS NOT NULL
     AND p_source_updated_at < v_order.source_updated_at THEN
    RETURN QUERY SELECT false, 0, v_order.pending_points;  -- stale payload
    RETURN;
  END IF;

  v_gross := GREATEST(
    COALESCE(v_order.gross_basis_pkr,
             CASE WHEN v_order.points_awarded
                  THEN COALESCE(v_order.earning_basis_pkr, 0) + v_order.refund_basis_at_award_pkr
                  ELSE 0 END),
    COALESCE(p_gross_basis_pkr, 0),
    v_current);
  v_total := LEAST(v_gross, GREATEST(v_order.refunded_basis_pkr, v_gross - v_current, v_order.refund_events_basis_pkr));

  IF v_order.points_awarded OR v_order.cancelled_at IS NOT NULL THEN
    UPDATE public.order_webhook_state
       SET gross_basis_pkr = v_gross,
           refunded_basis_pkr = v_total,
           source_updated_at = COALESCE(p_source_updated_at, source_updated_at),
           updated_at = now()
     WHERE id = v_order.id;
    IF v_order.points_awarded AND v_order.cancelled_at IS NULL THEN
      SELECT r.reversed INTO v_reversed
        FROM public.reconcile_order_points(
               p_shopify_order_id,
               'sync:' || p_shopify_order_id || ':' || COALESCE(EXTRACT(EPOCH FROM p_source_updated_at)::bigint::text, 'na'),
               'Order refunded') r;
    END IF;
    RETURN QUERY SELECT true, COALESCE(v_reversed, 0), 0;
    RETURN;
  END IF;

  v_earning := GREATEST(v_gross - v_total, 0);
  v_pending := FLOOR(v_earning * v_rate * COALESCE(v_order.multiplier_used, 1) + 0.000001)::integer;

  UPDATE public.order_webhook_state
     SET gross_basis_pkr = v_gross,
         refunded_basis_pkr = v_total,
         earning_basis_pkr = v_earning,
         points_rate = v_rate,
         pending_points = GREATEST(v_pending, 0),
         source_updated_at = COALESCE(p_source_updated_at, source_updated_at),
         updated_at = now()
   WHERE id = v_order.id;

  RETURN QUERY SELECT true, 0, GREATEST(v_pending, 0);
END;
$$;

-- upgrade_member_tier: tier change, history row and "stop the expiry clock"
-- in one transaction, so a crash cannot leave one without the others.
-- Tiers only ever go up (rule 9). Returns true when this call did the upgrade.
CREATE OR REPLACE FUNCTION public.upgrade_member_tier(
  p_member_id        uuid,
  p_to_tier          text,
  p_shopify_order_id text DEFAULT NULL
) RETURNS boolean
LANGUAGE plpgsql AS $$
DECLARE
  v_tier text;
  v_rank_from integer;
  v_rank_to integer;
BEGIN
  SELECT m.tier INTO v_tier FROM public.members m WHERE m.id = p_member_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'member % not found', p_member_id;
  END IF;
  v_rank_from := CASE v_tier WHEN 'diamond' THEN 2 WHEN 'gold' THEN 1 ELSE 0 END;
  v_rank_to   := CASE p_to_tier WHEN 'diamond' THEN 2 WHEN 'gold' THEN 1 WHEN 'silver' THEN 0 ELSE -1 END;
  IF v_rank_to < 0 THEN
    RAISE EXCEPTION 'upgrade_member_tier: unknown tier %', p_to_tier;
  END IF;
  IF v_rank_to <= v_rank_from THEN
    RETURN false;
  END IF;

  UPDATE public.members SET tier = p_to_tier, updated_at = now() WHERE id = p_member_id;
  INSERT INTO public.tier_history (member_id, from_tier, to_tier, shopify_order_id)
  VALUES (p_member_id, v_tier, p_to_tier, p_shopify_order_id);
  -- Gold and Diamond points never expire: stop the clock on what she holds.
  UPDATE public.points_ledger
     SET expires_at = NULL
   WHERE member_id = p_member_id AND expired = false AND expires_at IS NOT NULL;
  RETURN true;
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
    'public.reverse_order_points(text, text, text, numeric)',
    'public.reconcile_order_points(text, text, text)',
    'public.sync_order_snapshot(text, timestamptz, numeric, numeric, numeric, boolean)',
    'public.upgrade_member_tier(uuid, text, text)'
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
