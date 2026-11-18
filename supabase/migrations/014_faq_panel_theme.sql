-- 014_faq_panel_theme.sql
-- Small settings changes. Not applied anywhere yet when written.
--
--   app_settings.panel_theme   colour scheme of the storefront rewards panel,
--                              chosen on the admin On-site page: 'light' (the
--                              original look, default) or 'dark'.
--   default FAQ                the owner-approved "How are my points
--                              calculated?" entry, added to a store whose FAQ
--                              list is still empty (never customised). A store
--                              that saved its own list is left alone; the
--                              On-site page offers the entry instead.
--   column defaults            owner decision 17 Nov 2026: social follows
--                              earn 500 points each (was 1,000), and the
--                              reward table gains 50,000 points -> Rs. 2,500.
--                              Only the DEFAULTS change (a new database);
--                              a saved settings row is never overwritten.
--                              The owner changes a saved row on the admin
--                              Program page.
--
-- The program switch (app_settings.program_enabled, migration 007) needs no
-- change: since the owner's decision of 17 Nov 2026 it only pauses redeeming
-- (contract rule 20), so nothing about it is recorded here.
--
-- Safe to run more than once and on a database with data.

-- ─────────────────────────── panel style ───────────────────────────
ALTER TABLE public.app_settings
  ADD COLUMN IF NOT EXISTS panel_theme text NOT NULL DEFAULT 'light';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'app_settings_panel_theme_check'
                    AND conrelid = 'public.app_settings'::regclass) THEN
    ALTER TABLE public.app_settings
      ADD CONSTRAINT app_settings_panel_theme_check CHECK (panel_theme IN ('light', 'dark'));
  END IF;
END $$;

-- ─────────────────────────── defaults (new rows only) ───────────────────────────
-- SET DEFAULT changes nothing in a row that already exists.
ALTER TABLE public.app_settings
  ALTER COLUMN social_points           SET DEFAULT 500,
  ALTER COLUMN social_points_instagram SET DEFAULT 500,
  ALTER COLUMN social_points_facebook  SET DEFAULT 500,
  ALTER COLUMN social_points_youtube   SET DEFAULT 500,
  ALTER COLUMN redemption_tiers        SET DEFAULT '[
    {"points": 3000,   "discount_pkr": 100},
    {"points": 6000,   "discount_pkr": 250},
    {"points": 11500,  "discount_pkr": 500},
    {"points": 22000,  "discount_pkr": 1000},
    {"points": 50000,  "discount_pkr": 2500},
    {"points": 100000, "discount_pkr": 5000},
    {"points": 180000, "discount_pkr": 10000}
  ]'::jsonb;

-- ─────────────────────────── default FAQ ───────────────────────────
UPDATE public.app_settings
   SET faqs = jsonb_build_array(jsonb_build_object(
         'q', 'How are my points calculated?',
         'a', 'Points are earned on the amount you pay after discounts, and are added once your order is delivered and paid. Shipping, tax and any part paid by gift card do not earn points.'))
 WHERE id = 1
   AND (faqs IS NULL OR faqs = '[]'::jsonb);

NOTIFY pgrst, 'reload schema';
