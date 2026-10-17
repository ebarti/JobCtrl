import type { ApiClientPort } from "../../ports/ApiClientPort.js";
import type { ArtifactDownloadPort } from "../../ports/ArtifactDownloadPort.js";

export class BrowserArtifactDownloadAdapter implements ArtifactDownloadPort {
  constructor(
    private readonly api: Pick<ApiClientPort, "downloadMaterialDocx">,
  ) {}

  async downloadDocx(artifactId: string, filename: string): Promise<void> {
    const blob = await this.api.downloadMaterialDocx(artifactId);
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    document.body.append(anchor);
    try {
      anchor.click();
    } finally {
      anchor.remove();
      // Keep the object alive until the browser has consumed the download click.
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
  }
}
