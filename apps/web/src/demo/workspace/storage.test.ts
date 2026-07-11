import { describe, expect, it, vi } from "vitest";

import {
  DEMO_WORKSPACE_DATABASE,
  DEMO_WORKSPACE_DATABASE_VERSION,
} from "./contracts.js";
import { IndexedDbDemoWorkspaceStore } from "./storage.js";

describe("IndexedDbDemoWorkspaceStore", () => {
  it("opens without a requested version and rejects a future database without writing or downgrading it", async () => {
    const close = vi.fn();
    const database = {
      version: DEMO_WORKSPACE_DATABASE_VERSION + 1,
      close,
      objectStoreNames: { contains: () => true },
    } as unknown as IDBDatabase;
    const request = { result: database } as IDBOpenDBRequest;
    const open = vi.fn(() => {
      queueMicrotask(() => request.onsuccess?.(new Event("success")));
      return request;
    });
    const store = new IndexedDbDemoWorkspaceStore({
      open,
    } as unknown as IDBFactory);

    await expect(store.readSnapshot()).rejects.toMatchObject({
      kind: "upgrade_required",
      foundDatabaseVersion: DEMO_WORKSPACE_DATABASE_VERSION + 1,
    });
    expect(open.mock.calls).toEqual([[DEMO_WORKSPACE_DATABASE]]);
    expect(close).toHaveBeenCalledOnce();
  });
});
