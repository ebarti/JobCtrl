import { create } from "zustand";

import type { SessionPort } from "../ports/SessionPort.js";

interface FormDraftState<T> {
  readonly drafts: ReadonlyMap<SessionPort, ReadonlyMap<string, T>>;
  readonly resetEpochs: ReadonlyMap<SessionPort, ReadonlyMap<string, number>>;
  read(session: SessionPort, tenant: string, workspace: string): T | undefined;
  remember(session: SessionPort, tenant: string, workspace: string, draft: T, expectedResetEpoch: number): void;
  clear(session: SessionPort, tenant: string): void;
}

/** Memory-only, feature-owned drafts. Never add browser persistence to this store. */
export function createScopedFormDraftStore<T>() {
  return create<FormDraftState<T>>((set, get) => ({
    drafts: new Map(), resetEpochs: new Map(),
    read: (session, tenant, workspace) => get().drafts.get(session)?.get(JSON.stringify([tenant, workspace])),
    remember: (session, tenant, workspace, draft, expectedResetEpoch) => set((state) => {
      if ((state.resetEpochs.get(session)?.get(tenant) ?? 0) !== expectedResetEpoch) return state;
      const drafts = new Map(state.drafts); const scoped = new Map(drafts.get(session));
      scoped.set(JSON.stringify([tenant, workspace]), draft); drafts.set(session, scoped);
      return { drafts };
    }),
    clear: (session, tenant) => set((state) => {
      const drafts = new Map(state.drafts); const scoped = new Map(drafts.get(session));
      for (const key of scoped.keys()) if ((JSON.parse(key) as string[])[0] === tenant) scoped.delete(key);
      if (scoped.size) drafts.set(session, scoped); else drafts.delete(session);
      const resetEpochs = new Map(state.resetEpochs); const epochs = new Map(resetEpochs.get(session));
      epochs.set(tenant, (epochs.get(tenant) ?? 0) + 1); resetEpochs.set(session, epochs);
      return { drafts, resetEpochs };
    }),
  }));
}
