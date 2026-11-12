import { create } from "zustand";

import type { SessionPort } from "../../../shared/ports/SessionPort.js";
import { usePorts } from "../../../shared/providers/PortsProvider.js";
import { useTenantId } from "../../../shared/providers/TenantProvider.js";
import { useRuntimeHealth } from "../../runtime/index.js";
import type { CareerCohort, CareerMilestone, LearningResponse } from "../contracts.js";

export interface CohortDraftValues {
  title: string;
  asOf: string;
  aspirations: string;
  jobIds: string[];
}

export interface CohortDraft {
  values: CohortDraftValues;
  editing: CareerCohort | null;
  preview: LearningResponse["preview"];
}

export interface MilestoneDraft {
  revision: number;
  status: CareerMilestone["status"];
  completionEvidence: string;
}

interface LearningDrafts {
  cohorts: ReadonlyMap<string, CohortDraft>;
  milestones: ReadonlyMap<string, MilestoneDraft>;
  jobLists: ReadonlyMap<string, { search: string; page: number }>;
  epochs: ReadonlyMap<string, number>;
  setCohort: (tenant: string, value: CohortDraft | null) => void;
  setMilestone: (tenant: string, milestoneId: string, value: MilestoneDraft | null) => void;
  setJobList: (tenant: string, value: { search: string; page: number }) => void;
  clearScope: (scope: string) => void;
}

// Drafts remain only in this application session and never leave their tenant.
// Durable accepted comparisons and request identities stay with their owners.
export const useLearningDrafts = create<LearningDrafts>((set) => ({
  cohorts: new Map(),
  milestones: new Map(),
  jobLists: new Map(),
  epochs: new Map(),
  setCohort: (tenant, value) => set((state) => {
    const cohorts = new Map(state.cohorts);
    if (value) cohorts.set(tenant, value); else cohorts.delete(tenant);
    return { cohorts };
  }),
  setMilestone: (tenant, milestoneId, value) => set((state) => {
    const milestones = new Map(state.milestones);
    const key = JSON.stringify([tenant, milestoneId]);
    if (value) milestones.set(key, value); else milestones.delete(key);
    return { milestones };
  }),
  setJobList: (tenant, value) => set((state) => {
    const jobLists = new Map(state.jobLists);
    jobLists.set(tenant, value);
    return { jobLists };
  }),
  clearScope: (scope) => set((state) => {
    const cohorts = new Map(state.cohorts);
    const jobLists = new Map(state.jobLists);
    const milestones = new Map(state.milestones);
    const epochs = new Map(state.epochs);
    cohorts.delete(scope);
    jobLists.delete(scope);
    for (const key of milestones.keys()) {
      if ((JSON.parse(key) as [string, string])[0] === scope) milestones.delete(key);
    }
    epochs.set(scope, (epochs.get(scope) ?? 0) + 1);
    return { cohorts, jobLists, milestones, epochs };
  }),
}));

const sessionIds = new WeakMap<SessionPort, number>();
const knownScopes = new Set<string>();
let nextSessionId = 1;

function draftScope(session: SessionPort, tenant: string, databaseInstanceId: string): string {
  let id = sessionIds.get(session);
  if (id === undefined) { id = nextSessionId++; sessionIds.set(session, id); }
  const scope = JSON.stringify([id, tenant, databaseInstanceId]);
  knownScopes.add(scope);
  return scope;
}

export function useLearningDraftScope(): string {
  const { session } = usePorts();
  const tenant = useTenantId();
  const health = useRuntimeHealth();
  return draftScope(session, tenant, health.data?.databaseInstanceId ?? "unavailable");
}

/** Called after an explicit synthetic-workspace reset. */
export function clearLearningDraftsForSession(session: SessionPort, tenant: string): void {
  const id = sessionIds.get(session);
  if (id === undefined) return;
  for (const scope of knownScopes) {
    const [scopeId, scopeTenant] = JSON.parse(scope) as [number, string, string];
    if (scopeId === id && scopeTenant === tenant) useLearningDrafts.getState().clearScope(scope);
  }
}

export function milestoneDraft(tenant: string, milestoneId: string) {
  return useLearningDrafts.getState().milestones.get(JSON.stringify([tenant, milestoneId]));
}

export function useLearningJobListDraft() {
  const tenant = useLearningDraftScope();
  const saved = useLearningDrafts((state) => state.jobLists.get(tenant));
  const search = saved?.search ?? "";
  const page = saved?.page ?? 1;
  return {
    search,
    page,
    setSearch: (next: string) => useLearningDrafts.getState().setJobList(tenant, { search: next, page: 1 }),
    setPage: (next: number) => useLearningDrafts.getState().setJobList(tenant, { search, page: next }),
  };
}
