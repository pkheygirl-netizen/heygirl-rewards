-- Checks for 011_admin_stats.sql against a real Postgres with 001-011 applied.
-- Run: psql -v ON_ERROR_STOP=1 -d <scratch db> -f supabase/tests/011_admin_stats.pgtest.sql
-- Every check raises on failure; the last line printed is "011 checks passed".
-- Everything runs in one transaction and is rolled back.
--
-- Deterministic ledger order: inside one transaction now() never moves, so every
-- ledger row would get the same earned_at and the engine's "oldest first" rule
-- (ORDER BY earned_at, id) would fall back to the random row id. pg_temp.aged()
-- is called after each award and pushes all earlier rows one minute further
-- back, so each row has its own earned_at in the order it was written.
BEGIN;

CREATE FUNCTION pg_temp.aged() RETURNS void LANGUAGE sql AS $$
  UPDATE public.points_ledger SET earned_at = earned_at - interval '1 minute';
$$;

INSERT INTO members (id, shopify_customer_id, email, phone, first_name, last_name, referral_slug, tier, lifetime_spend_pkr, is_influencer, enrolled_at) VALUES
 ('00000000-0000-0000-0000-000000000001','C1','a(b)@x.com','+923001234567','Sara','Khan','sara','silver',46000,false, now()-interval '3 days'),
 ('00000000-0000-0000-0000-000000000002','C2',NULL,'03219876543',NULL,NULL,'p2','gold',60000,true, now()-interval '40 days'),
 ('00000000-0000-0000-0000-000000000003','C3','=cmd@x.com',NULL,'=Evil','%_','p3','diamond',200000,false, now()-interval '100 days'),
 ('00000000-0000-0000-0000-000000000004','C4','hira2@x.com','03451112222','Hira','Two','p4','gold',70000,true, now()-interval '100 days');

INSERT INTO referrals (id, referrer_member_id, referred_shopify_customer_id, referred_email, status, shopify_order_id, reward_points, fraud_flags, created_at, completed_at) VALUES
 ('00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-000000000002','C8','f8@x.com','completed','O5',12000,'{}', now()-interval '50 days', now()-interval '2 days'),
 ('00000000-0000-0000-0000-0000000000a2','00000000-0000-0000-0000-000000000002','C7','f7@x.com','flagged',NULL,NULL,'{same_network}', now()-interval '1 day', NULL),
 ('00000000-0000-0000-0000-0000000000a3','00000000-0000-0000-0000-000000000001','C6','f6@x.com','pending',NULL,NULL,'{}', now()-interval '1 day', NULL),
 -- paid, then the friend's order was refunded: the engine reverses it and marks it rejected
 ('00000000-0000-0000-0000-0000000000a4','00000000-0000-0000-0000-000000000002','C5','f5@x.com','rejected','O7',12000,'{}', now()-interval '3 days', now()-interval '3 days'),
 -- an ordinary member's link referral whose order ALSO used influencer 4's code
 ('00000000-0000-0000-0000-0000000000a5','00000000-0000-0000-0000-000000000001','C10','f10@x.com','completed','O6',6000,'{}', now()-interval '2 days', now()-interval '1 day');

SELECT * FROM award_points('00000000-0000-0000-0000-000000000001','signup','C1',1000);                                   SELECT pg_temp.aged();
SELECT * FROM award_points('00000000-0000-0000-0000-000000000001','import','imp',5000, now()+interval '10 days');        SELECT pg_temp.aged();
SELECT * FROM award_points('00000000-0000-0000-0000-000000000001','redemption','r1',-3000);                              SELECT pg_temp.aged();
SELECT * FROM award_points('00000000-0000-0000-0000-000000000001','redemption','r2',-1000);                              SELECT pg_temp.aged();
SELECT * FROM award_points('00000000-0000-0000-0000-000000000001','redemption_return','r2',1000);                        SELECT pg_temp.aged();
SELECT * FROM award_points('00000000-0000-0000-0000-000000000001','adjustment','adj1',200, NULL, NULL, 'internal', NULL, 'for you'); SELECT pg_temp.aged();
SELECT * FROM award_points('00000000-0000-0000-0000-000000000001','referral_earned','00000000-0000-0000-0000-0000000000a5',6000); SELECT pg_temp.aged();
SELECT * FROM award_points('00000000-0000-0000-0000-000000000002','referral_earned','00000000-0000-0000-0000-0000000000a1',12000); SELECT pg_temp.aged();
SELECT * FROM award_points('00000000-0000-0000-0000-000000000002','referral_earned','00000000-0000-0000-0000-0000000000a4',12000); SELECT pg_temp.aged();
SELECT * FROM award_points('00000000-0000-0000-0000-000000000002','referral_reversal','00000000-0000-0000-0000-0000000000a4',-12000); SELECT pg_temp.aged();

