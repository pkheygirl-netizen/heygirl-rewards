-- 015_review_manual_approval.sql (also: app_settings.launcher_label)
-- Owner decision (18 Nov 2026): review points are added only when staff
-- approve the claim in the admin. Nothing is released automatically, so a new
-- claim has no release time: `review_claims.release_at` may now be NULL.
--
-- Nothing is dropped or rewritten: the column and the values already stored
-- stay as they are (unused), and `app_settings.review_release_hours` is kept
-- (unused). Safe to apply twice: DROP NOT NULL on a nullable column is a no-op.
ALTER TABLE public.review_claims ALTER COLUMN release_at DROP NOT NULL;

COMMENT ON COLUMN public.review_claims.release_at IS
  'Unused since 015: review claims wait for staff approval. Older rows keep their old value; new claims leave it NULL.';
COMMENT ON COLUMN public.app_settings.review_release_hours IS
  'Unused since 015: review claims wait for staff approval (no automatic release).';

-- Launcher button text for visitors (owner, 18 Nov 2026: "Shop & Earn", editable
-- on the On-site page). Plain text, 1-24 characters after trimming. Existing
-- rows get the default; nothing else changes.
ALTER TABLE public.app_settings
  ADD COLUMN IF NOT EXISTS launcher_label text NOT NULL DEFAULT 'Shop & Earn';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'app_settings_launcher_label_len' AND conrelid = 'public.app_settings'::regclass
  ) THEN
    ALTER TABLE public.app_settings
      ADD CONSTRAINT app_settings_launcher_label_len
      CHECK (char_length(btrim(launcher_label)) BETWEEN 1 AND 24 AND launcher_label !~ '[<>[:cntrl:]]');
  END IF;
END $$;
