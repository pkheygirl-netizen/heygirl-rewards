// Real-Postgres test for migration 012 (Smile import tables) and for what the
// import relies on in 010: the `import` ledger action, the database-applied
// Silver expiry, and upgrade_member_tier. Same harness as
// 010_v3_core.pgtest.mjs (packages are NOT app dependencies):
//
//   mkdir /tmp/pgtest && cd /tmp/pgtest && npm init -y
//   npm install embedded-postgres pg
//   cp <repo>/supabase/tests/012_import.pgtest.mjs import.mjs
//   node import.mjs <repo>/supabase/migrations
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import fs from "node:fs";
import path from "node:path";

const MIG = process.argv[2];
const dataDir = path.join(process.cwd(), "data-012");
fs.rmSync(dataDir, { recursive: true, force: true });
const PORT = 54331;
const server = new EmbeddedPostgres({
  databaseDir: dataDir, user: "postgres", password: "pw", port: PORT,
  persistent: false, createPostgresUser: true, onLog: () => {}, onError: () => {},
});
await server.initialise();
await server.start();
await server.createDatabase("hg");
const conn = { host: "localhost", port: PORT, user: "postgres", password: "pw", database: "hg" };
const db = new pg.Client(conn); await db.connect();
const db2 = new pg.Client(conn); await db2.connect();
const q = async (sql, params) => (await db.query(sql, params)).rows;

let pass = 0, fail = 0; const failures = [];
function ok(name, cond, extra) {
  if (cond) { pass++; console.log("  PASS", name); }
  else { fail++; failures.push(name); console.log("  FAIL", name, extra !== undefined ? JSON.stringify(extra) : ""); }
}
const eq = (name, a, b) => ok(name, JSON.stringify(a) === JSON.stringify(b), { got: a, want: b });
const rejects = async (name, fn, code) => {
  try { await fn(); ok(name, false, "no error"); }
  catch (e) { ok(name, !code || e.code === code, { code: e.code, message: e.message }); }
};

