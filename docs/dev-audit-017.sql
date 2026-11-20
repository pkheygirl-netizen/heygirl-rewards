-- docs/dev-audit-017.sql  (review 13)
-- READ-ONLY audit of referral payments, for the owner or lead to run in the
-- Supabase SQL editor before go-live (and after applying 017 on any database
-- that already holds referrals). It changes nothing and returns counts only:
-- no names, emails, phones, addresses, customer ids or order ids.
--
-- What each line means (expected value in brackets):
--   earned_not_completed_open      referral_earned ledger row, no reversal,
--                                  status not 'completed' [0]. The referrer
--                                  holds the points but the referral does not
--                                  say so; 017's pay_referral records these
--                                  ('recorded') when the friend's next order
--                                  event or the 10-minute sweep reaches them.
--   earned_and_reversed            referral_earned AND referral_reversal rows
--                                  (paid, then taken back). Normal; listed so
--                                  the line above is read correctly.
--   earned_not_completed_by_status the first line split by status.
--   completed_unpaid_claim         completed, points_awarded = false,
--                                  reward_points set: a half-done payment by
--                                  the pre-017 code [0 once the sweep has run].
--   completed_unpaid_legacy        completed, points_awarded = false, no
--                                  reward_points: marked completed by the
--                                  pre-v3 admin button, never paid by v3 (by
--                                  design; staff decide).
--   completed_awarded_no_ledger    completed, points_awarded = true, but no
--                                  referral_earned row [0].
--   completed_email_not_recorded_7d completed and paid in the last 7 days
--                                  with completion_email_queued_at empty
--                                  [0 a few minutes after the sweep runs].
--   schema_version                 hg_schema_version() [17].
--
-- One SELECT statement (nothing is written); run all of it at once, one
-- result table. It needs 017 applied (completion_email_queued_at,
-- hg_schema_version); before 017 it fails with "column does not exist".

WITH earned AS (
  SELECT r.id, r.status,
         EXISTS (
           SELECT 1 FROM public.points_ledger pl
            WHERE pl.member_id = r.referrer_member_id
              AND pl.action_type = 'referral_reversal'
              AND pl.reference_id = r.id::text
         ) AS reversed
    FROM public.referrals r
   WHERE EXISTS (
           SELECT 1 FROM public.points_ledger pl
            WHERE pl.member_id = r.referrer_member_id
              AND pl.action_type = 'referral_earned'
              AND pl.reference_id = r.id::text
         )
)
SELECT 'earned_not_completed_open' AS check_name, count(*) AS referrals
  FROM earned WHERE status <> 'completed' AND NOT reversed
UNION ALL
SELECT 'earned_and_reversed', count(*) FROM earned WHERE reversed
UNION ALL
SELECT 'earned_not_completed_by_status: ' || status, count(*)
  FROM earned WHERE status <> 'completed' AND NOT reversed GROUP BY status
UNION ALL
SELECT 'completed_unpaid_claim', count(*)
  FROM public.referrals WHERE status = 'completed' AND NOT points_awarded AND reward_points IS NOT NULL
UNION ALL
SELECT 'completed_unpaid_legacy', count(*)
  FROM public.referrals WHERE status = 'completed' AND NOT points_awarded AND reward_points IS NULL
UNION ALL
SELECT 'completed_awarded_no_ledger', count(*)
  FROM public.referrals r
 WHERE r.status = 'completed' AND r.points_awarded
   AND NOT EXISTS (
         SELECT 1 FROM public.points_ledger pl
          WHERE pl.member_id = r.referrer_member_id
            AND pl.action_type = 'referral_earned'
            AND pl.reference_id = r.id::text
       )
UNION ALL
SELECT 'completed_email_not_recorded_7d', count(*)
  FROM public.referrals
 WHERE status = 'completed' AND points_awarded
   AND completion_email_queued_at IS NULL
   AND completed_at >= now() - interval '7 days'
UNION ALL
SELECT 'schema_version', public.hg_schema_version();
