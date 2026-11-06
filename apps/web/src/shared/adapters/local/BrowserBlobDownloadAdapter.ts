import type { BlobDownloadPort } from "../../ports/BlobDownloadPort.js";

export class BrowserBlobDownloadAdapter implements BlobDownloadPort {
  save(blob: Blob, filename: string): void {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    document.body.append(anchor);
    try {
      anchor.click();
    } finally {
      anchor.remove();
      // Browsers may consume the object URL after the click returns.
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
  }
}
