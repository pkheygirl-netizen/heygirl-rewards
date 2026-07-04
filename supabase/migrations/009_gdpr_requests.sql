-- supabase/migrations/009_gdpr_requests.sql
-- W4 (2026-07-03 review): customers/data_request was only console.log'd; Railway
-- logs rotate, so the merchant had no durable record of the 30-day obligation.

CREATE TABLE IF NOT EXISTS gdpr_requests (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type                 TEXT NOT NULL CHECK (type IN ('data_request', 'customer_redact', 'shop_redact')),
  shopify_customer_id  TEXT,
  payload              JSONB,
  status               TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'fulfilled')),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DROP TRIGGER IF EXISTS set_gdpr_requests_updated_at ON gdpr_requests;
CREATE TRIGGER set_gdpr_requests_updated_at
  BEFORE UPDATE ON gdpr_requests
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
