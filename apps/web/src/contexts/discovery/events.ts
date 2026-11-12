import { invalidateQueriesWithOptimisticOwnership } from "../../shared/lib/createOptimisticMutation.js";
import type { FeatureEventHandler } from "../../shared/ports/FeatureEvents.js";
import { discoveryKeys } from "./queryKeys.js";

export const discoveryEvents: FeatureEventHandler = {
  eventTypes: ["DiscoverySettingsUpdated", "SettingsUpdated", "DiscoverySourceUpdated", "SourceProposalUpdated", "DiscoveryCaptureUpdated", "DiscoveryFeedbackUpdated", "DiscoveryRunUpdated", "DiscoveryTargetsUpdated", "ProfileUpdated", "ProfileSourceUpdated", "PostingQuarantined", "PostingQuarantineReviewed", "ActionQueued", "ActionStarted", "ActionCompleted", "ActionFailed", "ActionCancellationRequested"],
  handle(event, queryClient) {
    if (["ActionQueued", "ActionStarted", "ActionCompleted", "ActionFailed", "ActionCancellationRequested"].includes(event.eventType)) {
      const payload = event.payload;
      const searchAction = payload && typeof payload === "object" && "action" in payload && payload.action === "discovery.search";
      if (event.feature === "discovery" || searchAction) {
        void invalidateQueriesWithOptimisticOwnership(queryClient, discoveryKeys.searchActions(event.tenantId));
        void invalidateQueriesWithOptimisticOwnership(queryClient, [...discoveryKeys.all(event.tenantId), "request-status", "discovery.search"]);
        void invalidateQueriesWithOptimisticOwnership(queryClient, discoveryKeys.runs(event.tenantId));
      }
      return;
    }
    if (event.eventType === "DiscoverySourceUpdated") {
      void invalidateQueriesWithOptimisticOwnership(queryClient, discoveryKeys.sourceRegistry(event.tenantId));
      const payload = event.payload;
      const sourceId = payload && typeof payload === "object" && "sourceId" in payload && typeof payload.sourceId === "string" ? payload.sourceId : null;
      if (sourceId) void invalidateQueriesWithOptimisticOwnership(queryClient, discoveryKeys.sourcePreview(event.tenantId, sourceId));
      return;
    }
    if (event.eventType === "DiscoveryRunUpdated") {
      void invalidateQueriesWithOptimisticOwnership(queryClient, discoveryKeys.runs(event.tenantId));
      void invalidateQueriesWithOptimisticOwnership(queryClient, discoveryKeys.sourceRegistry(event.tenantId));
      return;
    }
    const key = event.eventType === "DiscoveryTargetsUpdated" || event.eventType === "ProfileUpdated" || event.eventType === "ProfileSourceUpdated" ? discoveryKeys.targetPlan(event.tenantId)
      : event.eventType === "DiscoverySettingsUpdated" || event.eventType === "SettingsUpdated" ? discoveryKeys.settings(event.tenantId)
      : event.eventType === "SourceProposalUpdated" ? discoveryKeys.sourceLocator(event.tenantId)
      : event.eventType === "DiscoveryCaptureUpdated" ? discoveryKeys.manualCapture(event.tenantId)
      : event.eventType === "DiscoveryFeedbackUpdated" ? discoveryKeys.all(event.tenantId)
      : event.eventType === "PostingQuarantined" || event.eventType === "PostingQuarantineReviewed" ? discoveryKeys.quarantine(event.tenantId)
      : discoveryKeys.all(event.tenantId);
    void invalidateQueriesWithOptimisticOwnership(queryClient, key);
  },
};
