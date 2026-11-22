import type { CredentialUpdateRequest } from "../../settings/credentials.js";
import { useCredentialBatchMutation } from "../../settings/credentials.js";

export function useUpdateCredentialMutation() {
  const mutation = useCredentialBatchMutation();
  return {
    ...mutation,
    mutateAsync: (value: CredentialUpdateRequest & { expectedRevision?: number }) => mutation.mutateAsync({ operations: [{ operation: "set", key: value.key, value: value.value }], ...(value.expectedRevision !== undefined ? { expectedRevision: value.expectedRevision } : {}) }),
  };
}
