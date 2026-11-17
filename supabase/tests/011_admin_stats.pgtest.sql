-- Checks for 011_admin_stats.sql against a real Postgres with 001-011 applied.
-- Run: psql -v ON_ERROR_STOP=1 -d <scratch db> -f supabase/tests/011_admin_stats.pgtest.sql
-- Every check raises on failure; the last line printed is "011 checks passed".
BEGIN;

INSERT INTO members (id, shopify_customer_id, email, phone, first_name, last_name, referral_slug, tier, lifetime_spend_pkr, is_influencer, enrolled_at) VALUES
 ('00000000-0000-0000-0000-000000000001','C1','a(b)@x.com','+923001234567','Sara','Khan','sara','silver',46000,false, now()-interval '3 days'),
 ('00000000-0000-0000-0000-000000000002','C2',NULL,'03219876543',NULL,NULL,'p2','gold',60000,true, now()-interval '40 days'),
 ('00000000-0000-0000-0000-000000000003','C3','=cmd@x.com',NULL,'=Evil','%_','p3','diamond',200000,false, now()-interval '100 days');

SELECT * FROM award_points('00000000-0000-0000-0000-000000000001','signup','C1',1000);
SELECT * FROM award_points('00000000-0000-0000-0000-000000000001','import','imp',5000, now()+interval '10 days');
SELECT * FROM award_points('00000000-0000-0000-0000-000000000001','redemption','r1',-3000);
SELECT * FROM award_points('00000000-0000-0000-0000-000000000001','redemption','r2',-1000);
SELECT * FROM award_points('00000000-0000-0000-0000-000000000001','redemption_return','r2',1000);
SELECT * FROM award_points('00000000-0000-0000-0000-000000000001','adjustment','adj1',200, NULL, NULL, 'internal', NULL, 'for you');
SELECT * FROM award_points('00000000-0000-0000-0000-000000000002','referral_earned','ref1',12000);

INSERT INTO loyalty_codes (member_id, code, discount_amount, discount_amount_pkr, points_spent, expires_at, kind, status, shopify_order_id) VALUES
 ('00000000-0000-0000-0000-000000000001','REWARD-1',100,100,3000, now()+interval '30 days','reward','used','O1'),
 ('00000000-0000-0000-0000-000000000001','REWARD-2',100,100,1000, now()+interval '30 days','reward','cancelled',NULL),
 ('00000000-0000-0000-0000-000000000001','BDAY-1',250,250,0, now()+interval '30 days','birthday','active',NULL),
 ('00000000-0000-0000-0000-000000000001','FREESHIP-1',0,0,0, now()+interval '30 days','tier_gold','active',NULL);

INSERT INTO bonus_campaigns (id, name, multiplier, starts_at, ends_at, is_active) VALUES
 ('00000000-0000-0000-0000-0000000000c1','Eid',2.0, now()-interval '5 days', now()+interval '5 days', true);

INSERT INTO order_webhook_state (shopify_order_id, shopify_customer_id, order_name, order_total_pkr, placed_at, points_awarded, pending_points, points_awarded_amount, discount_codes, influencer_member_id, campaign_id, cancelled_at) VALUES
 ('O1','C1','#1001',4000, now()-interval '1 day', true, 0, 3900, '{}', NULL, '00000000-0000-0000-0000-0000000000c1', NULL),
 ('O2','C1','#1002',2500, now()-interval '1 day', false, 2500, 0, '{}', NULL, '00000000-0000-0000-0000-0000000000c1', NULL),
 ('O3','C9','#1003',9000, now()-interval '2 days', true, 0, 9000, '{HEYSANA}', '00000000-0000-0000-0000-000000000002', NULL, NULL),
 ('O4','C9','#1004',7000, now()-interval '2 days', false, 700, 0, '{HEYSANA}', '00000000-0000-0000-0000-000000000002', NULL, now()),
 ('O5','C8','#1005',3000, now()-interval '2 days', true, 0, 3000, '{}', NULL, NULL, NULL);

