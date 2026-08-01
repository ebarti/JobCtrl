import type {
  ArtifactDetail,
  ArtifactSummary,
  JobDetail,
  JobSummary,
} from "./types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function patchJobDetail(
  current: unknown,
  jobId: string,
  patch: (job: JobSummary) => JobSummary,
): unknown {
  if (isRecord(current) && isRecord(current.job) && typeof current.job.jobKey === "string") {
    const detail = current as unknown as JobDetail;
    if (detail.job.jobKey !== jobId) {
      return current;
    }
    return {
      ...detail,
      job: patch(detail.job),
    };
  }
  return current;
}

export function patchJobActiveState(
  current: unknown,
  payload: { readonly jobId: string; readonly activeState: JobSummary["activeState"] },
): unknown {
  return patchJobDetail(current, payload.jobId, (job) => ({
    ...job,
    activeState: payload.activeState,
  }));
}

function approveArtifact(artifact: ArtifactSummary, artifactId: string): ArtifactSummary {
  return artifact.artifactId === artifactId ? { ...artifact, status: "approved" } : artifact;
}

export function patchResumeApproved(
  current: unknown,
  payload: { readonly jobId: string; readonly artifactId: string },
): unknown {
  if (isRecord(current) && isRecord(current.artifact)) {
    const detail = current as unknown as ArtifactDetail;
    const artifact = approveArtifact(detail.artifact, payload.artifactId);
    if (artifact === detail.artifact) {
      return current;
    }
    return {
      ...detail,
      artifact,
    };
  }
  if (
    isRecord(current)
    && isRecord(current.job)
    && current.job.jobKey === payload.jobId
    && Array.isArray(current.artifacts)
  ) {
    const detail = current as unknown as JobDetail;
    let changed = false;
    const artifacts = detail.artifacts.map((artifact) => {
      const next = approveArtifact(artifact, payload.artifactId);
      changed ||= next !== artifact;
      return next;
    });
    return changed ? { ...detail, artifacts } : current;
  }
  return current;
}
