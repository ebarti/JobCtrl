import { Outlet } from "@tanstack/react-router";

import { DemoReceiptHistory } from "../../demo/workspace/DemoReceiptHistory.js";
import { DemoWorkspaceNotice } from "../../demo/workspace/DemoWorkspaceNotice.js";
import { useDensity } from "../hooks/useDensity.js";
import { usePageTitle } from "../hooks/usePageTitle.js";
import { SideRail } from "./SideRail.js";
import { Topbar } from "./Topbar.js";

export function AppShell() {
  const { density } = useDensity();
  usePageTitle();
  return (
    <div className="app-shell" data-density={density}>
      <SideRail />
      <div className="main-shell">
        <DemoWorkspaceNotice />
        <DemoReceiptHistory />
        <Topbar />
        <main className="main">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
