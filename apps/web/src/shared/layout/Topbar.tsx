import { IconMenu2, IconSearch } from "@tabler/icons-react";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";

import { useDensity } from "../hooks/useDensity.js";
import type { Density } from "../stores/ui-preferences.js";
import { Button } from "../ui/button.js";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "../ui/input-group.js";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "../ui/sheet.js";
import { ToggleGroup, ToggleGroupItem } from "../ui/toggle-group.js";
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
        <SheetTrigger
          render={
            <Button
              aria-label="Open navigation"
              className="topbar__hamburger"
              size="icon"
              variant="ghost"
            />
          }
        >
          <IconMenu2 aria-hidden="true" />
        </SheetTrigger>
        <SheetContent
          className="bg-sidebar text-sidebar-foreground"
          side="left"
          aria-describedby={undefined}
        >
          <SheetHeader>
            <SheetTitle>
              <BrandMark showTagline />
            </SheetTitle>
          </SheetHeader>
          <RailNav className="sheet-nav" onNavigate={() => setNavOpen(false)} />
          <LegalNotice className="legal-notice legal-notice--sheet" />
        </SheetContent>
      </Sheet>
      <InputGroup className="topbar__search">
        <InputGroupAddon>
          <IconSearch className="topbar__search-icon" aria-hidden="true" />
        </InputGroupAddon>
        <InputGroupInput
          aria-label="Global search"
          className="global-search"
          placeholder="Filter jobs, errors, companies..."
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && query.trim()) {
              void navigate({
                to: "/jobs",
                search: { q: query.trim(), page: 1 },
              });
            }
          }}
        />
      </InputGroup>
      <ToggleGroup
        aria-label="Row density"
        className="topbar__density"
        size="sm"
        spacing={0}
        type="single"
        value={density}
        variant="outline"
        onValueChange={(value) => {
          if (value) setDensity(value as Density);
        }}
      >
        {DENSITY_OPTIONS.map((option) => (
          <ToggleGroupItem key={option} value={option}>
            {option}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
      <ThemeToggle />
      <ConnectionStatusPill />
      <LegalNotice className="legal-notice legal-notice--topbar" />
    </header>
  );
}
