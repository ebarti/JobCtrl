import { z } from "zod";

import type { PlaceResult, PlacesPort } from "../../ports/PlacesPort.js";

const featureSchema = z.object({
  type: z.literal("Feature"),
  geometry: z.object({ type: z.literal("Point"), coordinates: z.tuple([z.number().finite().min(-180).max(180), z.number().finite().min(-90).max(90)]) }),
  properties: z.object({
    osm_type: z.enum(["N", "W", "R"]),
    osm_id: z.number().int().positive().safe(),
    name: z.string().optional(), city: z.string().optional(), county: z.string().optional(),
    state: z.string().optional(), country: z.string().optional(),
  }).passthrough(),
});
const responseSchema = z.object({ features: z.array(featureSchema).max(20) });

/** Photon is contacted only from search(), after an explicit control activation. */
export class PhotonPlacesAdapter implements PlacesPort {
  async search(text: string, options: { readonly signal?: AbortSignal } = {}): Promise<readonly PlaceResult[]> {
    const query = text.trim();
    if (!query || query.length > 300) throw new Error("Enter a location of up to 300 characters.");
    const url = new URL("https://photon.komoot.io/api/");
    url.searchParams.set("q", query);
    url.searchParams.set("limit", "5");
    const timeout = AbortSignal.timeout(12_000);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    let response: Response;
    try {
      response = await fetch(url, { signal, credentials: "omit", referrerPolicy: "no-referrer", headers: { Accept: "application/json" } });
    } catch (error) {
      if (options.signal?.aborted) throw error;
      throw new Error("Place lookup is unavailable. Your location text is still saved; try again later.");
    }
    if (!response.ok) throw new Error("Place lookup is unavailable. Your location text is still saved; try again later.");
    const parsed = responseSchema.safeParse(await response.json());
    if (!parsed.success) throw new Error("The place provider returned an unreadable result. Your location remains unverified.");
    const results = parsed.data.features.map(({ properties, geometry }): PlaceResult => ({
      provider: "photon",
      placeId: `${properties.osm_type}:${properties.osm_id}`,
      displayName: [...new Set([properties.name, properties.city, properties.county, properties.state, properties.country].filter((value): value is string => Boolean(value?.trim())))].join(", "),
      longitude: geometry.coordinates[0], latitude: geometry.coordinates[1],
    })).filter((result) => result.displayName.length > 0);
    return [...new Map(results.map((result) => [result.placeId, result])).values()];
  }
}
