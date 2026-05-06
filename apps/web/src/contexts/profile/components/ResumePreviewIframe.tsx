import { usePorts } from "../../../shared/providers/PortsProvider.js";

export interface ResumePreviewIframeProps {
  cacheKey: number | string;
}

export function ResumePreviewIframe({ cacheKey }: ResumePreviewIframeProps) {
  const ports = usePorts();
  return (
    <iframe
      className="pdf-preview-frame"
      key={cacheKey}
      src={ports.api.profilePreviewPdfUrl(cacheKey)}
      title="Rendered resume PDF preview"
    />
  );
}
