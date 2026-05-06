export type View = "dashboard" | "jobs" | "artifacts" | "config" | "profile";

const NAV_ITEMS: ReadonlyArray<{ readonly view: View; readonly label: string }> = [
  { view: "dashboard", label: "Dashboard" },
  { view: "jobs", label: "Jobs" },
  { view: "artifacts", label: "Artifacts" },
  { view: "profile", label: "Profile" },
  { view: "config", label: "Settings" },
];

export interface NavBarProps {
  currentView: View;
  onViewChange: (view: View) => void;
}

export function NavBar({ currentView, onViewChange }: NavBarProps) {
  return (
    <nav className="nav" aria-label="Main navigation">
      {NAV_ITEMS.map(({ view, label }) => (
        <button
          key={view}
          type="button"
          className={currentView === view ? "on" : ""}
          onClick={() => onViewChange(view)}
        >
          {label}
        </button>
      ))}
    </nav>
  );
}
