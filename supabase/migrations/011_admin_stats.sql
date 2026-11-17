-- supabase/migrations/011_admin_stats.sql
-- Stream C (embedded admin). Read-only SQL functions so that no admin number is
-- computed by downloading whole tables (handbook R1). Requires 010_v3_core.sql.
-- No table definitions change here. Two read indexes are added for the admin
-- activity feed and period totals (CREATE INDEX IF NOT EXISTS, idempotent).
--
-- Definitions used everywhere in the admin:
--   earned    = positive ledger rows, excluding 'import' (Smile balances carried
--               over) and 'redemption_return' (points handed back, not earned)
--   redeemed  = 'redemption' rows minus 'redemption_return' rows (never below 0)
--   expired   = 'expiry' rows
--   day       = calendar day in Asia/Karachi
--   redemptions (count) = loyalty_codes with kind = 'reward' only (handbook R8)

CREATE INDEX IF NOT EXISTS points_ledger_earned_at_idx
  ON public.points_ledger (earned_at DESC);
CREATE INDEX IF NOT EXISTS loyalty_codes_created_at_idx
  ON public.loyalty_codes (created_at DESC);

-- ── helpers ──────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.admin_member_name(
  p_first text, p_last text, p_email text, p_phone text
) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT COALESCE(
    NULLIF(btrim(COALESCE(p_first, '') || ' ' || COALESCE(p_last, '')), ''),
    NULLIF(p_email, ''),
    NULLIF(p_phone, ''),
    'Customer'
  );
$$;

-- ── period totals (Home key numbers, Analytics) ──────────────────────────────

CREATE OR REPLACE FUNCTION public.admin_period_stats(p_from timestamptz, p_to timestamptz)
RETURNS jsonb
LANGUAGE sql STABLE AS $$
  WITH led AS (
    SELECT
      COALESCE(SUM(points) FILTER (
        WHERE points > 0 AND action_type NOT IN ('import', 'redemption_return')), 0) AS earned,
      COALESCE(SUM(-points) FILTER (WHERE action_type = 'redemption'), 0)           AS redeemed_gross,
      COALESCE(SUM(points) FILTER (WHERE action_type = 'redemption_return'), 0)     AS returned,
      COALESCE(SUM(-points) FILTER (WHERE action_type = 'expiry'), 0)               AS expired,
      COALESCE(SUM(-points) FILTER (
        WHERE action_type IN ('refund_deduction', 'order_cancelled', 'referral_reversal')), 0) AS reversed
    FROM public.points_ledger
    WHERE earned_at >= p_from AND earned_at < p_to
  ),
  mem AS (
    SELECT
      COUNT(*) FILTER (WHERE enrolled_at < p_to)                         AS total,
      COUNT(*) FILTER (WHERE enrolled_at >= p_from AND enrolled_at < p_to) AS new_members
    FROM public.members
  ),
  pend AS (
    SELECT COALESCE(SUM(pending_points), 0) AS pending
    FROM public.order_webhook_state
    WHERE cancelled_at IS NULL AND NOT points_awarded AND pending_points > 0
  ),
  red AS (
    SELECT COUNT(*) AS redemptions
    FROM public.loyalty_codes
    WHERE kind = 'reward' AND created_at >= p_from AND created_at < p_to
  ),
  -- Orders placed in the period that used one of our reward codes.
  ro AS (
    SELECT o.shopify_order_id,
           COALESCE(o.order_total_pkr, 0) AS total,
           (SELECT COALESCE(SUM(c.discount_amount_pkr), 0)
              FROM public.loyalty_codes c
             WHERE c.kind = 'reward'
               AND (c.shopify_order_id = o.shopify_order_id OR c.code = ANY (o.discount_codes))) AS cost
    FROM public.order_webhook_state o
    WHERE o.cancelled_at IS NULL
      AND COALESCE(o.placed_at, o.created_at) >= p_from
      AND COALESCE(o.placed_at, o.created_at) < p_to
      AND EXISTS (
        SELECT 1 FROM public.loyalty_codes c
         WHERE c.kind = 'reward'
           AND (c.shopify_order_id = o.shopify_order_id OR c.code = ANY (o.discount_codes)))
  )
  SELECT jsonb_build_object(
    'members_total',   (SELECT total FROM mem),
    'members_new',     (SELECT new_members FROM mem),
    'points_earned',   (SELECT earned FROM led),
    'points_redeemed', (SELECT GREATEST(redeemed_gross - returned, 0) FROM led),
    'points_expired',  (SELECT expired FROM led),
    'points_reversed', (SELECT reversed FROM led),
    'points_pending',  (SELECT pending FROM pend),
    'redemptions',     (SELECT redemptions FROM red),
    'reward_orders',   (SELECT COUNT(*) FROM ro),
    'reward_sales_pkr',(SELECT COALESCE(SUM(total), 0) FROM ro),
    'reward_cost_pkr', (SELECT COALESCE(SUM(cost), 0) FROM ro)
  );
