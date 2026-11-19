// app/lib/testing/fake-db.ts
// In-memory stand-in for the Supabase client, for unit tests only. It
// implements the query-builder calls the engine uses and a small JavaScript
// model of the three points functions. The real SQL is tested separately
// against Postgres (supabase/tests/010_v3_core.pgtest.mjs).
import crypto from "node:crypto";

export type Row = Record<string, unknown>;
type Filter = (row: Row) => boolean;
type DbError = { code: string; message: string };
type Result<T> = { data: T; error: DbError | null; count?: number | null };

const TABLE_DEFAULTS: Record<string, () => Row> = {
  members: () => ({
    email: null, phone: null, first_name: null, last_name: null, tier: "silver", points_balance: 0,
    lifetime_spend_pkr: 0, referred_by_member_id: null, birthday_month: null, birthday_day: null,
    birthday_set_at: null, consent_given: false, consent_given_at: null, consent_source: null,
    is_blocked: false, opted_out: false, is_influencer: false, influencer_referral_rate: null,
    influencer_multiplier: null, influencer_campaign: null, influencer_paused: false,
    influencer_rate_starts_at: null, influencer_rate_ends_at: null, influencer_code: null,
    influencer_code_percent: null, influencer_code_discount_id: null, last_seen_ip: null,
    referrals_blocked: false, imported_from_smile: false, first_order_awarded_at: null,
  }),
  points_ledger: () => ({
    shopify_order_id: null, reference_id: null, reason_note: null, customer_note: null,
    expires_at: null, expired: false, points_remaining: null, earned_at: new Date().toISOString(),
  }),
  order_webhook_state: () => ({
    shopify_customer_id: null, fulfillment_status: null, financial_status: null, points_awarded: false,
    order_total_pkr: null, order_name: null, placed_at: null, cancelled_at: null, earning_basis_pkr: null,
    gift_card_amount_pkr: 0, refunded_basis_pkr: 0, multiplier_used: null, campaign_id: null,
    pending_points: 0, points_awarded_amount: 0, points_reversed_amount: 0, discount_codes: [],
    influencer_member_id: null, is_first_order: null, gross_basis_pkr: null, refund_events_basis_pkr: 0,
    refund_ids: [], refund_basis_at_award_pkr: 0, spend_reversed_pkr: 0, source_updated_at: null,
    points_rate: null, taxes_included: false,
  }),
  loyalty_codes: () => ({
    kind: "reward", status: "active", shopify_discount_id: null, issue_key: null, cancelled_at: null,
    used_at: null, shopify_order_id: null, shopify_price_rule_id: null, shopify_discount_code_id: null,
    discount_amount_pkr: 0,
  }),
  referrals: () => ({
    referred_shopify_customer_id: null, referred_email: null, referred_ip: null, referrer_ip: null,
    status: "pending", block_reason: null, shopify_order_id: null, points_awarded: false,
    completed_at: null, reward_points: null, friend_code_id: null, reviewed_at: null, reviewed_note: null,
    fraud_flags: [],
  }),
  review_claims: () => ({ shopify_order_id: null, status: "pending", claimed_at: new Date().toISOString(), resolved_at: null }),
  social_actions: () => ({ status: "pending", points_awarded: null }),
  bonus_campaigns: () => ({ is_active: true, deactivated_at: null }),
  gdpr_requests: () => ({ status: "open", shopify_customer_id: null, payload: null }),
  system_heartbeat: () => ({ detail: {} }),
};

const UNIQUE: Record<string, string[][]> = {
  members: [["shopify_customer_id"], ["referral_slug"], ["influencer_code"]],
  points_ledger: [["member_id", "action_type", "reference_id"]],
  order_webhook_state: [["shopify_order_id"]],
  loyalty_codes: [["code"], ["issue_key"]],
  notification_log: [["member_id", "event_type", "reference_id"]],
  social_actions: [["member_id", "action_type"]],
  system_heartbeat: [["key"]],
};

