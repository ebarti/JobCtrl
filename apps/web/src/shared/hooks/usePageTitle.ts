import { useRouterState } from "@tanstack/react-router";
import { useEffect } from "react";

import { workspaceLocation } from "../layout/workspace-location.js";

export function usePageTitle(): void {
  const location = useRouterState({ select: (state) => state.location });
  const { label } = workspaceLocation(location.pathname, location.search, location.hash);
  useEffect(() => {
    document.title = `JobCtrl · ${label}`;
  }, [label]);
}
