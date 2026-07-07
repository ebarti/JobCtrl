import type { ProfileShape } from "./contracts.js";
import { ProfileInputError } from "./profile-store.js";

export type PlaceValidator = (place: string) => Promise<boolean>;

const NOMINATIM_SEARCH_URL = "https://nominatim.openstreetmap.org/search";
const PLACE_VALIDATION_TIMEOUT_MS = 5_000;

export async function validateProfileTargetPlaces(
  profile: ProfileShape,
  validator: PlaceValidator = validatePlaceExists,
): Promise<void> {
  const locations = splitTargetText(profile.experience?.target_locations);
  const uniqueLocations = [...new Set(locations)];
  for (const location of uniqueLocations) {
    let exists = false;
    try {
      exists = await validator(location);
    } catch (error) {
      const detail = error instanceof Error ? error.message : "unknown error";
      throw new ProfileInputError(`target location "${location}" could not be validated: ${detail}`);
    }
    if (!exists) {
      throw new ProfileInputError(`target location "${location}" does not resolve to a real place.`);
    }
  }
}

export async function validatePlaceExists(place: string): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PLACE_VALIDATION_TIMEOUT_MS);
  try {
    const url = new URL(NOMINATIM_SEARCH_URL);
    url.searchParams.set("format", "jsonv2");
    url.searchParams.set("limit", "1");
    url.searchParams.set("q", place);
    const response = await fetch(url, {
      headers: {
        "Accept-Language": "en",
        "User-Agent": "JobCtl local app place validation",
      },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`place lookup returned HTTP ${response.status}`);
    }
    const payload = await response.json();
    return Array.isArray(payload) && payload.some((entry) => entry && typeof entry === "object");
  } finally {
    clearTimeout(timeout);
  }
}

function splitTargetText(value: unknown): string[] {
  if (value === null || value === undefined) {
    return [];
  }
  return String(value)
    .replace(/^\s*Target locations?:\s*/i, "")
    .split(/[;\n]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}
