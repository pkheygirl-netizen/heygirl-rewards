-- supabase/migrations/012_import.sql
-- Smile.io import (workstream D). Idempotent: safe to run more than once.
-- Needs 010_v3_core.sql (ledger action 'import', members.imported_from_smile).
--
-- import_runs: one row per uploaded file (dry run, then the real run).
-- import_rows: one compact row per file line, so the run can be resumed after
--   a restart and the unmatched / duplicates report can be downloaded.
--   Personal data kept: the e-mail (needed for matching and for the report).
--   Names, date of birth and referral url from the file are never stored.
--   The Shopify name and phone of a matched customer are held only between
--   the dry run and the import of that row, then cleared; whatever is left is
--   cleared when the run closes. The rows themselves are deleted 30 days after
--   the run closed (at once for a discarded dry run): import_runs.rows_purged_at.
-- import_runs.locked_by / locked_until: the lease of the worker processing the
--   run, taken with a conditional UPDATE so two workers cannot share a run.

CREATE TABLE IF NOT EXISTS public.import_runs (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source       text NOT NULL DEFAULT 'smile',
  status       text NOT NULL DEFAULT 'planning'
               CHECK (status IN ('planning','planned','running','completed','failed','cancelled')),
  phase        text NOT NULL DEFAULT 'plan' CHECK (phase IN ('plan','execute')),
  file_name    text,
  options      jsonb NOT NULL DEFAULT '{}'::jsonb,
  totals       jsonb NOT NULL DEFAULT '{}'::jsonb,
  progress     jsonb NOT NULL DEFAULT '{}'::jsonb,
  error        text,
  created_by   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  started_at   timestamptz,
  finished_at  timestamptz,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  locked_by    text,
  locked_until timestamptz,
  rows_purged_at timestamptz
);
ALTER TABLE public.import_runs
  ADD COLUMN IF NOT EXISTS locked_by      text,
  ADD COLUMN IF NOT EXISTS locked_until   timestamptz,
  ADD COLUMN IF NOT EXISTS rows_purged_at timestamptz;

-- Only one run may be open at a time. A failed run stays open until it is
-- resumed or discarded, so a half-finished import is never forgotten.
CREATE UNIQUE INDEX IF NOT EXISTS import_runs_one_open_uniq
  ON public.import_runs ((true))
  WHERE status IN ('planning','planned','running','failed');

CREATE TABLE IF NOT EXISTS public.import_rows (
  run_id              uuid NOT NULL REFERENCES public.import_runs(id) ON DELETE CASCADE,
  row_number          integer NOT NULL,
  smile_customer_id   text NOT NULL DEFAULT '',
  email               text,
  smile_status        text,
  vip_tier_name       text,
  file_points         integer NOT NULL DEFAULT 0,
  points              integer NOT NULL DEFAULT 0 CHECK (points >= 0),
  state               text NOT NULL
                      CHECK (state IN ('pending','matched','imported','unmatched','duplicate','invalid','skipped','error')),
  reason              text,
  shopify_customer_id text,
  shopify_first_name  text,
  shopify_last_name   text,
  shopify_phone       text,
  member_id           uuid,
  member_existed      boolean,
  member_has_welcome  boolean,
  points_awarded      integer,
  PRIMARY KEY (run_id, row_number)
);
ALTER TABLE public.import_rows
  ADD COLUMN IF NOT EXISTS member_has_welcome boolean;

CREATE INDEX IF NOT EXISTS import_rows_state_idx
  ON public.import_rows (run_id, state, row_number);

-- Service-key access only, like every other table of the app.
ALTER TABLE public.import_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.import_rows ENABLE ROW LEVEL SECURITY;

-- Ask PostgREST to pick up the new tables.
NOTIFY pgrst, 'reload schema';
