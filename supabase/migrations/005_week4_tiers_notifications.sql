-- notification_log: deduplication for all outbound notifications
CREATE TABLE IF NOT EXISTS notification_log (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  member_id  UUID NOT NULL REFERENCES public.members(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  reference_id TEXT NOT NULL DEFAULT '',
  sent_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS notification_log_dedup_idx
  ON public.notification_log (member_id, event_type, reference_id);

CREATE INDEX IF NOT EXISTS notification_log_member_idx
  ON public.notification_log (member_id, event_type);
