-- 013_rls.sql
-- Row level security on every app table that did not have it yet.
--
-- Migrations 010 and 012 switched it on for the tables they created; the
-- tables from 001-009 were left open, which means anyone holding the
-- project's public (anon / publishable) API key could read and write them
-- through Supabase's REST API.
--
-- No policy is created on purpose. With row level security on and no policy,
-- the public key sees and changes nothing. The app is not affected: it talks
-- to the database only with the service key (app/db.server.ts, also used by
-- the Shopify session storage), and that key's role bypasses row level
-- security. FORCE is NOT used, so the table owner (migrations, the SQL
-- editor, SECURITY DEFINER functions) keeps working as before.
--
-- Safe to run more than once: enabling what is already enabled does nothing,
-- and a table that does not exist is skipped.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'shopify_sessions',
    'members',
    'points_ledger',
    'order_webhook_state',
    'loyalty_codes',
    'referrals',
    'social_actions',
    'bonus_campaigns',
    'app_settings',
    'notification_log',
    'gdpr_requests',
    -- already enabled by 010 / 012; repeated so this file alone is the full list
    'review_claims',
    'tier_history',
    'staff_notes',
    'system_heartbeat',
    'import_runs',
    'import_rows'
  ]
  LOOP
    IF to_regclass(format('public.%I', t)) IS NOT NULL THEN
      EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    END IF;
  END LOOP;
END $$;