-- a cancelled code two days ago with no redemption that day: that day's "redeemed" is negative
UPDATE points_ledger SET earned_at = now() - interval '2 days' WHERE action_type = 'redemption_return';

-- a Silver row whose expiry date passed last night and which the nightly job has not processed yet
INSERT INTO points_ledger (member_id, points, action_type, reference_id, balance_after, earned_at, expires_at, expired, points_remaining)
SELECT '00000000-0000-0000-0000-000000000001', 700, 'campaign_bonus', 'overdue-1', points_balance + 700,
       now() - interval '5 days', now() - interval '6 hours', false, 700
  FROM members WHERE id = '00000000-0000-0000-0000-000000000001';
UPDATE members SET points_balance = points_balance + 700 WHERE id = '00000000-0000-0000-0000-000000000001';

INSERT INTO loyalty_codes (member_id, code, discount_amount, discount_amount_pkr, points_spent, expires_at, kind, status, shopify_order_id) VALUES
 ('00000000-0000-0000-0000-000000000001','REWARD-1',100,100,3000, now()+interval '30 days','reward','used','O1'),
 ('00000000-0000-0000-0000-000000000001','REWARD-2',100,100,1000, now()+interval '30 days','reward','cancelled',NULL),
 ('00000000-0000-0000-0000-000000000001','BDAY-1',250,250,0, now()+interval '30 days','birthday','active',NULL),
 ('00000000-0000-0000-0000-000000000001','FREESHIP-1',0,0,0, now()+interval '30 days','tier_gold','active',NULL);

INSERT INTO bonus_campaigns (id, name, multiplier, starts_at, ends_at, is_active) VALUES
 ('00000000-0000-0000-0000-0000000000c1','Eid',2.0, now()-interval '5 days', now()+interval '5 days', true),
 ('00000000-0000-0000-0000-0000000000c2','Future',1.5, now()+interval '10 days', now()+interval '12 days', true),
 ('00000000-0000-0000-0000-0000000000c3','Long ago',1.5, now()-interval '90 days', now()-interval '80 days', false);

INSERT INTO order_webhook_state (shopify_order_id, shopify_customer_id, order_name, order_total_pkr, placed_at, points_awarded, pending_points, points_awarded_amount, discount_codes, influencer_member_id, campaign_id, cancelled_at) VALUES
 ('O1','C1','#1001',4000, now()-interval '1 day', true, 0, 3900, '{}', NULL, '00000000-0000-0000-0000-0000000000c1', NULL),
 ('O2','C1','#1002',2500, now()-interval '1 day', false, 2500, 0, '{}', NULL, '00000000-0000-0000-0000-0000000000c1', NULL),
 ('O3','C9','#1003',9000, now()-interval '2 days', true, 0, 9000, '{HEYSANA}', '00000000-0000-0000-0000-000000000002', NULL, NULL),
 ('O4','C9','#1004',7000, now()-interval '2 days', false, 700, 0, '{HEYSANA}', '00000000-0000-0000-0000-000000000002', NULL, now()),
 ('O5','C8','#1005',3000, now()-interval '2 days', true, 0, 3000, '{}', NULL, NULL, NULL),
 ('O6','C10','#1006',5000, now()-interval '1 day', true, 0, 5000, '{HIRA10}', '00000000-0000-0000-0000-000000000004', NULL, NULL),
 ('O7','C5','#1007',8000, now()-interval '3 days', true, 0, 8000, '{}', NULL, NULL, NULL);

