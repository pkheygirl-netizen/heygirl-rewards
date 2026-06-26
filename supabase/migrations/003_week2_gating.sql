-- 003_week2_gating.sql
-- Week 2 gating migration. These objects were originally applied to the live
-- database out-of-band (via Supabase MCP) and are committed here so the schema
-- rebuilds correctly from migrations. All statements are idempotent: they are
-- no-ops against the existing production database and recreate the objects on a
-- fresh build. The award_points RPC (002) depends on the idempotency index
-- below for its `EXCEPTION WHEN unique_violation` no-op; the points engine
-- depends on points_remaining for FIFO clawback/expiry.

-- FIFO remaining-balance tracking on purchase tranches.
ALTER TABLE public.points_ledger
  ADD COLUMN IF NOT EXISTS points_remaining integer;

-- Backfill purchase tranches (no-op where already populated).
UPDATE public.points_ledger
  SET points_remaining = points
  WHERE points_remaining IS NULL AND action_type = 'purchase';

-- Idempotency: one ledger row per (member, action, reference). NULLS NOT
-- DISTINCT so a NULL reference_id still collides (requires Postgres 15+).
-- This is what makes award_points' unique_violation path actually fire.
CREATE UNIQUE INDEX IF NOT EXISTS points_ledger_idempotency_uniq
  ON public.points_ledger (member_id, action_type, reference_id)
  NULLS NOT DISTINCT;

-- FIFO scan support for clawback/expiry over unexpired purchase tranches.
CREATE INDEX IF NOT EXISTS points_ledger_fifo_idx
  ON public.points_ledger (member_id, earned_at)
  WHERE action_type = 'purchase' AND expired = false;

-- Balance can never go negative (award_points clamps, this is the backstop).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'members_points_balance_nonneg'
      AND conrelid = 'public.members'::regclass
  ) THEN
    ALTER TABLE public.members
      ADD CONSTRAINT members_points_balance_nonneg CHECK (points_balance >= 0);
  END IF;
END $$;

-- At most one active bonus campaign at any instant (no overlapping active ranges).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'bonus_campaigns_no_overlap'
      AND conrelid = 'public.bonus_campaigns'::regclass
  ) THEN
    ALTER TABLE public.bonus_campaigns
      ADD CONSTRAINT bonus_campaigns_no_overlap
      EXCLUDE USING gist (tstzrange(starts_at, ends_at) WITH &&) WHERE (is_active);
  END IF;
END $$;
