import type { SessionStorage } from "@shopify/shopify-app-session-storage";
import type { Session } from "@shopify/shopify-api";
import { db } from "./db.server";

export class SupabaseSessionStorage implements SessionStorage {
  async storeSession(session: Session): Promise<boolean> {
    const { error } = await db.from("shopify_sessions").upsert(
      {
        id: session.id,
        shop: session.shop,
        state: session.state,
        is_online: session.isOnline,
        scope: session.scope ?? null,
        expires: session.expires?.toISOString() ?? null,
        access_token: session.accessToken ?? null,
        user_id: (session as any).onlineAccessInfo?.associated_user?.id ?? null,
      },
      { onConflict: "id" }
    );
    if (error) {
      console.error("[session] storeSession error:", error);
      return false;
    }
    return true;
  }

  async loadSession(id: string): Promise<Session | undefined> {
    const { data, error } = await db
      .from("shopify_sessions")
      .select("*")
      .eq("id", id)
      .maybeSingle();

    if (error || !data) return undefined;

    const session = new (await import("@shopify/shopify-api")).Session({
      id: data.id,
      shop: data.shop,
      state: data.state ?? "",
      isOnline: data.is_online,
    });
    if (data.scope) session.scope = data.scope;
    if (data.expires) session.expires = new Date(data.expires);
    if (data.access_token) session.accessToken = data.access_token;
    return session;
  }

  async deleteSession(id: string): Promise<boolean> {
    const { error } = await db
      .from("shopify_sessions")
      .delete()
      .eq("id", id);
    if (error) {
      console.error("[session] deleteSession error:", error);
      return false;
    }
    return true;
  }

  async deleteSessions(ids: string[]): Promise<boolean> {
    const { error } = await db
      .from("shopify_sessions")
      .delete()
      .in("id", ids);
    return !error;
  }

  async findSessionsByShop(shop: string): Promise<Session[]> {
    const { data } = await db
      .from("shopify_sessions")
      .select("*")
      .eq("shop", shop);
    if (!data) return [];

    const { Session } = await import("@shopify/shopify-api");
    return data.map((row: any) => {
      const s = new Session({
        id: row.id,
        shop: row.shop,
        state: row.state,
        isOnline: row.is_online,
      });
      if (row.scope) s.scope = row.scope;
      if (row.expires) s.expires = new Date(row.expires);
      if (row.access_token) s.accessToken = row.access_token;
      return s;
    });
  }
}
