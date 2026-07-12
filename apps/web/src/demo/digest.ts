/** Stable JSON serialization for deterministic fixture digests. */
export function stableDemoStringify(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("Demo fixtures may not contain non-finite numbers.");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableDemoStringify).join(",")}]`;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableDemoStringify(record[key])}`)
      .join(",")}}`;
  }
  throw new TypeError("Demo fixtures must contain JSON values only.");
}

/** A compact deterministic integrity digest, not a security or identity primitive. */
export function demoSeedDigest(value: unknown): string {
  let hash = 0x811c9dc5;
  for (const character of stableDemoStringify(value)) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01000193);
  }
  return `fnv1a-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}
