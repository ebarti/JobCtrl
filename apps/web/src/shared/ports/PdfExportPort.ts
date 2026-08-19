export interface PdfExportRequest {
  readonly filename: string;
  readonly source: HTMLElement;
}

export interface PdfExportPort {
  downloadPdf(request: PdfExportRequest): Promise<void>;
}
