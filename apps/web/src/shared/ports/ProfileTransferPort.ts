/** Read-only inspection of browser-held records for an explicit Profile transfer. */
export interface ProfileTransferRecords {
  readonly selectedRaw: string | null;
  readonly legacyRaw: string | null;
  readonly reviewsRaw: string | null;
  readonly errors: readonly string[];
}

export interface ProfileTransferPort {
  inspect(): Promise<ProfileTransferRecords>;
  digestPdf(base64: string): Promise<{ readonly sha256: string; readonly byteLength: number; readonly isPdf: boolean }>;
}
