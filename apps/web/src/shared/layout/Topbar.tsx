import { useDensity } from "../hooks/useDensity.js";
import type { Density } from "../stores/ui-preferences.js";
import { ConnectionStatusPill } from "./ConnectionStatusPill.js";
import type { View } from "./NavBar.js";
import { ThemeToggle } from "./ThemeToggle.js";

const DENSITY_OPTIONS: ReadonlyArray<Density> = ["compact", "regular", "comfy"];

export interface TopbarProps {
  setView: (view: View) => void;
  globalQuery: string;
  setGlobalQuery: (query: string) => void;
}

export function Topbar({ setView, globalQuery, setGlobalQuery }: TopbarProps) {
  const { density, setDensity } = useDensity();
  return (
    <header className="topbar">
      <button className="brand" type="button" onClick={() => setView("dashboard")}>
        <span className="brand-mark">jh</span>
        <span>jobhunter</span>
      </button>
      <input
        aria-label="Global search"
        className="global-search"
        placeholder="Filter jobs, errors, companies..."
        value={globalQuery}
        onChange={(event) => setGlobalQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && globalQuery.trim()) {
            setView("jobs");
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
