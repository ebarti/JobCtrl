import { Link } from "@tanstack/react-router";

const NAV_ITEMS: ReadonlyArray<{
  readonly label: string;
  readonly to: "/dashboard" | "/jobs" | "/artifacts" | "/profile" | "/settings";
}> = [
  { label: "Dashboard", to: "/dashboard" },
  { label: "Jobs", to: "/jobs" },
  { label: "Artifacts", to: "/artifacts" },
  { label: "Profile", to: "/profile" },
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
