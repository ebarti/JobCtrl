import { useMutation, useQueryClient } from "@tanstack/react-query";

import { usePorts } from "../../../shared/providers/PortsProvider.js";
import { useTenantId } from "../../../shared/providers/TenantProvider.js";
import { dashboardKeys } from "../../operations/dashboardKeys.js";
import { discoveryKeys } from "../queryKeys.js";
import type {
  DiscoveryFeedbackRequest,
  ManualCaptureImportRequest,
  QuarantineDecision,
  SourceLocatorDecisionRequest,
  SourceStatePatch,
  SourceUpsertRequest,
} from "../../operations/types.js";

export function useUpsertDiscoverySourceMutation() {
  const tenantId = useTenantId();
  const { api } = usePorts();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: SourceUpsertRequest) => api.upsertDiscoverySource(body),
    onSettled: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: discoveryKeys.sourceRegistry(tenantId) }),
        queryClient.invalidateQueries({ queryKey: dashboardKeys.summary(tenantId) }),
      ]);
    },
  });
}

export function usePatchDiscoverySourceStateMutation() {
  const tenantId = useTenantId();
  const { api } = usePorts();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ sourceId, body }: { sourceId: string; body: SourceStatePatch }) =>
      api.patchDiscoverySourceState(sourceId, body),
    onSettled: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: discoveryKeys.sourceRegistry(tenantId) }),
        queryClient.invalidateQueries({ queryKey: dashboardKeys.summary(tenantId) }),
      ]);
    },
  });
}

export function usePromoteSourceLocatorCandidateMutation() {
  const tenantId = useTenantId();
  const { api } = usePorts();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ candidateId, body = {} }: { candidateId: string; body?: SourceLocatorDecisionRequest }) =>
      api.promoteSourceLocatorCandidate(candidateId, body),
    onSettled: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: discoveryKeys.sourceLocator(tenantId) }),
        queryClient.invalidateQueries({ queryKey: discoveryKeys.sourceRegistry(tenantId) }),
        queryClient.invalidateQueries({ queryKey: dashboardKeys.summary(tenantId) }),
      ]);
    },
  });
}

export function useRejectSourceLocatorCandidateMutation() {
  const tenantId = useTenantId();
  const { api } = usePorts();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ candidateId, body = {} }: { candidateId: string; body?: SourceLocatorDecisionRequest }) =>
      api.rejectSourceLocatorCandidate(candidateId, body),
    onSettled: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: discoveryKeys.sourceLocator(tenantId) }),
        queryClient.invalidateQueries({ queryKey: dashboardKeys.summary(tenantId) }),
      ]);
    },
  });
}

export function useDiscoveryQuarantineDecisionMutation() {
  const tenantId = useTenantId();
  const { api } = usePorts();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ jobKey, body }: { jobKey: string; body: QuarantineDecision }) =>
      api.decideDiscoveryQuarantine(jobKey, body),
    onSettled: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: discoveryKeys.quarantine(tenantId) }),
        queryClient.invalidateQueries({ queryKey: discoveryKeys.feedback(tenantId) }),
        queryClient.invalidateQueries({ queryKey: discoveryKeys.sourceRegistry(tenantId) }),
        queryClient.invalidateQueries({ queryKey: discoveryKeys.sourceQuality(tenantId) }),
        queryClient.invalidateQueries({ queryKey: dashboardKeys.summary(tenantId) }),
      ]);
    },
  });
}

export function useManualCaptureImportMutation() {
  const tenantId = useTenantId();
  const { api } = usePorts();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ itemId, body }: { itemId: string; body: ManualCaptureImportRequest }) =>
      api.importManualCapture(itemId, body),
    onSettled: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: discoveryKeys.manualCapture(tenantId) }),
        queryClient.invalidateQueries({ queryKey: discoveryKeys.quarantine(tenantId) }),
        queryClient.invalidateQueries({ queryKey: discoveryKeys.sourceRegistry(tenantId) }),
        queryClient.invalidateQueries({ queryKey: dashboardKeys.summary(tenantId) }),
      ]);
    },
  });
}

export function useManualCaptureDismissMutation() {
  const tenantId = useTenantId();
  const { api } = usePorts();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (itemId: string) => api.dismissManualCapture(itemId),
    onSettled: async () => {
      await queryClient.invalidateQueries({ queryKey: discoveryKeys.manualCapture(tenantId) });
    },
  });
}

export function useDiscoveryFeedbackMutation() {
  const tenantId = useTenantId();
  const { api } = usePorts();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: DiscoveryFeedbackRequest) => api.recordDiscoveryFeedback(body),
    onSettled: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: discoveryKeys.feedback(tenantId) }),
        queryClient.invalidateQueries({ queryKey: discoveryKeys.sourceRegistry(tenantId) }),
        queryClient.invalidateQueries({ queryKey: discoveryKeys.sourceQuality(tenantId) }),
        queryClient.invalidateQueries({ queryKey: dashboardKeys.summary(tenantId) }),
      ]);
    },
  });
}
