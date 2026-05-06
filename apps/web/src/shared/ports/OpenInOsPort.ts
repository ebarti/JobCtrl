import type { ArtifactOpenResponse } from "@jobhunter/contracts";

export interface OpenInOsPort {
  open(artifactId: string): Promise<ArtifactOpenResponse>;
}
