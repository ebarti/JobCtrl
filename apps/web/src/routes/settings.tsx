import { Link, Outlet, createFileRoute, useRouterState } from "@tanstack/react-router";

import { PageHead } from "../shared/ui/page-head.js";
import { SectionTabs, SectionTabsList } from "../shared/ui/section-tabs.js";
import { TabsContent, TabsTrigger } from "../shared/ui/tabs.js";

const TABS: ReadonlyArray<{
  readonly to: "/settings" | "/settings/credentials" | "/settings/models" | "/settings/browser";
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
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const activeTab = TABS.find((tab) => tab.to === pathname)?.to ?? "/settings";

  return (
    <div className="route-page route-page--settings">
      <PageHead eyebrow="Setup" title="Settings" />
      <div className="config-layout">
        <SectionTabs className="settings-route-tabs grid gap-[18px]" value={activeTab}>
          <nav className="settings-section-navigation" aria-label="Settings sections">
            <SectionTabsList>
              {TABS.map((tab) => {
                const active = activeTab === tab.to;
                return (
                  <TabsTrigger
                    key={tab.to}
                    value={tab.to}
                    className="data-[state=active]:border-foreground"
                    asChild
                  >
                    <Link
                      to={tab.to}
                      aria-current={active ? "page" : undefined}
                    >
                      {tab.label}
                    </Link>
                  </TabsTrigger>
                );
              })}
            </SectionTabsList>
          </nav>
          <TabsContent className="settings-route-tabs__content mt-0" value={activeTab} forceMount>
            <Outlet />
          </TabsContent>
        </SectionTabs>
      </div>
    </div>
  );
}