INSERT INTO referrals (referrer_member_id, referred_shopify_customer_id, referred_email, status, shopify_order_id, reward_points, fraud_flags) VALUES
 ('00000000-0000-0000-0000-000000000002','C8','f8@x.com','completed','O5',12000,'{}'),
 ('00000000-0000-0000-0000-000000000002','C7','f7@x.com','flagged',NULL,NULL,'{same_ip}'),
 ('00000000-0000-0000-0000-000000000001','C6','f6@x.com','pending',NULL,NULL,'{}');

INSERT INTO review_claims (member_id, shopify_order_id, points, release_at) VALUES ('00000000-0000-0000-0000-000000000001','O1',3000, now()+interval '2 days');
INSERT INTO tier_history (member_id, from_tier, to_tier) VALUES ('00000000-0000-0000-0000-000000000002','silver','gold');
INSERT INTO gdpr_requests (type, shopify_customer_id) VALUES ('data_request','C1');

DO $$
DECLARE s jsonb; n bigint; r record;
BEGIN
  s := admin_period_stats(now()-interval '7 days', now()+interval '1 minute');
  ASSERT (s->>'members_new')::int = 1, 'members_new ' || s::text;
  ASSERT (s->>'members_total')::int = 3, 'members_total ' || s::text;
  ASSERT (s->>'points_earned')::int = 13200, 'earned excludes import and returns ' || s::text;
  ASSERT (s->>'points_redeemed')::int = 3000, 'redeemed is net of returns ' || s::text;
  ASSERT (s->>'redemptions')::int = 2, 'only reward codes count ' || s::text;
  ASSERT (s->>'points_pending')::int = 2500, 'pending excludes cancelled ' || s::text;
  ASSERT (s->>'reward_orders')::int = 1 AND (s->>'reward_sales_pkr')::numeric = 4000
     AND (s->>'reward_cost_pkr')::numeric = 100, 'reward sales ' || s::text;
  s := admin_period_stats(now()-interval '60 days', now()-interval '30 days');
  ASSERT (s->>'members_new')::int = 1 AND (s->>'members_total')::int = 2, 'previous period ' || s::text;

  SELECT count(*) INTO n FROM admin_points_series(now()-interval '6 days', now()+interval '1 minute');
  ASSERT n IN (7, 8), 'series is zero-filled per Karachi day: ' || n;
  SELECT sum(earned) AS e, sum(redeemed) AS d INTO r FROM admin_points_series(now()-interval '6 days', now()+interval '1 minute');
  ASSERT r.e = 13200 AND r.d = 3000, 'series totals';

  s := admin_tier_counts();
  ASSERT (s->>'silver')::int = 1 AND (s->>'gold')::int = 1 AND (s->>'diamond')::int = 1, 'tiers ' || s::text;
  ASSERT (s->>'near_gold')::int = 1, 'near gold ' || s::text;

  s := admin_attention(30);
  ASSERT (s->>'referrals_flagged')::int = 1 AND (s->>'review_claims_pending')::int = 1
     AND (s->>'expiring_members')::int = 1 AND (s->>'gdpr_open')::int = 1, 'attention ' || s::text;
  ASSERT (s->>'expiring_points')::int = 1000, 'expiring uses points_remaining after FIFO spend ' || s::text;
  SELECT * INTO r FROM admin_expiring_members(30, 10, 0);
  ASSERT r.points = 1000 AND r.total_count = 1 AND r.name = 'Sara Khan', 'expiring list';

  -- search: brackets, percent signs and formula characters are plain text
  SELECT count(*) INTO n FROM admin_search_members('a(b)');   ASSERT n = 1, 'search with brackets';
  SELECT count(*) INTO n FROM admin_search_members('%');      ASSERT n = 1, 'percent is literal';
  SELECT count(*) INTO n FROM admin_search_members('sara kh'); ASSERT n = 1, 'full name';
  SELECT count(*) INTO n FROM admin_search_members('0300 1234567'); ASSERT n = 1, 'local phone finds +92 number';
  SELECT count(*) INTO n FROM admin_search_members('9876'); ASSERT n = 1, 'phone fragment';
  SELECT count(*) INTO n FROM admin_search_members(NULL, 'gold'); ASSERT n = 1, 'tier filter';
  SELECT count(*) INTO n FROM admin_search_members(NULL, NULL, true); ASSERT n = 2, 'has points';
  SELECT count(*) INTO n FROM admin_search_members(NULL, NULL, NULL, NULL, NULL, true); ASSERT n = 1, 'influencer';
  SELECT * INTO r FROM admin_search_members(NULL, NULL, NULL, NULL, NULL, NULL, 'points', true, 1, 0);
  ASSERT r.shopify_customer_id = 'C2' AND r.total_count = 3 AND r.name = '03219876543', 'sort by points, phone-only name';
  SELECT * INTO r FROM admin_search_members(NULL, NULL, NULL, NULL, NULL, NULL, 'spend', false, 1, 1);
  ASSERT r.shopify_customer_id = 'C2', 'sort asc with offset';

  SELECT count(*) INTO n FROM admin_activity('all', NULL, 50, 0);
  ASSERT n = 10, 'activity: 7 ledger + 2 automatic codes + 1 tier change, got ' || n;
  SELECT count(*) INTO n FROM admin_activity('all', '00000000-0000-0000-0000-000000000001', 50, 0);
  ASSERT n = 9, 'profile timeline includes the pending order, got ' || n;
  SELECT count(*) INTO n FROM admin_activity('redeemed', NULL, 50, 0); ASSERT n = 3, 'redeemed filter';
  SELECT count(*) INTO n FROM admin_activity('adjustments', NULL, 50, 0); ASSERT n = 1, 'adjustments filter';
  SELECT count(*) INTO n FROM admin_activity('referrals', NULL, 50, 0); ASSERT n = 1, 'referrals filter';
  SELECT count(*) INTO n FROM admin_activity('all', NULL, 3, 9); ASSERT n = 1, 'paging';
  SELECT * INTO r FROM admin_activity('all', '00000000-0000-0000-0000-000000000001', 50, 0) WHERE kind = 'pending';
  ASSERT r.points = 2500 AND r.order_name = '#1002', 'pending row';

  SELECT * INTO r FROM admin_top_members(now()-interval '7 days', now()+interval '1 minute', 'earned', 1);
  ASSERT r.points = 12000, 'top earner';
  SELECT * INTO r FROM admin_top_members(now()-interval '7 days', now()+interval '1 minute', 'redeemed', 5);
  ASSERT r.points = 3000 AND r.name = 'Sara Khan', 'top redeemer';

  s := admin_referral_funnel();
  ASSERT (s->>'recorded')::int = 3 AND (s->>'with_order')::int = 1 AND (s->>'completed')::int = 1
     AND (s->>'flagged')::int = 1 AND (s->>'points_paid')::int = 12000, 'funnel ' || s::text;

  SELECT * INTO r FROM admin_influencer_stats();
  ASSERT r.friends = 2 AND r.completed = 1 AND r.held = 1, 'influencer referrals';
  ASSERT r.orders = 2 AND r.sales_pkr = 12000 AND r.code_orders = 1, 'link order + code order, cancelled excluded: ' || r.orders || ' ' || r.sales_pkr;
  ASSERT r.points_paid = 12000, 'influencer points';
  SELECT count(*) INTO n FROM admin_influencer_stats(now()-interval '90 days', now()-interval '60 days') WHERE orders > 0;
  ASSERT n = 0, 'influencer period filter';

  SELECT * INTO r FROM admin_campaign_results();
  ASSERT r.orders = 2 AND r.sales_pkr = 6500 AND r.points_issued = 3900 AND r.points_pending = 2500, 'campaign results';

  s := admin_outstanding_points();
  ASSERT (s->>'points')::int = 15200 AND (s->>'members')::int = 2, 'outstanding ' || s::text;

  s := admin_member_summary('00000000-0000-0000-0000-000000000001');
  ASSERT (s->>'pending_points')::int = 2500 AND (s->>'referrals_pending')::int = 1
     AND (s->'next_expiry'->>'points')::int = 1000, 'member summary ' || s::text;
  ASSERT admin_member_summary('00000000-0000-0000-0000-00000000dead') IS NULL, 'unknown member';
END $$;

ROLLBACK;
\echo 011 checks passed