$$;

-- ── daily series (Karachi days, zero-filled) ─────────────────────────────────

CREATE OR REPLACE FUNCTION public.admin_points_series(p_from timestamptz, p_to timestamptz)
RETURNS TABLE(day date, earned bigint, redeemed bigint, expired bigint)
LANGUAGE sql STABLE AS $$
  WITH days AS (
    SELECT d::date AS day
    FROM generate_series(
      (p_from AT TIME ZONE 'Asia/Karachi')::date,
      ((p_to - interval '1 microsecond') AT TIME ZONE 'Asia/Karachi')::date,
      interval '1 day') d
  ),
  agg AS (
    SELECT (earned_at AT TIME ZONE 'Asia/Karachi')::date AS day,
      COALESCE(SUM(points) FILTER (
        WHERE points > 0 AND action_type NOT IN ('import', 'redemption_return')), 0) AS earned,
      GREATEST(
        COALESCE(SUM(-points) FILTER (WHERE action_type = 'redemption'), 0)
        - COALESCE(SUM(points) FILTER (WHERE action_type = 'redemption_return'), 0), 0) AS redeemed,
      COALESCE(SUM(-points) FILTER (WHERE action_type = 'expiry'), 0) AS expired
    FROM public.points_ledger
    WHERE earned_at >= p_from AND earned_at < p_to
    GROUP BY 1
  )
  SELECT days.day,
         COALESCE(agg.earned, 0)::bigint,
         COALESCE(agg.redeemed, 0)::bigint,
         COALESCE(agg.expired, 0)::bigint
  FROM days LEFT JOIN agg USING (day)
  ORDER BY days.day;
$$;

-- ── members by tier, and how many are close to the next tier ─────────────────

CREATE OR REPLACE FUNCTION public.admin_tier_counts()
RETURNS jsonb
LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_object(
    'silver',  COUNT(*) FILTER (WHERE m.tier = 'silver'),
    'gold',    COUNT(*) FILTER (WHERE m.tier = 'gold'),
    'diamond', COUNT(*) FILTER (WHERE m.tier = 'diamond'),
    'near_gold', COUNT(*) FILTER (
      WHERE m.tier = 'silver'
        AND m.lifetime_spend_pkr >= s.tier_gold_threshold_pkr - s.tier_progress_gold_threshold_pkr),
    'near_diamond', COUNT(*) FILTER (
      WHERE m.tier = 'gold'
        AND m.lifetime_spend_pkr >= s.tier_diamond_threshold_pkr - s.tier_progress_diamond_threshold_pkr),
    'near_gold_within_pkr',    MAX(s.tier_progress_gold_threshold_pkr),
    'near_diamond_within_pkr', MAX(s.tier_progress_diamond_threshold_pkr)
  )
  FROM public.app_settings s
  LEFT JOIN public.members m ON true
  WHERE s.id = 1;
$$;

