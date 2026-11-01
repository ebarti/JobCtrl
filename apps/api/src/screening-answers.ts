/** General activity/SSE carries references; private snapshots belong to screening reads. */
export function screeningEventReferences(payload: unknown): Record<string, unknown> {
  if (!payload || typeof payload !== "object") return {};
  const value = payload as { state?: { questionId?: unknown; snapshotId?: unknown; revision?: unknown }; entry?: { libraryId?: unknown; snapshotId?: unknown }; failure?: { questionId?: unknown; expectedRevision?: unknown; code?: unknown } };
  if (value.failure) return { questionId: value.failure.questionId, revision: value.failure.expectedRevision, failureCode: value.failure.code };
  return value.state
    ? { questionId: value.state.questionId, snapshotId: value.state.snapshotId, revision: value.state.revision }
    : { libraryId: value.entry?.libraryId, snapshotId: value.entry?.snapshotId };
}
