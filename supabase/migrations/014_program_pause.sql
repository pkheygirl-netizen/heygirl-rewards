-- 014_program_pause.sql
-- Rule 20 (docs/v3-contract.md): when the program is switched off nobody earns
-- or redeems, and an order earns only if the program was ON when the order was
-- PLACED, whenever it is later delivered and paid.
--
--   program_switch_history          every change of app_settings.program_enabled,
--                                   written by a trigger (so every path that saves
--                                   the switch records it, the admin page included)
--   program_enabled_at(timestamptz) was the program on at that moment?
--   order_webhook_state.program_on_at_placement
--                                   the answer for the order's placed_at, fixed
--                                   the first time the app sees the order (like
--                                   multiplier_used), so a late or missing
--                                   orders/create webhook does not change it
--
-- FAQ: the owner-approved "How are my points calculated?" entry is added to a
-- store whose FAQ list is still empty (never customised). A store that saved
-- its own list is left alone; the On-site page offers the entry instead.
--
-- Safe to run more than once and on a database with data.

-- ─────────────────────────── switch history ───────────────────────────
CREATE TABLE IF NOT EXISTS public.program_switch_history (
  id          bigserial PRIMARY KEY,
  enabled     boolean     NOT NULL,
  changed_at  timestamptz NOT NULL DEFAULT now(),
  source      text        NOT NULL DEFAULT 'settings'
);
CREATE INDEX IF NOT EXISTS program_switch_history_changed_at_idx
  ON public.program_switch_history (changed_at, id);
-- Same protection as every other app table (013_rls.sql): no policy, so the
-- public API key sees nothing; the service key bypasses row level security.
ALTER TABLE public.program_switch_history ENABLE ROW LEVEL SECURITY;

-- Baseline: the state when this migration first ran. Earlier history is not
-- known; program_enabled_at() assumes the baseline state held before it.
INSERT INTO public.program_switch_history (enabled, changed_at, source)
SELECT COALESCE((SELECT s.program_enabled FROM public.app_settings s WHERE s.id = 1), true), now(), 'baseline'
 WHERE NOT EXISTS (SELECT 1 FROM public.program_switch_history);

CREATE OR REPLACE FUNCTION public.app_settings_track_program_switch()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' OR NEW.program_enabled IS DISTINCT FROM OLD.program_enabled THEN
    INSERT INTO public.program_switch_history (enabled, changed_at, source)
    VALUES (COALESCE(NEW.program_enabled, true), now(), 'settings');
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_app_settings_program_switch ON public.app_settings;
CREATE TRIGGER trg_app_settings_program_switch
  AFTER INSERT OR UPDATE OF program_enabled ON public.app_settings
  FOR EACH ROW EXECUTE FUNCTION public.app_settings_track_program_switch();

-- Was the program on at p_at? The latest recorded state at or before that
-- moment; before the first record, the first record's state; with no history
-- at all, the current switch (default on).
CREATE OR REPLACE FUNCTION public.program_enabled_at(p_at timestamptz)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT COALESCE(
    (SELECT h.enabled FROM public.program_switch_history h
      WHERE h.changed_at <= COALESCE(p_at, now())
      ORDER BY h.changed_at DESC, h.id DESC LIMIT 1),
    (SELECT h.enabled FROM public.program_switch_history h
      ORDER BY h.changed_at ASC, h.id ASC LIMIT 1),
    (SELECT s.program_enabled FROM public.app_settings s WHERE s.id = 1),
    true);
$$;

-- ─────────────────────────── orders ───────────────────────────
-- Orders recorded before this migration: the state at placement was not
-- recorded, so they keep earning as before (true).
ALTER TABLE public.order_webhook_state
  ADD COLUMN IF NOT EXISTS program_on_at_placement boolean NOT NULL DEFAULT true;

-- ─────────────────────────── default FAQ ───────────────────────────
UPDATE public.app_settings
   SET faqs = jsonb_build_array(jsonb_build_object(
         'q', 'How are my points calculated?',
         'a', 'Points are earned on the amount you pay after discounts, and are added once your order is delivered and paid. Shipping and tax do not earn points.'))
 WHERE id = 1
   AND (faqs IS NULL OR faqs = '[]'::jsonb);

-- ─────────────────────────── grants ───────────────────────────
DO $$
DECLARE
  fn text;
BEGIN
  FOREACH fn IN ARRAY ARRAY['public.program_enabled_at(timestamptz)'] LOOP
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

NOTIFY pgrst, 'reload schema';
