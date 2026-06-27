import { db } from "../db.server";

export type CampaignRow = {
  id: string;
  name: string;
  multiplier: number;
  startsAt: string;
  endsAt: string;
  isActive: boolean;
};

export type CampaignInput = {
  name: string;
  multiplier: number;
  startsAt: string;
  endsAt: string;
  isActive: boolean;
};

function validate(input: CampaignInput) {
  if (!input.name || !input.name.trim()) throw new Error("invalid campaign");
  if (!(input.multiplier >= 1)) throw new Error("invalid campaign");
  if (new Date(input.endsAt).getTime() <= new Date(input.startsAt).getTime()) {
    throw new Error("invalid campaign");
  }
}

async function deactivateAllExcept(exceptId: string | null) {
  let q = db.from("bonus_campaigns").update({ is_active: false });
  q = exceptId ? q.neq("id", exceptId) : q.neq("id", "00000000-0000-0000-0000-000000000000");
  const { error } = await q;
  if (error) throw error;
}

export async function listCampaigns(): Promise<CampaignRow[]> {
  const { data, error } = await db
    .from("bonus_campaigns")
    .select("id, name, multiplier, starts_at, ends_at, is_active")
    .order("created_at", { ascending: false });
  if (error) throw error;
  return (data ?? []).map((c: any) => ({
    id: c.id, name: c.name, multiplier: Number(c.multiplier),
    startsAt: c.starts_at, endsAt: c.ends_at, isActive: c.is_active,
  }));
}

export async function createCampaign(input: CampaignInput): Promise<void> {
  validate(input);
  if (input.isActive) await deactivateAllExcept(null);
  const { error } = await db.from("bonus_campaigns").insert({
    name: input.name.trim(),
    multiplier: input.multiplier,
    starts_at: input.startsAt,
    ends_at: input.endsAt,
    is_active: input.isActive,
  });
  if (error) throw error;
}

export async function updateCampaign(id: string, input: CampaignInput): Promise<void> {
  validate(input);
  if (input.isActive) await deactivateAllExcept(id);
  const { error } = await db
    .from("bonus_campaigns")
    .update({
      name: input.name.trim(),
      multiplier: input.multiplier,
      starts_at: input.startsAt,
      ends_at: input.endsAt,
      is_active: input.isActive,
    })
    .eq("id", id);
  if (error) throw error;
}

export async function deleteCampaign(id: string): Promise<void> {
  const { error } = await db.from("bonus_campaigns").delete().eq("id", id);
  if (error) throw error;
}

export type LedgerExportRow = {
  earnedAt: string;
  memberName: string;
  email: string;
  actionType: string;
  points: number;
  balanceAfter: number;
  reason: string;
};

export async function listLedger(opts: {
  from?: string;
  to?: string;
  actionType?: string;
}): Promise<LedgerExportRow[]> {
  let q = db
    .from("points_ledger")
    .select("earned_at, action_type, points, balance_after, reason_note, members(first_name,last_name,email)");
  if (opts.from) q = q.gte("earned_at", opts.from);
  if (opts.to) q = q.lte("earned_at", opts.to);
  if (opts.actionType) q = q.eq("action_type", opts.actionType);
  const { data, error } = await q.order("earned_at", { ascending: false }).limit(5000);
  if (error) throw error;
  return (data ?? []).map((r: any) => ({
    earnedAt: r.earned_at,
    memberName: [r.members?.first_name, r.members?.last_name].filter(Boolean).join(" ") || "—",
    email: r.members?.email ?? "",
    actionType: r.action_type,
    points: r.points,
    balanceAfter: r.balance_after,
    reason: r.reason_note ?? "",
  }));
}