-- ── "Needs your attention" counters ──────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.admin_attention(p_days integer DEFAULT 30)
RETURNS jsonb
LANGUAGE sql STABLE AS $$
  WITH ex AS (
    SELECT COUNT(DISTINCT member_id) AS members,
           COALESCE(SUM(COALESCE(points_remaining, points)), 0) AS points
    FROM public.points_ledger
    WHERE points > 0 AND NOT expired
      AND COALESCE(points_remaining, points) > 0
      AND expires_at IS NOT NULL
      AND expires_at >= now() AND expires_at < now() + make_interval(days => p_days)
  )
  SELECT jsonb_build_object(
    'referrals_flagged',     (SELECT COUNT(*) FROM public.referrals WHERE status = 'flagged'),
    'review_claims_pending', (SELECT COUNT(*) FROM public.review_claims WHERE status = 'pending'),
    'expiring_members',      (SELECT members FROM ex),
    'expiring_points',       (SELECT points FROM ex),
    'gdpr_open',             (SELECT COUNT(*) FROM public.gdpr_requests WHERE status = 'open')
  );
$$;

CREATE OR REPLACE FUNCTION public.admin_expiring_members(
  p_days integer DEFAULT 30, p_limit integer DEFAULT 50, p_offset integer DEFAULT 0
) RETURNS TABLE(member_id uuid, name text, email text, phone text,
                points bigint, first_expiry timestamptz, total_count bigint)
LANGUAGE sql STABLE AS $$
  WITH ex AS (
    SELECT l.member_id,
           SUM(COALESCE(l.points_remaining, l.points)) AS points,
           MIN(l.expires_at) AS first_expiry
    FROM public.points_ledger l
    WHERE l.points > 0 AND NOT l.expired
      AND COALESCE(l.points_remaining, l.points) > 0
      AND l.expires_at IS NOT NULL
      AND l.expires_at >= now() AND l.expires_at < now() + make_interval(days => p_days)
    GROUP BY l.member_id
  )
  SELECT m.id, public.admin_member_name(m.first_name, m.last_name, m.email, m.phone),
         m.email, m.phone, ex.points::bigint, ex.first_expiry, COUNT(*) OVER ()
  FROM ex JOIN public.members m ON m.id = ex.member_id
  ORDER BY ex.first_expiry, m.id
  LIMIT LEAST(GREATEST(p_limit, 1), 5000) OFFSET GREATEST(p_offset, 0);
$$;

-- ── customers list: search, filters, sort and paging in the database ─────────

CREATE OR REPLACE FUNCTION public.admin_search_members(
  p_query      text    DEFAULT NULL,
  p_tier       text    DEFAULT NULL,
  p_has_points boolean DEFAULT NULL,
  p_blocked    boolean DEFAULT NULL,
  p_opted_out  boolean DEFAULT NULL,
  p_influencer boolean DEFAULT NULL,
  p_sort       text    DEFAULT 'joined',
  p_desc       boolean DEFAULT true,
  p_limit      integer DEFAULT 25,
  p_offset     integer DEFAULT 0
) RETURNS TABLE(id uuid, shopify_customer_id text, name text, email text, phone text, tier text,
                points_balance integer, lifetime_spend_pkr numeric, is_blocked boolean,
                opted_out boolean, is_influencer boolean, enrolled_at timestamptz, total_count bigint)