// Partial unique indexes from migration 010.
const PARTIAL_UNIQUE: Record<string, Array<{ cols: string[]; when: Filter; name: string }>> = {
  referrals: [{
    cols: ["referred_shopify_customer_id"],
    when: (r) => r.status === "pending" || r.status === "flagged",
    name: "referrals_one_open_per_referred_uniq",
  }],
  review_claims: [{
    cols: ["shopify_order_id"],
    when: (r) => r.status !== "rejected" && r.shopify_order_id != null,
    name: "review_claims_one_per_order_uniq",
  }],
};

// Embedded parent rows, e.g. select("..., members!inner(tier)").
const PARENTS: Record<string, { table: string; fk: string }> = {
  members: { table: "members", fk: "member_id" },
};

export class FakeDb {
  tables: Record<string, Row[]> = {};
  rpcCalls: Array<{ fn: string; args: Row }> = [];
  /** Make the next call(s) on a table fail: failNext("members", "update", { code, message }). */
  private failures: Array<{ table: string; op: string; error: DbError }> = [];

  constructor(seed: Record<string, Row[]> = {}) {
    for (const [t, rows] of Object.entries(seed)) for (const r of rows) this.seed(t, r);
  }

  table(name: string): Row[] {
    return (this.tables[name] ??= []);
  }

  seed(table: string, row: Row): Row {
    const full: Row = {
      ...(table === "system_heartbeat" ? {} : { id: crypto.randomUUID() }),
      created_at: new Date().toISOString(),
      ...(TABLE_DEFAULTS[table]?.() ?? {}),
      ...row,
    };
    this.table(table).push(full);
    return full;
  }

  failNext(table: string, op: "select" | "insert" | "update" | "delete" | "upsert", error: DbError): void {
    this.failures.push({ table, op, error });
  }

  takeFailure(table: string, op: string): DbError | null {
    const i = this.failures.findIndex((f) => f.table === table && f.op === op);
    if (i < 0) return null;
    return this.failures.splice(i, 1)[0].error;
  }

  uniqueViolation(table: string, candidate: Row, ignore?: Row): DbError | null {
    for (const cols of UNIQUE[table] ?? []) {
      if (cols.some((c) => candidate[c] === null || candidate[c] === undefined) && table !== "points_ledger") continue;
      const clash = this.table(table).find((r) => r !== ignore && cols.every((c) => (r[c] ?? null) === (candidate[c] ?? null)));
      if (clash) return { code: "23505", message: `duplicate key value violates unique constraint "${table}_${cols.join("_")}_key"` };
    }
    for (const p of PARTIAL_UNIQUE[table] ?? []) {
      if (!p.when(candidate)) continue;
      const clash = this.table(table).find((r) => r !== ignore && p.when(r) && p.cols.every((c) => r[c] === candidate[c]));
      if (clash) return { code: "23505", message: `duplicate key value violates unique constraint "${p.name}"` };
    }
    return null;
  }

  from(table: string): Query {
    return new Query(this, table);
  }

  async rpc(fn: string, args: Row): Promise<Result<Row[] | null>> {
    this.rpcCalls.push({ fn, args });
    const fail = this.takeFailure(`rpc:${fn}`, "select");
    if (fail) return { data: null, error: fail };
    try {
      if (fn === "award_points") return { data: [this.awardPoints(args)], error: null };
      if (fn === "award_order_points") return { data: [this.awardOrderPoints(args)], error: null };
      if (fn === "reverse_order_points") return { data: [this.reverseOrderPoints(args)], error: null };
      if (fn === "sync_order_snapshot") return { data: [this.syncOrderSnapshot(args)], error: null };
      if (fn === "upgrade_member_tier") return { data: this.upgradeMemberTier(args) as never, error: null };
      return { data: null, error: { code: "PGRST202", message: `function ${fn} not found` } };
    } catch (err) {
      return { data: null, error: { code: "P0001", message: err instanceof Error ? err.message : String(err) } };
    }
  }

