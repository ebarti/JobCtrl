import type {
  BrowserCapabilitiesResponse,
  BrowserCapabilityEnableRequest,
  BrowserCapabilityId,
  BrowserProfileCopyRequest,
} from "@jobctrl/contracts";
import { BrowserCapabilitiesResponseSchema } from "@jobctrl/contracts";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { createOptimisticMutation } from "../../../shared/lib/createOptimisticMutation.js";
import { usePorts } from "../../../shared/providers/PortsProvider.js";
import { useTenantId } from "../../../shared/providers/TenantProvider.js";
import { browserCapabilityKeys } from "../browserCapabilityKeys.js";
import { parseBrowserCapabilitiesWrite } from "../browserApi.js";

type EnableInput = BrowserCapabilityEnableRequest & {
  capabilityId: Exclude<BrowserCapabilityId, "core-browser">;
};

export function useEnableBrowserCapabilityMutation() {
  const tenantId = useTenantId();
  const { http } = usePorts();
  const queryClient = useQueryClient();
  return useMutation(
    createOptimisticMutation<BrowserCapabilitiesResponse, EnableInput>(
      queryClient,
      {
        mutationKey: [
          ...browserCapabilityKeys.capabilities(tenantId),
          "enable",
        ],
        mutationFn: async ({ capabilityId, ...browser }) => {
          const path = `/v1/browser-capabilities/${encodeURIComponent(capabilityId)}/enable`;
          return parseBrowserCapabilitiesWrite(await http.json<unknown>("POST", path, { body: browser }), path);
        },
        optimisticUpdates: ({ capabilityId }) => [
          {
            queryKey: browserCapabilityKeys.capabilities(tenantId),
            patch: (current) =>
              patchCapability(current, capabilityId, {
                enabled: true,
                status: "missing",
                detail: "Checking the explicitly selected browser.",
              }),
          },
        ],
        settle: () => [browserCapabilityKeys.capabilities(tenantId)],
      },
    ),
  );
}

export function useDisableBrowserCapabilityMutation() {
  const tenantId = useTenantId();
  const { http } = usePorts();
  const queryClient = useQueryClient();
  return useMutation(
    createOptimisticMutation<
      BrowserCapabilitiesResponse,
      Exclude<BrowserCapabilityId, "core-browser">
    >(queryClient, {
      mutationKey: [...browserCapabilityKeys.capabilities(tenantId), "disable"],
      mutationFn: async (capabilityId) => {
        const path = `/v1/browser-capabilities/${encodeURIComponent(capabilityId)}/disable`;
        return parseBrowserCapabilitiesWrite(await http.json<unknown>("POST", path, { body: {} }), path);
      },
      optimisticUpdates: (capabilityId) => [
        {
          queryKey: browserCapabilityKeys.capabilities(tenantId),
          patch: (current) =>
            patchCapability(current, capabilityId, {
              enabled: false,
              status: "disabled",
              detail: "Disabled; browser access is revoked.",
            }),
        },
      ],
      settle: () => [browserCapabilityKeys.capabilities(tenantId)],
    }),
  );
}

export function useCopyLinkedInBrowserProfileMutation() {
  const tenantId = useTenantId();
  const { http } = usePorts();
  const queryClient = useQueryClient();
  return useMutation(
    createOptimisticMutation<
      BrowserCapabilitiesResponse,
      BrowserProfileCopyRequest
    >(queryClient, {
      mutationKey: [
        ...browserCapabilityKeys.capabilities(tenantId),
        "profile-copy",
      ],
      mutationFn: async (body) => {
        const path = "/v1/browser-capabilities/authenticated-linkedin-browser/profile-copy";
        return parseBrowserCapabilitiesWrite(await http.json<unknown>("POST", path, { body }), path);
      },
      optimisticUpdates: () => [
        {
          queryKey: browserCapabilityKeys.capabilities(tenantId),
          patch: (current) =>
            patchCapability(current, "authenticated-linkedin-browser", {
              detail: "Copying the explicitly selected profile.",
            }),
        },
      ],
      settle: () => [browserCapabilityKeys.capabilities(tenantId)],
    }),
  );
}

function patchCapability(
  current: unknown,
  capabilityId: BrowserCapabilityId,
  patch: Partial<BrowserCapabilitiesResponse["capabilities"][number]>,
): unknown {
  if (!isBrowserCapabilitiesResponse(current)) {
    return current;
  }
  return {
    ...current,
    capabilities: current.capabilities.map((capability) =>
      capability.id === capabilityId ? { ...capability, ...patch } : capability,
    ),
  };
}

function isBrowserCapabilitiesResponse(
  value: unknown,
): value is BrowserCapabilitiesResponse {
  return BrowserCapabilitiesResponseSchema.safeParse(value).success;
}
