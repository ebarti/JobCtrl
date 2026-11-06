import type { CredentialKey } from "../../settings/credentials.js";
import { useCredentialBatchMutation } from "../../settings/credentials.js";

export function useDeleteCredentialMutation() {
  const mutation = useCredentialBatchMutation();
  return {
    ...mutation,
    mutateAsync: (key: CredentialKey, expectedRevision?: number) => mutation.mutateAsync({
      operations: [{ operation: "delete", key }], ...(expectedRevision !== undefined ? { expectedRevision } : {}),
    }),
  };
}
