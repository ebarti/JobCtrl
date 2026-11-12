/** Explicit, user-initiated lookup of a target location. No Profile data is sent. */
export interface PlaceResult {
  readonly provider: "photon";
  readonly placeId: string;
  readonly displayName: string;
  readonly latitude: number;
  readonly longitude: number;
}

export interface PlacesPort {
  search(text: string, options?: { readonly signal?: AbortSignal }): Promise<readonly PlaceResult[]>;
}