  // ── JavaScript model of the SQL functions (kept deliberately small) ──
  private awardPoints(a: Row): Row {
    const member = this.table("members").find((m) => m.id === a.p_member_id);
    if (!member) throw new Error(`member ${String(a.p_member_id)} not found`);
    const balance = Number(member.points_balance);
    const lifetime = Number(member.lifetime_spend_pkr);
    const ledger = this.table("points_ledger");
    const ref = (a.p_reference_id ?? null) as string | null;
    const dup = ledger.some((l) => l.member_id === member.id && l.action_type === a.p_action_type && (l.reference_id ?? null) === ref);
    if (dup) return { awarded: false, new_balance: balance, new_lifetime_spend_pkr: lifetime };

    let delta = Number(a.p_points);
    const live = () =>
      ledger
        .filter((l) => l.member_id === member.id && Number(l.points) > 0 && !l.expired && Number(l.points_remaining ?? 0) > 0)
        .sort((x, y) => String(x.earned_at).localeCompare(String(y.earned_at)));

    if (a.p_action_type === "expiry") {
      const src = ledger.find((l) => l.id === ref && l.member_id === member.id && Number(l.points) > 0 && !l.expired);
      if (!src || member.tier !== "silver") return { awarded: false, new_balance: balance, new_lifetime_spend_pkr: lifetime };
      if (Number(src.points_remaining ?? 0) <= 0 || balance <= 0) {
        src.points_remaining = 0;
        src.expired = true;
        return { awarded: false, new_balance: balance, new_lifetime_spend_pkr: lifetime };
      }
      delta = -Math.min(Number(src.points_remaining ?? 0), balance);
      src.points_remaining = 0;
      src.expired = true;
    } else if (a.p_action_type === "redemption" && balance + delta < 0) {
      return { awarded: false, new_balance: balance, new_lifetime_spend_pkr: lifetime };
    } else if (balance + delta < 0) {
      delta = -balance;
    }
    if (delta < 0 && a.p_action_type !== "expiry") {
      let left = -delta;
      for (const t of live()) {
        if (left <= 0) break;
        const take = Math.min(Number(t.points_remaining), left);
        t.points_remaining = Number(t.points_remaining) - take;
        left -= take;
      }
    }
    const newBalance = balance + delta;
    this.seed("points_ledger", {
      member_id: member.id,
      action_type: a.p_action_type,
      reference_id: ref,
      points: delta,
      balance_after: newBalance,
      expires_at: delta > 0 ? (a.p_expires_at ?? null) : null,
      points_remaining: delta > 0 ? delta : null,
      shopify_order_id: a.p_shopify_order_id ?? null,
      reason_note: a.p_reason_note ?? null,
      customer_note: a.p_customer_note ?? null,
    });
    member.points_balance = newBalance;
    if (a.p_action_type === "purchase" && a.p_purchase_amount_pkr != null) {
      member.lifetime_spend_pkr = lifetime + Number(a.p_purchase_amount_pkr);
    }
    return { awarded: true, new_balance: newBalance, new_lifetime_spend_pkr: Number(member.lifetime_spend_pkr) };
  }

