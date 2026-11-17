// Real-Postgres test for migration 010 (award_points, award_order_points,
// reverse_order_points). It needs two packages that are deliberately NOT
// dependencies of the app, so run it from a scratch folder outside the repo:
//
//   mkdir /tmp/pgtest && cd /tmp/pgtest && npm init -y
//   npm install embedded-postgres pg
//   cp <repo>/supabase/tests/010_v3_core.pgtest.mjs run.mjs
//   node run.mjs <repo>/supabase/migrations
//
// It starts a private Postgres, applies 001-009, writes some pre-v3 data,
// applies 010 twice (to prove it can be re-run), then runs the cases.
// Nothing Supabase-specific had to be stubbed.
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import fs from "node:fs";
import path from "node:path";

const MIG = process.argv[2];
const dataDir = path.join(process.cwd(), "data");
fs.rmSync(dataDir, { recursive: true, force: true });

const server = new EmbeddedPostgres({
  databaseDir: dataDir, user: "postgres", password: "pw", port: 54329,
  persistent: false, createPostgresUser: true, onLog: () => {}, onError: () => {},
});
await server.initialise();
await server.start();
await server.createDatabase("hg");
const conn = { host: "localhost", port: 54329, user: "postgres", password: "pw", database: "hg" };
const db = new pg.Client(conn); await db.connect();
const q = async (sql, params) => (await db.query(sql, params)).rows;

let pass = 0, fail = 0; const failures = [];
function ok(name, cond, extra) {
  if (cond) { pass++; console.log("  PASS", name); }
  else { fail++; failures.push(name); console.log("  FAIL", name, extra !== undefined ? JSON.stringify(extra) : ""); }
}
const eq = (name, a, b) => ok(name, JSON.stringify(a) === JSON.stringify(b), { got: a, want: b });

const files = fs.readdirSync(MIG).filter((f) => f.endsWith(".sql")).sort();
console.log("server:", (await q("select version()"))[0].version);
console.log("migrations:", files.join(", "));

// ── 001-009, then legacy data, then 010 (backfill), then 010 again ──
for (const f of files.filter((f) => f < "010")) {
  await db.query(fs.readFileSync(path.join(MIG, f), "utf8"));
}
console.log("applied 001-009");

// legacy data written the pre-v3 way
const [{ id: legacy }] = await q(`insert into members (shopify_customer_id,email,referral_slug,points_balance,lifetime_spend_pkr,birthday_month,birthday_day)
  values ('L1','legacy@x.com','legacy-1',0,0,3,4) returning id`);
const [{ id: legacyGold }] = await q(`insert into members (shopify_customer_id,email,referral_slug,tier) values ('L2','gold@x.com','legacy-2','gold') returning id`);
await q(`insert into order_webhook_state (shopify_order_id, shopify_customer_id, order_total_pkr) values ('LO1','L1',2000)`);
await q(`select * from award_points($1,'signup','L1',1000,null,null,null,null::numeric)`, [legacy]);
await q(`select * from award_points($1,'purchase','LO1',2000,now()+interval '300 days','LO1',null,2000)`, [legacy]);
await q(`select * from award_points($1,'redemption','code-a',-1500,null,null,null,null::numeric)`, [legacy]);
await q(`select * from award_points($1,'signup','L2',1000,null,null,null,null::numeric)`, [legacyGold]);
// a pre-v3 order that was awarded and then partly refunded before the migration
const [{ id: legacyRefunded }] = await q(`insert into members (shopify_customer_id,email,referral_slug) values ('L3','l3@x.com','legacy-3') returning id`);
await q(`insert into order_webhook_state (shopify_order_id, shopify_customer_id, order_total_pkr) values ('LO2','L3',4000), ('LO3','L3',4000)`);
await q(`select * from award_points($1,'purchase','LO2',4000,now()+interval '300 days','LO2',null,4000)`, [legacyRefunded]);
await q(`select * from award_points($1,'refund_deduction','old-refund-1',-1000,null,'LO2',null,null::numeric)`, [legacyRefunded]);
await q(`select * from award_points($1,'purchase','LO3',4000,now()+interval '300 days','LO3',null,4000)`, [legacyRefunded]);
await q(`select * from award_points($1,'refund_deduction','old-refund-2',-1000,null,'LO3',null,null::numeric)`, [legacyRefunded]);
await q(`insert into loyalty_codes (member_id,code,discount_amount,points_spent,expires_at,shopify_price_rule_id) values
  ($1,'BDAY-AAAA',250,0,now()+interval '30 days','gid://shopify/PriceRule/1'),
  ($1,'FREESHIP-BBBB',0,0,now()+interval '30 days',null),
  ($1,'REWARD-CCCC',100,3000,now()+interval '30 days',null)`, [legacy]);
await q(`insert into referrals (referrer_member_id, referred_shopify_customer_id, referred_email, status, created_at) values
  ($1,'F1','f1@x.com','pending', now()-interval '2 days'),
  ($1,'F1','f1@x.com','pending', now()-interval '1 day'),
  ($1,'F1','f1@x.com','flagged', now()),
  ($1,'F2','f2@x.com','pending', now())`, [legacy]);

const m010 = fs.readFileSync(path.join(MIG, "010_v3_core.sql"), "utf8");
await db.query(m010);
console.log("applied 010");
let rerunErr = null;
try { await db.query(m010); } catch (e) { rerunErr = e.message; }
console.log("\n[migration]");
ok("010 is re-runnable (second run without error)", rerunErr === null, rerunErr);
for (const f of files.filter((f) => f > "010_v3_core.sql")) {
  let err = null;
  try { await db.query(fs.readFileSync(path.join(MIG, f), "utf8")); } catch (e) { err = e.message; }
  ok(`later migration ${f} applies on top of 010`, err === null, err);
}

