-- 016_referral_checks.sql
-- Referral fraud rules without network addresses (owner decision, 19 Nov 2026).
-- The app cannot see shoppers' addresses behind Shopify's proxy and Railway's
-- edge, so the "same network" rule is gone. Instead:
--   at sign-in:  same email / same phone -> blocked; similar email / same full name -> held
--   on the friend's order that used her free-shipping code: same shipping phone
--   as the referrer -> blocked; same shipping address -> held; either raises a
--   Home "Needs your attention" item.
-- Only reason codes are stored, never the phone or address that matched.
-- Also (owner, 19 Nov 2026): the matched order is tagged "Rewards: check
-- referral" in Shopify, and a staff summary email goes out each morning at
-- 09:00 Pakistan time when something is waiting (app_settings below).
-- Safe to apply twice and on a populated database: columns are added with
-- IF NOT EXISTS, checks are added only when missing, functions are replaced,
-- and no existing row is changed.

-- ── referrals: the result of the order-time check and its Home alert ─────────
ALTER TABLE public.referrals
  ADD COLUMN IF NOT EXISTS order_check            text,
  ADD COLUMN IF NOT EXISTS order_checked_order_id text,
  ADD COLUMN IF NOT EXISTS order_checked_at       timestamptz,
  ADD COLUMN IF NOT EXISTS alert_resolved_at      timestamptz,
  ADD COLUMN IF NOT EXISTS order_tag              text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.referrals'::regclass AND conname = 'referrals_order_check_check'
  ) THEN
    ALTER TABLE public.referrals
      ADD CONSTRAINT referrals_order_check_check
      CHECK (order_check IS NULL OR order_check IN ('clear', 'not_checked', 'same_phone', 'same_address'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.referrals'::regclass AND conname = 'referrals_order_tag_check'
  ) THEN
    ALTER TABLE public.referrals
      ADD CONSTRAINT referrals_order_tag_check
      CHECK (order_tag IS NULL OR order_tag IN ('tagged', 'failed'));
  END IF;
END $$;

COMMENT ON COLUMN public.referrals.order_tag IS
  'Whether the matched order got the Shopify tag "Rewards: check referral" (tagsAdd, needs write_orders): tagged | failed. NULL = not attempted.';
COMMENT ON COLUMN public.referrals.order_check IS
  'Order-time check of the friend''s order that used her referral free-shipping code: clear | not_checked (delivery details not available) | same_phone | same_address. NULL = not run.';
COMMENT ON COLUMN public.referrals.order_checked_order_id IS
  'Shopify order id the order-time check ran for; the check runs once per order (webhook replays skip it).';
COMMENT ON COLUMN public.referrals.alert_resolved_at IS
  'When staff dismissed the Home alert raised by the order-time check (or approved, rejected or blocked).';

-- Open alerts are read on every Home load.
CREATE INDEX IF NOT EXISTS referrals_order_alert_open_idx
  ON public.referrals (order_checked_at DESC)
  WHERE order_check IN ('same_phone', 'same_address') AND alert_resolved_at IS NULL;

-- ── Home "Needs your attention": 011's function plus the order alerts ────────
-- Same body as 011 with one key added ('referral_order_alerts'). If 011 is
-- ever re-applied after this, apply 016 again.
CREATE OR REPLACE FUNCTION public.admin_attention(p_days integer DEFAULT 30)
RETURNS jsonb
LANGUAGE sql STABLE AS $$
  -- Rows whose expiry date has passed but which the nightly job has not yet
  -- processed are still the member's points: they are counted, as "expiring now".
  WITH ex AS (
    SELECT COUNT(DISTINCT member_id) AS members,
           COUNT(DISTINCT member_id) FILTER (WHERE expires_at < now()) AS overdue_members,
           COALESCE(SUM(COALESCE(points_remaining, points)), 0) AS points
    FROM public.points_ledger
    WHERE points > 0 AND NOT expired
      AND COALESCE(points_remaining, points) > 0
      AND expires_at IS NOT NULL
      AND expires_at < now() + make_interval(days => p_days)
  )
  SELECT jsonb_build_object(
    'referrals_flagged',     (SELECT COUNT(*) FROM public.referrals WHERE status = 'flagged'),
    'review_claims_pending', (SELECT COUNT(*) FROM public.review_claims WHERE status = 'pending'),
    'expiring_members',      (SELECT members FROM ex),
    'expiring_points',       (SELECT points FROM ex),
    'expiring_overdue_members', (SELECT overdue_members FROM ex),
    'gdpr_open',             (SELECT COUNT(*) FROM public.gdpr_requests WHERE status = 'open'),
    'referral_order_alerts', (SELECT COUNT(*) FROM public.referrals
                               WHERE order_check IN ('same_phone', 'same_address')
                                 AND alert_resolved_at IS NULL)
  );
$$;

-- ── Staff morning email ──────────────────────────────────────────────────────
-- Optional staff address (Settings page). The worker emails it at 09:00
-- Asia/Karachi only when something is waiting. staff_digest_sent_on is the
-- Pakistan date of the last email: the job claims the day by moving it
-- forward (WHERE staff_digest_sent_on < today), so a restarted worker or a
-- repeated run never sends twice. NOT NULL with an old default so the
-- comparison never meets a NULL.
ALTER TABLE public.app_settings
  ADD COLUMN IF NOT EXISTS staff_alert_email    text,
  ADD COLUMN IF NOT EXISTS staff_digest_sent_on date NOT NULL DEFAULT DATE '2000-01-01';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.app_settings'::regclass AND conname = 'app_settings_staff_alert_email_check'
  ) THEN
    ALTER TABLE public.app_settings
      ADD CONSTRAINT app_settings_staff_alert_email_check
      CHECK (staff_alert_email IS NULL OR (
        length(staff_alert_email) <= 254
        AND staff_alert_email ~ '^[^@[:space:]<>,;"]+@[^@[:space:]<>,;"]+\.[^@[:space:]<>,;"]+$'
      ));
  END IF;
END $$;