LANGUAGE sql STABLE AS $$
  WITH q AS (
    SELECT NULLIF(btrim(p_query), '') AS term,
           NULLIF(regexp_replace(COALESCE(p_query, ''), '\D', '', 'g'), '') AS digits
  ),
  f AS (
    SELECT m.*, public.admin_member_name(m.first_name, m.last_name, m.email, m.phone) AS display_name
    FROM public.members m, q
    WHERE (p_tier IS NULL OR m.tier = p_tier)
      AND (p_has_points IS NULL OR (m.points_balance > 0) = p_has_points)
      AND (p_blocked IS NULL OR m.is_blocked = p_blocked)
      AND (p_opted_out IS NULL OR m.opted_out = p_opted_out)
      AND (p_influencer IS NULL OR m.is_influencer = p_influencer)
      AND (
        q.term IS NULL
        -- position() is a plain substring test: the search text is never a pattern
        OR position(lower(q.term) IN lower(COALESCE(m.first_name, '') || ' ' || COALESCE(m.last_name, ''))) > 0
        OR position(lower(q.term) IN lower(COALESCE(m.email, ''))) > 0
        OR (length(q.digits) >= 4
            AND position(ltrim(q.digits, '0') IN regexp_replace(COALESCE(m.phone, ''), '\D', '', 'g')) > 0)
      )
  )
  SELECT f.id, f.shopify_customer_id, f.display_name, f.email, f.phone, f.tier,
         f.points_balance, f.lifetime_spend_pkr, f.is_blocked, f.opted_out, f.is_influencer,
         f.enrolled_at, COUNT(*) OVER ()
  FROM f
  ORDER BY
    CASE WHEN p_sort = 'points' AND p_desc     THEN f.points_balance END DESC NULLS LAST,
    CASE WHEN p_sort = 'points' AND NOT p_desc THEN f.points_balance END ASC  NULLS LAST,
    CASE WHEN p_sort = 'spend'  AND p_desc     THEN f.lifetime_spend_pkr END DESC NULLS LAST,
    CASE WHEN p_sort = 'spend'  AND NOT p_desc THEN f.lifetime_spend_pkr END ASC  NULLS LAST,
    CASE WHEN p_sort = 'name'   AND p_desc     THEN lower(f.display_name) END DESC NULLS LAST,
    CASE WHEN p_sort = 'name'   AND NOT p_desc THEN lower(f.display_name) END ASC  NULLS LAST,
    CASE WHEN p_sort NOT IN ('points', 'spend', 'name') AND NOT p_desc THEN f.enrolled_at END ASC,
    f.enrolled_at DESC, f.id
  LIMIT LEAST(GREATEST(p_limit, 1), 5000) OFFSET GREATEST(p_offset, 0);
$$;

-- ── activity feed (Home: all members; profile: one member) ───────────────────
-- kind: 'points' ledger row | 'code' automatic code issued (birthday, tier,
-- referral friend; reward codes already appear as their 'redemption' ledger row)
-- | 'tier' tier change | 'pending' order waiting for payment (profile only).
-- p_filter: all | earned | redeemed | referrals | adjustments

CREATE OR REPLACE FUNCTION public.admin_activity(
  p_filter text    DEFAULT 'all',
  p_member uuid    DEFAULT NULL,
  p_limit  integer DEFAULT 25,
  p_offset integer DEFAULT 0
) RETURNS TABLE(id text, at timestamptz, kind text, action text, points integer,
                member_id uuid, member_name text, order_id text, order_name text,
                reason_note text, customer_note text, code text, discount_pkr integer)
