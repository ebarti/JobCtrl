const SPAIN_REGION_LABELS: Record<string, string> = {
  AN: "Andalusia",
  CT: "Catalonia",
  MD: "Community of Madrid",
};

const REMOTE_PATTERN = /\b(?:remote|en remoto|remoto|teletrabajo|work from home|wfh)\b/i;
const REMOTE_MARKER_PATTERN = /\s*\((?:remote|en remoto|remoto)\)\s*/gi;

export function normalizeJobLocation(location: string | null | undefined): string {
  const raw = String(location ?? "").trim();
  if (!raw) {
    return "";
  }

  const isRemote = REMOTE_PATTERN.test(raw) || /\((?:remote|en remoto|remoto)\)/i.test(raw);
  const cleaned = raw
    .replace(REMOTE_MARKER_PATTERN, " ")
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part && !REMOTE_PATTERN.test(part));

  const hasSpainCountry = cleaned.some(isSpainCountryToken);
  const parts = cleaned
    .map((part) => normalizeLocationPart(part, hasSpainCountry))
    .filter(Boolean);
  const deduped = dedupeAdjacent(parts);
  const base = deduped.length ? deduped.join(", ") : isRemote ? "Remote" : raw;

  return isRemote && !/\bremote\b/i.test(base) ? `${base} (Remote)` : base;
}

function normalizeLocationPart(part: string, hasSpainCountry: boolean): string {
  const token = part.trim();
  if (!token) {
    return "";
  }
  if (isSpainCountryToken(token)) {
    return "Spain";
  }
  if (hasSpainCountry) {
    const region = SPAIN_REGION_LABELS[token.toUpperCase()];
    if (region) {
      return region;
    }
  }
  return token;
}

function isSpainCountryToken(part: string): boolean {
  return /^(?:ES|ESP|Spain|España)$/i.test(part.trim());
}

function dedupeAdjacent(parts: string[]): string[] {
  const result: string[] = [];
  for (const part of parts) {
    if (result[result.length - 1]?.toLocaleLowerCase() !== part.toLocaleLowerCase()) {
      result.push(part);
    }
  }
  return result;
}
