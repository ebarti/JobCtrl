import { Outlet, useBlocker } from "@tanstack/react-router";
import { useCallback, useLayoutEffect, useRef, type CSSProperties } from "react";

import { useProfilePrivateDraftStatus, useWordingRecoveryGuard } from "../../contexts/profile/index.js";
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
  const wordingRecoveryPending = useWordingRecoveryGuard();
  const privateDraft = useRef(hasPrivateDraft);
  useLayoutEffect(() => { privateDraft.current = hasPrivateDraft; }, [hasPrivateDraft]);
  const shouldWarnOnUnload = useCallback(
    () => privateDraft.current || wordingRecoveryPending(),
    [wordingRecoveryPending],
  );
  useBlocker({
    // Stay registered before a wording edit starts: the recovery write can be
    // pending before React has another opportunity to render.
    disabled: false,
    enableBeforeUnload: shouldWarnOnUnload,
    // In-app navigation retains drafts; only an unload can interrupt the
    // recovery write or discard a session-only private field.
    shouldBlockFn: allowInAppNavigation,
  });
  return null;
}

function allowInAppNavigation() { return false; }
