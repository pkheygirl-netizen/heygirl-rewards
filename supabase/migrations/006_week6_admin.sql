-- supabase/migrations/006_week6_admin.sql
-- Week 6 admin dashboard: remaining configurable settings fields.

ALTER TABLE app_settings
  ADD COLUMN IF NOT EXISTS birthday_reward_silver_pkr   INTEGER NOT NULL DEFAULT 250,
  ADD COLUMN IF NOT EXISTS birthday_reward_gold_pkr     INTEGER NOT NULL DEFAULT 500,
  ADD COLUMN IF NOT EXISTS birthday_reward_diamond_pkr  INTEGER NOT NULL DEFAULT 1000,
  ADD COLUMN IF NOT EXISTS social_points_youtube        INTEGER NOT NULL DEFAULT 1000,
  ADD COLUMN IF NOT EXISTS social_points_facebook       INTEGER NOT NULL DEFAULT 1000,
  ADD COLUMN IF NOT EXISTS social_points_instagram      INTEGER NOT NULL DEFAULT 1000,
  ADD COLUMN IF NOT EXISTS bonus_campaign_default_multiplier NUMERIC(3,1) NOT NULL DEFAULT 2.0,
  ADD COLUMN IF NOT EXISTS influencer_cta_link          TEXT,
  ADD COLUMN IF NOT EXISTS shopify_email_injection_enabled BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS terms_and_conditions         TEXT,
  ADD COLUMN IF NOT EXISTS faqs                         JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS nudges_config                JSONB NOT NULL DEFAULT '{}'::jsonb;
