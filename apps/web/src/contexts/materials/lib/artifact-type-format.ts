export function artifactKindLabel(type: string): string {
  if (type.includes("cover")) {
    return "cover";
  }
  if (type.includes("resume")) {
    return "resume";
  }
  return "artifact";
}

export function artifactFormatLabel(type: string): string {
  if (type.endsWith("_pdf")) {
    return "PDF";
  }
  if (type.endsWith("_txt")) {
    return "TXT";
  }
  return type.replaceAll("_", " ");
}

export function formatBytes(sizeBytes: number | null): string {
  if (sizeBytes === null || !Number.isFinite(sizeBytes)) {
    return "-";
  }
  if (sizeBytes < 1024) {
    return `${sizeBytes} B`;
  }
  const units = ["KB", "MB", "GB"];
  let value = sizeBytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unitIndex]}`;
}
