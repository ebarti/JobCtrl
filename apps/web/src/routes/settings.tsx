import {
  Link,
  Outlet,
  createFileRoute,
  useRouterState,
} from "@tanstack/react-router";
import { useEffect, useRef } from "react";

import { PageHead } from "../shared/ui/page-head.js";

const TABS: ReadonlyArray<{
  readonly to:
    | "/settings"
    | "/settings/credentials"
    | "/settings/models"
    | "/settings/browser";
  readonly label: string;
}> = [
  { to: "/settings", label: "General" },
  { to: "/settings/credentials", label: "Credentials" },
  { to: "/settings/models", label: "Model selection" },
  { to: "/settings/browser", label: "Browser & extension" },
];

export const Route = createFileRoute("/settings")({
  component: SettingsLayout,
});

function SettingsLayout() {
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  });
  const activeTabRef = useRef<HTMLAnchorElement | null>(null);

  useEffect(() => {
    activeTabRef.current?.scrollIntoView?.({
      block: "nearest",
      inline: "nearest",
    });
  }, [pathname]);

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
                ref={active ? activeTabRef : undefined}
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
