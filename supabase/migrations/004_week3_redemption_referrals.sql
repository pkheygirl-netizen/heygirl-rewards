-- loyalty_codes: add missing columns (points_spent, status, expires_at, used_at already exist)
ALTER TABLE public.loyalty_codes
  ADD COLUMN IF NOT EXISTS shopify_price_rule_id text,
  ADD COLUMN IF NOT EXISTS discount_amount_pkr integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS shopify_order_id text;

DO $$ BEGIN
  ALTER TABLE public.loyalty_codes
    ADD CONSTRAINT loyalty_codes_status_check
    CHECK (status IN ('active','used','expired'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- unique index on code (the discount code column)
CREATE UNIQUE INDEX IF NOT EXISTS loyalty_codes_shopify_code_uniq
  ON public.loyalty_codes (code);

CREATE INDEX IF NOT EXISTS loyalty_codes_member_status_idx
  ON public.loyalty_codes (member_id, status);

-- referrals: add missing fraud-check columns
-- (referrer_ip, referred_ip, referred_email, status already exist)
ALTER TABLE public.referrals
  ADD COLUMN IF NOT EXISTS referred_shipping_address_hash text,
  ADD COLUMN IF NOT EXISTS device_fingerprint_hash text,
  ADD COLUMN IF NOT EXISTS fraud_flags text[] NOT NULL DEFAULT '{}';

DO $$ BEGIN
  ALTER TABLE public.referrals
    ADD CONSTRAINT referrals_status_check
    CHECK (status IN ('pending','completed','flagged','blocked'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS referrals_referrer_member_idx
  ON public.referrals (referrer_member_id, status);

CREATE INDEX IF NOT EXISTS referrals_referred_customer_idx
  ON public.referrals (referred_shopify_customer_id);

-- app_settings: add missing columns (referral_points already exists)
ALTER TABLE public.app_settings
  ADD COLUMN IF NOT EXISTS redemption_tiers jsonb NOT NULL DEFAULT '[
    {"points": 3000,   "discount_pkr": 100},
    {"points": 6000,   "discount_pkr": 250},
    {"points": 11500,  "discount_pkr": 500},
    {"points": 22000,  "discount_pkr": 1000},
    {"points": 100000, "discount_pkr": 5000},
    {"points": 180000, "discount_pkr": 10000}
  ]'::jsonb,
  ADD COLUMN IF NOT EXISTS referral_friend_discount_pkr integer NOT NULL DEFAULT 0;

-- Seed app_settings row if absent
INSERT INTO public.app_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
