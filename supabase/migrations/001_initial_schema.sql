-- Sessions table (Shopify auth)
CREATE TABLE IF NOT EXISTS shopify_sessions (
  id           TEXT PRIMARY KEY,
  shop         TEXT NOT NULL,
  state        TEXT,
  is_online    BOOLEAN NOT NULL DEFAULT false,
  scope        TEXT,
  expires      TIMESTAMPTZ,
  access_token TEXT,
  user_id      BIGINT
);

-- Members
CREATE TABLE IF NOT EXISTS members (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shopify_customer_id    TEXT UNIQUE NOT NULL,
  email                  TEXT NOT NULL,
  first_name             TEXT,
  last_name              TEXT,
  tier                   TEXT NOT NULL DEFAULT 'silver' CHECK (tier IN ('silver','gold','diamond')),
  points_balance         INTEGER NOT NULL DEFAULT 0,
  lifetime_spend_pkr     NUMERIC(12,2) NOT NULL DEFAULT 0,
  referral_slug          TEXT UNIQUE NOT NULL,
  referred_by_member_id  UUID REFERENCES members(id),
  birthday_month         INTEGER CHECK (birthday_month BETWEEN 1 AND 12),
  birthday_day           INTEGER CHECK (birthday_day BETWEEN 1 AND 31),
  consent_given          BOOLEAN NOT NULL DEFAULT false,
  consent_given_at       TIMESTAMPTZ,
  is_blocked             BOOLEAN NOT NULL DEFAULT false,
  is_influencer          BOOLEAN NOT NULL DEFAULT false,
  influencer_referral_rate INTEGER,
  enrolled_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Points ledger (append-only, source of truth)
CREATE TABLE IF NOT EXISTS points_ledger (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  member_id        UUID NOT NULL REFERENCES members(id),
  points           INTEGER NOT NULL,
  action_type      TEXT NOT NULL CHECK (action_type IN (
    'signup','purchase','social_youtube','social_facebook','social_instagram',
    'review','referral_earned','referral_bonus','redemption','expiry',
    'adjustment','birthday','campaign_bonus','refund_deduction'
  )),
  shopify_order_id TEXT,
  reference_id     TEXT,
  reason_note      TEXT,
  balance_after    INTEGER NOT NULL,
  earned_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at       TIMESTAMPTZ,
  expired          BOOLEAN NOT NULL DEFAULT false
);

-- Dual-webhook state machine
CREATE TABLE IF NOT EXISTS order_webhook_state (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shopify_order_id    TEXT UNIQUE NOT NULL,
  shopify_customer_id TEXT,
  fulfillment_status  TEXT,
  financial_status    TEXT,
  points_awarded      BOOLEAN NOT NULL DEFAULT false,
  order_total_pkr     NUMERIC(12,2),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Loyalty discount codes
CREATE TABLE IF NOT EXISTS loyalty_codes (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  member_id                UUID NOT NULL REFERENCES members(id),
  shopify_discount_code_id TEXT,
  code                     TEXT NOT NULL,
  discount_amount          INTEGER NOT NULL,
  points_spent             INTEGER NOT NULL,
  status                   TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','used','expired')),
  expires_at               TIMESTAMPTZ NOT NULL,
  used_at                  TIMESTAMPTZ,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Referrals
CREATE TABLE IF NOT EXISTS referrals (
  id                           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  referrer_member_id           UUID NOT NULL REFERENCES members(id),
  referred_shopify_customer_id TEXT,
  referred_email               TEXT NOT NULL,
  referred_ip                  TEXT,
  referrer_ip                  TEXT,
  status                       TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','completed','blocked','flagged')),
  block_reason                 TEXT,
  shopify_order_id             TEXT,
  points_awarded               BOOLEAN NOT NULL DEFAULT false,
  created_at                   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at                 TIMESTAMPTZ
);

-- Social actions (12h honour system)
CREATE TABLE IF NOT EXISTS social_actions (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  member_id      UUID NOT NULL REFERENCES members(id),
  action_type    TEXT NOT NULL CHECK (action_type IN ('youtube','facebook','instagram')),
  status         TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','awarded','voided')),
  pending_until  TIMESTAMPTZ NOT NULL,
  points_awarded INTEGER,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(member_id, action_type)
);

-- Bonus campaigns
CREATE TABLE IF NOT EXISTS bonus_campaigns (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name       TEXT NOT NULL,
  multiplier NUMERIC(3,1) NOT NULL DEFAULT 2.0,
  starts_at  TIMESTAMPTZ NOT NULL,
  ends_at    TIMESTAMPTZ NOT NULL,
  is_active  BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- App settings (singleton row)
CREATE TABLE IF NOT EXISTS app_settings (
  id                                  INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  program_name                        TEXT NOT NULL DEFAULT 'HeyGirl.pk Rewards®',
  brand_color_primary                 TEXT NOT NULL DEFAULT '#E91E8C',
  brand_color_secondary               TEXT NOT NULL DEFAULT '#7B5EA7',
  tagline                             TEXT NOT NULL DEFAULT 'Shop. Earn. Glow.',
  tier_gold_threshold_pkr             NUMERIC(12,2) NOT NULL DEFAULT 50000,
  tier_diamond_threshold_pkr          NUMERIC(12,2) NOT NULL DEFAULT 100000,
  signup_points                       INTEGER NOT NULL DEFAULT 1000,
  purchase_points_rate                NUMERIC(5,2) NOT NULL DEFAULT 1.0,
  referral_points                     INTEGER NOT NULL DEFAULT 6000,
  social_points                       INTEGER NOT NULL DEFAULT 1000,
  review_points                       INTEGER NOT NULL DEFAULT 3000,
  silver_expiry_days                  INTEGER NOT NULL DEFAULT 365,
  whatsapp_enabled                    BOOLEAN NOT NULL DEFAULT false,
  whatsapp_provider                   TEXT,
  whatsapp_api_key                    TEXT,
  wa_referral_template                TEXT DEFAULT 'Hey! I''ve been shopping at heygirl.pk and I think you''ll love it. Use my link to get FREE shipping on your first order: {link}',
  nudge_account_creation_enabled      BOOLEAN NOT NULL DEFAULT true,
  nudge_points_spending_enabled       BOOLEAN NOT NULL DEFAULT true,
  nudge_reward_usage_enabled          BOOLEAN NOT NULL DEFAULT true,
  nudge_post_purchase_enabled         BOOLEAN NOT NULL DEFAULT true,
  nudge_tier_progress_enabled         BOOLEAN NOT NULL DEFAULT true,
  tier_progress_gold_threshold_pkr    NUMERIC(12,2) NOT NULL DEFAULT 5000,
  tier_progress_diamond_threshold_pkr NUMERIC(12,2) NOT NULL DEFAULT 10000,
  updated_at                          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- updated_at auto-trigger
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_members_updated_at ON members;
CREATE TRIGGER trg_members_updated_at
  BEFORE UPDATE ON members FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_order_webhook_state_updated_at ON order_webhook_state;
CREATE TRIGGER trg_order_webhook_state_updated_at
  BEFORE UPDATE ON order_webhook_state FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_app_settings_updated_at ON app_settings;
CREATE TRIGGER trg_app_settings_updated_at
  BEFORE UPDATE ON app_settings FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Idempotent seed
INSERT INTO app_settings (id) VALUES (1) ON CONFLICT DO NOTHING;

-- Indexes
CREATE INDEX IF NOT EXISTS idx_members_shopify_customer_id ON members(shopify_customer_id);
CREATE INDEX IF NOT EXISTS idx_members_email ON members(email);
CREATE INDEX IF NOT EXISTS idx_members_referral_slug ON members(referral_slug);
CREATE INDEX IF NOT EXISTS idx_points_ledger_member_id ON points_ledger(member_id);
CREATE INDEX IF NOT EXISTS idx_points_ledger_earned_at ON points_ledger(earned_at);
CREATE INDEX IF NOT EXISTS idx_points_ledger_expires_at ON points_ledger(expires_at) WHERE expired = false;
CREATE INDEX IF NOT EXISTS idx_order_webhook_state_order_id ON order_webhook_state(shopify_order_id);
CREATE INDEX IF NOT EXISTS idx_referrals_referrer_member_id ON referrals(referrer_member_id);
CREATE INDEX IF NOT EXISTS idx_loyalty_codes_member_id ON loyalty_codes(member_id);
CREATE INDEX IF NOT EXISTS idx_loyalty_codes_code ON loyalty_codes(code);