LANGUAGE sql STABLE AS $$
  WITH lim AS (
    SELECT LEAST(GREATEST(p_limit, 1), 200) + GREATEST(p_offset, 0) AS n
  ),
  led AS (
    SELECT l.id::text AS id, l.earned_at AS at, 'points'::text AS kind, l.action_type AS action,
           l.points, l.member_id, l.shopify_order_id AS order_id,
           l.reason_note, l.customer_note, NULL::text AS code, NULL::integer AS discount_pkr
    FROM public.points_ledger l
    WHERE (p_member IS NULL OR l.member_id = p_member)
      AND CASE p_filter
            WHEN 'earned'      THEN l.points > 0 AND l.action_type NOT IN ('adjustment', 'redemption_return')
            WHEN 'redeemed'    THEN l.action_type IN ('redemption', 'redemption_return')
            WHEN 'referrals'   THEN l.action_type IN ('referral_earned', 'referral_bonus', 'referral_reversal', 'influencer_sale')
            WHEN 'adjustments' THEN l.action_type = 'adjustment'
            ELSE true
          END
    ORDER BY l.earned_at DESC
    LIMIT (SELECT n FROM lim)
  ),
  codes AS (
    SELECT 'code:' || c.id::text, c.created_at, 'code'::text, c.kind,
           0, c.member_id, c.shopify_order_id,
           NULL::text, NULL::text, c.code, c.discount_amount_pkr
    FROM public.loyalty_codes c
    WHERE c.kind <> 'reward'
      AND (p_member IS NULL OR c.member_id = p_member)
      AND (p_filter = 'all' OR (p_filter = 'referrals' AND c.kind = 'referral_friend'))
    ORDER BY c.created_at DESC
    LIMIT (SELECT n FROM lim)
  ),
  tiers AS (
    SELECT 'tier:' || t.id::text, t.created_at, 'tier'::text, t.to_tier,
           0, t.member_id, t.shopify_order_id,
           t.from_tier, NULL::text, NULL::text, NULL::integer
    FROM public.tier_history t
    WHERE p_filter = 'all' AND (p_member IS NULL OR t.member_id = p_member)
    ORDER BY t.created_at DESC
    LIMIT (SELECT n FROM lim)
  ),
  pend AS (
    SELECT 'pending:' || o.shopify_order_id, COALESCE(o.placed_at, o.created_at), 'pending'::text,
           'purchase'::text, o.pending_points, mm.id, o.shopify_order_id,
           NULL::text, NULL::text, NULL::text, NULL::integer
    FROM public.order_webhook_state o
    JOIN public.members mm ON mm.shopify_customer_id = o.shopify_customer_id
    WHERE p_member IS NOT NULL AND mm.id = p_member
      AND p_filter IN ('all', 'earned')
      AND o.cancelled_at IS NULL AND NOT o.points_awarded AND o.pending_points > 0
  ),
  u AS (
    SELECT * FROM led UNION ALL SELECT * FROM codes
    UNION ALL SELECT * FROM tiers UNION ALL SELECT * FROM pend
  )
  SELECT u.id, u.at, u.kind, u.action, u.points, u.member_id,
         public.admin_member_name(m.first_name, m.last_name, m.email, m.phone),
         u.order_id, o.order_name, u.reason_note, u.customer_note, u.code, u.discount_pkr
  FROM u
  JOIN public.members m ON m.id = u.member_id
  LEFT JOIN public.order_webhook_state o ON o.shopify_order_id = u.order_id
  ORDER BY u.at DESC, u.id
  LIMIT LEAST(GREATEST(p_limit, 1), 200) OFFSET GREATEST(p_offset, 0);
$$;

-- ── top earners / redeemers in a period ──────────────────────────────────────

CREATE OR REPLACE FUNCTION public.admin_top_members(
  p_from timestamptz, p_to timestamptz, p_kind text DEFAULT 'earned', p_limit integer DEFAULT 10
) RETURNS TABLE(member_id uuid, name text, email text, points bigint)
LANGUAGE sql STABLE AS $$
  WITH agg AS (
    SELECT l.member_id,
      CASE WHEN p_kind = 'redeemed' THEN
        GREATEST(
          COALESCE(SUM(-l.points) FILTER (WHERE l.action_type = 'redemption'), 0)
          - COALESCE(SUM(l.points) FILTER (WHERE l.action_type = 'redemption_return'), 0), 0)
      ELSE
        COALESCE(SUM(l.points) FILTER (
          WHERE l.points > 0 AND l.action_type NOT IN ('import', 'redemption_return')), 0)
      END AS pts
    FROM public.points_ledger l
    WHERE l.earned_at >= p_from AND l.earned_at < p_to
    GROUP BY l.member_id
  )
  SELECT m.id, public.admin_member_name(m.first_name, m.last_name, m.email, m.phone),
         m.email, agg.pts::bigint
  FROM agg JOIN public.members m ON m.id = agg.member_id
  WHERE agg.pts > 0
  ORDER BY agg.pts DESC, m.id
  LIMIT LEAST(GREATEST(p_limit, 1), 100);
