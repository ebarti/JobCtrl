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
      <Select value={density} onValueChange={(value) => setDensity(value as Density)}>
        <SelectTrigger className="topbar__density" aria-label="Row density">
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
      <ThemeToggle />
      <ConnectionStatusPill />
      <LegalNotice className="legal-notice legal-notice--topbar" />
    </header>
  );
}
