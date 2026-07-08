import { Link, Outlet, createFileRoute, useRouterState } from "@tanstack/react-router";

import { PageHead } from "../shared/ui/page-head.js";

const TABS: ReadonlyArray<{
  readonly to: "/settings" | "/settings/credentials";
  readonly label: string;
}> = [
  { to: "/settings", label: "general" },
  { to: "/settings/credentials", label: "credentials" },
];

export const Route = createFileRoute("/settings")({
  component: SettingsLayout,
});

function SettingsLayout() {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  return (
    <>
      <PageHead eyebrow="Setup" title="Settings" />
      <div className="config-layout">
        <nav className="settings-tabs" aria-label="Settings sections">
          {TABS.map((tab) => {
            const active = pathname === tab.to;
            return (
              <Link
                key={tab.to}
                to={tab.to}
                className={`tab ${active ? "on" : ""}`}
                aria-current={active ? "page" : undefined}
              >
                {tab.label}
              </Link>
            );
          })}
        </nav>
        <Outlet />
      </div>
    </>
  );
}