$$;

-- ── referral funnel ──────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.admin_referral_funnel(
  p_from timestamptz DEFAULT NULL, p_to timestamptz DEFAULT NULL
) RETURNS jsonb
LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_object(
    'recorded',   COUNT(*),
    'with_order', COUNT(*) FILTER (WHERE r.shopify_order_id IS NOT NULL),
    'completed',  COUNT(*) FILTER (WHERE r.status = 'completed'),
    'pending',    COUNT(*) FILTER (WHERE r.status = 'pending'),
    'flagged',    COUNT(*) FILTER (WHERE r.status = 'flagged'),
    'blocked',    COUNT(*) FILTER (WHERE r.status = 'blocked'),
    'rejected',   COUNT(*) FILTER (WHERE r.status = 'rejected'),
    'points_paid', COALESCE(SUM(r.reward_points) FILTER (WHERE r.status = 'completed'), 0)
  )
  FROM public.referrals r
  WHERE (p_from IS NULL OR r.created_at >= p_from)
    AND (p_to IS NULL OR r.created_at < p_to);
$$;

-- ── influencers: one row per influencer ──────────────────────────────────────
-- Orders and sales = distinct orders that came through her link (the referral's
-- qualifying order) or her discount code (order_webhook_state.influencer_member_id),
-- cancelled orders excluded. Points paid is net of reversals.

CREATE OR REPLACE FUNCTION public.admin_influencer_stats(
  p_from timestamptz DEFAULT NULL, p_to timestamptz DEFAULT NULL
) RETURNS TABLE(member_id uuid, friends bigint, completed bigint, pending bigint, held bigint,
                orders bigint, sales_pkr numeric, code_orders bigint, points_paid bigint)
LANGUAGE sql STABLE AS $$
  WITH inf AS (SELECT id FROM public.members WHERE is_influencer),
  refs AS (
    SELECT r.referrer_member_id AS member_id,
           COUNT(*) AS friends,
           COUNT(*) FILTER (WHERE r.status = 'completed') AS completed,
           COUNT(*) FILTER (WHERE r.status = 'pending') AS pending,
           COUNT(*) FILTER (WHERE r.status = 'flagged') AS held
    FROM public.referrals r
    WHERE r.referrer_member_id IN (SELECT id FROM inf)
      AND (p_from IS NULL OR r.created_at >= p_from)
      AND (p_to IS NULL OR r.created_at < p_to)
    GROUP BY 1
  ),
  ord AS (
    SELECT DISTINCT x.member_id, x.shopify_order_id, x.total, x.via_code
    FROM (
      SELECT r.referrer_member_id AS member_id, o.shopify_order_id,
             COALESCE(o.order_total_pkr, 0) AS total, false AS via_code,
             COALESCE(o.placed_at, o.created_at) AS at, o.cancelled_at
      FROM public.referrals r
      JOIN public.order_webhook_state o ON o.shopify_order_id = r.shopify_order_id
      WHERE r.referrer_member_id IN (SELECT id FROM inf)
        AND r.status = 'completed'
        AND o.influencer_member_id IS DISTINCT FROM r.referrer_member_id
      UNION ALL
      SELECT o.influencer_member_id, o.shopify_order_id,
             COALESCE(o.order_total_pkr, 0), true,
             COALESCE(o.placed_at, o.created_at), o.cancelled_at
      FROM public.order_webhook_state o
      WHERE o.influencer_member_id IN (SELECT id FROM inf)
    ) x
    WHERE x.cancelled_at IS NULL
      AND (p_from IS NULL OR x.at >= p_from)
      AND (p_to IS NULL OR x.at < p_to)
  ),
  osum AS (
    SELECT member_id, COUNT(*) AS orders, SUM(total) AS sales,
           COUNT(*) FILTER (WHERE via_code) AS code_orders
    FROM ord GROUP BY 1
  ),
  paid AS (
    SELECT l.member_id, SUM(l.points) AS pts
    FROM public.points_ledger l
    WHERE l.member_id IN (SELECT id FROM inf)
      AND l.action_type IN ('referral_earned', 'referral_bonus', 'influencer_sale', 'referral_reversal')
      AND (p_from IS NULL OR l.earned_at >= p_from)
      AND (p_to IS NULL OR l.earned_at < p_to)
    GROUP BY 1
  )
  SELECT inf.id,
         COALESCE(refs.friends, 0), COALESCE(refs.completed, 0),
         COALESCE(refs.pending, 0), COALESCE(refs.held, 0),
         COALESCE(osum.orders, 0), COALESCE(osum.sales, 0), COALESCE(osum.code_orders, 0),
         GREATEST(COALESCE(paid.pts, 0), 0)::bigint
  FROM inf
  LEFT JOIN refs ON refs.member_id = inf.id
  LEFT JOIN osum ON osum.member_id = inf.id
  LEFT JOIN paid ON paid.member_id = inf.id;
