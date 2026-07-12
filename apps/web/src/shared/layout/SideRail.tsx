import {
  IconAddressBook,
  IconAdjustments,
  IconBriefcase,
  IconBug,
  IconChartBar,
  IconChecklist,
  IconFileText,
  IconHistory,
  IconLayoutDashboard,
  IconMap2,
  IconRadar,
  IconSettings,
  IconSitemap,
  IconUser,
  type Icon,
} from "@tabler/icons-react";
import { Link } from "@tanstack/react-router";

import { useDemoWorkspace } from "../../demo/workspace/DemoWorkspaceProvider.js";
import { cn } from "../lib/cn.js";
import { BrandMark } from "./BrandMark.js";
import { LegalNotice } from "./LegalNotice.js";

type NavTarget =
  | "/dashboard"
  | "/analytics"
  | "/jobs"
  | "/apply-review"
  | "/pipelines"
  | "/discovery"
  | "/artifacts"
  | "/evidence-map"
  | "/outreach"
  | "/runs"
  | "/debug"
  | "/profile"
  | "/preferences"
  | "/settings";

interface NavItem {
  readonly label: string;
  readonly to: NavTarget;
  readonly icon: Icon;
}

interface NavGroup {
  readonly label: string;
  readonly items: readonly NavItem[];
}

export const NAV_GROUPS: readonly NavGroup[] = [
  {
    label: "Overview",
    items: [
      { label: "Dashboard", to: "/dashboard", icon: IconLayoutDashboard },
      { label: "Analytics", to: "/analytics", icon: IconChartBar },
    ],
  },
  {
    label: "Pipeline",
    items: [
      { label: "Jobs", to: "/jobs", icon: IconBriefcase },
      { label: "Apply review", to: "/apply-review", icon: IconChecklist },
      { label: "Pipelines", to: "/pipelines", icon: IconSitemap },
      { label: "Discovery", to: "/discovery", icon: IconRadar },
    ],
  },
  {
    label: "Library",
    items: [
      { label: "Artifacts", to: "/artifacts", icon: IconFileText },
      { label: "Evidence", to: "/evidence-map", icon: IconMap2 },
      { label: "Contacts", to: "/outreach", icon: IconAddressBook },
    ],
  },
  {
    label: "Activity",
    items: [
      { label: "Runs", to: "/runs", icon: IconHistory },
      { label: "Debug", to: "/debug", icon: IconBug },
    ],
  },
  {
    label: "Setup",
    items: [
      { label: "Profile", to: "/profile", icon: IconUser },
      { label: "Preferences", to: "/preferences", icon: IconAdjustments },
      { label: "Settings", to: "/settings", icon: IconSettings },
    ],
  },
];

interface RailNavProps {
  readonly className?: string;
  readonly onNavigate?: () => void;
}

export function RailNav({ className, onNavigate }: RailNavProps) {
  return (
    <nav className={cn("side-rail__nav", className)} aria-label="Main navigation">
      {NAV_GROUPS.map((group) => (
        <div key={group.label} className="side-rail__group">
          <span className="side-rail__group-label">{group.label}</span>
          {group.items.map(({ label, to, icon: NavIcon }) => (
            <Link
              key={to}
              to={to}
              className="side-rail__link"
              activeProps={{ className: "on" }}
              aria-label={label}
              title={label}
              onClick={onNavigate}
            >
              <NavIcon className="side-rail__icon" size={18} stroke={1.75} aria-hidden="true" />
              <span className="side-rail__label">{label}</span>
            </Link>
          ))}
        </div>
      ))}
    </nav>
  );
}

export function LocalModeCard() {
  const workspace = useDemoWorkspace();
  const text =
    workspace.mode === "demo"
      ? workspace.runtime.storageMode === "indexeddb"
        ? "Demo mode — shared browser profile"
        : "Demo mode — this tab only"
      : "Local mode — all data stays on device";
  return (
    <div className="side-rail__footer">
      <span className="side-rail__status-dot" aria-hidden="true" />
      <span className="side-rail__footer-text">{text}</span>
    </div>
  );
}

export function SideRail() {
  return (
    <aside className="side-rail">
      <Link to="/dashboard" className="side-rail__brand" aria-label="JobCtrl">
        <BrandMark />
      </Link>
      <RailNav />
      <span className="side-rail__spacer" />
      <LocalModeCard />
      <LegalNotice className="legal-notice legal-notice--rail" />
    </aside>
  );
}
