import type { ArtifactOpenResponse } from "@jobctl/contracts";

export interface OpenInOsPort {
  open(artifactId: string): Promise<ArtifactOpenResponse>;
}
