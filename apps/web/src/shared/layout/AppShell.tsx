import { Outlet } from "@tanstack/react-router";
import type { CSSProperties } from "react";

import { DemoGuide } from "../../demo/guide/DemoGuide.js";
import { DemoReceiptHistory } from "../../demo/workspace/DemoReceiptHistory.js";
import { DemoWorkspaceNotice } from "../../demo/workspace/DemoWorkspaceNotice.js";
import { useDensity } from "../hooks/useDensity.js";
import { usePageTitle } from "../hooks/usePageTitle.js";
import { useSidebarPreference } from "../hooks/useSidebarPreference.js";
import { SidebarProvider, SidebarTrigger } from "../ui/sidebar.js";
import { SideRail } from "./SideRail.js";
import { Topbar } from "./Topbar.js";

export function AppShell() {
  const { density } = useDensity();
  const { sidebarOpen, setSidebarOpen } = useSidebarPreference();
  usePageTitle();
  return (
    <SidebarProvider
      className="app-shell"
      data-density={density}
      data-sidebar-open={sidebarOpen ? "true" : "false"}
      onOpenChange={setSidebarOpen}
      open={sidebarOpen}
      style={
        {
          "--sidebar-width": "var(--rail-width)",
          "--sidebar-width-icon": "var(--rail-width-collapsed)",
        } as CSSProperties
      }
    >
      <SideRail />
      <div className="main-shell">
        <DemoWorkspaceNotice />
        <DemoGuide />
        <DemoReceiptHistory />
        <Topbar
          navigationToggle={
            <SidebarTrigger
              className="topbar__rail-trigger"
              title="Collapse or expand navigation"
            />
          }
        />
        <main className="main">
          <Outlet />
        </main>
      </div>
    </SidebarProvider>
  );
}