INSERT INTO review_claims (member_id, shopify_order_id, points, release_at) VALUES ('00000000-0000-0000-0000-000000000001','O1',3000, now()+interval '2 days');
INSERT INTO tier_history (member_id, from_tier, to_tier) VALUES ('00000000-0000-0000-0000-000000000002','silver','gold');
INSERT INTO gdpr_requests (type, shopify_customer_id) VALUES ('data_request','C1');

DO $$
DECLARE s jsonb; p jsonb; n bigint; r record;
BEGIN
  -- ── period totals ──
  s := admin_period_stats(now()-interval '7 days', now()+interval '1 minute');
  ASSERT (s->>'members_new')::int = 1 AND (s->>'members_total')::int = 4, 'members ' || s::text;
  -- earned: signup 1000 + adjustment 200 + bonus 700 + referrals 6000 + 12000 + 12000; import and the returned code are not earnings
  ASSERT (s->>'points_earned')::int = 31900, 'earned excludes import and returns ' || s::text;
  ASSERT (s->>'points_redeemed')::int = 3000, 'redeemed is net of returns ' || s::text;
  ASSERT (s->>'points_reversed')::int = 12000, 'reversed ' || s::text;
  ASSERT (s->>'redemptions')::int = 2, 'only reward codes count (R8) ' || s::text;
  ASSERT (s->>'points_pending')::int = 2500, 'pending excludes cancelled ' || s::text;
  ASSERT (s->>'reward_orders')::int = 1 AND (s->>'reward_sales_pkr')::numeric = 4000
     AND (s->>'reward_cost_pkr')::numeric = 100, 'reward sales ' || s::text;
  p := admin_period_stats(now()-interval '60 days', now()-interval '30 days');
  ASSERT (p->>'members_new')::int = 1 AND (p->>'members_total')::int = 3, 'previous period ' || p::text;

  -- ── daily series: zero-filled, and it adds up to the period total (A9) ──
  SELECT count(*) INTO n FROM admin_points_series(now()-interval '6 days', now()+interval '1 minute');
  ASSERT n IN (7, 8), 'series is zero-filled per Karachi day: ' || n;
  SELECT sum(earned) AS e, sum(redeemed) AS d, min(redeemed) AS lowest INTO r
    FROM admin_points_series(now()-interval '7 days', now()+interval '1 minute');
  ASSERT r.e = (s->>'points_earned')::int, 'series earned = period earned';
  ASSERT r.d = (s->>'points_redeemed')::int, 'series redeemed = period redeemed, got ' || r.d;
  ASSERT r.lowest = -1000, 'a day with only a cancelled code is negative, not clamped: ' || r.lowest;

  s := admin_tier_counts();
  ASSERT (s->>'silver')::int = 1 AND (s->>'gold')::int = 2 AND (s->>'diamond')::int = 1, 'tiers ' || s::text;
  ASSERT (s->>'near_gold')::int = 1, 'near gold ' || s::text;

  -- ── attention: overdue rows still count, as "expiring now" (A9) ──
  s := admin_attention(30);
  ASSERT (s->>'referrals_flagged')::int = 1 AND (s->>'review_claims_pending')::int = 1
     AND (s->>'gdpr_open')::int = 1, 'attention ' || s::text;
  ASSERT (s->>'expiring_members')::int = 1 AND (s->>'expiring_overdue_members')::int = 1, 'overdue member counted ' || s::text;
  -- FIFO spent the signup 1000 then 3000 of the import: 2000 of the import left, plus the overdue 700
  ASSERT (s->>'expiring_points')::int = 2700, 'expiring uses points_remaining after FIFO spend ' || s::text;
  SELECT * INTO r FROM admin_expiring_members(30, 10, 0);
  ASSERT r.points = 2700 AND r.total_count = 1 AND r.name = 'Sara Khan' AND r.first_expiry < now(), 'expiring list starts with the overdue row';

  -- ── search: plain text, and phone only for phone-like text (A4) ──
  SELECT count(*) INTO n FROM admin_search_members('a(b)');   ASSERT n = 1, 'search with brackets';
  SELECT count(*) INTO n FROM admin_search_members('%');      ASSERT n = 1, 'percent is literal';
  SELECT count(*) INTO n FROM admin_search_members('sara kh'); ASSERT n = 1, 'full name';
  SELECT count(*) INTO n FROM admin_search_members('0300 1234567'); ASSERT n = 1, 'local phone finds +92 number';
  SELECT count(*) INTO n FROM admin_search_members('+92 300-1234567'); ASSERT n = 1, 'international format';
  SELECT count(*) INTO n FROM admin_search_members('9876'); ASSERT n = 1, 'phone fragment';
  SELECT count(*) INTO n FROM admin_search_members('0000'); ASSERT n = 0, '"0000" must not match everyone, got ' || n;
  SELECT count(*) INTO n FROM admin_search_members('000'); ASSERT n = 0, 'zeros only';
  SELECT count(*) INTO n FROM admin_search_members('123'); ASSERT n = 0, 'fewer than 4 digits is not a phone search';
  SELECT count(*) INTO n FROM admin_search_members('hira2'); ASSERT n = 1, 'letters with a digit search name/email only';
  SELECT count(*) INTO n FROM admin_search_members('x1112222'); ASSERT n = 0, 'text with letters never matches by phone';
  SELECT count(*) INTO n FROM admin_search_members('1112222@'); ASSERT n = 0, 'text with @ never matches by phone';
  SELECT count(*) INTO n FROM admin_search_members(NULL, 'gold'); ASSERT n = 2, 'tier filter';
  SELECT count(*) INTO n FROM admin_search_members(NULL, NULL, true); ASSERT n = 2, 'has points';
  SELECT count(*) INTO n FROM admin_search_members(NULL, NULL, NULL, NULL, NULL, true); ASSERT n = 2, 'influencer';
  SELECT * INTO r FROM admin_search_members(NULL, NULL, NULL, NULL, NULL, NULL, 'points', true, 1, 0);
  ASSERT r.shopify_customer_id = 'C2' AND r.total_count = 4 AND r.name = '03219876543', 'sort by points, phone-only name';
  SELECT * INTO r FROM admin_search_members(NULL, NULL, NULL, NULL, NULL, NULL, 'spend', false, 1, 1);
  ASSERT r.shopify_customer_id = 'C2', 'sort asc with offset';

  -- ── activity ──
  SELECT count(*) INTO n FROM admin_activity('all', NULL, 50, 0);
  ASSERT n = 14, 'activity: 11 ledger + 2 automatic codes + 1 tier change, got ' || n;
  SELECT count(*) INTO n FROM admin_activity('all', '00000000-0000-0000-0000-000000000001', 50, 0);
  ASSERT n = 11, 'profile timeline: 8 ledger + 2 codes + the pending order, got ' || n;
  SELECT count(*) INTO n FROM admin_activity('redeemed', NULL, 50, 0); ASSERT n = 3, 'redeemed filter';
  SELECT count(*) INTO n FROM admin_activity('adjustments', NULL, 50, 0); ASSERT n = 1, 'adjustments filter';
  SELECT count(*) INTO n FROM admin_activity('referrals', NULL, 50, 0); ASSERT n = 4, 'referrals filter, got ' || n;
  SELECT count(*) INTO n FROM admin_activity('all', NULL, 3, 12); ASSERT n = 2, 'paging';
  SELECT * INTO r FROM admin_activity('all', '00000000-0000-0000-0000-000000000001', 50, 0) WHERE kind = 'pending';
  ASSERT r.points = 2500 AND r.order_name = '#1002', 'pending row';

  SELECT * INTO r FROM admin_top_members(now()-interval '7 days', now()+interval '1 minute', 'earned', 1);
  ASSERT r.points = 24000, 'top earner';
  SELECT * INTO r FROM admin_top_members(now()-interval '7 days', now()+interval '1 minute', 'redeemed', 5);
  ASSERT r.points = 3000 AND r.name = 'Sara Khan', 'top redeemer';

  -- ── referral funnel: points paid is net of reversals (A9) ──
  s := admin_referral_funnel();
  ASSERT (s->>'recorded')::int = 5 AND (s->>'with_order')::int = 3 AND (s->>'completed')::int = 2
     AND (s->>'flagged')::int = 1 AND (s->>'rejected')::int = 1, 'funnel ' || s::text;
  ASSERT (s->>'points_paid')::int = 18000, 'paid 12000 + 6000; the reversed 12000 nets to zero: ' || s::text;

  -- ── influencers (A9) ──
  SELECT * INTO r FROM admin_influencer_stats() WHERE member_id = '00000000-0000-0000-0000-000000000002';
  ASSERT r.friends = 3 AND r.completed = 1 AND r.held = 1, 'influencer referrals';
  ASSERT r.orders = 2 AND r.sales_pkr = 12000 AND r.code_orders = 1, 'her link order + her code order; cancelled and reversed excluded: ' || r.orders || ' ' || r.sales_pkr;
  ASSERT r.points_paid = 12000, 'influencer points are net of the reversal: ' || r.points_paid;
  -- O6 completed member 1's link referral, so influencer 4's code does not also count it
  SELECT * INTO r FROM admin_influencer_stats() WHERE member_id = '00000000-0000-0000-0000-000000000004';
  ASSERT r.orders = 0 AND r.code_orders = 0 AND r.sales_pkr = 0, 'link referral wins over another influencer''s code: ' || r.orders;
  -- period basis: referral a1 was recorded 50 days ago but completed 2 days ago
  SELECT * INTO r FROM admin_influencer_stats(now()-interval '7 days', now()+interval '1 minute') WHERE member_id = '00000000-0000-0000-0000-000000000002';
  ASSERT r.friends = 2, 'friends by sign-in date: ' || r.friends;
  ASSERT r.completed = 1, 'completed by completion date: ' || r.completed;
  ASSERT r.orders = 2 AND r.points_paid = 12000, 'orders by order date, points by date paid';
  SELECT * INTO r FROM admin_influencer_stats(now()-interval '60 days', now()-interval '30 days') WHERE member_id = '00000000-0000-0000-0000-000000000002';
  ASSERT r.friends = 1 AND r.completed = 0 AND r.orders = 0 AND r.points_paid = 0, 'earlier period: only the sign-in falls in it';

  SELECT * INTO r FROM admin_campaign_results();
  ASSERT r.orders = 2 AND r.sales_pkr = 6500 AND r.points_issued = 3900 AND r.points_pending = 2500, 'campaign results';

  s := admin_outstanding_points();
  ASSERT (s->>'points')::int = 21900 AND (s->>'members')::int = 2, 'outstanding ' || s::text;

  s := admin_member_summary('00000000-0000-0000-0000-000000000001');
  ASSERT (s->>'pending_points')::int = 2500 AND (s->>'referrals_pending')::int = 1, 'member summary ' || s::text;
  ASSERT (s->'next_expiry'->>'points')::int = 700 AND (s->'next_expiry'->>'at')::timestamptz < now(), 'next expiry is the overdue row ' || s::text;
  ASSERT admin_member_summary('00000000-0000-0000-0000-00000000dead') IS NULL, 'unknown member';

  -- ── campaigns: atomic save (A2) and switch-off rule (A3) ──
  -- 1. overlap without confirmation: told which campaign, nothing changed
  s := admin_save_campaign(NULL, 'Flash', 3.0, now()-interval '1 hour', now()+interval '1 day', true, false);
  ASSERT (s->>'ok')::boolean = false AND s->'conflicts'->0->>'name' = 'Eid', 'conflict reported ' || s::text;
  SELECT count(*) INTO n FROM bonus_campaigns; ASSERT n = 3, 'nothing inserted on conflict';
  SELECT * INTO r FROM bonus_campaigns WHERE name = 'Eid';
  ASSERT r.is_active AND r.ends_at > now() AND r.deactivated_at IS NULL, 'Eid untouched on conflict';

  -- 2. confirmed: Eid ends now (not just is_active=false), Future is left alone, Flash is saved
  s := admin_save_campaign(NULL, 'Flash', 3.0, now()-interval '1 hour', now()+interval '1 day', true, true);
  ASSERT (s->>'ok')::boolean AND s->'switched_off' = '["Eid"]'::jsonb, 'replace ' || s::text;
  SELECT * INTO r FROM bonus_campaigns WHERE name = 'Eid';
  ASSERT NOT r.is_active AND r.ends_at = now() AND r.deactivated_at = now() AND r.starts_at = now()-interval '5 days',
    'a running campaign that is switched off ends now';
  -- rule 2 as the engine reads it: an order placed an hour ago is inside Eid's dates and before deactivated_at
  SELECT count(*) INTO n FROM bonus_campaigns
   WHERE name = 'Eid' AND starts_at <= now()-interval '1 hour' AND ends_at >= now()-interval '1 hour'
     AND deactivated_at > now()-interval '1 hour';
  ASSERT n = 1, 'orders placed during Eid still find it';
  SELECT * INTO r FROM bonus_campaigns WHERE name = 'Future';
  ASSERT r.is_active AND r.ends_at = now()+interval '12 days', 'a campaign that does not overlap is never touched';
  SELECT count(*) INTO n FROM bonus_campaigns WHERE name = 'Flash' AND is_active; ASSERT n = 1, 'Flash saved';

  -- 3. a failure after the switch-off undoes the switch-off too (one transaction)
  BEGIN
    PERFORM admin_save_campaign(NULL, NULL, 2.0, now()+interval '11 days', now()+interval '13 days', true, true);
    ASSERT false, 'a null name must fail';
  EXCEPTION WHEN not_null_violation THEN NULL;
  END;
  SELECT * INTO r FROM bonus_campaigns WHERE name = 'Future';
  ASSERT r.is_active AND r.deactivated_at IS NULL, 'Future is still on after the failed save: nothing was half-done';

  -- 4. switching off a campaign that has not started keeps its dates; it can be switched on again
  s := admin_set_campaign_active('00000000-0000-0000-0000-0000000000c2', false);
  SELECT * INTO r FROM bonus_campaigns WHERE name = 'Future';
  ASSERT (s->>'ok')::boolean AND NOT r.is_active AND r.starts_at = now()+interval '10 days' AND r.ends_at = now()+interval '12 days',
    'a scheduled campaign is not shortened';
  s := admin_set_campaign_active('00000000-0000-0000-0000-0000000000c2', true);
  SELECT * INTO r FROM bonus_campaigns WHERE name = 'Future';
  ASSERT (s->>'ok')::boolean AND r.is_active AND r.deactivated_at IS NULL, 'switched on again';

  -- 5. switching on is refused while it overlaps, for an ended campaign, and for an unknown id
  INSERT INTO bonus_campaigns (id, name, multiplier, starts_at, ends_at, is_active)
    VALUES ('00000000-0000-0000-0000-0000000000c4','Clash',2.0, now()+interval '11 days', now()+interval '11 days 5 hours', false);
  s := admin_set_campaign_active('00000000-0000-0000-0000-0000000000c4', true);
  ASSERT (s->>'ok')::boolean = false AND s->'conflicts'->0->>'name' = 'Future', 'switch-on conflict ' || s::text;
  s := admin_set_campaign_active('00000000-0000-0000-0000-0000000000c3', true);
  ASSERT s->>'error' = 'ended', 'ended campaign ' || s::text;
  s := admin_set_campaign_active('00000000-0000-0000-0000-00000000dead', true);
  ASSERT s->>'error' = 'not_found', 'unknown campaign ' || s::text;
  s := admin_save_campaign('00000000-0000-0000-0000-00000000dead', 'x', 2.0, now(), now()+interval '1 day', false, false);
  ASSERT s->>'error' = 'not_found', 'unknown campaign on save ' || s::text;

  -- 6. un-ticking "switched on" in the edit form of a running campaign also ends it now
  s := admin_save_campaign((SELECT id FROM bonus_campaigns WHERE name = 'Flash'), 'Flash', 3.0, now()-interval '1 hour', now()+interval '1 day', false, false);
  SELECT * INTO r FROM bonus_campaigns WHERE name = 'Flash';
  ASSERT (s->>'ok')::boolean AND NOT r.is_active AND r.ends_at = now() AND r.deactivated_at = now(), 'edit-form switch-off ends it now';

  -- 7. editing a campaign that stays on keeps its dates as typed
  s := admin_save_campaign('00000000-0000-0000-0000-0000000000c2', 'Future 2', 2.5, now()+interval '10 days', now()+interval '14 days', true, false);
  SELECT * INTO r FROM bonus_campaigns WHERE id = '00000000-0000-0000-0000-0000000000c2';
  ASSERT (s->>'ok')::boolean AND r.name = 'Future 2' AND r.multiplier = 2.5 AND r.ends_at = now()+interval '14 days', 'plain edit';
END $$;

ROLLBACK;
\echo 011 checks passed
