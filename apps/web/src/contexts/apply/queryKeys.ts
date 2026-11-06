export const applyKeys = {
  all: (tenantId: string) => ["tenant", tenantId, "apply"] as const,
  queue: (tenantId: string) => [...applyKeys.all(tenantId), "review"] as const,
  application: (tenantId: string, jobId: string) =>
    [...applyKeys.all(tenantId), "job", jobId] as const,
  screening: (tenantId: string, jobId: string) =>
    [...applyKeys.application(tenantId, jobId), "screening"] as const,
  repeat: (tenantId: string, jobId: string) =>
    [...applyKeys.application(tenantId, jobId), "repeat"] as const,
  action: (tenantId: string, runId: string) =>
    [...applyKeys.all(tenantId), "action", runId] as const,
};
