export interface ArtifactDownloadPort {
  downloadDocx(artifactId: string, filename: string): Promise<void>;
}
