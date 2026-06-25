import { PdfPreviewViewer } from "../../../shared/ui/PdfPreviewViewer.js";
import { useProfilePdfPreviewUrl } from "../hooks/useProfilePdfPreviewUrl.js";

export function ResumePreviewIframe() {
  const { url, cacheKey } = useProfilePdfPreviewUrl();
  return (
    <PdfPreviewViewer
      cacheKey={cacheKey}
      loadingMessage="The PDF endpoint is loading into the in-app preview."
      loadingTitle="Rendering baseline resume."
      pageAltPrefix="Resume"
      title="Baseline resume preview"
      url={url}
    />
  );
}