{
  const rows = await q(`select action_type, points, points_remaining, expires_at is not null as has_exp from points_ledger where member_id=$1 order by earned_at, id`, [legacy]);
  const m = (await q(`select points_balance, birthday_set_at is not null as bset from members where id=$1`, [legacy]))[0];
  eq("legacy balance unchanged (1000+2000-1500)", m.points_balance, 1500);
  const rem = rows.filter((r) => r.points > 0).reduce((s, r) => s + r.points_remaining, 0);
  eq("backfill: sum(points_remaining) equals balance", rem, 1500);
  eq("backfill: oldest tranche (signup 1000) consumed first", rows.find((r) => r.action_type === "signup").points_remaining, 0);
  eq("backfill: purchase tranche has 1500 left", rows.find((r) => r.action_type === "purchase").points_remaining, 1500);
  ok("backfill: silver positive rows with points left got an expiry", rows.filter((r) => r.points > 0 && r.points_remaining > 0).every((r) => r.has_exp));
  const g = await q(`select expires_at from points_ledger where member_id=$1`, [legacyGold]);
  ok("backfill: gold member rows get no expiry", g.every((r) => r.expires_at === null));
  ok("backfill: existing birthday counts as set", m.bset === true);
  const kinds = await q(`select code, kind, shopify_discount_id from loyalty_codes where member_id=$1 order by code`, [legacy]);
  eq("backfill: loyalty_codes.kind from prefix", kinds.map((k) => k.kind), ["birthday", "referral_friend", "reward"]);
  eq("backfill: price rule id copied to shopify_discount_id", kinds[0].shopify_discount_id, "gid://shopify/PriceRule/1");
  const refs = await q(`select status from referrals where referred_shopify_customer_id='F1' order by created_at`);
  eq("referral de-dup keeps the oldest open row", refs.map((r) => r.status), ["pending", "rejected", "rejected"]);
  let dupErr = null;
  try { await q(`insert into referrals (referrer_member_id, referred_shopify_customer_id, referred_email, status) values ($1,'F2','x','flagged')`, [legacy]); } catch (e) { dupErr = e.code; }
  eq("unique index: second open referral for the same friend refused", dupErr, "23505");
  const ows = (await q(`select points_awarded_amount, earning_basis_pkr from order_webhook_state where shopify_order_id='LO1'`))[0];
  eq("backfill: legacy awarded order gets points_awarded_amount", [ows.points_awarded_amount, Number(ows.earning_basis_pkr)], [2000, 2000]);
  // review item 7: a pre-v3 order with an earlier refund, refunded again under v3
  const lo2 = (await q(`select points_awarded_amount a, points_reversed_amount r, refunded_basis_pkr rb, refund_events_basis_pkr ev from order_webhook_state where shopify_order_id='LO2'`))[0];
  eq("backfill: legacy refunded order carries the old refund as basis AND as a refund event", [lo2.a, lo2.r, Number(lo2.rb), Number(lo2.ev)], [4000, 1000, 1000, 1000]);
  const same = (await q(`select * from reverse_order_points('LO2','refund','new-refund-1',1000)`))[0];
  eq("legacy refunded order: a new refund the SAME size as the old one reverses its full share", same.reversed, 1000);
  const replay = (await q(`select * from reverse_order_points('LO2','refund','new-refund-1',1000)`))[0];
  eq("legacy refunded order: the same refund replayed reverses nothing", replay.reversed, 0);
  const bigger = (await q(`select * from reverse_order_points('LO3','refund','new-refund-2',2500)`))[0];
  eq("legacy refunded order: a bigger new refund reverses all of it, not just the difference", bigger.reversed, 2500);
  const after = await q(`select shopify_order_id o, points_reversed_amount r, refunded_basis_pkr::float rb from order_webhook_state where shopify_order_id in ('LO2','LO3') order by 1`);
  eq("legacy refunded orders: totals after the new refunds", after, [{ o: "LO2", r: 2000, rb: 2000 }, { o: "LO3", r: 3500, rb: 3500 }]);
  eq("legacy refunded member: balance = 8000 - 2000 - 3500", (await q(`select points_balance b from members where id=$1`, [legacyRefunded]))[0].b, 2500);
  const cancelRest = (await q(`select * from reverse_order_points('LO3','cancel','cancel-LO3',null)`))[0];
  eq("legacy refunded order: cancelling takes only the remainder (never more than awarded)", cancelRest.reversed, 500);
  const over = await q(`select count(*)::int c from pg_proc where proname='award_points'`);
  eq("only one award_points overload remains", over[0].c, 1);
  let chk = null;
  try { await q(`insert into loyalty_codes (member_id,code,discount_amount,points_spent,expires_at,status) values ($1,'P-1',0,0,now(),'pending')`, [legacy]); } catch (e) { chk = e.message; }
  ok("loyalty_codes accepts status 'pending'", chk === null, chk);
  let nullEmail = null;
  try { await q(`insert into members (shopify_customer_id,phone,referral_slug) values ('PH1','+923001234567','phone-1')`); } catch (e) { nullEmail = e.message; }
  ok("member without email (phone only) can be inserted", nullEmail === null, nullEmail);
}