$$;

-- ── campaign results: orders placed under each campaign ──────────────────────

CREATE OR REPLACE FUNCTION public.admin_campaign_results()
RETURNS TABLE(campaign_id uuid, orders bigint, sales_pkr numeric,
              points_issued bigint, points_pending bigint)
LANGUAGE sql STABLE AS $$
  SELECT o.campaign_id,
         COUNT(*),
         COALESCE(SUM(o.order_total_pkr), 0),
         COALESCE(SUM(GREATEST(o.points_awarded_amount - o.points_reversed_amount, 0)), 0)::bigint,
         COALESCE(SUM(o.pending_points) FILTER (WHERE NOT o.points_awarded), 0)::bigint
  FROM public.order_webhook_state o
  WHERE o.campaign_id IS NOT NULL AND o.cancelled_at IS NULL
  GROUP BY o.campaign_id;
$$;

-- ── outstanding points (liability) ───────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.admin_outstanding_points()
RETURNS jsonb
LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_object(
    'points',  COALESCE(SUM(points_balance), 0),
    'members', COUNT(*) FILTER (WHERE points_balance > 0)
  )
  FROM public.members;
$$;

-- ── one customer's counters for the profile page ─────────────────────────────

CREATE OR REPLACE FUNCTION public.admin_member_summary(p_member uuid)
RETURNS jsonb
LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_object(
    'pending_points', (
      SELECT COALESCE(SUM(o.pending_points), 0)
      FROM public.order_webhook_state o
      WHERE o.shopify_customer_id = m.shopify_customer_id
        AND o.cancelled_at IS NULL AND NOT o.points_awarded AND o.pending_points > 0),
    'referrals_completed', (SELECT COUNT(*) FROM public.referrals r
                             WHERE r.referrer_member_id = m.id AND r.status = 'completed'),
    'referrals_pending',   (SELECT COUNT(*) FROM public.referrals r
                             WHERE r.referrer_member_id = m.id AND r.status = 'pending'),
    'referrals_held',      (SELECT COUNT(*) FROM public.referrals r
                             WHERE r.referrer_member_id = m.id AND r.status = 'flagged'),
    'next_expiry', (
      SELECT jsonb_build_object('points', COALESCE(l.points_remaining, l.points), 'at', l.expires_at)
      FROM public.points_ledger l
      WHERE l.member_id = m.id AND l.points > 0 AND NOT l.expired
        AND COALESCE(l.points_remaining, l.points) > 0
        AND l.expires_at IS NOT NULL AND l.expires_at >= now()
      ORDER BY l.expires_at LIMIT 1)
  )
  FROM public.members m
  WHERE m.id = p_member;
$$;

-- ── access: these are for the server (service key) only ──────────────────────

DO $$
DECLARE
  fn text;
BEGIN
  FOR fn IN
    SELECT p.oid::regprocedure::text
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname LIKE 'admin\_%'
  LOOP
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