  private awardOrderPoints(a: Row): Row {
    const order = this.table("order_webhook_state").find((o) => o.shopify_order_id === a.p_shopify_order_id);
    const member = this.table("members").find((m) => m.id === a.p_member_id);
    if (!member) throw new Error("member not found");
    const snapshot = () => ({ new_balance: Number(member.points_balance), new_lifetime_spend_pkr: Number(member.lifetime_spend_pkr) });
    if (!order || order.cancelled_at || order.points_awarded) return { awarded: false, ...snapshot() };
    const own = order.gross_basis_pkr != null; // the row's own figures win over the caller's
    const points = Math.max(0, Number((own ? order.pending_points : a.p_points) ?? 0));
    const basis = Math.max(0, Number((own ? order.earning_basis_pkr : a.p_basis_pkr) ?? 0));
    if (points > 0) {
      this.awardPoints({
        p_member_id: member.id, p_action_type: "purchase", p_reference_id: a.p_shopify_order_id, p_points: points,
        p_expires_at: a.p_expires_at, p_shopify_order_id: a.p_shopify_order_id, p_purchase_amount_pkr: basis,
      });
    } else {
      member.lifetime_spend_pkr = Number(member.lifetime_spend_pkr) + basis;
    }
    Object.assign(order, {
      points_awarded: true, points_awarded_amount: points, multiplier_used: order.multiplier_used ?? a.p_multiplier,
      earning_basis_pkr: basis, gross_basis_pkr: order.gross_basis_pkr ?? basis + Number(order.refunded_basis_pkr),
      refund_basis_at_award_pkr: Number(order.refunded_basis_pkr), spend_reversed_pkr: 0, pending_points: 0,
    });
    if (!member.first_order_awarded_at) member.first_order_awarded_at = new Date().toISOString();
    return { awarded: true, ...snapshot() };
  }

  /** Bring reversed points in line with the order's totals (model of reconcile_order_points). */
  private reconcile(order: Row, reference: string, note: string): Row {
    const member = this.table("members").find((m) => m.shopify_customer_id === order.shopify_customer_id);
    if (!member || !order.points_awarded) return { reversed: 0, new_balance: member ? Number(member.points_balance) : null };
    const cancelled = !!order.cancelled_at;
    const basis = Math.max(0, Number(order.earning_basis_pkr ?? order.order_total_pkr ?? 0));
    const awarded = Number(order.points_awarded_amount);
    const already = Number(order.points_reversed_amount);
    const post = cancelled
      ? basis
      : Math.min(Math.max(Number(order.refunded_basis_pkr) - Number(order.refund_basis_at_award_pkr), 0), basis);
    const target = cancelled ? awarded : basis > 0 ? Math.round((awarded * post) / basis) : 0;
    const amount = Math.min(Math.max(target - already, 0), Math.max(awarded - already, 0));
    const cut = Math.max(post - Number(order.spend_reversed_pkr), 0);
    if (amount <= 0 && cut <= 0) return { reversed: 0, new_balance: Number(member.points_balance) };
    const before = Number(member.points_balance);
    if (amount > 0) {
      const action = cancelled ? "order_cancelled" : "refund_deduction";
      let ref = reference;
      if (this.table("points_ledger").some((l) => l.member_id === member.id && l.action_type === action && l.reference_id === ref)) {
        ref = `${ref}:${already}`;
      }
      this.awardPoints({
        p_member_id: member.id, p_action_type: action, p_reference_id: ref, p_points: -amount,
        p_shopify_order_id: order.shopify_order_id,
        p_customer_note: order.order_name ? `${note} (${String(order.order_name)})` : note,
      });
    }
    order.points_reversed_amount = already + amount;
    order.spend_reversed_pkr = post;
    member.lifetime_spend_pkr = Math.max(0, Number(member.lifetime_spend_pkr) - cut);
    return { reversed: before - Number(member.points_balance), new_balance: Number(member.points_balance) };
  }

  private reverseOrderPoints(a: Row): Row {
    const order = this.table("order_webhook_state").find((o) => o.shopify_order_id === a.p_shopify_order_id);
    if (!order) return { reversed: 0, new_balance: null };
    if (a.p_kind === "cancel") {
      order.cancelled_at = order.cancelled_at ?? new Date().toISOString();
      order.pending_points = 0;
      return this.reconcile(order, String(a.p_reference_id), "Order cancelled");
    }
    const refund = Math.max(0, Number(a.p_refunded_basis_pkr ?? 0));
    const ids = order.refund_ids as string[];
    if (refund > 0 && !ids.includes(String(a.p_reference_id))) {
      const gross = Number(
        order.gross_basis_pkr ??
          Number(order.earning_basis_pkr ?? order.order_total_pkr ?? 0) +
            Number(order.points_awarded ? order.refund_basis_at_award_pkr : order.refunded_basis_pkr),
      );
      const events = Number(order.refund_events_basis_pkr) + refund;
      const total = Math.min(gross, Math.max(Number(order.refunded_basis_pkr), events));
      if (!order.points_awarded && !order.cancelled_at) {
        const earning = Math.max(gross - total, 0);
        order.pending_points =
          order.points_rate != null
            ? Math.floor(earning * Number(order.points_rate) * Number(order.multiplier_used ?? 1) + 1e-6)
            : Number(order.earning_basis_pkr ?? 0) > 0
              ? Math.floor((Number(order.pending_points) * earning) / Number(order.earning_basis_pkr))
              : 0;
        order.earning_basis_pkr = earning;
      }
      Object.assign(order, { gross_basis_pkr: gross, refund_events_basis_pkr: events, refunded_basis_pkr: total });
      ids.push(String(a.p_reference_id));
    }
    return this.reconcile(order, String(a.p_reference_id), "Order refunded");
  }

