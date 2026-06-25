import { usePorts } from "../../../shared/providers/PortsProvider.js";
import { useProfileMutationCount } from "./useProfileMutationCount.js";

export function useProfileHtmlPreviewUrl(): { url: string; cacheKey: number } {
  const { api } = usePorts();
  const cacheKey = useProfileMutationCount();
  return { url: api.profilePreviewHtmlUrl(cacheKey), cacheKey };
}
