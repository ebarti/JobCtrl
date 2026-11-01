import { JobCtrlApiError } from "@jobctrl/api-client";
import { afterEach, describe, expect, it } from "vitest";

import { useToastStore } from "../stores/toasts.js";
import { createQueryClient } from "./queryClient.js";

describe("global query error notifications", () => {
  afterEach(() => useToastStore.getState().clear());

  it("leaves schema problems to the persistent banner without suppressing unrelated errors", async () => {
    const client = createQueryClient();
    const schemaError = new JobCtrlApiError(503, "Unavailable", "upgrade required", {
      error: "database_migration_required", currentVersion: 14, expectedVersion: 15,
    });
    await expect(client.fetchQuery({ queryKey: ["schema"], retry: false, queryFn: async () => { throw schemaError; } })).rejects.toBe(schemaError);
    expect(useToastStore.getState().toasts).toHaveLength(0);
    await expect(client.fetchQuery({ queryKey: ["other"], retry: false, queryFn: async () => { throw new Error("different failure"); } })).rejects.toThrow("different failure");
    expect(useToastStore.getState().toasts.map((toast) => toast.message)).toEqual(["different failure"]);
    client.clear();
  });
});