  private syncOrderSnapshot(a: Row): Row {
    const order = this.table("order_webhook_state").find((o) => o.shopify_order_id === a.p_shopify_order_id);
    if (!order) return { applied: false, reversed: 0, pending_points: 0 };
    const at = a.p_source_updated_at ? Date.parse(String(a.p_source_updated_at)) : null;
    const stored = order.source_updated_at ? Date.parse(String(order.source_updated_at)) : null;
    if (at !== null && stored !== null && at < stored) return { applied: false, reversed: 0, pending_points: order.pending_points };
    const current = Math.max(0, Number(a.p_current_basis_pkr ?? 0));
    const gross = Math.max(
      Number(order.gross_basis_pkr ?? (order.points_awarded ? Number(order.earning_basis_pkr ?? 0) + Number(order.refund_basis_at_award_pkr) : 0)),
      Number(a.p_gross_basis_pkr ?? 0),
      current,
    );
    const total = Math.min(gross, Math.max(Number(order.refunded_basis_pkr), gross - current, Number(order.refund_events_basis_pkr)));
    Object.assign(order, {
      gross_basis_pkr: gross, refunded_basis_pkr: total,
      source_updated_at: a.p_source_updated_at ?? order.source_updated_at,
    });
    if (order.points_awarded || order.cancelled_at) {
      const reversed =
        order.points_awarded && !order.cancelled_at
          ? Number(this.reconcile(order, `sync:${String(order.shopify_order_id)}:${at ?? "na"}`, "Order refunded").reversed)
          : 0;
      return { applied: true, reversed, pending_points: 0 };
    }
    const rate = a.p_can_earn ? Math.max(0, Number(a.p_points_rate ?? 0)) : 0;
    const earning = Math.max(gross - total, 0);
    const pending = Math.max(0, Math.floor(earning * rate * Number(order.multiplier_used ?? 1) + 1e-6));
    Object.assign(order, { earning_basis_pkr: earning, points_rate: rate, pending_points: pending });
    return { applied: true, reversed: 0, pending_points: pending };
  }

  private upgradeMemberTier(a: Row): boolean {
    const rank: Record<string, number> = { silver: 0, gold: 1, diamond: 2 };
    const member = this.table("members").find((m) => m.id === a.p_member_id);
    if (!member) throw new Error("member not found");
    const from = String(member.tier);
    const to = String(a.p_to_tier);
    if (!(to in rank)) throw new Error(`unknown tier ${to}`);
    if (rank[to] <= (rank[from] ?? 0)) return false;
    member.tier = to;
    this.seed("tier_history", { member_id: member.id, from_tier: from, to_tier: to, shopify_order_id: a.p_shopify_order_id ?? null });
    for (const l of this.table("points_ledger")) {
      if (l.member_id === member.id && !l.expired && l.expires_at != null) l.expires_at = null;
    }
    return true;
  }
}

