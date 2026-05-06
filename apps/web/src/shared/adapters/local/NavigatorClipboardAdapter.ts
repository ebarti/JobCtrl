import type { ClipboardPort } from "../../ports/ClipboardPort.js";

export class NavigatorClipboardAdapter implements ClipboardPort {
  async write(text: string): Promise<void> {
    if (typeof navigator === "undefined" || !navigator.clipboard) {
      throw new Error("Clipboard API is not available in this environment.");
    }
    await navigator.clipboard.writeText(text);
  }
}