// ── helpers ──
let n = 0;
async function member(tier = "silver") {
  n++;
  const [r] = await q(`insert into members (shopify_customer_id,email,referral_slug,tier) values ($1,$2,$3,$4) returning id`,
    [`C${n}`, `c${n}@x.com`, `slug-${n}`, tier]);
  return { id: r.id, cust: `C${n}` };
}
async function order(cust, id, basis, pending = 0) {
  await q(`insert into order_webhook_state (shopify_order_id, shopify_customer_id, order_total_pkr, earning_basis_pkr, pending_points, order_name)
           values ($1,$2,$3,$3,$4,$5)`, [id, cust, basis, pending, `#${id}`]);
}
const award = async (m, action, ref, pts, extra = {}) =>
  (await q(`select * from award_points($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [m, action, ref, pts, extra.exp ?? null, extra.order ?? null, extra.note ?? null, extra.amt ?? null, extra.cnote ?? null]))[0];
const bal = async (m) => (await q(`select points_balance b, lifetime_spend_pkr::float l from members where id=$1`, [m]))[0];
const tranches = async (m) => q(`select action_type a, points p, points_remaining r, expired e from points_ledger where member_id=$1 and points>0 order by earned_at, id`, [m]);
const sumRem = async (m) => (await q(`select coalesce(sum(points_remaining),0)::int s from points_ledger where member_id=$1 and points>0 and expired=false`, [m]))[0].s;

console.log("\n[1] FIFO across action types");
{
  const m = await member();
  await award(m.id, "signup", "s", 1000);
  await q(`select pg_sleep(0.01)`);
  await award(m.id, "social_instagram", "i", 1000);
  await q(`select pg_sleep(0.01)`);
  await order(m.cust, "O1", 3000, 3000);
  const a = (await q(`select * from award_order_points('O1',$1,3000,3000,1,null)`, [m.id]))[0];
  ok("award_order_points awards", a.awarded === true && a.new_balance === 5000);
  const r = await award(m.id, "redemption", "code1", -1500);
  ok("redemption accepted", r.awarded && r.new_balance === 3500);
  let t = await tranches(m.id);
  eq("redemption consumed signup then instagram (oldest first, non-purchase rows too)", t.map((x) => x.r), [0, 500, 3000]);
  await award(m.id, "adjustment", "adj1", -700);
  t = await tranches(m.id);
  eq("adjustment (another action type) continues FIFO into the purchase tranche", t.map((x) => x.r), [0, 0, 2800]);
  eq("sum(points_remaining) == balance", await sumRem(m.id), (await bal(m.id)).b);
  ok("every positive silver row got an expiry by default", (await q(`select count(*)::int c from points_ledger where member_id=$1 and points>0 and expires_at is null`, [m.id]))[0].c === 0);
  const g = await member("gold");
  await award(g.id, "signup", "s", 1000);
  ok("gold member positive row has no expiry", (await q(`select expires_at from points_ledger where member_id=$1`, [g.id]))[0].expires_at === null);
}

console.log("\n[2] redemption with insufficient balance");
{
  const m = await member();
  await award(m.id, "signup", "s", 1000);
  const r = await award(m.id, "redemption", "codeX", -3000);
  ok("refused (awarded=false), balance untouched", r.awarded === false && r.new_balance === 1000);
  eq("no ledger row written for the refused redemption", (await q(`select count(*)::int c from points_ledger where member_id=$1 and action_type='redemption'`, [m.id]))[0].c, 0);
  eq("tranche untouched", (await tranches(m.id))[0].r, 1000);
  const r2 = await award(m.id, "redemption", "codeY", -1000);
  ok("exact-balance redemption accepted", r2.awarded === true && r2.new_balance === 0);
}

console.log("\n[3] idempotent replays");
{
  const m = await member();
  const a1 = await award(m.id, "signup", "s", 1000);
  const a2 = await award(m.id, "signup", "s", 1000);
  ok("award_points replay is a no-op", a1.awarded && !a2.awarded && a2.new_balance === 1000);
  const n1 = await award(m.id, "adjustment", null, 50);
  const n2 = await award(m.id, "adjustment", null, 50);
  ok("NULL reference still de-duplicates", n1.awarded && !n2.awarded);
  await order(m.cust, "O3", 2000, 2000);
  const o1 = (await q(`select * from award_order_points('O3',$1,2000,2000,1,null)`, [m.id]))[0];
  const o2 = (await q(`select * from award_order_points('O3',$1,2000,2000,1,null)`, [m.id]))[0];
  ok("award_order_points replay is a no-op", o1.awarded && !o2.awarded && o2.new_balance === 3050);
  eq("lifetime spend added once", (await bal(m.id)).l, 2000);
  const r1 = (await q(`select * from reverse_order_points('O3','refund','R1',500)`))[0];
  const r2 = (await q(`select * from reverse_order_points('O3','refund','R1',500)`))[0];
  eq("refund replay reverses once", [r1.reversed, r2.reversed], [500, 0]);
  const st = (await q(`select points_reversed_amount a, refunded_basis_pkr::float b from order_webhook_state where shopify_order_id='O3'`))[0];
  eq("replay did not bump reversed/refunded twice", [st.a, st.b], [500, 500]);
  eq("lifetime spend reduced once", (await bal(m.id)).l, 1500);
  const missing = (await q(`select * from reverse_order_points('NOPE','cancel','NOPE')`))[0];
  eq("unknown order: no-op", missing.reversed, 0);
}

console.log("\n[4] refund then cancel (no double reversal)");
{
  const m = await member();
  await order(m.cust, "O4", 4000, 8000);
  await q(`select * from award_order_points('O4',$1,8000,4000,2,null)`, [m.id]); // 2x campaign
  const r = (await q(`select * from reverse_order_points('O4','refund','R4',1000)`))[0];
  eq("part refund reverses awarded x refunded / basis (8000 x 1000/4000)", r.reversed, 2000);
  const c = (await q(`select * from reverse_order_points('O4','cancel','O4')`))[0];
  eq("cancel reverses only the remainder", c.reversed, 6000);
  const c2 = (await q(`select * from reverse_order_points('O4','cancel','O4')`))[0];
  const r2 = (await q(`select * from reverse_order_points('O4','refund','R4b',3000)`))[0];
  eq("further cancel/refund reverse nothing", [c2.reversed, r2.reversed], [0, 0]);
  const st = (await q(`select points_awarded_amount a, points_reversed_amount r, cancelled_at is not null c from order_webhook_state where shopify_order_id='O4'`))[0];
  eq("never more than awarded", [st.a, st.r, st.c], [8000, 8000, true]);
  const b = await bal(m.id);
  eq("balance 0 and lifetime spend back to 0", [b.b, b.l], [0, 0]);
  const notes = await q(`select action_type, customer_note from points_ledger where member_id=$1 and points<0 order by earned_at`, [m.id]);
  eq("customer-visible notes", notes.map((x) => x.customer_note), ["Order refunded (#O4)", "Order cancelled (#O4)"]);

  // several part refunds add up to exactly the award (cumulative rounding)
  const k = await member();
  await order(k.cust, "O4b", 999, 999);
  await q(`select * from award_order_points('O4b',$1,999,999,1,null)`, [k.id]);
  let total = 0;
  for (const [ref, amt] of [["a", 333], ["b", 333], ["c", 333]]) total += (await q(`select * from reverse_order_points('O4b','refund',$1,$2)`, [ref, amt]))[0].reversed;
  eq("three part refunds = full award, not more", total, 999);
  const over = (await q(`select * from reverse_order_points('O4b','refund','d',500)`))[0];
  eq("refund beyond the basis reverses nothing more", over.reversed, 0);
}

console.log("\n[5] cancel before award blocks later award");
{
  const m = await member();
  await order(m.cust, "O5", 2500, 2500);
  const c = (await q(`select * from reverse_order_points('O5','cancel','O5')`))[0];
  eq("cancel with nothing awarded reverses 0", c.reversed, 0);
  const st = (await q(`select cancelled_at is not null c, pending_points p from order_webhook_state where shopify_order_id='O5'`))[0];
  eq("order flagged cancelled, pending cleared", [st.c, st.p], [true, 0]);
  const a = (await q(`select * from award_order_points('O5',$1,2500,2500,1,null)`, [m.id]))[0];
  ok("later award refused", a.awarded === false);
  const b = await bal(m.id);
  eq("no points, no lifetime spend", [b.b, b.l], [0, 0]);
  const none = (await q(`select * from award_order_points('NO-ROW',$1,10,10,1,null)`, [m.id]))[0];
  ok("award for an order with no stored row refused", none.awarded === false);
}

console.log("\n[6] expiry after partial spend");
{
  const m = await member();
  await award(m.id, "signup", "s", 1000, { exp: new Date(Date.now() - 86400000).toISOString() });
  await q(`select pg_sleep(0.01)`);
  await award(m.id, "review", "rv", 3000);
  await award(m.id, "adjustment", "spend", -400);
  const src = (await q(`select id, points_remaining from points_ledger where member_id=$1 and action_type='signup'`, [m.id]))[0];
  eq("tranche has 600 left after spending 400", src.points_remaining, 600);
  const e = await award(m.id, "expiry", src.id, -1000); // caller asks for the full 1000
  ok("expiry removes only what is left in that tranche (600, not 1000)", e.awarded && e.new_balance === 3000, e);
  const row = (await q(`select points from points_ledger where member_id=$1 and action_type='expiry'`, [m.id]))[0];
  eq("expiry ledger row is -600", row.points, -600);
  const t = await tranches(m.id);
  eq("source marked expired; other tranche untouched", t.map((x) => [x.r, x.e]), [[0, true], [3000, false]]);
  const e2 = await award(m.id, "expiry", src.id, -1000);
  ok("expiry replay is a no-op", e2.awarded === false && e2.new_balance === 3000);
  eq("sum(points_remaining) == balance", await sumRem(m.id), 3000);
  await award(m.id, "adjustment", "spend2", -500);
  eq("later deductions skip the expired tranche", (await tranches(m.id)).map((x) => x.r), [0, 2500]);
}

console.log("\n[7] floor at zero");
{
  const m = await member();
  await award(m.id, "signup", "s", 500);
  const a = await award(m.id, "adjustment", "big", -2000);
  ok("deduction clamped to the balance", a.awarded && a.new_balance === 0);
  eq("ledger row records what was actually taken", (await q(`select points from points_ledger where member_id=$1 and reference_id='big'`, [m.id]))[0].points, -500);
  // order points already spent before the refund
  const k = await member();
  await order(k.cust, "O7", 3000, 3000);
  await q(`select * from award_order_points('O7',$1,3000,3000,1,null)`, [k.id]);
  await award(k.id, "redemption", "c7", -3000);
  const r = (await q(`select * from reverse_order_points('O7','cancel','O7')`))[0];
  eq("cancel after the points were spent: reverses what it can (0), balance stays 0", [r.reversed, r.new_balance], [0, 0]);
  let neg = null;
  try { await q(`update members set points_balance=-1 where id=$1`, [k.id]); } catch (e) { neg = e.code; }
  eq("CHECK constraint still forbids a negative balance", neg, "23514");
  await award(k.id, "signup", "s", 1000);
  const again = (await q(`select * from reverse_order_points('O7','cancel','O7')`))[0];
  eq("the forgiven part is not taken from later earnings", [again.reversed, (await bal(k.id)).b], [0, 1000]);
}

console.log("\n[8] two concurrent reversals / races");
{
  const m = await member();
  await order(m.cust, "O8", 5000, 5000);
  await q(`select * from award_order_points('O8',$1,5000,5000,1,null)`, [m.id]);
  const c1 = new pg.Client(conn), c2 = new pg.Client(conn);
  await c1.connect(); await c2.connect();
  const [x, y] = await Promise.all([
    c1.query(`select * from reverse_order_points('O8','refund','R8',5000)`),
    c2.query(`select * from reverse_order_points('O8','cancel','O8')`),
  ]);
  const total = x.rows[0].reversed + y.rows[0].reversed;
  eq("refund(full) + cancel at the same time reverse 5000 in total", total, 5000);
  const st = (await q(`select points_reversed_amount r from order_webhook_state where shopify_order_id='O8'`))[0];
  eq("order shows exactly 5000 reversed, balance 0", [st.r, (await bal(m.id)).b], [5000, 0]);

  // same refund delivered twice at once
  const k = await member();
  await order(k.cust, "O8b", 4000, 4000);
  await q(`select * from award_order_points('O8b',$1,4000,4000,1,null)`, [k.id]);
  const [p, r] = await Promise.all([
    c1.query(`select * from reverse_order_points('O8b','refund','SAME',1000)`),
    c2.query(`select * from reverse_order_points('O8b','refund','SAME',1000)`),
  ]);
  eq("duplicate refund webhook in parallel reverses once", p.rows[0].reversed + r.rows[0].reversed, 1000);

  // award vs cancel race: exactly one outcome, never points on a cancelled order
  let bad = 0;
  for (let i = 0; i < 25; i++) {
    const z = await member();
    await order(z.cust, `RACE${i}`, 1000, 1000);
    await Promise.all([
      c1.query(`select * from award_order_points($1,$2,1000,1000,1,null)`, [`RACE${i}`, z.id]),
      c2.query(`select * from reverse_order_points($1,'cancel',$1)`, [`RACE${i}`]),
    ]);
    const b = await bal(z.id);
    const s = (await q(`select points_awarded_amount a, points_reversed_amount r from order_webhook_state where shopify_order_id=$1`, [`RACE${i}`]))[0];
    if (b.b !== 0 || b.l !== 0 || s.a !== s.r) bad++;
  }
  eq("25 award-vs-cancel races: balance and spend always end at 0", bad, 0);

  // two concurrent redemptions of the whole balance
  const w = await member();
  await award(w.id, "signup", "s", 3000);
  const [ra, rb] = await Promise.all([
    c1.query(`select * from award_points($1,'redemption','ca',-3000)`, [w.id]),
    c2.query(`select * from award_points($1,'redemption','cb',-3000)`, [w.id]),
  ]);
  eq("two concurrent full redemptions: exactly one succeeds", [ra.rows[0].awarded, rb.rows[0].awarded].filter(Boolean).length, 1);
  await c1.end(); await c2.end();
}

console.log("\n[9] extras");
{
  const m = await member();
  await order(m.cust, "O9", 1500, 0);
  const a = (await q(`select * from award_order_points('O9',$1,0,1500,1,null)`, [m.id]))[0];
  ok("zero-point order (gift card / rule off) still counts spend and is marked awarded", a.awarded === true && Number(a.new_lifetime_spend_pkr) === 1500 && a.new_balance === 0);
  eq("first_order_awarded_at set", (await q(`select first_order_awarded_at is not null f from members where id=$1`, [m.id]))[0].f, true);
  let err = null;
  try { await q(`select * from reverse_order_points('O9','bogus','x')`); } catch (e) { err = e.message; }
  ok("unknown kind raises", err !== null);
  let err2 = null;
  try { await award("00000000-0000-0000-0000-000000000000", "signup", "s", 1); } catch (e) { err2 = e.message; }
  ok("unknown member raises", err2 !== null);
  let err3 = null;
  try { await award(m.id, "not_a_type", "s", 1); } catch (e) { err3 = e.code; }
  eq("unknown action type rejected by CHECK", err3, "23514");
  for (const t of ["order_cancelled", "referral_reversal", "redemption_return", "tier_reward", "influencer_sale", "import"]) {
    const r = await award(m.id, t, `new-${t}`, t === "referral_reversal" || t === "order_cancelled" ? -1 : 10);
    if (!r.awarded) ok(`new action type ${t} accepted`, false);
  }
  ok("all six new action types accepted", true);
  const cn = await award(m.id, "adjustment", "cn", 5, { note: "internal reason", cnote: "A gift from us" });
  const row = (await q(`select reason_note, customer_note from points_ledger where member_id=$1 and reference_id='cn'`, [m.id]))[0];
  eq("customer_note stored separately from reason_note", [row.reason_note, row.customer_note], ["internal reason", "A gift from us"]);
}


// ── v3 fix round: reconciliation on totals ──
const sync = async (id, at, gross, current, rate = 1, can = true) =>
  (await q(`select * from sync_order_snapshot($1,$2,$3,$4,$5,$6)`, [id, at, gross, current, rate, can]))[0];
const bare = async (cust, id, mult = 1) =>
  q(`insert into order_webhook_state (shopify_order_id, shopify_customer_id, multiplier_used, order_name) values ($1,$2,$3,$4)`, [id, cust, mult, `#${id}`]);
const ows = async (id) => (await q(`select pending_points p, earning_basis_pkr::float e, gross_basis_pkr::float g, refunded_basis_pkr::float r,
  points_awarded a, points_awarded_amount pa, points_reversed_amount pr, refund_basis_at_award_pkr::float r0 from order_webhook_state where shopify_order_id=$1`, [id]))[0];
const T = (n) => new Date(Date.UTC(2026, 10, 10, 10, n)).toISOString();

console.log("\n[10] refunds and order updates in any order (reconcile on totals)");
{
  // A. refund BEFORE the award, then a STALE pre-refund payload triggers the award
  const a = await member(); await bare(a.cust, "RA");
  await sync("RA", T(1), 3000, 3000);
  eq("A: pending from snapshot", (await ows("RA")).p, 3000);
  const r = (await q(`select * from reverse_order_points('RA','refund','RF-A',1000)`))[0];
  eq("A: refund before award reverses no points but is remembered", [r.reversed, (await ows("RA")).p, (await ows("RA")).r], [0, 2000, 1000]);
  await sync("RA", T(2), 3000, 3000); // payload built before the refund, newer timestamp
  eq("A: stale-content payload cannot restore the refunded part", (await ows("RA")).p, 2000);
  const aw = (await q(`select * from award_order_points('RA',$1,3000,3000,1,null)`, [a.id]))[0]; // caller passes OLD figures
  eq("A: award is net of the refund (2000, not 3000)", [aw.awarded, aw.new_balance, Number(aw.new_lifetime_spend_pkr)], [true, 2000, 2000]);
  await sync("RA", T(3), 3000, 2000); // fresh payload now shows the refund
  await q(`select * from reverse_order_points('RA','refund','RF-A',1000)`); // replayed refund webhook
  eq("A: nothing further is reversed afterwards", [(await bal(a.id)).b, (await ows("RA")).pr], [2000, 0]);

  // B. award first (stale payload), THEN the refund event, THEN the fresh payload
  const b = await member(); await bare(b.cust, "RB");
  await sync("RB", T(1), 3000, 3000);
  await q(`select * from award_order_points('RB',$1,3000,3000,1,null)`, [b.id]);
  const rb = (await q(`select * from reverse_order_points('RB','refund','RF-B',1000)`))[0];
  eq("B: refund after award reverses 1000", rb.reversed, 1000);
  const sb = await sync("RB", T(2), 3000, 2000);
  eq("B: the order update that follows reverses nothing more (no double deduction)", [sb.reversed, (await bal(b.id)).b, (await bal(b.id)).l], [0, 2000, 2000]);

  // C. award, then the fresh payload arrives BEFORE the refund event
  const c = await member(); await bare(c.cust, "RC");
  await sync("RC", T(1), 3000, 3000);
  await q(`select * from award_order_points('RC',$1,3000,3000,1,null)`, [c.id]);
  const sc = await sync("RC", T(2), 3000, 2000);
  eq("C: order update alone reverses the difference", sc.reversed, 1000);
  const rc = (await q(`select * from reverse_order_points('RC','refund','RF-C',1000)`))[0];
  eq("C: the refund event that follows reverses nothing more", [rc.reversed, (await bal(c.id)).b], [0, 2000]);
  const notes = await q(`select customer_note from points_ledger where member_id=$1 and points<0`, [c.id]);
  eq("C: one customer-visible reversal row", notes.map((n) => n.customer_note), ["Order refunded (#RC)"]);

  // D. stale retry: an OLDER payload arrives after a newer one
  const d = await member(); await bare(d.cust, "RD");
  await sync("RD", T(5), 3000, 2000); // newest: item removed
  const stale = await sync("RD", T(1), 3000, 3000); // retried old job
  eq("D: older payload is ignored", [stale.applied, (await ows("RD")).p, (await ows("RD")).e], [false, 2000, 2000]);
  const same = await sync("RD", T(5), 3000, 2000);
  eq("D: same payload again is harmless", [same.applied, (await ows("RD")).p], [true, 2000]);

  // E. two refund events + payloads interleaved, then full refund
  const e = await member(); await bare(e.cust, "RE");
  await sync("RE", T(1), 4000, 4000);
  await q(`select * from award_order_points('RE',$1,0,0,1,null)`, [e.id]);
  eq("E: awarded 4000", (await bal(e.id)).b, 4000);
  await sync("RE", T(3), 4000, 2000); // reflects refunds 1 and 2 already
  await q(`select * from reverse_order_points('RE','refund','E1',1000)`);
  await q(`select * from reverse_order_points('RE','refund','E2',1000)`);
  eq("E: two refunds + one update = 2000 reversed, once", [(await bal(e.id)).b, (await ows("RE")).pr], [2000, 2000]);
  await q(`select * from reverse_order_points('RE','refund','E3',2000)`);
  const fin = await ows("RE");
  eq("E: full refund reverses everything, spend back to 0", [(await bal(e.id)).b, fin.pr, (await bal(e.id)).l, fin.r], [0, 4000, 0, 4000]);
  const cz = (await q(`select * from reverse_order_points('RE','cancel','RE')`))[0];
  eq("E: cancel after full refund reverses nothing", cz.reversed, 0);

  // F. amount-only refund (in the refund events, not in the order's current figures)
  const f = await member(); await bare(f.cust, "RG");
  await sync("RG", T(1), 2000, 2000);
  await q(`select * from award_order_points('RG',$1,0,0,1,null)`, [f.id]);
  await q(`select * from reverse_order_points('RG','refund','G1',500)`);
  await sync("RG", T(2), 2000, 2000); // current figures unchanged by an amount-only refund
  eq("F: amount-only refund reverses and a later update does not undo or repeat it", [(await bal(f.id)).b, (await ows("RG")).pr], [1500, 500]);

  // G. campaign multiplier + member who cannot earn + item added after creation
  const g = await member(); await bare(g.cust, "RH", 2);
  eq("G: pending uses the stored multiplier and the rate", (await sync("RH", T(1), 1000, 1000, 0.5, true)).pending_points, 1000);
  eq("G: cannot earn -> 0 pending", (await sync("RH", T(2), 1000, 1000, 1, false)).pending_points, 0);
  eq("G: item added before delivery raises the basis", (await sync("RH", T(3), 1000, 1500, 1, true)).pending_points, 3000);
  eq("G: unknown order: not applied", (await sync("NOPE", T(1), 1, 1, 1, true)).applied, false);

  // H. concurrent refund event and order update for the same refund
  const hM = await member(); await bare(hM.cust, "RI");
  await sync("RI", T(1), 5000, 5000);
  await q(`select * from award_order_points('RI',$1,0,0,1,null)`, [hM.id]);
  const c1 = new pg.Client(conn), c2 = new pg.Client(conn); await c1.connect(); await c2.connect();
  await Promise.all([
    c1.query(`select * from reverse_order_points('RI','refund','I1',2000)`),
    c2.query(`select * from sync_order_snapshot('RI',$1,5000,3000,1,true)`, [T(2)]),
  ]);
  eq("H: refund event and order update at the same time reverse 2000 once", [(await bal(hM.id)).b, (await ows("RI")).pr], [3000, 2000]);
  await c1.end(); await c2.end();
}

console.log("\n[11] expiry: no 0-point rows, Silver only");
{
  const m = await member();
  await award(m.id, "signup", "s", 1000, { exp: new Date(Date.now() - 86400000).toISOString() });
  await award(m.id, "redemption", "c", -1000);
  const src = (await q(`select id from points_ledger where member_id=$1 and action_type='signup'`, [m.id]))[0];
  const e = await award(m.id, "expiry", src.id, 0);
  eq("fully spent tranche: closed without a ledger row", [e.awarded, (await q(`select count(*)::int c from points_ledger where member_id=$1 and action_type='expiry'`, [m.id]))[0].c], [false, 0]);
  eq("...and marked expired", (await q(`select expired from points_ledger where id=$1`, [src.id]))[0].expired, true);
  const g = await member("gold");
  await award(g.id, "signup", "s", 1000, { exp: new Date(Date.now() - 86400000).toISOString() });
  const gs = (await q(`select id from points_ledger where member_id=$1`, [g.id]))[0];
  const ge = await award(g.id, "expiry", gs.id, -1000);
  eq("expiry is refused for a non-Silver member", [ge.awarded, (await bal(g.id)).b, (await q(`select expired from points_ledger where id=$1`, [gs.id]))[0].expired], [false, 1000, false]);
}

console.log("\n[12] upgrade_member_tier is atomic");
{
  const m = await member();
  await award(m.id, "signup", "s", 1000);
  const up = (await q(`select upgrade_member_tier($1,'gold','O-T') u`, [m.id]))[0].u;
  const st = (await q(`select tier from members where id=$1`, [m.id]))[0];
  const hist = await q(`select from_tier, to_tier, shopify_order_id from tier_history where member_id=$1`, [m.id]);
  const exp = (await q(`select count(*)::int c from points_ledger where member_id=$1 and expires_at is not null`, [m.id]))[0].c;
  eq("tier, history row and cleared expiry together", [up, st.tier, hist, exp], [true, "gold", [{ from_tier: "silver", to_tier: "gold", shopify_order_id: "O-T" }], 0]);
  eq("second call does nothing", [(await q(`select upgrade_member_tier($1,'gold',null) u`, [m.id]))[0].u, (await q(`select count(*)::int c from tier_history where member_id=$1`, [m.id]))[0].c], [false, 1]);
  eq("never downgrades", [(await q(`select upgrade_member_tier($1,'silver',null) u`, [m.id]))[0].u, (await q(`select tier from members where id=$1`, [m.id]))[0].tier], [false, "gold"]);
  eq("gold -> diamond", (await q(`select upgrade_member_tier($1,'diamond',null) u`, [m.id]))[0].u, true);
}

console.log("\n[13] campaign switched off is time-stamped");
{
  const [c] = await q(`insert into bonus_campaigns (name, multiplier, starts_at, ends_at, is_active) values ('x',2,'2030-01-01','2030-01-05',true) returning id, deactivated_at`);
  eq("active campaign has no deactivated_at", c.deactivated_at, null);
  await q(`update bonus_campaigns set is_active=false where id=$1`, [c.id]);
  ok("switching off stamps deactivated_at", (await q(`select deactivated_at from bonus_campaigns where id=$1`, [c.id]))[0].deactivated_at !== null);
  await q(`update bonus_campaigns set is_active=true where id=$1`, [c.id]);
  eq("switching back on clears it", (await q(`select deactivated_at from bonus_campaigns where id=$1`, [c.id]))[0].deactivated_at, null);
  await q(`update bonus_campaigns set is_active=false where id=$1`, [c.id]);
}

console.log("\n[14] 013_rls: row level security on every app table, no policies");
{
  const m013 = fs.readFileSync(path.join(MIG, "013_rls.sql"), "utf8");
  let again = null;
  try { await db.query(m013); await db.query(m013); } catch (e) { again = e.message; }
  ok("013 is re-runnable (applied twice more without error)", again === null, again);

  // every table the migrations create, straight from the catalogue, so a
  // table added later without row level security fails this test
  const open = await q(`select c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='public' and c.relkind='r' and not c.relrowsecurity order by 1`);
  eq("no table in public is left without row level security", open.map((r) => r.relname), []);
  const forced = await q(`select c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='public' and c.relkind='r' and c.relforcerowsecurity`);
  eq("FORCE is not used (the owner and definer functions keep working)", forced.length, 0);
  eq("no policies exist", (await q(`select count(*)::int c from pg_policies where schemaname='public'`))[0].c, 0);
  const named = await q(`select relname from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='r' and c.relrowsecurity
    and relname in ('shopify_sessions','members','points_ledger','order_webhook_state','loyalty_codes','referrals','social_actions','bonus_campaigns','app_settings','notification_log','gdpr_requests') order by 1`);
  eq("the eleven 001-009 tables are covered", named.length, 11);

  // A role like Supabase's anon (no BYPASSRLS, plain table grants) sees nothing
  // and can write nothing; one like service_role (BYPASSRLS) is unaffected.
  await db.query(`do $$ begin
    if not exists (select 1 from pg_roles where rolname='t_anon') then create role t_anon nologin; end if;
    if not exists (select 1 from pg_roles where rolname='t_service') then create role t_service nologin bypassrls; end if;
  end $$;
  grant usage on schema public to t_anon, t_service;
  grant all on all tables in schema public to t_anon, t_service;`);
  const total = (await q(`select count(*)::int c from members`))[0].c;
  await db.query(`set role t_anon`);
  const anonSees = (await q(`select (select count(*) from members)::int m, (select count(*) from points_ledger)::int l, (select count(*) from app_settings)::int s, (select count(*) from shopify_sessions)::int ss`))[0];
  let anonWrite = null;
  try { await q(`insert into members (shopify_customer_id, referral_slug) values ('ANON','anon-slug')`); } catch (e) { anonWrite = e.code; }
  const anonUpd = (await db.query(`update members set points_balance = 999999`)).rowCount;
  await db.query(`reset role`);
  eq("anon-like role reads zero rows from members, ledger, settings, sessions", anonSees, { m: 0, l: 0, s: 0, ss: 0 });
  eq("anon-like role cannot insert (42501) and updates zero rows", [anonWrite, anonUpd], ["42501", 0]);
  await db.query(`set role t_service`);
  const svc = (await q(`select count(*)::int c from members`))[0].c;
  const svcSettings = (await q(`select count(*)::int c from app_settings`))[0].c;
  await db.query(`reset role`);
  ok("service-like role (BYPASSRLS) still reads everything", total > 0 && svc === total && svcSettings === 1, { total, svc, svcSettings });
  // the engine's functions still work for the owner after 013
  const m = await member();
  const r = await award(m.id, "signup", "after-rls", 100);
  eq("award_points still works after 013", [r.awarded, r.new_balance], [true, 100]);
}

console.log("\n[15] 014_program_pause: switch history, state at placement, default FAQ");
{
  const m014 = fs.readFileSync(path.join(MIG, "014_program_pause.sql"), "utf8");
  // 014 was applied once with the later migrations above (on the legacy data)
  const legacyOrder = (await q(`select program_on_at_placement p from order_webhook_state where shopify_order_id='LO1'`))[0];
  eq("orders recorded before 014 count as placed while on", legacyOrder.p, true);
  const APPROVED = [{ q: "How are my points calculated?", a: "Points are earned on the amount you pay after discounts, and are added once your order is delivered and paid. Shipping and tax do not earn points." }];
  // jsonb sorts object keys, so compare in SQL rather than as JSON text
  const sameFaqs = async (want) => (await q(`select faqs = $1::jsonb s from app_settings where id=1`, [JSON.stringify(want)]))[0].s;
  eq("an empty FAQ list gets the approved entry", await sameFaqs(APPROVED), true);
  let again = null;
  try { await db.query(m014); await db.query(m014); } catch (e) { again = e.message; }
  ok("014 is re-runnable (applied twice more without error)", again === null, again);
  eq("one baseline row, not one per run", (await q(`select count(*)::int c from program_switch_history where source='baseline'`))[0].c, 1);
  eq("the FAQ is not added twice", (await q(`select jsonb_array_length(faqs) n from app_settings where id=1`))[0].n, 1);
  await q(`update app_settings set faqs='[{"q":"Own question","a":"Own answer"}]'::jsonb where id=1`);
  await db.query(m014);
  eq("a store's own FAQ list is left alone", await sameFaqs([{ q: "Own question", a: "Own answer" }]), true);

  // the trigger records every change of the switch, and nothing else
  const count = async () => (await q(`select count(*)::int c from program_switch_history`))[0].c;
  const before = await count();
  await q(`update app_settings set program_enabled=false where id=1`);
  await q(`update app_settings set program_enabled=false where id=1`); // same value: no row
  await q(`update app_settings set tagline='x' where id=1`);           // other column: no row
  await q(`update app_settings set program_enabled=true, tagline='y' where id=1`);
  const rows = await q(`select enabled, source from program_switch_history order by changed_at desc, id desc limit 2`);
  eq("switch off then on writes exactly two rows (latest first)", [await count() - before, rows], [2, [{ enabled: true, source: "settings" }, { enabled: false, source: "settings" }]]);

  // program_enabled_at against a known history
  await q(`truncate program_switch_history`);
  await q(`insert into program_switch_history (enabled, changed_at, source) values
    (true,  '2026-01-01T00:00:00Z', 'baseline'),
    (false, '2026-11-09T00:00:00Z', 'settings'),
    (true,  '2026-11-12T00:00:00Z', 'settings')`);
  const at = async (t) => (await q(`select program_enabled_at($1::timestamptz) v`, [t]))[0].v;
  eq("before the first record: the baseline state", await at("2025-06-01T00:00:00Z"), true);
  eq("while on", await at("2026-11-08T10:00:00Z"), true);
  eq("at the moment it was switched off", await at("2026-11-09T00:00:00Z"), false);
  eq("while off", await at("2026-11-10T10:00:00+05:00"), false);
  eq("back on", await at("2026-11-13T00:00:00Z"), true);
  eq("null means now", await at(null), true);
  await q(`truncate program_switch_history`);
  await q(`update app_settings set program_enabled=false where id=1`); // trigger writes one row: off
  await q(`truncate program_switch_history`);
  eq("no history at all: the current switch", await at("2026-11-10T00:00:00Z"), false);
  await q(`update app_settings set program_enabled=true where id=1`);
  let rpcErr = null;
  try { await q(`insert into order_webhook_state (shopify_order_id, shopify_customer_id, program_on_at_placement) values ('P20','C-P20', false)`); } catch (e) { rpcErr = e.message; }
  ok("program_on_at_placement can be stored false", rpcErr === null, rpcErr);
  const rls = (await q(`select relrowsecurity r from pg_class where relname='program_switch_history'`))[0].r;
  eq("program_switch_history has row level security", rls, true);
}

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
if (fail) console.log("FAILED:", failures.join(" | "));
await db.end();
await server.stop();
process.exit(fail ? 1 : 0);
