import { usePorts } from "../../../shared/providers/PortsProvider.js";
import { useProfileMutationCount } from "./useProfileMutationCount.js";

export function useProfilePdfPreviewUrl(): { url: string; cacheKey: number } {
  const { api } = usePorts();
  const cacheKey = useProfileMutationCount();
  return { url: api.profilePreviewPdfUrl(cacheKey), cacheKey };
}
