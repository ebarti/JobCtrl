import type { ReactNode } from "react";

import { useDensity } from "../hooks/useDensity.js";
import type { View } from "./NavBar.js";
import { NavBar } from "./NavBar.js";
import { Topbar } from "./Topbar.js";

export interface AppShellProps {
  currentView: View;
  setView: (view: View) => void;
  globalQuery: string;
  setGlobalQuery: (query: string) => void;
  children: ReactNode;
}

export function AppShell({
  currentView,
  setView,
  globalQuery,
  setGlobalQuery,
  children,
}: AppShellProps) {
  const { density } = useDensity();
  return (
    <div className="app-shell" data-density={density}>
      <Topbar
        setView={setView}
        globalQuery={globalQuery}
        setGlobalQuery={setGlobalQuery}
      />
      <NavBar currentView={currentView} onViewChange={setView} />
      <main className="main">{children}</main>
    </div>
  );
}
