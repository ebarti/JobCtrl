import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  CareerLearningCommand,
  CareerLearningResponse,
} from "@jobctrl/contracts";

import { usePorts } from "../../../shared/providers/PortsProvider.js";
import { useTenantId } from "../../../shared/providers/TenantProvider.js";
import { getApiCapabilityAvailability } from "../../../shared/lib/apiCapabilityAvailability.js";
import { evidenceMapKeys } from "../evidenceMapKeys.js";

export function useCareerLearningQuery() {
  const tenant = useTenantId();
  const { api, featureFlags } = usePorts();
  const availability = getApiCapabilityAvailability(
    featureFlags,
    "careerLearning",
  );
  const query = useQuery({
    queryKey: evidenceMapKeys.learning(tenant),
    queryFn: () => api.careerLearning(),
    enabled: availability.available,
    meta: { suppressGlobalErrorToast: true },
  });
  return { ...query, availability };
}

export function useCareerLearningMutation() {
  const tenant = useTenantId();
  const { api } = usePorts();
  const client = useQueryClient();
  const key = evidenceMapKeys.learning(tenant);
  return useMutation({
    mutationFn: (command: CareerLearningCommand) =>
      api.writeCareerLearning(command),
    onMutate: async (command) => {
      await client.cancelQueries({ queryKey: key });
      const previous = client.getQueryData<CareerLearningResponse>(key);
      if (previous && command.action === "update")
        client.setQueryData<CareerLearningResponse>(key, {
          ...previous,
          milestones: previous.milestones.map((milestone) =>
            milestone.milestoneId === command.milestoneId
              ? {
                  ...milestone,
                  status: command.status,
                  completionEvidence: command.completionEvidence,
                }
              : milestone,
          ),
        });
      return { previous };
    },
    onSuccess: (response) => client.setQueryData(key, response),
    onError: (_error, _command, context) => {
      if (context?.previous) client.setQueryData(key, context.previous);
    },
    onSettled: () => client.invalidateQueries({ queryKey: key }),
    meta: { suppressGlobalErrorToast: true },
  });
}
