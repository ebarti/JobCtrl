import type { ArtifactOpenResponse } from "@jobctrl/contracts";

export interface OpenInOsPort {
  open(artifactId: string): Promise<ArtifactOpenResponse>;
}
