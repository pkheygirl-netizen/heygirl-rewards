import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeDb } from "./admin-test-helpers";

beforeEach(() => {
  vi.resetModules();
});

async function load(script: Parameters<typeof fakeDb>[0] = {}) {
  vi.resetModules();
  const fake = fakeDb(script);
  vi.doMock("../db.server", () => ({ db: fake.db }));
  return { fake, mod: await import("./admin-db.server") };
}

describe("rpc helpers", () => {
  it("rpcRows always returns an array", async () => {
    expect(await (await load({ rpc: () => ({ data: [{ a: 1 }] }) })).mod.rpcRows("f")).toEqual([{ a: 1 }]);
    expect(await (await load({ rpc: () => ({ data: { a: 1 } }) })).mod.rpcRows("f")).toEqual([{ a: 1 }]);
    expect(await (await load({ rpc: () => ({ data: null }) })).mod.rpcRows("f")).toEqual([]);
  });

  it("rpcObject unwraps a single-row array and never returns null", async () => {
    expect(await (await load({ rpc: () => ({ data: [{ a: 1 }] }) })).mod.rpcObject("f")).toEqual({ a: 1 });
    expect(await (await load({ rpc: () => ({ data: null }) })).mod.rpcObject("f")).toEqual({});
  });

  it("both name the function in the error", async () => {
    const { mod } = await load({ rpc: () => ({ error: { message: "permission denied" } }) });
    await expect(mod.rpcRows("admin_x")).rejects.toThrow("admin_x failed: permission denied");
    await expect(mod.rpcObject("admin_y")).rejects.toThrow("admin_y failed: permission denied");
  });
});

describe("value helpers", () => {
  it("reads numbers from numeric strings and falls back otherwise", async () => {
    const { mod } = await load();
    expect(mod.num("71200.50")).toBe(71200.5);
    expect(mod.num(null, 7)).toBe(7);
    expect(mod.num("", 7)).toBe(7);
    expect(mod.num("abc")).toBe(0);
    expect(mod.strOrNull("")).toBeNull();
    expect(mod.strOrNull(5)).toBe("5");
  });

  it("names a member by name, then email, then phone", async () => {
    const { mod } = await load();
    expect(mod.memberName({ first_name: "Sara", last_name: "Khan" })).toBe("Sara Khan");
    expect(mod.memberName({ first_name: null, email: "s@x.com", phone: "0300" })).toBe("s@x.com");
    expect(mod.memberName({ phone: "0300" })).toBe("0300");
    expect(mod.memberName(null)).toBe("Customer");
  });

  it("extracts the numeric Shopify id from a bare id or a gid", async () => {
    const { mod } = await load();
    expect(mod.shopifyNumericId("gid://shopify/Customer/778899")).toBe("778899");
    expect(mod.shopifyNumericId("778899")).toBe("778899");
    expect(mod.shopifyNumericId("abc")).toBe("");
    expect(mod.UUID_RE.test("11111111-1111-4111-8111-111111111111")).toBe(true);
    expect(mod.UUID_RE.test("11111111-1111-4111-8111-111111111111; drop")).toBe(false);
  });
});
