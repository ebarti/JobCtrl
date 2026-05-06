import type { ApiClientPort } from "../../ports/ApiClientPort.js";
import type { OpenInOsPort } from "../../ports/OpenInOsPort.js";

export class OpenArtifactAdapter implements OpenInOsPort {
  constructor(private readonly api: ApiClientPort) {}

  async open(artifactId: string) {
    return this.api.openArtifact(artifactId);
  }
}
