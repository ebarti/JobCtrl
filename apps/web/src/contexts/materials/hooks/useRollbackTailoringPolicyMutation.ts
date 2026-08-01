import type {
  TailoringPolicyRevisionListResponse,
  TailoringPolicyRevisionSummary,
  TailoringPolicyRollbackResponse,
} from "@jobctrl/contracts";
import {
  useMutation,
  useQueryClient,
  type QueryKey,
  type UseMutationResult,
} from "@tanstack/react-query";

import { usePorts } from "../../../shared/providers/PortsProvider.js";
import { useTenantId } from "../../../shared/providers/TenantProvider.js";
import { learningKeys } from "../../operations/learningKeys.js";

interface PolicyRevisionSnapshot {
  readonly queryKey: QueryKey;
  readonly data: TailoringPolicyRevisionListResponse | undefined;
}

interface RollbackTailoringPolicyContext {
  readonly snapshots: readonly PolicyRevisionSnapshot[];
  readonly patched: boolean;
}

export function useRollbackTailoringPolicyMutation(): UseMutationResult<
  TailoringPolicyRollbackResponse,
  Error,
  number,
  RollbackTailoringPolicyContext
> {
  const tenantId = useTenantId();
  const { api } = usePorts();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (targetVersion) => api.rollbackTailoringPolicy({ targetVersion }),
    onMutate: async (targetVersion) => {
      const queryKey = learningKeys.policyRevisions(tenantId);
      await queryClient.cancelQueries({ queryKey });
      const snapshots = queryClient
        .getQueriesData<TailoringPolicyRevisionListResponse>({ queryKey })
        .map(([cachedKey, data]) => ({ queryKey: cachedKey, data }));
      const target = snapshots
        .flatMap(({ data }) => data?.revisions ?? [])
        .find((revision) => revision.version === targetVersion);
      const current = snapshots
        .flatMap(({ data }) => data?.revisions ?? [])
        .find((revision) => revision.status === "current");
      const provisional =
        target && current
          ? rollbackRevision(target, current.version + 1, new Date().toISOString())
          : null;
      const patched = provisional ? patchSnapshots(queryClient, snapshots, provisional) : false;
      return { snapshots, patched };
    },
    onSuccess: (response, _targetVersion, context) => {
      const revision: TailoringPolicyRevisionSummary = {
        context: response.context,
        policyKind: response.policyKind,
        version: response.version,
        status: response.status,
        learnedRules: response.learnedRules,
        sourceReviewId: response.sourceReviewId,
        sourceRecommendationId: response.sourceRecommendationId,
        rollbackOfVersion: response.rollbackOfVersion,
        rollbackReasonCode: response.rollbackReasonCode,
        createdAt: response.createdAt,
      };
      patchSnapshots(queryClient, context.snapshots, revision);
    },
    onError: (_error, _targetVersion, context) => {
      for (const { queryKey, data } of context?.snapshots ?? []) {
        queryClient.setQueryData(queryKey, data);
      }
    },
    onSettled: async () => {
      await queryClient.invalidateQueries({ queryKey: learningKeys.policyRevisions(tenantId) });
    },
  });
}

function rollbackRevision(
  target: TailoringPolicyRevisionSummary,
  version: number,
  createdAt: string,
): TailoringPolicyRevisionSummary {
  return {
    ...target,
    version,
    status: "current",
    sourceReviewId: null,
    sourceRecommendationId: null,
    rollbackOfVersion: target.version,
    rollbackReasonCode: "user_requested",
    createdAt,
  };
}

function patchSnapshots(
  queryClient: ReturnType<typeof useQueryClient>,
  snapshots: readonly PolicyRevisionSnapshot[],
  revision: TailoringPolicyRevisionSummary,
): boolean {
  const pages = snapshots
    .filter(
      (snapshot): snapshot is PolicyRevisionSnapshot & {
        data: TailoringPolicyRevisionListResponse;
      } => snapshot.data !== undefined,
    )
    .toSorted((left, right) => left.data.page - right.data.page);
  if (!isCompleteCache(pages)) {
    return false;
  }
  const firstPage = pages[0];
  if (!firstPage) {
    return false;
  }
  const pageSize = firstPage.data.pageSize;
  const prior = pages.flatMap(({ data }) => data.revisions);
  const revisions = [
    revision,
    ...prior
      .filter((item) => item.version !== revision.version)
      .map((item) => (item.status === "current" ? { ...item, status: "superseded" as const } : item)),
  ];
  const total = prior.some((item) => item.version === revision.version)
    ? firstPage.data.total
    : firstPage.data.total + 1;
  const totalPages = total === 0 ? 0 : Math.ceil(total / pageSize);
  if (totalPages > pages.length) {
    return false;
  }
  for (const { queryKey, data } of pages) {
    const offset = (data.page - 1) * pageSize;
    queryClient.setQueryData<TailoringPolicyRevisionListResponse>(queryKey, {
      ...data,
      revisions: revisions.slice(offset, offset + pageSize),
      total,
      totalPages,
    });
  }
  return true;
}

function isCompleteCache(
  pages: readonly { readonly data: TailoringPolicyRevisionListResponse }[],
): boolean {
  if (pages.length === 0 || pages[0]?.data.page !== 1) {
    return false;
  }
  const first = pages[0].data;
  return (
    pages.length === first.totalPages &&
    pages.every(
      ({ data }, index) =>
        data.page === index + 1 &&
        data.pageSize === first.pageSize &&
        data.total === first.total &&
        data.totalPages === first.totalPages,
    ) &&
    pages.reduce((count, { data }) => count + data.revisions.length, 0) === first.total
  );
}