class Query implements PromiseLike<Result<Row[] | Row | null>> {
  private op: "select" | "insert" | "update" | "delete" | "upsert" = "select";
  private filters: Filter[] = [];
  private payload: Row | Row[] | null = null;
  private returning = false;
  private orderBy: Array<{ col: string; asc: boolean }> = [];
  private max: number | null = null;
  private window: [number, number] | null = null;
  private mode: "many" | "single" | "maybeSingle" = "many";
  private selectCols = "*";
  private head = false;
  private wantCount = false;
  private conflict: string | null = null;

  constructor(private db: FakeDb, private name: string) {}

  select(cols = "*", opts?: { count?: string; head?: boolean }): this {
    if (this.op !== "select") this.returning = true;
    this.selectCols = cols;
    this.head = !!opts?.head;
    this.wantCount = !!opts?.count;
    return this;
  }
  insert(rows: Row | Row[]): this { this.op = "insert"; this.payload = rows; return this; }
  update(patch: Row): this { this.op = "update"; this.payload = patch; return this; }
  upsert(rows: Row | Row[], opts?: { onConflict?: string }): this {
    this.op = "upsert"; this.payload = rows; this.conflict = opts?.onConflict ?? null; return this;
  }
  delete(): this { this.op = "delete"; return this; }

  private get(row: Row, col: string): unknown {
    if (col.includes(".")) {
      const [parent, field] = col.split(".");
      const link = PARENTS[parent];
      const p = link ? this.db.table(link.table).find((r) => r.id === row[link.fk]) : undefined;
      return p ? p[field] : undefined;
    }
    return row[col];
  }
  private cmp(col: string, test: (v: unknown) => boolean): this {
    this.filters.push((r) => test(this.get(r, col)));
    return this;
  }
  eq(col: string, v: unknown): this { return this.cmp(col, (x) => x === v); }
  neq(col: string, v: unknown): this { return this.cmp(col, (x) => x !== v); }
  in(col: string, vs: unknown[]): this { return this.cmp(col, (x) => vs.includes(x)); }
  is(col: string, v: unknown): this { return this.cmp(col, (x) => (v === null ? x === null || x === undefined : x === v)); }
  not(col: string, op: string, v: unknown): this {
    if (op === "is" && v === null) return this.cmp(col, (x) => x !== null && x !== undefined);
    return this.cmp(col, (x) => x !== v);
  }
  // SQL comparisons with NULL are never true.
  lt(col: string, v: unknown): this { return this.cmp(col, (x) => x != null && (x as never) < (v as never)); }
  lte(col: string, v: unknown): this { return this.cmp(col, (x) => x != null && (x as never) <= (v as never)); }
  gt(col: string, v: unknown): this { return this.cmp(col, (x) => x != null && (x as never) > (v as never)); }
  gte(col: string, v: unknown): this { return this.cmp(col, (x) => x != null && (x as never) >= (v as never)); }
  order(col: string, opts?: { ascending?: boolean }): this { this.orderBy.push({ col, asc: opts?.ascending !== false }); return this; }
  limit(n: number): this { this.max = n; return this; }
  range(a: number, b: number): this { this.window = [a, b]; return this; }
  single(): this { this.mode = "single"; return this; }
  maybeSingle(): this { this.mode = "maybeSingle"; return this; }

  private shape(rows: Row[]): Result<Row[] | Row | null> {
    let out = rows.map((r) => ({ ...r }));
    for (const [parent, link] of Object.entries(PARENTS)) {
      if (this.selectCols.includes(`${parent}!inner`) || this.selectCols.includes(`${parent}(`)) {
        out = out
          .map((r) => ({ ...r, [parent]: this.db.table(link.table).find((p) => p.id === r[link.fk]) ?? null }))
          .filter((r) => !this.selectCols.includes(`${parent}!inner`) || r[parent] !== null);
      }
    }
    for (const o of [...this.orderBy].reverse()) {
      out.sort((a, b) => {
        const x = a[o.col] as never, y = b[o.col] as never;
        return (x < y ? -1 : x > y ? 1 : 0) * (o.asc ? 1 : -1);
      });
    }
    const count = out.length;
    if (this.window) out = out.slice(this.window[0], this.window[1] + 1);
    if (this.max !== null) out = out.slice(0, this.max);
    if (this.head) return { data: null, error: null, count };
    if (this.mode === "single") {
      if (out.length !== 1) return { data: null, error: { code: "PGRST116", message: "JSON object requested, multiple (or no) rows returned" } };
      return { data: out[0], error: null };
    }
    if (this.mode === "maybeSingle") {
      if (out.length > 1) return { data: null, error: { code: "PGRST116", message: "JSON object requested, multiple rows returned" } };
      return { data: out[0] ?? null, error: null };
    }
    return { data: out, error: null, count: this.wantCount ? count : null };
  }

