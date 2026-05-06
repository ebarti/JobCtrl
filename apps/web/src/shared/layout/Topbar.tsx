import { Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";

import { useDensity } from "../hooks/useDensity.js";
import type { Density } from "../stores/ui-preferences.js";
import { ConnectionStatusPill } from "./ConnectionStatusPill.js";
import { ThemeToggle } from "./ThemeToggle.js";

const DENSITY_OPTIONS: ReadonlyArray<Density> = ["compact", "regular", "comfy"];

export function Topbar() {
  const { density, setDensity } = useDensity();
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  return (
    <header className="topbar">
      <Link className="brand" to="/dashboard">
        <span className="brand-mark">jh</span>
        <span>jobhunter</span>
      </Link>
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
      <ThemeToggle />
      <ConnectionStatusPill />
    </header>
  );
}
