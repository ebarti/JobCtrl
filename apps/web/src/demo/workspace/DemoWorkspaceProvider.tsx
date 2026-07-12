import {
  createContext,
  useContext,
  useMemo,
  useSyncExternalStore,
  type ReactNode,
} from "react";

import type { DemoWorkspaceRuntimeSnapshot } from "./contracts.js";
import type { DemoWorkspaceRepository } from "./DemoWorkspaceRepository.js";

export type DemoWorkspaceContextValue =
  | { readonly mode: "local" }
  | {
      readonly mode: "demo";
      readonly workspace: DemoWorkspaceRepository;
      readonly runtime: DemoWorkspaceRuntimeSnapshot;
    };

const LOCAL_CONTEXT: DemoWorkspaceContextValue = { mode: "local" };
const EMPTY_RUNTIME: DemoWorkspaceRuntimeSnapshot = {
  status: "initializing",
  storageMode: "memory",
  warning: null,
};
const subscribeEmpty = () => () => undefined;
const getEmptyRuntime = () => EMPTY_RUNTIME;

const DemoWorkspaceContext =
  createContext<DemoWorkspaceContextValue>(LOCAL_CONTEXT);

export function DemoWorkspaceProvider({
  workspace,
  children,
}: {
  readonly workspace: DemoWorkspaceRepository | null;
  readonly children: ReactNode;
}) {
  const runtime = useSyncExternalStore(
    workspace?.subscribeRuntime ?? subscribeEmpty,
    workspace?.getRuntimeSnapshot ?? getEmptyRuntime,
    workspace?.getRuntimeSnapshot ?? getEmptyRuntime,
  );
  const value = useMemo<DemoWorkspaceContextValue>(
    () => (workspace ? { mode: "demo", workspace, runtime } : LOCAL_CONTEXT),
    [runtime, workspace],
  );
  return (
    <DemoWorkspaceContext.Provider value={value}>
      {children}
    </DemoWorkspaceContext.Provider>
  );
}

export function useDemoWorkspace(): DemoWorkspaceContextValue {
  return useContext(DemoWorkspaceContext);
}