  private run(): Result<Row[] | Row | null> {
    const forced = this.db.takeFailure(this.name, this.op);
    if (forced) return { data: null, error: forced };
    const rows = this.db.table(this.name);
    const match = (r: Row) => this.filters.every((f) => f(r));

    if (this.op === "select") return this.shape(rows.filter(match));

    if (this.op === "insert" || this.op === "upsert") {
      const list = Array.isArray(this.payload) ? this.payload : [this.payload as Row];
      const created: Row[] = [];
      for (const raw of list) {
        if (this.op === "upsert" && this.conflict) {
          const keys = this.conflict.split(",").map((k) => k.trim());
          const existing = rows.find((r) => keys.every((k) => r[k] === raw[k]));
          if (existing) { Object.assign(existing, raw); created.push(existing); continue; }
        }
        const candidate = { ...(TABLE_DEFAULTS[this.name]?.() ?? {}), ...raw };
        const clash = this.db.uniqueViolation(this.name, candidate);
        if (clash) return { data: null, error: clash };
        created.push(this.db.seed(this.name, raw));
      }
      return this.returning ? this.shape(created) : { data: null, error: null };
    }

    const hit = rows.filter(match);
    if (this.op === "update") {
      for (const r of hit) {
        const clash = this.db.uniqueViolation(this.name, { ...r, ...(this.payload as Row) }, r);
        if (clash) return { data: null, error: clash };
      }
      for (const r of hit) Object.assign(r, this.payload as Row);
      return this.returning ? this.shape(hit) : { data: null, error: null };
    }
    // delete
    this.db.tables[this.name] = rows.filter((r) => !hit.includes(r));
    return this.returning ? this.shape(hit) : { data: null, error: null };
  }

  then<A = Result<Row[] | Row | null>, B = never>(
    ok?: ((value: Result<Row[] | Row | null>) => A | PromiseLike<A>) | null,
    bad?: ((reason: unknown) => B | PromiseLike<B>) | null,
  ): PromiseLike<A | B> {
    return Promise.resolve().then(() => this.run()).then(ok, bad);
  }
}

/** Queue stand-in: records what was added. */
export function fakeQueue() {
  const jobs: Array<{ name: string; data: Row; opts?: Row }> = [];
  return {
    jobs,
    add: async (name: string, data: Row, opts?: Row) => {
      jobs.push({ name, data, opts });
      return { id: String(jobs.length) };
    },
    /** Repeatable schedules removed with removeRepeatable(name, repeat, jobId). */
    removedRepeatables: [] as Array<{ name: string; repeat: Row; jobId?: string }>,
    async removeRepeatable(name: string, repeat: Row, jobId?: string) {
      this.removedRepeatables.push({ name, repeat, jobId });
      return true;
    },
    getFailedCount: async () => 0,
    /** Jobs a test wants to exist already (e.g. a failed job with a fixed id). */
    existing: new Map<string, { failed: boolean; removed: boolean }>(),
    async getJob(id: string) {
      const j = this.existing.get(id);
      if (!j || j.removed) return undefined;
      return { isFailed: async () => j.failed, isCompleted: async () => false, remove: async () => { j.removed = true; } };
    },
    named: (name: string) => jobs.filter((j) => j.name === name),
    clear: () => {
      jobs.length = 0;
    },
  };
}