try {
  const files = fs.readdirSync(MIG).filter((f) => f.endsWith(".sql")).sort();
  console.log("server:", (await q("select version()"))[0].version);
  for (const f of files) await db.query(fs.readFileSync(path.join(MIG, f), "utf8"));
  console.log("applied:", files.join(", "));
  // 012 can be run again (also over the earlier version of itself).
  await db.query(fs.readFileSync(path.join(MIG, "012_import.sql"), "utf8"));
  ok("012 applies twice", true);

  // ── one open run at a time ──
  const [{ id: run1 }] = await q(`insert into import_runs (status) values ('planning') returning id`);
  await rejects("second open run refused (planning + planning)", () => q(`insert into import_runs (status) values ('planning')`), "23505");
  for (const st of ["planned", "running", "failed"]) {
    await q(`update import_runs set status = $2 where id = $1`, [run1, st]);
    await rejects(`second open run refused while first is ${st}`, () => q(`insert into import_runs (status) values ('planning')`), "23505");
  }
  await q(`update import_runs set status = 'completed', finished_at = now() where id = $1`, [run1]);
  const [{ id: run2 }] = await q(`insert into import_runs (status) values ('planning') returning id`);
  ok("new run allowed after the first completed", !!run2);
  await q(`update import_runs set status = 'cancelled' where id = $1`, [run2]);
  const [{ id: run }] = await q(`insert into import_runs (status) values ('running') returning id`);
  ok("new run allowed after a cancelled one", !!run);
  await rejects("unknown status refused", () => q(`insert into import_runs (status) values ('weird')`), "23514");

  // ── lease: conditional updates, two connections racing ──
  const claim = (client, who) => client.query(
    `update import_runs set locked_by = $2, locked_until = now() + interval '2 minutes'
      where id = $1 and (locked_until is null) returning id`, [run, who]);
  const [a, b] = await Promise.all([claim(db, "worker-a"), claim(db2, "worker-b")]);
  eq("exactly one of two racing workers gets the lease", a.rowCount + b.rowCount, 1);
  const holder = (await q(`select locked_by from import_runs where id = $1`, [run]))[0].locked_by;
  const other = holder === "worker-a" ? "worker-b" : "worker-a";
  eq("expired-lease claim refused while the lease is live",
    (await db.query(`update import_runs set locked_by = $2 where id = $1 and locked_until < now() returning id`, [run, other])).rowCount, 0);
  eq("renewal by a non-holder touches nothing",
    (await db.query(`update import_runs set locked_until = now() + interval '2 minutes' where id = $1 and locked_by = $2 returning id`, [run, other])).rowCount, 0);
  await q(`update import_runs set locked_until = now() - interval '1 second' where id = $1`, [run]);
  eq("expired lease can be taken over",
    (await db.query(`update import_runs set locked_by = $2, locked_until = now() + interval '2 minutes' where id = $1 and locked_until < now() returning id`, [run, other])).rowCount, 1);

  // ── rows: upsert on (run_id, row_number), checks, cascade ──
  const upsert = (rowNumber, state, extra = {}) => q(
    `insert into import_rows (run_id, row_number, smile_customer_id, email, file_points, points, state, reason, shopify_first_name, shopify_phone, member_has_welcome, points_awarded)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     on conflict (run_id, row_number) do update set state = excluded.state, reason = excluded.reason,
       shopify_first_name = excluded.shopify_first_name, shopify_phone = excluded.shopify_phone,
       member_has_welcome = excluded.member_has_welcome, points_awarded = excluded.points_awarded`,
    [run, rowNumber, extra.id ?? String(rowNumber), "email" in extra ? extra.email : `r${rowNumber}@x.com`, extra.file ?? 10, extra.points ?? 10,
      state, extra.reason ?? null, extra.first ?? null, extra.phone ?? null, extra.welcome ?? null, extra.awarded ?? null]);
  await upsert(1, "pending");
  await upsert(1, "matched", { first: "A", phone: "+92300", welcome: true });
  await upsert(1, "imported", { awarded: 10 });
  eq("upsert keeps one row per (run, row_number) and updates it",
    await q(`select state, shopify_first_name, shopify_phone, points_awarded from import_rows where run_id = $1`, [run]),
    [{ state: "imported", shopify_first_name: null, shopify_phone: null, points_awarded: 10 }]);
  await upsert(2, "skipped", { reason: "member_opted_out" });
  await upsert(3, "unmatched", { reason: "no_email", email: null, file: -35600, points: 0 });
  eq("negative file points stored as-is, import points 0",
    (await q(`select file_points, points, email from import_rows where run_id = $1 and row_number = 3`, [run]))[0],
    { file_points: -35600, points: 0, email: null });
  await rejects("negative import points refused", () => upsert(4, "pending", { points: -1 }), "23514");
  await rejects("unknown row state refused", () => upsert(5, "nonsense"), "23514");
  await rejects("row for an unknown run refused", () =>
    q(`insert into import_rows (run_id, row_number, state) values (gen_random_uuid(), 1, 'pending')`), "23503");
  eq("state index exists", (await q(`select count(*)::int n from pg_indexes where indexname = 'import_rows_state_idx'`))[0].n, 1);
  eq("row level security on both tables",
    (await q(`select relname from pg_class where relname in ('import_runs','import_rows') and relrowsecurity order by 1`)).map((r) => r.relname),
    ["import_rows", "import_runs"]);

  // ── what the import does to members and the ledger ──
  const member = async (cid, tier = "silver") => (await q(
    `insert into members (shopify_customer_id, email, referral_slug, tier, consent_given, consent_given_at, consent_source, imported_from_smile)
     values ($1, $2, $3, $4, true, now(), 'import', true) returning id`, [cid, `${cid}@x.com`, `slug-${cid}`, tier]))[0].id;
  const award = async (m, ref, pts) => (await q(
    `select * from award_points($1::uuid, 'import', $2, $3, null, null, $4, null::numeric, $5)`,
    [m, ref, pts, "Smile import test", "Points brought over from your previous rewards balance"]))[0];
  const silver = await member("S1");
  const gold = await member("G1", "gold");
  ok("consent_source 'import' accepted", true);

  const r1 = await award(silver, "smile:111", 12500);
  eq("import award for a Silver member", [r1.awarded, r1.new_balance], [true, 12500]);
  const days = (await q(`select silver_expiry_days d from app_settings where id = 1`))[0].d;
  const sRow = (await q(
    `select action_type, reference_id, points, points_remaining, customer_note,
            round(extract(epoch from (expires_at - earned_at)) / 86400)::int as days
       from points_ledger where member_id = $1`, [silver]))[0];
  eq("Silver import row: action, reference, FIFO tranche and expiry one year from import",
    [sRow.action_type, sRow.reference_id, sRow.points, sRow.points_remaining, sRow.days],
    ["import", "smile:111", 12500, 12500, days]);
  eq("silver_expiry_days is 365", days, 365);

  const again = await award(silver, "smile:111", 12500);
  eq("same reference again adds nothing", [again.awarded, again.new_balance], [false, 12500]);
  eq("still one import row", (await q(`select count(*)::int n from points_ledger where member_id = $1`, [silver]))[0].n, 1);

  const r2 = await award(gold, "smile:222", 800);
  const gRow = (await q(`select expires_at, points_remaining from points_ledger where member_id = $1`, [gold]))[0];
  eq("Gold import row has no expiry", [r2.awarded, gRow.expires_at, gRow.points_remaining], [true, null, 800]);

  // tier from Smile: member created at Silver, then raised atomically BEFORE the award
  const vip = await member("V1");
  const [{ upgrade_member_tier: raised }] = await q(`select upgrade_member_tier($1, 'gold')`, [vip]);
  await award(vip, "smile:333", 500);
  eq("upgrade_member_tier raises tier and writes history in one call",
    [raised, (await q(`select tier from members where id = $1`, [vip]))[0].tier,
      await q(`select from_tier, to_tier, shopify_order_id from tier_history where member_id = $1`, [vip])],
    [true, "gold", [{ from_tier: "silver", to_tier: "gold", shopify_order_id: null }]]);
  eq("award after the raise has no expiry", (await q(`select expires_at from points_ledger where member_id = $1`, [vip]))[0].expires_at, null);
  eq("raising again is a no-op with no second history row",
    [(await q(`select upgrade_member_tier($1, 'gold')`, [vip]))[0].upgrade_member_tier,
      (await q(`select count(*)::int n from tier_history where member_id = $1`, [vip]))[0].n], [false, 1]);
  eq("a tier is never lowered", (await q(`select upgrade_member_tier($1, 'silver')`, [vip]))[0].upgrade_member_tier, false);
  // existing Silver member with points that carry an expiry: the raise stops the clock
  await q(`select upgrade_member_tier($1, 'diamond')`, [silver]);
  eq("raising an existing member clears pending expiry",
    (await q(`select count(*)::int n from points_ledger where member_id = $1 and expires_at is not null`, [silver]))[0].n, 0);

  // welcome-bonus lookups used by the dry run
  await q(`select * from award_points($1::uuid, 'signup', 'S1', 1000, null, null, null, null::numeric, null)`, [silver]);
  eq("signup + import coexist on one member",
    (await q(`select action_type from points_ledger where member_id = $1 order by earned_at, action_type`, [silver])).map((r) => r.action_type).sort(),
    ["import", "signup"]);

  // ── retention: scrub contact fields, then delete rows; cascade on run delete ──
  await upsert(6, "matched", { first: "B", phone: "+92301" });
  await q(`update import_rows set shopify_first_name = null, shopify_last_name = null, shopify_phone = null where run_id = $1`, [run]);
  eq("contact fields scrubbed", (await q(`select count(*)::int n from import_rows where run_id = $1 and (shopify_first_name is not null or shopify_phone is not null)`, [run]))[0].n, 0);
  await q(`update import_runs set status = 'completed', finished_at = now() - interval '31 days' where id = $1`, [run]);
  eq("runs due for purging are found",
    (await q(`select id from import_runs where status in ('completed','cancelled') and rows_purged_at is null and finished_at < now() - interval '30 days'`)).map((r) => r.id), [run]);
  await q(`delete from import_rows where run_id = $1`, [run]);
  await q(`update import_runs set rows_purged_at = now() where id = $1`, [run]);
  eq("rows deleted, run and totals kept", [(await q(`select count(*)::int n from import_rows where run_id = $1`, [run]))[0].n,
    (await q(`select count(*)::int n from import_runs where id = $1`, [run]))[0].n], [0, 1]);
  const [{ id: run9 }] = await q(`insert into import_runs (status) values ('planning') returning id`);
  await q(`insert into import_rows (run_id, row_number, state) values ($1, 1, 'pending')`, [run9]);
  await q(`delete from import_runs where id = $1`, [run9]);
  eq("deleting a run removes its rows", (await q(`select count(*)::int n from import_rows where run_id = $1`, [run9]))[0].n, 0);
} catch (e) {
  fail++; failures.push(`crashed: ${e.message}`);
  console.log("  CRASH", e.message);
} finally {
  console.log(`\n${pass} passed, ${fail} failed`);
  if (failures.length) console.log("failures:", failures.join(" | "));
  await db.end(); await db2.end();
  await server.stop();
  fs.rmSync(dataDir, { recursive: true, force: true });
  process.exit(fail ? 1 : 0);
}
