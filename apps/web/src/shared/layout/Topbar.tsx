import {
  IconAdjustments,
  IconMenu2,
  IconSearch,
  IconX,
} from "@tabler/icons-react";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";

import { useDensity } from "../hooks/useDensity.js";
import { useTheme } from "../hooks/useTheme.js";
import type { Density } from "../stores/ui-preferences.js";
import { Button } from "../ui/button.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu.js";
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

const DENSITY_OPTIONS: ReadonlyArray<{
  readonly label: string;
  readonly value: Density;
}> = [
  { label: "Compact", value: "compact" },
  { label: "Regular", value: "regular" },
  { label: "Comfortable", value: "comfy" },
];

interface TopbarProps {
  readonly navigationToggle?: ReactNode;
}

export function Topbar({ navigationToggle }: TopbarProps = {}) {
  const { density, setDensity } = useDensity();
  const { theme, setTheme } = useTheme();
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [navOpen, setNavOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const searchId = useId();
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const searchTriggerRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (searchOpen) searchInputRef.current?.focus();
  }, [searchOpen]);

  const closeSearch = (restoreFocus = false) => {
    setSearchOpen(false);
    if (restoreFocus) {
      requestAnimationFrame(() => searchTriggerRef.current?.focus());
    }
  };

  const submitSearch = () => {
    const normalizedQuery = query.trim();
    if (!normalizedQuery) return;
    void navigate({
      to: "/jobs",
      search: { q: normalizedQuery, page: 1 },
    });
    closeSearch();
  };

  return (
    <header className="topbar">
      {navigationToggle}
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
          <IconMenu2 aria-hidden="true" className="size-4" />
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
      <Button
        ref={searchTriggerRef}
        aria-controls={searchId}
        aria-expanded={searchOpen}
        aria-label={searchOpen ? "Close global search" : "Open global search"}
        className="topbar__search-trigger"
        size="icon"
        type="button"
        variant="ghost"
        onClick={() => {
          if (searchOpen) {
            closeSearch(true);
          } else {
            setSearchOpen(true);
          }
        }}
      >
        {searchOpen ? (
          <IconX aria-hidden="true" />
        ) : (
          <IconSearch aria-hidden="true" />
        )}
      </Button>
      <InputGroup
        className="topbar__search"
        data-state={searchOpen ? "open" : "closed"}
        id={searchId}
      >
        <InputGroupAddon>
          <IconSearch
            aria-hidden="true"
            className="topbar__search-icon size-4"
          />
        </InputGroupAddon>
        <InputGroupInput
          ref={searchInputRef}
          aria-label="Global search"
          className="global-search"
          placeholder="Filter jobs, errors, companies..."
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              closeSearch(true);
            } else if (event.key === "Enter") {
              submitSearch();
            }
          }}
        />
        <InputGroupAddon align="inline-end" className="topbar__search-close">
          <Button
            aria-label="Close global search"
            size="icon"
            type="button"
            variant="ghost"
            onClick={() => closeSearch(true)}
          >
            <IconX aria-hidden="true" />
          </Button>
        </InputGroupAddon>
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
        {DENSITY_OPTIONS.map(({ label, value }) => (
          <ToggleGroupItem key={value} data-typography="control" value={value}>
            {label}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
      <ThemeToggle />
      <ConnectionStatusPill />
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              aria-label="Open display preferences"
              className="topbar__preferences"
              size="icon"
              type="button"
              variant="ghost"
            />
          }
        >
          <IconAdjustments aria-hidden="true" />
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          aria-label="Display preferences"
          className="topbar__preferences-menu"
        >
          <DropdownMenuGroup>
            <DropdownMenuLabel>Density</DropdownMenuLabel>
            <DropdownMenuRadioGroup
              value={density}
              onValueChange={(value) => {
                const option = DENSITY_OPTIONS.find(
                  (candidate) => candidate.value === value,
                );
                if (option) setDensity(option.value);
              }}
            >
              {DENSITY_OPTIONS.map(({ label, value }) => (
                <DropdownMenuRadioItem key={value} value={value}>
                  {label}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
          >
            Use {theme === "dark" ? "light" : "dark"} theme
            <DropdownMenuShortcut>
              {theme === "dark" ? "Dark" : "Light"}
            </DropdownMenuShortcut>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <LegalNotice className="legal-notice legal-notice--topbar" />
    </header>
  );
}
