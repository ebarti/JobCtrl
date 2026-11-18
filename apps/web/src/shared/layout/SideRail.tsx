import { IconBriefcase, IconSettings, IconUser, type Icon } from "@tabler/icons-react";
import { Link, useRouterState } from "@tanstack/react-router";

import { useJobsReturnSearch } from "../../contexts/jobs/index.js";
import { useDemoWorkspace } from "../../demo/workspace/DemoWorkspaceProvider.js";
import { cn } from "../lib/cn.js";
import { Sidebar, SidebarRail } from "../ui/sidebar.js";
import { BrandMark } from "./BrandMark.js";
import { LegalNotice } from "./LegalNotice.js";
import { workspaceLocation, type Workspace } from "./workspace-location.js";

interface RailNavProps {
  readonly className?: string;
  readonly onNavigate?: () => void;
}

export function RailNav({ className, onNavigate }: RailNavProps) {
  const location = useRouterState({ select: (state) => state.location });
  const { workspace } = workspaceLocation(location.pathname, location.search, location.hash);
  const jobsSearch = useJobsReturnSearch();
  const linkClass = (name: Workspace) => cn("side-rail__link", workspace === name && "on");
  const content = (label: string, NavIcon: Icon) => <>
    <NavIcon className="side-rail__icon" size={18} stroke={1.75} aria-hidden="true" />
    <span className="side-rail__label">{label}</span>
  </>;

  return (
    <nav className={cn("side-rail__nav", className)} aria-label="Main navigation">
      <div className="side-rail__group">
        <Link to="/jobs" search={jobsSearch} className={linkClass("jobs")}
          aria-current={workspace === "jobs" ? "page" : undefined} aria-label="Jobs" title="Jobs" onClick={onNavigate}>
          {content("Jobs", IconBriefcase)}
        </Link>
        <Link to="/profile" search={{ section: "experience" }} className={linkClass("profile")}
          aria-current={workspace === "profile" ? "page" : undefined} aria-label="My profile" title="My profile" onClick={onNavigate}>
          {content("My profile", IconUser)}
        </Link>
      </div>
      <div className="side-rail__utility">
        <Link to="/settings" className={linkClass("settings")}
          aria-current={workspace === "settings" ? "page" : undefined} aria-label="Settings" title="Settings" onClick={onNavigate}>
          {content("Settings", IconSettings)}
        </Link>
      </div>
    </nav>
  );
}

export function LocalModeCard() {
  const workspace = useDemoWorkspace();
  const text = workspace.mode === "demo"
    ? workspace.runtime.storageMode === "indexeddb" ? "Demo mode — browser-local workspace" : "Demo mode — this tab only"
    : "Local mode — all data stays on device";
  return <div className="side-rail__footer">
    <span className="side-rail__status-dot" aria-hidden="true" />
    <span className="side-rail__footer-text" data-typography="metadata">{text}</span>
  </div>;
}

export function SideRail() {
  const jobsSearch = useJobsReturnSearch();
  return (
    <Sidebar className="side-rail-frame" collapsible="icon">
      <aside className="side-rail">
        <Link to="/jobs" search={jobsSearch} className="side-rail__brand" aria-label="JobCtrl — Jobs">
          <BrandMark />
        </Link>
        <RailNav />
        <LocalModeCard />
        <LegalNotice className="legal-notice legal-notice--rail" />
      </aside>
      <SidebarRail />
    </Sidebar>
  );
}
