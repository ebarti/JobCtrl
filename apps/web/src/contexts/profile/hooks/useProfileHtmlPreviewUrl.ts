import { profileHtmlPreviewPath } from "../client.js";
import { useProfileMutationCount } from "./useProfileMutationCount.js";

export function useProfileHtmlPreviewUrl(): { url: string; cacheKey: number } {
  const cacheKey = useProfileMutationCount();
  return { url: profileHtmlPreviewPath(cacheKey), cacheKey };
}
