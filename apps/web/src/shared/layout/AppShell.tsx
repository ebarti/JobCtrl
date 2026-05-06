import { Outlet } from "@tanstack/react-router";

import { useDensity } from "../hooks/useDensity.js";
import { NavBar } from "./NavBar.js";
import { Topbar } from "./Topbar.js";

export function AppShell() {
  const { density } = useDensity();
  return (
    <div className="app-shell" data-density={density}>
      <Topbar />
      <NavBar />
      <main className="main">
        <Outlet />
      </main>
    </div>
  );
}
