import { Link } from "@tanstack/react-router";

const NAV_ITEMS: ReadonlyArray<{
  readonly label: string;
  readonly to:
    | "/dashboard"
    | "/analytics"
    | "/apply-review"
    | "/jobs"
    | "/pipelines"
    | "/discovery"
    | "/runs"
    | "/debug"
    | "/artifacts"
    | "/profile"
    | "/preferences"
    | "/settings";
}> = [
  { label: "Dashboard", to: "/dashboard" },
  { label: "Analytics", to: "/analytics" },
  { label: "Apply review", to: "/apply-review" },
  { label: "Jobs", to: "/jobs" },
  { label: "Pipelines", to: "/pipelines" },
  { label: "Discovery", to: "/discovery" },
  { label: "Runs", to: "/runs" },
  { label: "Debug", to: "/debug" },
  { label: "Artifacts", to: "/artifacts" },
  { label: "Profile", to: "/profile" },
  { label: "Preferences", to: "/preferences" },
  { label: "Settings", to: "/settings" },
];

export function NavBar() {
  return (
    <nav className="nav" aria-label="Main navigation">
      {NAV_ITEMS.map(({ label, to }) => (
        <Link key={to} to={to} activeProps={{ className: "on" }}>
          {label}
        </Link>
      ))}
    </nav>
  );
}
