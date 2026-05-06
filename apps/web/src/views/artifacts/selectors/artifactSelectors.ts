import type { ArtifactSummary } from "../../../contexts/operations/types.js";

export interface ArtifactGroup {
  groupKey: string;
  jobKey: string;
  title: string;
  company: string;
  artifacts: ArtifactSummary[];
}

export function groupArtifacts(artifacts: ArtifactSummary[]): ArtifactGroup[] {
  const groups = new Map<string, ArtifactGroup>();
  for (const artifact of artifacts) {
    const groupKey = artifact.jobKey || `${artifact.title}:${artifact.company}`;
    const group = groups.get(groupKey) ?? {
      groupKey,
      jobKey: artifact.jobKey,
      title: artifact.title,
      company: artifact.company,
      artifacts: [],
    };
    group.artifacts.push(artifact);
    groups.set(groupKey, group);
  }
  return Array.from(groups.values()).map((group) => ({
    ...group,
    artifacts: group.artifacts.slice().sort((left, right) => compareArtifactVersions(left, right)),
  }));
}

export function compareArtifactVersions(left: ArtifactSummary, right: ArtifactSummary): number {
  return (
    artifactVersionRank(left.type) - artifactVersionRank(right.type) ||
    left.type.localeCompare(right.type)
  );
}

export function artifactVersionRank(type: string): number {
  if (type.includes("resume") && type.endsWith("_txt")) {
    return 10;
  }
  if (type.includes("resume") && type.endsWith("_pdf")) {
    return 20;
  }
  if (type.includes("cover") && type.endsWith("_txt")) {
    return 30;
  }
  if (type.includes("cover") && type.endsWith("_pdf")) {
    return 40;
  }
  return 50;
}

export function artifactKind(type: string): string {
  return type.includes("cover") ? "cover" : type.includes("resume") ? "resume" : "artifact";
}

export function artifactVersionLabel(type: string): string {
  if (type.endsWith("_pdf")) {
    return "PDF";
  }
  if (type.endsWith("_txt")) {
    return "TXT";
  }
  return type.replaceAll("_", " ");
}
