import type { ArtifactSummary, JobSummary, Stage } from "../../../contexts/operations/types.js";

export interface JobFunnelSummary {
  readonly stage: Stage;
  readonly count: number;
}

export function summarizeFunnel(jobs: readonly JobSummary[]): readonly JobFunnelSummary[] {
  const counts = new Map<Stage, number>();
  for (const job of jobs) {
    counts.set(job.currentStage, (counts.get(job.currentStage) ?? 0) + 1);
  }
  return Array.from(counts.entries()).map(([stage, count]) => ({ stage, count }));
}

export function groupArtifactsByJob(
  artifacts: readonly ArtifactSummary[],
): ReadonlyMap<string, readonly ArtifactSummary[]> {
  const grouped = new Map<string, ArtifactSummary[]>();
  for (const artifact of artifacts) {
    const key = artifact.jobKey;
    if (!key) {
      continue;
    }
    const list = grouped.get(key) ?? [];
    list.push(artifact);
    grouped.set(key, list);
  }
  return grouped;
}
