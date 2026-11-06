/** Saves an already authorized response without exposing browser APIs to features. */
export interface BlobDownloadPort {
  save(blob: Blob, filename: string): void;
}
