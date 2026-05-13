import type {
  CanonicalJobIdentityResolved,
  DuplicateJobLinked,
  DuplicateJobLinkRejected,
  JobDeleted,
  JobDiscovered,
  JobRestored,
  JobSourceObserved,
  JobUpdated,
  SourceLocationCandidateDiscovered,
  SourceLocationCandidatePromoted,
  SourceRegistryEntryCreated,
  SourceRegistryEntryUpdated,
  SourceStateChanged,
} from "@jobhunter/domain-types";

import { dashboardKeys } from "../operations/dashboardKeys.js";
import { discoveryKeys } from "./queryKeys.js";
import { invalidate, type InvalidationItem } from "../operations/invalidation-router.js";
import { jobsKeys } from "../operations/jobsKeys.js";

export const jobDiscoveredHandler = (event: JobDiscovered): readonly InvalidationItem[] => [
  invalidate(jobsKeys.lists(event.tenantId)),
  invalidate(dashboardKeys.summary(event.tenantId)),
];

export const jobUpdatedHandler = (event: JobUpdated): readonly InvalidationItem[] => [
  invalidate(jobsKeys.lists(event.tenantId)),
  invalidate(jobsKeys.detail(event.tenantId, event.payload.jobId)),
];

export const jobDeletedHandler = (event: JobDeleted): readonly InvalidationItem[] => [
  invalidate(jobsKeys.lists(event.tenantId)),
  invalidate(jobsKeys.detail(event.tenantId, event.payload.jobId)),
  invalidate(dashboardKeys.summary(event.tenantId)),
];

export const jobRestoredHandler = (event: JobRestored): readonly InvalidationItem[] => [
  invalidate(jobsKeys.lists(event.tenantId)),
  invalidate(jobsKeys.detail(event.tenantId, event.payload.jobId)),
  invalidate(dashboardKeys.summary(event.tenantId)),
];

export const jobSourceObservedHandler = (
  event: JobSourceObserved,
): readonly InvalidationItem[] => [
  invalidate(jobsKeys.lists(event.tenantId)),
  invalidate(jobsKeys.detail(event.tenantId, event.payload.jobId)),
  invalidate(discoveryKeys.sourceQuality(event.tenantId)),
];

export const canonicalJobIdentityResolvedHandler = (
  event: CanonicalJobIdentityResolved,
): readonly InvalidationItem[] => [
  invalidate(jobsKeys.lists(event.tenantId)),
  invalidate(jobsKeys.detail(event.tenantId, event.payload.jobId)),
  invalidate(discoveryKeys.sourceQuality(event.tenantId)),
];

export const duplicateJobLinkedHandler = (
  event: DuplicateJobLinked,
): readonly InvalidationItem[] => [
  invalidate(jobsKeys.lists(event.tenantId)),
  invalidate(jobsKeys.detail(event.tenantId, event.payload.survivingJobId)),
  invalidate(discoveryKeys.sourceQuality(event.tenantId)),
  invalidate(dashboardKeys.summary(event.tenantId)),
];

export const duplicateJobLinkRejectedHandler = (
  event: DuplicateJobLinkRejected,
): readonly InvalidationItem[] => [
  invalidate(discoveryKeys.sourceQuality(event.tenantId)),
  invalidate(dashboardKeys.summary(event.tenantId)),
];

export const sourceLocationCandidateDiscoveredHandler = (
  event: SourceLocationCandidateDiscovered,
): readonly InvalidationItem[] => [
  invalidate(discoveryKeys.sourceLocator(event.tenantId)),
  invalidate(discoveryKeys.sourceRegistry(event.tenantId)),
];

export const sourceLocationCandidatePromotedHandler = (
  event: SourceLocationCandidatePromoted,
): readonly InvalidationItem[] => [
  invalidate(discoveryKeys.sourceLocator(event.tenantId)),
  invalidate(discoveryKeys.sourceRegistry(event.tenantId)),
  invalidate(dashboardKeys.summary(event.tenantId)),
];

export const sourceRegistryEntryCreatedHandler = (
  event: SourceRegistryEntryCreated,
): readonly InvalidationItem[] => [
  invalidate(discoveryKeys.sourceRegistry(event.tenantId)),
  invalidate(discoveryKeys.sourceQuality(event.tenantId)),
];

export const sourceRegistryEntryUpdatedHandler = (
  event: SourceRegistryEntryUpdated,
): readonly InvalidationItem[] => [
  invalidate(discoveryKeys.sourceRegistry(event.tenantId)),
  invalidate(discoveryKeys.sourceQuality(event.tenantId)),
];

export const sourceStateChangedHandler = (
  event: SourceStateChanged,
): readonly InvalidationItem[] => [
  invalidate(discoveryKeys.sourceRegistry(event.tenantId)),
  invalidate(discoveryKeys.sourceQuality(event.tenantId)),
  invalidate(dashboardKeys.summary(event.tenantId)),
];
