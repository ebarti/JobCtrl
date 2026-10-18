import { LOCAL_TENANT } from "@jobctrl/domain-types";
import { createTestQueryClient } from "../../../test/render.js";
import { buildTestPorts } from "../../../test/testPorts.js";
import { ensureActivityEvent } from "../readQueries.js";
import { waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { renderHookWithProviders } from "../../../test/render.js";
import { useActivityEventQuery } from "./useActivityEventQuery.js";

describe("useActivityEventQuery", () => {
  it("returns the matching activity entry", async () => {
    const { result } = renderHookWithProviders(() =>
      useActivityEventQuery("evt-1"),
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.eventId).toBe("evt-1");
  });

  it("returns null when no event matches", async () => {
    const { result } = renderHookWithProviders(() =>
      useActivityEventQuery("missing"),
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toBeNull();
  });
});

it("keeps loader 404 propagation distinct from the observer's null policy", async () => {
  const ports = buildTestPorts();
  const queryClient = createTestQueryClient();
  await expect(
    ensureActivityEvent(
      { ports, queryClient, tenantId: LOCAL_TENANT },
      "missing",
    ),
  ).rejects.toMatchObject({ status: 404 });
  const { result } = renderHookWithProviders(
    () => useActivityEventQuery("missing"),
    { ports, queryClient },
  );
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  expect(result.current.data).toBeNull();
});
