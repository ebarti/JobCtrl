import { IconMenu2, IconSearch } from "@tabler/icons-react";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";

import { useDensity } from "../hooks/useDensity.js";
import type { Density } from "../stores/ui-preferences.js";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "../ui/sheet.js";
import { BrandMark } from "./BrandMark.js";
import { ConnectionStatusPill } from "./ConnectionStatusPill.js";
import { LegalNotice } from "./LegalNotice.js";
import { RailNav } from "./SideRail.js";
import { ThemeToggle } from "./ThemeToggle.js";

const DENSITY_OPTIONS: ReadonlyArray<Density> = ["compact", "regular", "comfy"];

export function Topbar() {
  const { density, setDensity } = useDensity();
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [navOpen, setNavOpen] = useState(false);
  return (
    <header className="topbar">
      <Sheet open={navOpen} onOpenChange={setNavOpen}>
        <SheetTrigger asChild>
          <button type="button" className="tab topbar__hamburger" aria-label="Open navigation">
            <IconMenu2 aria-hidden="true" size={18} />
          </button>
        </SheetTrigger>
        <SheetContent side="left" aria-describedby={undefined}>
          <SheetHeader>
            <SheetTitle>
              <BrandMark showTagline />
            </SheetTitle>
          </SheetHeader>
          <RailNav className="sheet-nav" onNavigate={() => setNavOpen(false)} />
          <LegalNotice className="legal-notice legal-notice--sheet" />
        </SheetContent>
      </Sheet>
      <div className="topbar__search">
        <IconSearch
          className="topbar__search-icon"
          size={16}
          stroke={1.8}
          aria-hidden="true"
        />
        <input
          aria-label="Global search"
          className="global-search"
          placeholder="Filter jobs, errors, companies..."
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && query.trim()) {
              void navigate({ to: "/jobs", search: { q: query.trim(), page: 1 } });
            }
          }}
        />
      </div>
      <div className="topbar__density">
        <select
          aria-label="Row density"
          className="select"
          value={density}
          onChange={(event) => setDensity(event.target.value as Density)}
        >
          {DENSITY_OPTIONS.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      </div>
      <ThemeToggle />
      <ConnectionStatusPill />
      <LegalNotice className="legal-notice legal-notice--topbar" />
    </header>
  );
}
