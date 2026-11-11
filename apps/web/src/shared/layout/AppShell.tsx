import { Outlet, useBlocker } from "@tanstack/react-router";
import type { CSSProperties } from "react";

import { useProfilePrivateDraftStatus } from "../../contexts/profile/index.js";
import { DemoGuide } from "../../demo/guide/DemoGuide.js";
import { DemoReceiptHistory } from "../../demo/workspace/DemoReceiptHistory.js";
import { DemoWorkspaceNotice } from "../../demo/workspace/DemoWorkspaceNotice.js";
import { useDensity } from "../hooks/useDensity.js";
import { usePageTitle } from "../hooks/usePageTitle.js";
import { useSidebarPreference } from "../hooks/useSidebarPreference.js";
import { SidebarProvider, SidebarTrigger } from "../ui/sidebar.js";
import { PageHeadNavigationProvider } from "../ui/page-head.js";
import { SideRail } from "./SideRail.js";
import { Topbar } from "./Topbar.js";
import { WorkspaceNav } from "./WorkspaceNav.js";

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
      <ProfileDraftReloadGuard />
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
          <PageHeadNavigationProvider navigation={<WorkspaceNav />}>
            <Outlet />
          </PageHeadNavigationProvider>
        </main>
      </div>
    </SidebarProvider>
  );
}

function ProfileDraftReloadGuard() {
  const hasPrivateDraft = useProfilePrivateDraftStatus();
  useBlocker({
    disabled: !hasPrivateDraft,
    enableBeforeUnload: hasPrivateDraft,
    // In-app navigation retains the draft in session memory. Only leaving or
    // reloading the browser would discard an unsaved private field.
    shouldBlockFn: () => false,
  });
  return null;
}
