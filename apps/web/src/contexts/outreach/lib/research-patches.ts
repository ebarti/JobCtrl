import type { ContactResearchDetailResponse } from "@jobhunter/contracts";

function isResearchDetailResponse(value: unknown): value is ContactResearchDetailResponse {
  return (
    typeof value === "object" &&
    value !== null &&
    "task" in value &&
    typeof (value as ContactResearchDetailResponse).task === "object"
  );
}

/**
 * Optimistically mark one candidate confirmed in a cached research-task detail:
 * flip its status + provenance, decrement needs-review, increment confirmed. The
 * server response (and the SSE invalidation) reconciles the authoritative state;
 * a failed confirm rolls this back via the optimistic-mutation helper.
 */
export function markCandidateConfirmed(current: unknown, candidateId: string): unknown {
  if (!isResearchDetailResponse(current)) {
    return current;
  }
  let flipped = false;
  const candidates = current.task.candidates.map((candidate) => {
    if (candidate.candidateId !== candidateId || candidate.status !== "needs_review") {
      return candidate;
    }
    flipped = true;
    return {
      ...candidate,
      status: "confirmed" as const,
      provenance: { ...candidate.provenance, userConfirmed: true },
    };
  });
  if (!flipped) {
    return current;
  }
  return {
    ...current,
    task: {
      ...current.task,
      candidates,
      needsReviewCount: Math.max(0, current.task.needsReviewCount - 1),
      confirmedCount: current.task.confirmedCount + 1,
    },
  };
}
