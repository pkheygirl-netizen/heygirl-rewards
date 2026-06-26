// app/widget/api.ts
// All fetch calls go through Shopify App Proxy — relative to heygirl.pk.
// Shopify appends customer_id and signature automatically.
const BASE = "/apps/loyalty";

export type CustomerResponse = {
  loggedIn: boolean;
  member?: {
    memberId: string;
    firstName: string | null;
    tier: "silver" | "gold" | "diamond";
    balance: number;
    lifetimeSpend: number;
    nextTier: "gold" | "diamond" | null;
    spendToNextTier: number;
    activeCodes: Array<{ code: string; discount_pkr: number; expires_at: string }>;
    referralSlug: string | null;
    birthdayMonth: number | null;
  } | null;
  nudgeSettings: {
    nudge1_enabled: boolean;
    nudge2_enabled: boolean;
    nudge3_enabled: boolean;
    nudge5_enabled: boolean;
    tier_progress_gold_threshold: number;
    tier_progress_diamond_threshold: number;
  };
};

export async function fetchCustomer(): Promise<CustomerResponse | null> {
  try {
    const res = await fetch(`${BASE}/customer`);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

export async function fetchHistory(page = 1, filterType: string | null = null) {
  try {
    const params = new URLSearchParams({ page: String(page) });
    if (filterType) params.set("type", filterType);
    const res = await fetch(`${BASE}/history?${params}`);
    if (!res.ok) return { items: [], total: 0 };
    return await res.json();
  } catch {
    return { items: [], total: 0 };
  }
}

export async function fetchReferral() {
  try {
    const res = await fetch(`${BASE}/referral`);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

export async function redeem(requestedPoints: number) {
  try {
    const res = await fetch(`${BASE}/redeem`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requestedPoints }),
    });
    return await res.json();
  } catch {
    return { redeemed: false, error: "network_error" };
  }
}

export async function claimSocial(platform: "youtube" | "facebook" | "instagram") {
  try {
    const res = await fetch(`${BASE}/social`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ platform }),
    });
    return await res.json();
  } catch {
    return { queued: false };
  }
}
