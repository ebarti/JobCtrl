import { IconMenu2 } from "@tabler/icons-react";
import { useRouterState } from "@tanstack/react-router";
import { useState, type ReactNode } from "react";

import { Button } from "../ui/button.js";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "../ui/sheet.js";
import { BrandMark } from "./BrandMark.js";
import { ConnectionStatusPill } from "./ConnectionStatusPill.js";
import { LegalNotice } from "./LegalNotice.js";
import { RailNav } from "./SideRail.js";
import { WORKSPACE_LABELS, workspaceLocation } from "./workspace-location.js";

interface TopbarProps {
  readonly navigationToggle?: ReactNode;
}

export function Topbar({ navigationToggle }: TopbarProps = {}) {
  const [navOpen, setNavOpen] = useState(false);
  const location = useRouterState({ select: (state) => state.location });
  const { workspace, label } = workspaceLocation(location.pathname, location.search, location.hash);

  return (
    <header className="topbar">
      {navigationToggle}
      <Sheet open={navOpen} onOpenChange={setNavOpen}>
        <SheetTrigger render={<Button aria-label="Open navigation" className="topbar__hamburger" size="icon" variant="ghost" />}>
          <IconMenu2 aria-hidden="true" className="size-4" />
        </SheetTrigger>
        <SheetContent className="bg-sidebar text-sidebar-foreground" side="left" aria-describedby={undefined}>
          <SheetHeader><SheetTitle><BrandMark /></SheetTitle></SheetHeader>
          <RailNav className="sheet-nav" onNavigate={() => setNavOpen(false)} />
          <LegalNotice className="legal-notice legal-notice--sheet" />
        </SheetContent>
      </Sheet>
      <div className="topbar__breadcrumb" aria-label="Current workspace">
        <span>{WORKSPACE_LABELS[workspace]}</span>
        <span className="topbar__breadcrumb-separator" aria-hidden="true">/</span>
        <strong>{label}</strong>
      </div>
      <ConnectionStatusPill />
    </header>
  );
}
