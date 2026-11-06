import { create } from "zustand";
import type { SessionPort } from "../../shared/ports/SessionPort.js";
import type { PostingSnapshot } from "./client.js";

interface Selection { readonly session: SessionPort; readonly tenant: string; readonly scope: string; readonly rows: Readonly<Record<string, PostingSnapshot>> }
interface GridSelectionState {
  readonly current: Selection | null;
  update: (session: SessionPort, tenant: string, scope: string, rows: readonly PostingSnapshot[], checked: boolean) => void;
  clear: (session: SessionPort, tenant: string) => void;
}
/** Navigation-only selection; never persisted across app sessions or tenants. */
export const useJobGridSelectionStore = create<GridSelectionState>((set) => ({
  current: null,
  update: (session, tenant, scope, rows, checked) => set((state) => {
    const existing = state.current;
    const next = existing?.session === session && existing.tenant === tenant && existing.scope === scope ? { ...existing.rows } : {};
    for (const row of rows) { if (checked) next[row.job_id] = row; else delete next[row.job_id]; }
    return { current: { session, tenant, scope, rows: next } };
  }),
  clear: (session, tenant) => set((state) => ({ current: state.current?.session === session && state.current.tenant === tenant ? null : state.current })),
}));
