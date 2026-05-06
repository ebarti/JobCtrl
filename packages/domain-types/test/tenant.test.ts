import { describe, it, expect } from "vitest";
import { createTenantId, LOCAL_TENANT, type TenantId } from "../src/tenant.js";

describe("TenantId", () => {
  it("LOCAL_TENANT equals 'local'", () => {
    expect(LOCAL_TENANT).toBe("local");
  });

  it("createTenantId returns a branded string", () => {
    const id: TenantId = createTenantId("tenant-abc");
    expect(id).toBe("tenant-abc");
    // TenantId should be usable as a string
    expect(id.toUpperCase()).toBe("TENANT-ABC");
  });

  it("createTenantId throws on empty string", () => {
    expect(() => createTenantId("")).toThrow("TenantId cannot be empty");
  });

  it("createTenantId throws on whitespace-only string", () => {
    expect(() => createTenantId("   ")).toThrow("TenantId cannot be empty");
  });

  it("LOCAL_TENANT is assignable to TenantId", () => {
    const id: TenantId = LOCAL_TENANT;
    expect(id).toBe("local");
  });
});
