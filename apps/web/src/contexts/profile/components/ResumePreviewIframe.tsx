import { useProfilePdfPreviewUrl } from "../hooks/useProfilePdfPreviewUrl.js";

export function ResumePreviewIframe() {
  const { url, cacheKey } = useProfilePdfPreviewUrl();
  return (
    <iframe
      className="pdf-preview-frame"
      key={cacheKey}
      src={url}
      title="Rendered resume PDF preview"
    />
  );
}
