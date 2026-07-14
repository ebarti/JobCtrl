import { IconMenu2, IconSearch } from "@tabler/icons-react";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";

import { useDensity } from "../hooks/useDensity.js";
import type { Density } from "../stores/ui-preferences.js";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "../ui/sheet.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../ui/select.js";
import { BrandMark } from "./BrandMark.js";
import { ConnectionStatusPill } from "./ConnectionStatusPill.js";
import { LegalNotice } from "./LegalNotice.js";
import { LocalModeStatus, RailNav } from "./SideRail.js";
import { ThemeToggle } from "./ThemeToggle.js";

const DENSITY_OPTIONS: ReadonlyArray<Density> = ["compact", "regular", "comfy"];

interface DensityControlProps {
  readonly className: string;
  readonly density: Density;
  readonly onDensityChange: (density: Density) => void;
}

function DensityControl({ className, density, onDensityChange }: DensityControlProps) {
  return (
    <Select value={density} onValueChange={(value) => onDensityChange(value as Density)}>
      <SelectTrigger className={className} aria-label="Row density">
        <SelectValue />
      </SelectTrigger>
      <SelectContent align="end">
        {DENSITY_OPTIONS.map((option) => (
          <SelectItem key={option} value={option}>
            {option[0]?.toUpperCase()}{option.slice(1)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

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
        <SheetContent
          side="left"
          className="mobile-navigation-sheet"
          aria-describedby={undefined}
        >
          <SheetHeader className="mobile-navigation-sheet__header">
            <SheetTitle className="mobile-navigation-sheet__title">
              <BrandMark showTagline />
            </SheetTitle>
          </SheetHeader>
          <RailNav className="sheet-nav" onNavigate={() => setNavOpen(false)} />
          <section
            className="mobile-navigation-sheet__utilities"
            aria-labelledby="mobile-navigation-utilities-title"
          >
            <h2 id="mobile-navigation-utilities-title">Interface controls</h2>
            <div className="mobile-navigation-sheet__density-row">
              <span>Row density</span>
              <DensityControl
                className="mobile-navigation-sheet__density"
                density={density}
                onDensityChange={setDensity}
              />
            </div>
            <ThemeToggle />
            <ConnectionStatusPill />
          </section>
          <LocalModeStatus />
          <LegalNotice className="legal-notice legal-notice--sheet" />
        </SheetContent>
      </Sheet>
      <label className="topbar__search">
        <IconSearch aria-hidden="true" size={17} stroke={1.8} />
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
      </label>
      <DensityControl
        className="topbar__density"
        density={density}
        onDensityChange={setDensity}
      />
      <span className="topbar__theme-control">
        <ThemeToggle />
      </span>
      <ConnectionStatusPill />
      <LegalNotice className="legal-notice legal-notice--topbar" />
    </header>
  );
}
