import { create } from "zustand";
import type { SessionPort } from "../../shared/ports/SessionPort.js";
import type { PermanentDeletionRequest, PostingSnapshot } from "./client.js";

interface Selection { readonly session: SessionPort; readonly tenant: string; readonly scope: string; readonly rows: Readonly<Record<string, PostingSnapshot>> }
interface PendingCleanup { readonly session: SessionPort; readonly tenant: string; readonly request: PermanentDeletionRequest }
interface GridSelectionState {
  readonly current: Selection | null;
  readonly pendingCleanups: readonly PendingCleanup[];
  update: (session: SessionPort, tenant: string, scope: string, rows: readonly PostingSnapshot[], checked: boolean) => void;
  clear: (session: SessionPort, tenant: string) => void;
  recordCleanup: (session: SessionPort, tenant: string, request: PermanentDeletionRequest, pending: boolean) => void;
}
/** Selection and reviewed cleanup requests survive navigation within this session. */
export const useJobGridSelectionStore = create<GridSelectionState>((set) => ({
  current: null,
  pendingCleanups: [],
  update: (session, tenant, scope, rows, checked) => set((state) => {
    const existing = state.current;
    const next = existing?.session === session && existing.tenant === tenant && existing.scope === scope ? { ...existing.rows } : {};
    for (const row of rows) { if (checked) next[row.job_id] = row; else delete next[row.job_id]; }
    return { current: { session, tenant, scope, rows: next } };
  }),
  clear: (session, tenant) => set((state) => ({ current: state.current?.session === session && state.current.tenant === tenant ? null : state.current })),
  recordCleanup: (session, tenant, request, pending) => set((state) => {
    const remaining = state.pendingCleanups.filter((item) =>
      item.session !== session || item.tenant !== tenant || item.request.selectionId !== request.selectionId);
    return { pendingCleanups: pending ? [...remaining, { session, tenant, request }] : remaining };
  }),
}));
